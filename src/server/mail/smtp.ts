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

/**
 * What a connection failure actually means, and what to do about it.
 *
 * The person setting this up is a founder, not a sysadmin. "getaddrinfo ENOTFOUND" and
 * "535-5.7.8 Username and Password not accepted" are both accurate and both useless: the first
 * does not say the hostname is wrong and the second does not say that a Gmail account needs an
 * app password rather than the password you log in with, which is the single most common way
 * this fails.
 *
 * The raw text is kept, because when the guess is wrong the original is the only thing that helps.
 */
export interface SmtpDiagnosis { message: string; fix?: string; raw: string }

export function explainSmtpError(error: string, host = ""): SmtpDiagnosis {
  const raw = error.trim();
  const gmail = /gmail|googlemail/i.test(host);
  const at = (message: string, fix?: string): SmtpDiagnosis => ({ message, fix, raw });

  // 534 is Google specifically telling you an application-specific password is required.
  if (/\b534\b/.test(raw) || /application-specific password/i.test(raw)) {
    return at("This mailbox needs an app password, not your normal one.",
      "In your Google Account: Security → 2-Step Verification → App passwords. Generate one and paste it here.");
  }
  if (/\b535\b/.test(raw) || /AUTHENTICATIONFAILED/i.test(raw)
      || /invalid login|authentication failed|auth.*(failed|unsuccessful)|username and password not accepted/i.test(raw)) {
    return at("The mailbox rejected the username or password.",
      gmail
        ? "Gmail needs an app password, not the password you sign in with, and 2-Step Verification has to be on first. Check the address is exactly right too."
        : "Check the address and the password. Many providers need an app-specific password rather than your normal one.");
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) {
    return at(`No server found at "${host || "that hostname"}".`,
      "Check the SMTP host for a typo. If it is right, check you are online.");
  }
  if (/ECONNREFUSED/i.test(raw)) {
    return at("The server refused the connection.",
      "Usually the wrong port. Gmail is 465 with SSL on, or 587 with it off.");
  }
  if (/ETIMEDOUT|ESOCKETTIMEDOUT|timed out|timeout/i.test(raw)) {
    return at("The connection timed out.",
      "A firewall or network is blocking the port. Try 587 instead of 465, or a different network.");
  }
  if (/wrong version number|SSL routines|ssl3?_get_record|EPROTO/i.test(raw)) {
    return at("The server answered, but not in the encryption this port expects.",
      "The SSL setting does not match the port: 465 needs it on, 587 needs it off.");
  }
  if (/self.signed|certificate|CERT_|unable to verify/i.test(raw)) {
    return at("The server's TLS certificate could not be verified.",
      "Check the hostname is the provider's own. On a corporate network this can be an intercepting proxy.");
  }
  if (/\b(421|450|451|452)\b|too many|rate limit|try again later/i.test(raw)) {
    return at("The mailbox is temporarily refusing connections.",
      "Usually rate limiting. Wait a few minutes and test again.");
  }
  // No guess is better than a wrong one dressed up as an explanation.
  return at(raw);
}
