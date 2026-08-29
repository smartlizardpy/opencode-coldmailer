/**
 * Reply detection over IMAP, using the same app password as sending.
 *
 * Replies are matched to sends by the Message-ID we generated BEFORE sending, checked against
 * In-Reply-To and References. Matching on subject or address would misfire across campaigns.
 */
import { ImapFlow } from "imapflow";
import { ulid, now, tx, type Db } from "../db/index.ts";
import { getSecret } from "./secrets.ts";
import { classifyInbound, isDeadMailbox } from "./classify.ts";
import { suppress } from "../queue/sendQueue.ts";

export interface ImapConfig { host: string; port: number; secure: boolean; user: string; mailbox?: string }
export const GMAIL_IMAP: Omit<ImapConfig, "user"> = { host: "imap.gmail.com", port: 993, secure: true, mailbox: "INBOX" };

export async function verifyImap(cfg: ImapConfig, password: string): Promise<{ ok: boolean; error?: string }> {
  const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure,
    auth: { user: cfg.user, pass: password.replace(/\s+/g, "") }, logger: false });
  try { await c.connect(); await c.logout(); return { ok: true }; }
  catch (e) {
    // imapflow's `message` for a rejected login is the bare "Command failed", which tells the
    // user nothing at all. `response` carries the server's actual reply and
    // `authenticationFailed` says which kind of failure it was; use whichever exists.
    const err = e as Error & { code?: string; response?: string; authenticationFailed?: boolean };
    const detail = err.response || err.message || "connection failed";
    const prefix = err.authenticationFailed && !/\b5\d\d\b|AUTHENTICATIONFAILED/i.test(detail)
      ? "Authentication failed: " : "";
    return { ok: false, error: `${prefix}${detail}`.slice(0, 300) };
  }
}

/**
 * Every Message-ID this inbound message says it is answering, from the envelope and from the
 * raw headers, most specific first.
 *
 * Exported because reply matching depends entirely on it: if this returns nothing, a real
 * reply from a real prospect is recorded as unmatched and nobody is ever shown it.
 */
export function threadRefs(headerText: string, envelopeInReplyTo?: unknown): string[] {
  return [
    ...idsFrom(envelopeInReplyTo),
    ...idsFrom(/in-reply-to:[ \t]*([^\r\n]+)/i.exec(headerText)?.[1]),
    // References is folded across lines more often than not, so the capture has to run past a
    // newline that is followed by whitespace. The terminator must also allow the END OF THE
    // BLOCK: with only `\r?\n(?![ \t])`, a References header that happens to be last matched
    // nothing at all and the whole thread chain was lost. `[ \t]` rather than `\s`, so the
    // blank line that ends the header block still terminates the capture.
    ...idsFrom(/references:[ \t]*([\s\S]*?)(?:\r?\n(?![ \t])|(?![\s\S]))/i.exec(headerText)?.[1]),
  ];
}

function idsFrom(value: unknown): string[] {
  if (!value) return [];
  const s = Array.isArray(value) ? value.join(" ") : String(value);
  return s.match(/<[^>]+>/g) ?? [];
}

export interface PollResult {
  scanned: number; matched: number; unmatched: number; errors: string[];
  /** Broken out because they mean completely different things to the user. */
  replies: number; bounces: number; autoReplies: number; suppressed: number;
}

