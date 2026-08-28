/** SMTP sending via nodemailer. App passwords only - no OAuth, nothing to expire silently. */
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { randomBytes } from "node:crypto";

export interface SmtpConfig {
  host: string; port: number; secure: boolean;
  user: string; fromEmail: string; fromName: string;
}

export const GMAIL_PRESET: Omit<SmtpConfig, "user" | "fromEmail" | "fromName"> =
  { host: "smtp.gmail.com", port: 465, secure: true };

export function makeTransport(cfg: SmtpConfig, password: string): Transporter {
  return nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.secure,
    auth: { user: cfg.user, pass: password.replace(/\s+/g, "") },  // app passwords are pasted with spaces
    pool: false,
    connectionTimeout: 20_000, greetingTimeout: 20_000, socketTimeout: 40_000,
  });
}

export async function verifySmtp(cfg: SmtpConfig, password: string): Promise<{ ok: boolean; error?: string }> {
  const t = makeTransport(cfg, password);
  try { await t.verify(); return { ok: true }; }
  catch (e) { return { ok: false, error: (e as Error).message.slice(0, 300) }; }
  finally { t.close(); }
}

/** Generated BEFORE sending so a reply can always be matched back to the send. */
export function newMessageId(fromEmail: string): string {
  const domain = fromEmail.split("@")[1] ?? "coldcall.local";
  return `<${Date.now().toString(36)}.${randomBytes(8).toString("hex")}@${domain}>`;
}

export interface SendArgs { to: string; subject: string; text: string; messageId: string }

export async function sendMail(cfg: SmtpConfig, password: string, args: SendArgs): Promise<{ response: string }> {
  const t = makeTransport(cfg, password);
  try {
    const info = await t.sendMail({
      from: cfg.fromName ? `"${cfg.fromName}" <${cfg.fromEmail}>` : cfg.fromEmail,
      to: args.to,
      subject: args.subject,
      text: args.text,          // plain text only: no HTML, no images, no tracking pixels
      messageId: args.messageId,
      headers: { "X-Mailer": "coldcall" },
    });
    return { response: String(info.response ?? "ok") };
  } finally { t.close(); }
}
