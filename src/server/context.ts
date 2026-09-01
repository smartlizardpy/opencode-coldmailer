/** Everything the routes need, assembled once at boot. */
import { homedir } from "node:os";
import { join } from "node:path";
import type { Db } from "./db/index.ts";
import type { OpencodeSupervisor } from "./opencode/supervisor.ts";
import type { LlmService } from "./llm/index.ts";
import type { ModelSlots } from "./opencode/models.ts";
import type { Fetcher } from "./research/fetcher.ts";
import type { EventBus } from "./http/server.ts";
import type { SendRunner } from "./queue/sendQueue.ts";
import type { TunnelSupervisor } from "./tunnel/cloudflared.ts";
import { getSetting } from "./db/settings.ts";
import { GMAIL_PRESET, type SmtpConfig } from "./mail/smtp.ts";
import { GMAIL_IMAP, type ImapConfig } from "./mail/imap.ts";

export function coldcallHome(): string {
  return process.env.COLDCALL_HOME ?? join(homedir(), ".coldcall");
}

export interface AppContext {
  db: Db;
  supervisor: OpencodeSupervisor;
  llm: LlmService;
  fetcher: Fetcher;
  bus: EventBus;
  sender: SendRunner;
  /**
   * The Cloudflare tunnel, if one has been opened. Its hostname is the ONLY remote Host header
   * the server accepts, so this is load-bearing for access control and not just for the UI.
   */
  tunnel: TunnelSupervisor;
  /** The port the local server ended up on, so the tunnel knows what to point at. */
  port: () => number;
  slots: () => ModelSlots;
  setSlots: (s: ModelSlots) => void;
  smtpConfig: () => SmtpConfig | undefined;
  imapConfig: () => ImapConfig | undefined;
  log: (msg: string) => void;
  version: string;
  busy: Map<string, { label: string; startedAt: number }>;
}

export interface SmtpSettings {
  host?: string; port?: number; secure?: boolean;
  user?: string; fromEmail?: string; fromName?: string;
  imapHost?: string; imapPort?: number; imapSecure?: boolean;
  configured?: boolean; lastVerifiedAt?: number | null; lastError?: string | null;
}

/**
 * Keys that must never reach the `setting` table or a JSON response.
 *
 * The mailbox password lives in the Keychain and the DB holds a pointer - that is the whole
 * reason `coldcall.db` is safe to back up or attach to a bug report. It only stays true if
 * every write goes through here, because one handler that spreads a request body into the
 * settings row undoes it silently and the value then echoes back on every settings load.
 */
const SECRET_KEYS = ["password", "pass", "appPassword", "secret", "token"];

export function sanitizeSmtp<T extends Record<string, unknown>>(input: T): SmtpSettings {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) if (!SECRET_KEYS.includes(k)) out[k] = v;
  return out as SmtpSettings;
}

/** True when a settings object is carrying something it should not be. */
export function carriesSecret(input: Record<string, unknown>): boolean {
  return SECRET_KEYS.some((k) => k in input && input[k] != null && input[k] !== "");
}

export function readSmtpConfig(db: Db): SmtpConfig | undefined {
  const s = getSetting<SmtpSettings>(db, "smtp", {});
  if (!s.user || !s.configured) return undefined;
  return {
    host: s.host ?? GMAIL_PRESET.host,
    port: s.port ?? GMAIL_PRESET.port,
    secure: s.secure ?? GMAIL_PRESET.secure,
    user: s.user,
    fromEmail: s.fromEmail ?? s.user,
    fromName: s.fromName ?? "",
  };
}

export function readImapConfig(db: Db): ImapConfig | undefined {
  const s = getSetting<SmtpSettings>(db, "smtp", {});
  if (!s.user || !s.configured) return undefined;
  return {
    host: s.imapHost ?? GMAIL_IMAP.host,
    port: s.imapPort ?? GMAIL_IMAP.port,
    secure: s.imapSecure ?? GMAIL_IMAP.secure,
    user: s.user,
    mailbox: "INBOX",
  };
}
