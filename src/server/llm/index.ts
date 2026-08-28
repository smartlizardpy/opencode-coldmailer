/**
 * llm() - the single entry point for every model call in the product.
 *
 * Guarantees:
 *   - Resolves with a validated value, or throws a typed LlmError. Never a partial or empty
 *     success, so no caller can silently proceed on nothing.
 *   - One fresh opencode session per call, deleted afterwards. Not for cost (it is free) but
 *     for correctness: a long-lived judging session that has seen 40 companies starts scoring
 *     #41 relative to #1-40 and bleeds facts from #12 into #41. That output parses fine, so it
 *     would never be caught downstream - it would just quietly put a wrong fact in an email to
 *     a real business.
 *   - Every tool call in the whole turn is inspected against the policy. Anything outside it is
 *     a hard TOOL_POLICY_VIOLATION that stops the campaign rather than being retried.
 */
import { randomUUID } from "node:crypto";
import { LlmError, classifyTransportError, type LlmErrorCode } from "../errors.ts";
import { extractJson, outputContract } from "./json.ts";
import { validate } from "./validate.ts";
import { LlmQueue, type Lane } from "./queue.ts";
import { harvestUrls, type MessagePart, type ModelRef, type OpencodeClient } from "../opencode/client.ts";
import { agentFor, allowedToolsFor, toolsMapFor, type ToolPolicy } from "../opencode/policy.ts";
import { candidatesFor, Cooldowns, type ModelSlots, type Slot } from "../opencode/models.ts";
import { ulid, now, type Db } from "../db/index.ts";

export type LlmTask =
  | "interview.next_question" | "interview.extract_product"
  | "search.queries" | "company.judge" | "company.enrich" | "contact.find" | "contact.extract"
  | "email.draft" | "email.revise" | "reply.classify" | "reply.draft";

/** Which lane and tool policy each task runs under. Central so no caller can get it wrong. */
const TASK_CONFIG: Record<LlmTask, { slot: Slot; policy: ToolPolicy; kind: "extract" | "write" }> = {
  "interview.next_question":  { slot: "writing",  policy: "none",     kind: "write" },
  "interview.extract_product":{ slot: "writing",  policy: "none",     kind: "extract" },
  "search.queries":           { slot: "writing",  policy: "none",     kind: "extract" },
  "company.judge":            { slot: "writing",  policy: "none",     kind: "extract" },
  "company.enrich":           { slot: "research", policy: "research", kind: "extract" },
  "contact.find":             { slot: "research", policy: "research", kind: "extract" },
  "contact.extract":          { slot: "writing",  policy: "none",     kind: "extract" },
  "email.draft":              { slot: "writing",  policy: "none",     kind: "write" },
  "email.revise":             { slot: "writing",  policy: "none",     kind: "write" },
  "reply.classify":           { slot: "writing",  policy: "none",     kind: "extract" },
  "reply.draft":              { slot: "writing",  policy: "none",     kind: "write" },
};

export interface LlmRequest {
  task: LlmTask;
  system: string;
  prompt: string;
  schema?: object;
  schemaRoot?: "object" | "array";
  model?: ModelRef;
  timeoutMs?: number;
  priority?: "interactive" | "batch";
  maxAttempts?: number;
  signal?: AbortSignal;
  subject?: { type: string; id: string };
}

export interface LlmResult<T = unknown> {
  value: T;
  toolCalls: Array<{ tool: string; callID?: string; status?: string; input?: unknown; output?: string }>;
  harvestedUrls: string[];
  meta: {
    llmCallId: string;
    model: ModelRef;
    attempts: number;
    modelsTried: ModelRef[];
    repaired: boolean;
    searchCalls: number;
    durationMs: number;
    raw: string;
  };
}

export interface LlmServiceDeps {
  client: () => OpencodeClient | undefined;
  slots: () => ModelSlots;
  db?: Db;
  queue?: LlmQueue;
  cooldowns?: Cooldowns;
  maxModelFailover?: number;
}

const REPAIR_PROMPT = (why: string) =>
  [
    "Your previous reply could not be used.",
    why.slice(0, 400),
    "",
    "Reply again with ONLY the corrected JSON object inside a single ```json fenced block.",
    "Do not apologise. Do not explain. Output only the fence.",
  ].join("\n");

export class LlmService {
  private readonly deps: LlmServiceDeps;
  readonly queue: LlmQueue;
  readonly cooldowns: Cooldowns;

  constructor(deps: LlmServiceDeps) {
    this.deps = deps;
    this.queue = deps.queue ?? new LlmQueue();
    this.cooldowns = deps.cooldowns ?? new Cooldowns();
  }

  async run<T = unknown>(req: LlmRequest): Promise<LlmResult<T>> {
    const cfg = TASK_CONFIG[req.task];
    if (!cfg) throw new LlmError({ code: "INTERNAL", message: `unknown task "${req.task}"`, task: req.task });

    const lane: Lane = req.priority === "interactive" ? "interactive" : cfg.slot === "research" ? "research" : "writing";
    return this.queue.run(lane, () => this.execute<T>(req, cfg));
  }