export async function pollReplies(db: Db, cfg: ImapConfig, opts: { sinceMs?: number } = {}): Promise<PollResult> {
  const password = await getSecret(db, "smtp.password");
  if (!password) return { scanned: 0, matched: 0, unmatched: 0, errors: ["no password stored"],
    replies: 0, bounces: 0, autoReplies: 0, suppressed: 0 };

  const client = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure,
    auth: { user: cfg.user, pass: password.replace(/\s+/g, "") }, logger: false });
  const result: PollResult = { scanned: 0, matched: 0, unmatched: 0, errors: [],
    replies: 0, bounces: 0, autoReplies: 0, suppressed: 0 };

  try {
    await client.connect();
    const lock = await client.getMailboxLock(cfg.mailbox ?? "INBOX");
    try {
      // Only look back as far as our oldest unanswered send.
      const since = new Date(opts.sinceMs ?? Date.now() - 30 * 24 * 3600_000);
      // The whole header block, not two fields: Content-Type, Return-Path and Auto-Submitted
      // are what separate a bounce and an out-of-office from a person writing back.
      for await (const msg of client.fetch({ since }, { envelope: true, headers: true, source: false, bodyStructure: false, uid: true })) {
        result.scanned++;
        const env = msg.envelope;
        const messageId = env?.messageId;
        if (messageId && db.prepare("SELECT 1 FROM reply WHERE message_id=?").get(messageId)) continue;

        const headerText = msg.headers?.toString() ?? "";
        const refs = threadRefs(headerText, env?.inReplyTo);
        if (refs.length === 0) continue;

        let send: any;
        for (const ref of refs) {
          send = db.prepare("SELECT * FROM send_log WHERE message_id=?").get(ref);
          if (send) break;
        }
        if (!send) { result.unmatched++; continue; }

        const from = env?.from?.[0]?.address ?? "";
        const subject = env?.subject ?? "";

        // A bounce report keeps its details in the body, so it is the one case worth a
        // second round trip. Only for messages that already look like one.
        let bodyText = "";
        if (mightBeReport(headerText, from, subject)) {
          try { bodyText = await downloadText(client, msg.uid); } catch { /* classified without it */ }
        }
        const verdict = classifyInbound({ headers: headerText, from, subject, body: bodyText });

        tx(db, () => {
          db.prepare(
            `INSERT INTO reply (id,send_log_id,campaign_id,contact_id,from_email,subject,body_text,
               message_id,in_reply_to,received_at,handled,created_at,kind,bounced_recipient,bounce_status)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ).run(ulid(), send.id, send.campaign_id, send.contact_id, from,
                subject, "", messageId ?? null, refs[0] ?? null,
                env?.date ? new Date(env.date).getTime() : now(), 
                // An auto-reply needs nothing from the user, so it arrives already handled.
                verdict.kind === "auto_reply" ? 1 : 0,
                now(), verdict.kind, verdict.recipient ?? null, verdict.status ?? null);

          if (verdict.kind === "reply") {
            // Only a person answering stops the outreach.
            db.prepare("UPDATE campaign_company SET status='replied', updated_at=? WHERE id=(SELECT campaign_company_id FROM email_draft WHERE id=?)")
              .run(now(), send.draft_id);
            db.prepare("UPDATE email_draft SET status='sent' WHERE id=? AND status='approved'").run(send.draft_id);
          }
        });

        if (verdict.kind === "reply") result.replies++;
        else if (verdict.kind === "auto_reply") result.autoReplies++;
        else {
          result.bounces++;
          // Suppressed automatically, and only for a mailbox that does not exist. This is the
          // one case where acting without asking is right: the address is gone, nothing is
          // lost by never mailing it again, and continuing to mail it costs sender reputation.
          // A 5.7.x policy rejection is deliberately excluded - that can be about the content
          // or a temporary block, and silently discarding the lead would be wrong.
          const dead = verdict.recipient ?? contactEmail(db, send.contact_id);
          if (verdict.kind === "bounce_hard" && isDeadMailbox(verdict.status) && dead) {
            suppress(db, dead, "bounce", `${verdict.status}${verdict.reason ? ` - ${verdict.reason}` : ""}`);
            result.suppressed++;
          }
        }
        result.matched++;
      }
    } finally { lock.release(); }
    await client.logout();
  } catch (e) {
    result.errors.push((e as Error).message.slice(0, 300));
    try { await client.logout(); } catch { /* already gone */ }
  }
  return result;
}

/** Fetch the body of one reply on demand - we do not store message bodies until asked. */
export async function fetchReplyBody(db: Db, cfg: ImapConfig, replyId: string): Promise<string> {
  const reply = db.prepare("SELECT message_id FROM reply WHERE id=?").get(replyId) as { message_id: string } | undefined;
  if (!reply?.message_id) return "";
  const password = await getSecret(db, "smtp.password");
  if (!password) return "";
  const client = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure,
    auth: { user: cfg.user, pass: password.replace(/\s+/g, "") }, logger: false });
  try {
    await client.connect();
    const lock = await client.getMailboxLock(cfg.mailbox ?? "INBOX");
    try {
      for await (const msg of client.fetch({ header: { "message-id": reply.message_id } }, { source: true, uid: true })) {
        const raw = msg.source?.toString() ?? "";
        const body = stripQuoted(raw.split(/\r?\n\r?\n/).slice(1).join("\n\n"));
        db.prepare("UPDATE reply SET body_text=? WHERE id=?").run(body.slice(0, 20_000), replyId);
        return body;
      }
    } finally { lock.release(); }
    await client.logout();
  } catch { /* fall through */ }
  return "";
}

/** Drop the quoted original so the model reads only what the person actually wrote. */
/**
 * Cheap pre-filter so an ordinary reply never costs a second fetch. Deliberately generous -
 * a false positive here only downloads one message, a false negative misses a bounce.
 */
function mightBeReport(headers: string, from: string, subject: string): boolean {
  const local = (from.split("@")[0] ?? "").toLowerCase();
  return /multipart\/report|report-type\s*=\s*"?delivery-status/i.test(headers)
    || /^return-path:\s*<>\s*$/im.test(headers)
    || /mailer-daemon|postmaster|bounce|no-?reply/.test(local)
    || /undelivered|delivery status|delivery has failed|returned to sender|address not found/i.test(subject);
}

async function downloadText(client: ImapFlow, uid: number): Promise<string> {
  const msg = await client.download(String(uid), undefined, { uid: true });
  if (!msg?.content) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of msg.content) chunks.push(chunk as Buffer);
  // Reports are ASCII by definition; 64KB is far more than any of them need.
  return Buffer.concat(chunks).subarray(0, 64 * 1024).toString("utf8");
}

function contactEmail(db: Db, contactId: string): string | undefined {
  return (db.prepare("SELECT email FROM contact WHERE id=?").get(contactId) as { email?: string } | undefined)?.email;
}

export function stripQuoted(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) break;
    if (/^\s*On .+ wrote:\s*$/.test(line)) break;
    if (/^\s*-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    if (/^\s*From:\s.+@/.test(line) && out.length > 0) break;
    out.push(line);
  }
  return out.join("\n").trim();
}
