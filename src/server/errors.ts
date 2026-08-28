/** Typed errors. llm() never returns a partial or empty success - it resolves or throws one of these. */

export type LlmErrorCode =
  | "OPENCODE_NOT_INSTALLED"
  | "OPENCODE_DOWN"
  | "OPENCODE_UNAUTHORIZED"
  | "NO_MODEL"
  | "MODEL_UNAVAILABLE"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "ABORTED"
  | "PERMISSION_PROMPT"
  | "TOOL_POLICY_VIOLATION"
  | "SEARCH_UNAVAILABLE"
  | "EMPTY_RESPONSE"
  | "SCHEMA_INVALID"
  | "PROVIDER_ERROR"
  | "INTERNAL";

/** Codes worth trying a different model for. Everything else is terminal. */
const RETRYABLE = new Set<LlmErrorCode>([
  "OPENCODE_DOWN", "MODEL_UNAVAILABLE", "RATE_LIMITED", "TIMEOUT",
  "EMPTY_RESPONSE", "SCHEMA_INVALID", "PROVIDER_ERROR",
]);

export interface LlmErrorInit {
  code: LlmErrorCode;
  message: string;
  task?: string;
  model?: { providerID: string; modelID: string };
  modelsTried?: Array<{ providerID: string; modelID: string }>;
  attempts?: number;
  sessionID?: string;
  raw?: string;
  validationErrors?: string[];
  retryAfterMs?: number;
  cause?: unknown;
}

export class LlmError extends Error {
  code: LlmErrorCode;
  task?: string;
  retryable: boolean;
  model?: { providerID: string; modelID: string };
  modelsTried: Array<{ providerID: string; modelID: string }>;
  attempts: number;
  sessionID?: string;
  raw?: string;
  validationErrors?: string[];
  retryAfterMs?: number;

  constructor(init: LlmErrorInit) {
    super(init.message, { cause: init.cause });
    this.name = "LlmError";
    this.code = init.code;
    this.task = init.task;
    this.retryable = RETRYABLE.has(init.code);
    this.model = init.model;
    this.modelsTried = init.modelsTried ?? [];
    this.attempts = init.attempts ?? 0;
    this.sessionID = init.sessionID;
    // Truncate: this is written to the DB and rendered in the UI.
    this.raw = init.raw?.slice(0, 8_000);
    this.validationErrors = init.validationErrors;
    this.retryAfterMs = init.retryAfterMs;
  }
}

export function isLlmError(e: unknown): e is LlmError {
  return e instanceof LlmError;
}

/** Map a transport-level failure onto a typed code. */
export function classifyTransportError(e: unknown): LlmErrorCode {
  const msg = String((e as Error)?.message ?? e).toLowerCase();
  const status = (e as { status?: number })?.status;
  if (status === 401 || status === 403) return "OPENCODE_UNAUTHORIZED";
  if (status === 429) return "RATE_LIMITED";
  if (status && status >= 500) return "PROVIDER_ERROR";
  if (msg.includes("rate limit") || msg.includes("quota") || msg.includes("429")) return "RATE_LIMITED";
  if (msg.includes("timeout") || msg.includes("aborted")) return "TIMEOUT";
  if (msg.includes("econnrefused") || msg.includes("fetch failed") || msg.includes("socket")) return "OPENCODE_DOWN";
  return "PROVIDER_ERROR";
}
