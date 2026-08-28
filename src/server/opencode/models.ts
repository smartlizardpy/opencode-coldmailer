/**
 * Model capability probing and slot assignment.
 *
 * The critical, counter-intuitive fact - verified in the v1.14.41 bundle and confirmed live:
 *
 *   ToolRegistry.tools -> filter(U => {
 *     if (U.id === Ra.id) return V.providerID === Is.opencode || ee.OPENCODE_ENABLE_EXA;
 *   })                          // Ra = Co("websearch", ...)
 *
 * websearch is offered ONLY to models whose providerID is "opencode" - the FREE zen models.
 * Selecting an authed openai/google model REMOVES the tool. So the research slot must be free
 * models, and the writing slot should take the best model the user actually has.
 *
 * Confirmed empirically: websearch completed on opencode/big-pickle (17 URLs harvested) and was
 * absent on google/*.
 */
import type { ModelRef, OpencodeClient } from "./client.ts";
import { AGENT_EXTRACT, AGENT_RESEARCH, toolsMapFor } from "./policy.ts";

/**
 * Models that cannot do text chat. The user's live catalogue is full of these - embeddings,
 * video, TTS, image, computer-use - and sending a prompt to one is a confusing hard failure.
 */
const NON_TEXT = /(embedding|image|tts|veo|lyria|live|computer-use|robotics|deep-research|guard|rerank|whisper|transcribe|moderation)/i;

/** Preference order among the free models, best-first. Unknown ones sort after, alphabetically. */
const FREE_PREFERENCE = [
  "nemotron-3-ultra-free",
  "big-pickle",
  "hy3-free",
  "mimo-v2.5-free",
  "ling-3.0-flash-fin-free",
  "nemotron-3.5-lightning-free",
  "muse-spark-1.2-contributor-free",
];

export type Slot = "research" | "writing";

export interface ProbedModel {
  providerID: string;
  modelID: string;
  ok: boolean;
  searchProbe?: "pass" | "fail" | "skipped";
  latencyMs?: number;
  error?: string;
}

export interface ModelSlots {
  research: { active: ModelRef | null; ranking: ProbedModel[]; status: "ok" | "none" };
  writing: { active: ModelRef | null; ranking: ProbedModel[]; status: "ok" | "none" };
  enableExa: boolean;
  probedAt: number | null;
}

export function isSearchCapable(m: ModelRef, enableExa = false): boolean {
  return m.providerID === "opencode" || enableExa;
}

export function isTextModel(m: ModelRef): boolean {
  return !NON_TEXT.test(m.modelID);
}

export async function enumerateModels(client: OpencodeClient): Promise<ModelRef[]> {
  const res = await client.providers();
  const out: ModelRef[] = [];
  for (const p of (res.providers ?? []) as Array<{ id?: string; models?: Record<string, unknown> }>) {
    if (!p.id) continue;
    for (const modelID of Object.keys(p.models ?? {})) out.push({ providerID: p.id, modelID });
  }
  return out.filter(isTextModel);
}

function rankFree(models: ModelRef[]): ModelRef[] {
  const free = models.filter((m) => m.providerID === "opencode");
  return free.sort((a, b) => {
    const ia = FREE_PREFERENCE.indexOf(a.modelID);
    const ib = FREE_PREFERENCE.indexOf(b.modelID);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return a.modelID.localeCompare(b.modelID);
  });
}

function rankWriting(models: ModelRef[], defaults: Record<string, string>): ModelRef[] {
  // The user's own authed providers first (they are paying for the better model anyway), each
  // provider's declared default, then the free pool as a fallback.
  const authed: ModelRef[] = [];
  for (const [providerID, modelID] of Object.entries(defaults ?? {})) {
    if (providerID === "opencode") continue;
    const ref = { providerID, modelID };
    if (isTextModel(ref)) authed.push(ref);
  }
  return [...authed, ...rankFree(models)];
}

/** One cheap round-trip: can this model answer at all under the tools-denied agent? */
async function probeText(client: OpencodeClient, model: ModelRef, timeoutMs: number): Promise<ProbedModel> {
  const started = Date.now();
  const s = await client.createSession(`coldcall-probe-text-${Date.now()}`);
  try {
    const r = await client.promptAndCollect(s.id, {
      agent: AGENT_EXTRACT,
      model,
      tools: toolsMapFor("none"),
      parts: [{ type: "text", text: 'Reply with exactly the word: ok' }],
    }, { timeoutMs });
    const ok = /\bok\b/i.test(r.text);
    return { ...model, ok, latencyMs: Date.now() - started, error: ok ? undefined : "no usable reply" };
  } catch (e) {
    return { ...model, ok: false, latencyMs: Date.now() - started, error: (e as Error).message.slice(0, 200) };
  } finally {
    await client.deleteSession(s.id).catch(() => {});
  }
}

