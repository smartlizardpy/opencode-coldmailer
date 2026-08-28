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
