/** Typed accessors over the `setting` key/value table. */
import { now, type Db } from "./index.ts";

export interface SendingSettings {
  dailyLimit: number;
  minGapSeconds: number;
  maxGapSeconds: number;
  /**
   * Opt-out + identity footer. Default OFF, per explicit user instruction.
   *
   * Note for whoever turns this on: an identifiable sender and a working opt-out are what
   * UK PECR / GDPR expect of B2B cold email. It is a one-line addition when wanted.
   */
  footerEnabled: boolean;
  footerText: string;
  paused: boolean;
}

export const DEFAULT_SETTINGS: Record<string, unknown> = {
  sending: {
    dailyLimit: 30,
    minGapSeconds: 60,
    maxGapSeconds: 180,
    footerEnabled: false,
    footerText: "",
    // Starts paused. Nothing leaves this machine until the user explicitly presses Start.
    paused: true,
  } satisfies SendingSettings,
  llm: { researchTimeoutMs: 300_000, writingTimeoutMs: 90_000, maxAttemptsPerModel: 2, maxModelFailover: 2 },
  opencode: { binPath: null, enableExa: false },
  model_slots: { research: null, writing: null, probedAt: null },
  onboarding: { completed: false },
};

export function getSetting<T>(db: Db, key: string, fallback: T): T {
  const row = db.prepare("SELECT value FROM setting WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try { return JSON.parse(row.value) as T; } catch { return fallback; }
}

export function setSetting(db: Db, key: string, value: unknown): void {
  db.prepare(
    "INSERT INTO setting (key, value, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(key, JSON.stringify(value), now());
}

export function seedDefaults(db: Db): void {
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    const row = db.prepare("SELECT 1 FROM setting WHERE key = ?").get(k);
    if (!row) setSetting(db, k, v);
  }
}