/**
 * Does websearch actually run for this model?
 *
 * Checks for a COMPLETED websearch tool part, not for plausible prose. A model will happily
 * answer from memory and claim it searched - observed directly during development, where
 * big-pickle answered an F1 question confidently without calling the tool at all.
 */
async function probeSearch(client: OpencodeClient, model: ModelRef, timeoutMs: number): Promise<"pass" | "fail"> {
  const s = await client.createSession(`coldcall-probe-search-${Date.now()}`);
  try {
    const r = await client.promptAndCollect(s.id, {
      agent: AGENT_RESEARCH,
      model,
      tools: toolsMapFor("research"),
      parts: [{ type: "text", text: 'Use your websearch tool to search for "opencode ai cli", then reply DONE.' }],
    }, { timeoutMs });
    const hit = r.toolParts.some((p) => p.tool === "websearch" && p.state?.status === "completed");
    return hit ? "pass" : "fail";
  } catch {
    return "fail";
  } finally {
    await client.deleteSession(s.id).catch(() => {});
  }
}

export interface ProbeOptions {
  enableExa?: boolean;
  maxCandidates?: number;
  textTimeoutMs?: number;
  searchTimeoutMs?: number;
}

export async function probeModels(client: OpencodeClient, opts: ProbeOptions = {}): Promise<ModelSlots> {
  const enableExa = opts.enableExa ?? false;
  const maxCandidates = opts.maxCandidates ?? 3;
  const all = await enumerateModels(client);
  const res = await client.providers();

  const researchCandidates = (enableExa ? all : rankFree(all))
    .filter((m) => isSearchCapable(m, enableExa))
    .slice(0, maxCandidates);
  const writingCandidates = rankWriting(all, res.default ?? {}).slice(0, maxCandidates);

  // In series, deliberately: a probe storm against a shared free service is exactly the thing
  // the queue exists to prevent.
  const researchRanking: ProbedModel[] = [];
  for (const m of researchCandidates) {
    const t = await probeText(client, m, opts.textTimeoutMs ?? 45_000);
    if (t.ok) t.searchProbe = await probeSearch(client, m, opts.searchTimeoutMs ?? 180_000);
    else t.searchProbe = "skipped";
    researchRanking.push(t);
  }

  const writingRanking: ProbedModel[] = [];
  for (const m of writingCandidates) {
    const already = researchRanking.find((r) => r.providerID === m.providerID && r.modelID === m.modelID);
    writingRanking.push(already ? { ...already, searchProbe: undefined } : await probeText(client, m, opts.textTimeoutMs ?? 45_000));
  }

  const research = researchRanking.filter((m) => m.ok && m.searchProbe === "pass");
  const writing = writingRanking.filter((m) => m.ok);

  return {
    research: {
      active: research[0] ? { providerID: research[0].providerID, modelID: research[0].modelID } : null,
      ranking: researchRanking,
      status: research.length > 0 ? "ok" : "none",
    },
    writing: {
      active: writing[0] ? { providerID: writing[0].providerID, modelID: writing[0].modelID } : null,
      ranking: writingRanking,
      status: writing.length > 0 ? "ok" : "none",
    },
    enableExa,
    probedAt: Date.now(),
  };
}

/** In-memory cooldowns. A model enters one on 429 or repeated schema failures. */
export class Cooldowns {
  private readonly map = new Map<string, { until: number; reason: string }>();
  private key(m: ModelRef) { return `${m.providerID}/${m.modelID}`; }

  add(m: ModelRef, ms: number, reason: string): void {
    this.map.set(this.key(m), { until: Date.now() + ms, reason });
  }
  isCool(m: ModelRef): boolean {
    const e = this.map.get(this.key(m));
    if (!e) return false;
    if (Date.now() >= e.until) { this.map.delete(this.key(m)); return false; }
    return true;
  }
  list(): Array<{ model: string; until: number; reason: string }> {
    return [...this.map.entries()].map(([model, v]) => ({ model, ...v }));
  }
  clear(): void { this.map.clear(); }
}

/** Ordered candidates for a slot, skipping cooled-down models. */
export function candidatesFor(slots: ModelSlots, slot: Slot, cooldowns: Cooldowns, limit = 2): ModelRef[] {
  const ranking = slots[slot].ranking.filter((m) => m.ok && (slot !== "research" || m.searchProbe === "pass"));
  const refs = ranking.map((m) => ({ providerID: m.providerID, modelID: m.modelID }));
  const active = slots[slot].active;
  if (active && !refs.some((r) => r.providerID === active.providerID && r.modelID === active.modelID)) {
    refs.unshift(active);
  }
  return refs.filter((m) => !cooldowns.isCool(m)).slice(0, limit);
}