  private async execute<T>(
    req: LlmRequest,
    cfg: { slot: Slot; policy: ToolPolicy; kind: "extract" | "write" },
  ): Promise<LlmResult<T>> {
    const started = Date.now();
    const client = this.deps.client();
    if (!client) {
      throw new LlmError({ code: "OPENCODE_DOWN", message: "opencode is not running", task: req.task });
    }

    const failover = this.deps.maxModelFailover ?? 2;
    const models = req.model
      ? [req.model]
      : candidatesFor(this.deps.slots(), cfg.slot, this.cooldowns, failover);

    if (models.length === 0) {
      const slots = this.deps.slots();
      const code: LlmErrorCode = cfg.slot === "research" && slots.research.status === "none" ? "SEARCH_UNAVAILABLE" : "NO_MODEL";
      throw new LlmError({
        code,
        task: req.task,
        message:
          code === "SEARCH_UNAVAILABLE"
            ? "no search-capable model available - websearch requires a free opencode/* model"
            : "no usable model available",
      });
    }

    const modelsTried: ModelRef[] = [];
    let last: LlmError | undefined;

    for (const model of models) {
      modelsTried.push(model);
      try {
        return await this.attemptWithModel<T>(req, cfg, client, model, modelsTried, started);
      } catch (e) {
        const err = e instanceof LlmError ? e : new LlmError({ code: "INTERNAL", message: String(e), task: req.task, cause: e });
        // A policy violation or an abort must not be papered over by trying another model.
        if (err.code === "TOOL_POLICY_VIOLATION" || err.code === "ABORTED" || err.code === "PERMISSION_PROMPT") throw err;
        if (!err.retryable) throw err;

        if (err.code === "RATE_LIMITED") {
          this.cooldowns.add(model, err.retryAfterMs ?? 600_000, "rate limited");
          this.queue.throttle();
        } else if (err.code === "SCHEMA_INVALID" || err.code === "EMPTY_RESPONSE") {
          this.cooldowns.add(model, 600_000, err.code.toLowerCase());
        }
        last = err;
      }
    }

    last!.modelsTried = modelsTried;
    throw last!;
  }

  private async attemptWithModel<T>(
    req: LlmRequest,
    cfg: { slot: Slot; policy: ToolPolicy; kind: "extract" | "write" },
    client: OpencodeClient,
    model: ModelRef,
    modelsTried: ModelRef[],
    started: number,
  ): Promise<LlmResult<T>> {
    const llmCallId = ulid();
    const maxAttempts = Math.min(Math.max(req.maxAttempts ?? 2, 1), 3);
    const timeoutMs = req.timeoutMs ?? (cfg.slot === "research" ? 300_000 : 90_000);
    const allowed = allowedToolsFor(cfg.policy);

    const system = req.schema ? `${req.system}\n\n${outputContract(req.schema)}` : req.system;

    let session: { id: string } | undefined;
    let attempts = 0;
    let repaired = false;
    let raw = "";
    let toolParts: MessagePart[] = [];

    try {
      try {
        session = await client.createSession(`coldcall:${req.task}:${llmCallId}`);
      } catch (e) {
        // Classify here too: a failure to even open a session is almost always "opencode is
        // down", and must not be reported as an internal bug.
        throw new LlmError({
          code: classifyTransportError(e), task: req.task, model,
          message: `could not create session: ${(e as Error).message}`, cause: e,
        });
      }
      let nextPrompt = req.prompt;

      for (attempts = 1; attempts <= maxAttempts; attempts++) {
        if (req.signal?.aborted) throw new LlmError({ code: "ABORTED", message: "aborted", task: req.task });

        let collected;
        try {
          // promptAndCollect, never prompt: an agentic turn spans several assistant messages
          // and POST returns only the last, so tool parts would otherwise be invisible.
          collected = await client.promptAndCollect(session.id, {
            agent: agentFor(cfg.policy, cfg.kind),
            model,
            tools: toolsMapFor(cfg.policy),
            system,
            parts: [{ type: "text", text: nextPrompt }],
          }, { timeoutMs, signal: req.signal });
        } catch (e) {
          throw new LlmError({
            code: classifyTransportError(e), task: req.task, model, attempts,
            sessionID: session.id, message: (e as Error).message, cause: e,
          });
        }

        raw = collected.text;
        toolParts = collected.toolParts;

        // Layer 4 of the sandbox: verify what the turn ACTUALLY did.
        const offending = toolParts.filter((p) => typeof p.tool === "string" && !allowed.has(p.tool));
        if (offending.length > 0) {
          throw new LlmError({
            code: "TOOL_POLICY_VIOLATION", task: req.task, model, attempts, sessionID: session.id,
            message: `model used disallowed tool(s): ${offending.map((p) => p.tool).join(", ")}`,
            raw,
          });
        }

        if (!req.schema) {
          if (!raw.trim()) {
            throw new LlmError({ code: "EMPTY_RESPONSE", task: req.task, model, attempts, sessionID: session.id, message: "empty response" });
          }
          return this.finish<T>(raw as unknown as T, { llmCallId, model, attempts, modelsTried, repaired, started, raw, toolParts, req, cfg });
        }

        const extracted = extractJson(raw, req.schemaRoot ?? "object");
        if (extracted.ok) {
          if (extracted.method === "repaired") repaired = true;
          const v = validate(req.schema, extracted.value);
          if (v.ok) {
            return this.finish<T>(extracted.value as T, { llmCallId, model, attempts, modelsTried, repaired, started, raw, toolParts, req, cfg });
          }
          nextPrompt = REPAIR_PROMPT(`Validation errors:\n${v.errors.join("\n")}`);
          if (attempts === maxAttempts) {
            throw new LlmError({
              code: "SCHEMA_INVALID", task: req.task, model, attempts, sessionID: session.id,
              message: `output failed schema validation after ${attempts} attempts`,
              raw, validationErrors: v.errors,
            });
          }
        } else {
          nextPrompt = REPAIR_PROMPT(`Parse error: ${extracted.error}`);
          if (attempts === maxAttempts) {
            throw new LlmError({
              code: raw.trim() ? "SCHEMA_INVALID" : "EMPTY_RESPONSE",
              task: req.task, model, attempts, sessionID: session.id,
              message: `no parseable JSON after ${attempts} attempts: ${extracted.error}`,
              raw,
            });
          }
        }
        repaired = true;
      }

      throw new LlmError({ code: "INTERNAL", message: "attempt loop fell through", task: req.task, model });
    } catch (e) {
      const err = e instanceof LlmError ? e : new LlmError({ code: "INTERNAL", message: String(e), task: req.task, cause: e });
      this.log({ llmCallId, req, cfg, model, attempts, modelsTried, repaired, started, raw, toolParts, ok: false, err });
      throw err;
    } finally {
      if (session) {
        if (req.signal?.aborted) await client.abortSession(session.id).catch(() => {});
        await client.deleteSession(session.id).catch(() => {});
      }
    }
  }

