/**
 * The JSON extraction ladder.
 *
 * This is where reliability actually comes from - not from prompting. Every step is a pure
 * function so the whole thing is table-testable without a model.
 *
 * We do NOT use opencode's `format: {type:"json_schema"}`. Verified against v1.14.41: it is
 * implemented as a synthetic tool, so under our tools-denied posture it leaks markup as literal
 * text (`<structured_output>...`, and DSML tool-call markup on some models) instead of
 * executing. Fenced JSON works cleanly on every free model tested.
 */

export type ExtractMethod = "direct" | "fence" | "brace-scan" | "repaired" | "failed";

export interface ExtractResult {
  ok: boolean;
  value?: unknown;
  method: ExtractMethod;
  error?: string;
}

/** The output contract appended to the system prompt whenever a schema is supplied. */
export function outputContract(schema: unknown): string {
  return [
    "## Output contract",
    "Return your answer as exactly one JSON object inside a single fenced block:",
    "```json",
    "{ ... }",
    "```",
    "Rules:",
    "- No text before or after the fence.",
    "- No markdown, no comments, no trailing commas.",
    "- Every required key must be present. Use null for unknown values, never invent data.",
    "- Do not call any tools for this. Respond with text only.",
    "",
    "## JSON Schema the object must satisfy",
    JSON.stringify(schema, null, 2),
  ].join("\n");
}

function tryParse(text: string): unknown | undefined {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** Last fenced block, preferring ```json over a bare ```. */
export function extractFence(text: string): string | undefined {
  const jsonFences = [...text.matchAll(/```json\s*\n?([\s\S]*?)```/gi)];
  if (jsonFences.length > 0) return jsonFences[jsonFences.length - 1][1];
  const anyFences = [...text.matchAll(/```\s*\n?([\s\S]*?)```/g)];
  if (anyFences.length > 0) return anyFences[anyFences.length - 1][1];
  return undefined;
}

/**
 * Walk from the first opening bracket to its match, tracking string state and escapes.
 * Handles the very common "Here's the JSON: {...} Let me know if you need anything else!".
 */
export function braceScan(text: string, root: "object" | "array" = "object"): string | undefined {
  const open = root === "array" ? "[" : "{";
  const close = root === "array" ? "]" : "}";
  const start = text.indexOf(open);
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { if (inString) escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/** Non-LLM repairs for the mistakes models actually make. */
export function repairLite(text: string): string {
  return text
    .replace(/^﻿/, "")
    // Smart quotes, but only the ones used as delimiters - inside a string they are legal.
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    // Line comments, avoiding "http://" and friends.
    .replace(/(^|[^:\w])\/\/[^\n\r]*/g, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // Trailing commas.
    .replace(/,(\s*[}\]])/g, "$1")
    .trim();
}

/** Strip wrappers some models emit around structured output. */
function stripKnownWrappers(text: string): string {
  return text
    .replace(/<\/?structured_output>/gi, "")
    .replace(/<\｜?DSML\｜?[^>]*>/gi, "")
    .trim();
}

export function extractJson(raw: string, root: "object" | "array" = "object"): ExtractResult {
  const text = stripKnownWrappers(raw ?? "");
  if (!text.trim()) return { ok: false, method: "failed", error: "empty response" };

  const direct = tryParse(text.trim());
  if (direct !== undefined) return { ok: true, value: direct, method: "direct" };

  const fenced = extractFence(text);
  if (fenced !== undefined) {
    const v = tryParse(fenced.trim());
    if (v !== undefined) return { ok: true, value: v, method: "fence" };
    const r = tryParse(repairLite(fenced));
    if (r !== undefined) return { ok: true, value: r, method: "repaired" };
  }

  const scanned = braceScan(text, root);
  if (scanned !== undefined) {
    const v = tryParse(scanned);
    if (v !== undefined) return { ok: true, value: v, method: "brace-scan" };
    const r = tryParse(repairLite(scanned));
    if (r !== undefined) return { ok: true, value: r, method: "repaired" };
  }

  const repaired = tryParse(repairLite(text));
  if (repaired !== undefined) return { ok: true, value: repaired, method: "repaired" };

  return { ok: false, method: "failed", error: "no parseable JSON found" };
}
