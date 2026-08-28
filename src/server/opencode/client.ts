/**
 * Minimal typed client for the opencode HTTP server.
 *
 * Deliberately NOT @opencode-ai/sdk: the published 1.14.41 typings are already behind the
 * 1.14.41 binary (no `format`, no `variant`), and we need exact control over AbortSignal,
 * timeouts and basic auth.
 *
 * Endpoint and body shapes verified against the installed binary.
 */

export interface ModelRef {
  providerID: string;
  modelID: string;
}

/** Verified: OutputFormatJsonSchema = {type:"json_schema", schema, retryCount ?? 2} */
export interface OutputFormatJsonSchema {
  type: "json_schema";
  schema: Record<string, unknown>;
  retryCount?: number;
}
export type OutputFormat = { type: "text" } | OutputFormatJsonSchema;

export interface MessagePart {
  type: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: {
    status?: "pending" | "running" | "completed" | "error";
    input?: Record<string, unknown>;
    output?: string;
    error?: string;
    title?: string;
    metadata?: Record<string, unknown>;
    time?: { start?: number; end?: number };
  };
  [k: string]: unknown;
}

export interface AssistantMessage {
  info?: Record<string, unknown>;
  parts?: MessagePart[];
  [k: string]: unknown;
}

export interface PromptBody {
  messageID?: string;
  model?: ModelRef;
  agent?: string;
  noReply?: boolean;
  system?: string;
  variant?: string;
  tools?: Record<string, boolean>;
  format?: OutputFormat;
  parts: Array<{ type: "text"; text: string }>;
}

export class OpencodeHttpError extends Error {
  status: number;
  path: string;
  body: string;
  constructor(status: number, path: string, body: string) {
    super(`opencode ${path} -> HTTP ${status}: ${body.slice(0, 400)}`);
    this.name = "OpencodeHttpError";
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

export interface ClientOptions {
  baseUrl: string;
  username?: string;
  password?: string;
  /** Working directory opencode resolves the session against. */
  directory?: string;
}

export class OpencodeClient {
  private readonly authHeader?: string;
  private readonly opts: ClientOptions;

  constructor(opts: ClientOptions) {
    this.opts = opts;
    if (opts.password) {
      const raw = `${opts.username ?? "opencode"}:${opts.password}`;
      this.authHeader = `Basic ${Buffer.from(raw).toString("base64")}`;
    }
  }

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  private url(path: string, query?: Record<string, string | undefined>): string {
    const u = new URL(path, this.opts.baseUrl);
    if (this.opts.directory) u.searchParams.set("directory", this.opts.directory);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) u.searchParams.set(k, v);
    }
    return u.toString();
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    const onAbort = () => ctrl.abort(opts.signal?.reason);
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (this.authHeader) headers.authorization = this.authHeader;
      if (opts.body !== undefined) headers["content-type"] = "application/json";

      const res = await fetch(this.url(path), {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: ctrl.signal,
      });

      const text = await res.text();
      if (!res.ok) throw new OpencodeHttpError(res.status, path, text);
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as unknown as T;
      }
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  health(timeoutMs = 5_000): Promise<{ healthy: boolean; version: string }> {
    return this.request("GET", "/global/health", { timeoutMs });
  }

  providers(timeoutMs = 20_000): Promise<{ providers: unknown[]; default: Record<string, string> }> {
    return this.request("GET", "/config/providers", { timeoutMs });
  }

  toolIds(timeoutMs = 10_000): Promise<string[]> {
    return this.request("GET", "/experimental/tool/ids", { timeoutMs });
  }

  createSession(title: string, timeoutMs = 15_000): Promise<{ id: string }> {
    return this.request("POST", "/session", { body: { title }, timeoutMs });
  }

  deleteSession(id: string, timeoutMs = 10_000): Promise<unknown> {
    return this.request("DELETE", `/session/${encodeURIComponent(id)}`, { timeoutMs });
  }

  abortSession(id: string, timeoutMs = 10_000): Promise<unknown> {
    return this.request("POST", `/session/${encodeURIComponent(id)}/abort`, { timeoutMs });
  }

  prompt(
    sessionId: string,
    body: PromptBody,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<AssistantMessage> {
    return this.request("POST", `/session/${encodeURIComponent(sessionId)}/message`, {
      body,
      timeoutMs: opts.timeoutMs ?? 120_000,
      signal: opts.signal,
    });
  }

  messages(sessionId: string, timeoutMs = 30_000): Promise<AssistantMessage[]> {
    return this.request("GET", `/session/${encodeURIComponent(sessionId)}/message`, { timeoutMs });
  }

  /**
   * Prompt, then read back the FULL message history.
   *
   * This is the only correct way to observe what a turn actually did. Verified against
   * v1.14.41: an agentic turn emits SEVERAL assistant messages, and `POST /message` returns
   * only the LAST one. Tool calls live in the earlier messages, so a caller that inspects
   * only the POST response sees `parts: [step-start, reasoning, text, step-finish]` and
   * concludes no tool ran - even when webfetch just fetched a page.
   *
   * Both the tool-policy violation check and citation harvesting depend on seeing every tool
   * part, so both MUST use this rather than the POST response.
   */
  async promptAndCollect(
    sessionId: string,
    body: PromptBody,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ final: AssistantMessage; history: AssistantMessage[]; text: string; toolParts: MessagePart[] }> {
    const final = await this.prompt(sessionId, body, opts);
    const history = await this.messages(sessionId);
    const assistant = history.filter((m) => (m.info as { role?: string } | undefined)?.role === "assistant");
    const toolParts: MessagePart[] = [];
    for (const m of assistant) {
      for (const p of m.parts ?? []) {
        if (p.type === "tool") toolParts.push(p);
      }
    }
    // Text comes from the final message only - earlier ones are intermediate reasoning steps.
    return { final, history, text: textOf(final), toolParts };
  }
}

/** Concatenate the text parts of an assistant message. */
export function textOf(msg: AssistantMessage): string {
  return (msg.parts ?? [])
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
}

/**
 * Tool parts of a SINGLE message.
 *
 * Rarely what you want: an agentic turn spans several assistant messages and this only sees
 * one of them. Use OpencodeClient.promptAndCollect() to observe a whole turn.
 */
export function toolPartsOf(msg: AssistantMessage): MessagePart[] {
  return (msg.parts ?? []).filter((p) => p.type === "tool");
}

/** URLs a turn actually saw, harvested from webfetch inputs and websearch outputs. */
export function harvestUrls(toolParts: MessagePart[]): string[] {
  const urls = new Set<string>();
  for (const p of toolParts) {
    if (p.state?.status !== "completed") continue;
    if (p.tool === "webfetch") {
      const u = (p.state.input as { url?: unknown } | undefined)?.url;
      if (typeof u === "string") urls.add(u);
    }
    if (p.tool === "websearch") {
      // websearch returns metadata:{} and no attachments - the opaque output string is the
      // only citation carrier, so scrape URLs out of it.
      for (const m of String(p.state.output ?? "").match(/https?:\/\/[^\s"'<>)\]]+/g) ?? []) {
        urls.add(m);
      }
    }
  }
  return [...urls];
}