  private finish<T>(value: T, ctx: FinishCtx): LlmResult<T> {
    this.log({ ...ctx, ok: true });
    const searchCalls = ctx.toolParts.filter((p) => p.tool === "websearch").length;
    return {
      value,
      toolCalls: ctx.toolParts.map((p) => ({
        tool: String(p.tool), callID: p.callID, status: p.state?.status,
        input: p.state?.input, output: p.state?.output,
      })),
      harvestedUrls: harvestUrls(ctx.toolParts),
      meta: {
        llmCallId: ctx.llmCallId, model: ctx.model, attempts: ctx.attempts,
        modelsTried: ctx.modelsTried, repaired: ctx.repaired, searchCalls,
        durationMs: Date.now() - ctx.started, raw: ctx.raw,
      },
    };
  }

  /** Every call is logged, success or failure. This is what makes failures inspectable. */
  private log(ctx: FinishCtx & { ok: boolean; err?: LlmError }): void {
    const db = this.deps.db;
    if (!db) return;
    try {
      db.prepare(
        `INSERT INTO llm_call (id,task,tool_policy,slot,provider_id,model_id,attempts,models_tried,
           repaired,search_calls,ok,error_code,error_message,duration_ms,prompt_chars,response_text,
           subject_type,subject_id,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        ctx.llmCallId, ctx.req.task, ctx.cfg.policy, ctx.cfg.slot,
        ctx.model.providerID, ctx.model.modelID, ctx.attempts,
        JSON.stringify(ctx.modelsTried), ctx.repaired ? 1 : 0,
        ctx.toolParts.filter((p) => p.tool === "websearch").length,
        ctx.ok ? 1 : 0, ctx.err?.code ?? null, ctx.err?.message.slice(0, 1000) ?? null,
        Date.now() - ctx.started, ctx.req.prompt.length, ctx.raw.slice(0, 8000),
        ctx.req.subject?.type ?? null, ctx.req.subject?.id ?? null, now(),
      );
      for (const p of ctx.toolParts) {
        db.prepare(
          "INSERT INTO tool_call_log (id,llm_call_id,call_id,tool,status,input,output,created_at) VALUES (?,?,?,?,?,?,?,?)",
        ).run(
          ulid(), ctx.llmCallId, p.callID ?? randomUUID(), String(p.tool),
          String(p.state?.status ?? "unknown"), JSON.stringify(p.state?.input ?? {}),
          String(p.state?.output ?? "").slice(0, 16000), now(),
        );
      }
    } catch {
      // Logging must never take down a real call.
    }
  }
}

interface FinishCtx {
  llmCallId: string;
  req: LlmRequest;
  cfg: { slot: Slot; policy: ToolPolicy; kind: "extract" | "write" };
  model: ModelRef;
  attempts: number;
  modelsTried: ModelRef[];
  repaired: boolean;
  started: number;
  raw: string;
  toolParts: MessagePart[];
}

export { TASK_CONFIG };
