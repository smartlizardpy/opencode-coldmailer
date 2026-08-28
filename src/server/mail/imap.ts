/**
 * Reply detection over IMAP, using the same app password as sending.
 *
 * Replies are matched to sends by the Message-ID we generated BEFORE sending, checked against
 * In-Reply-To and References. Matching on subject or address would misfire across campaigns.
 */
import { ImapFlow } from "imapflow";
import { ulid, now, tx, type Db } from "../db/index.ts";
import { getSecret } from "./secrets.ts";

export interface ImapConfig { host: string; port: number; secure: boolean; user: string; mailbox?: string }
export const GMAIL_IMAP: Omit<ImapConfig, "user"> = { host: "imap.gmail.com", port: 993, secure: true, mailbox: "INBOX" };

export async function verifyImap(cfg: ImapConfig, password: string): Promise<{ ok: boolean; error?: string }> {
  const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure,
    auth: { user: cfg.user, pass: password.replace(/\s+/g, "") }, logger: false });
  try { await c.connect(); await c.logout(); return { ok: true }; }
  catch (e) { return { ok: false, error: (e as Error).message.slice(0, 300) }; }
}

function idsFrom(value: unknown): string[] {
  if (!value) return [];
  const s = Array.isArray(value) ? value.join(" ") : String(value);
  return s.match(/<[^>]+>/g) ?? [];
}

export interface PollResult { scanned: number; matched: number; unmatched: number; errors: string[] }

export async function pollReplies(db: Db, cfg: ImapConfig, opts: { sinceMs?: number } = {}): Promise<PollResult> {
  const password = await getSecret(db, "smtp.password");
  if (!password) return { scanned: 0, matched: 0, unmatched: 0, errors: ["no password stored"] };

  const client = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure,
    auth: { user: cfg.user, pass: password.replace(/\s+/g, "") }, logger: false });
  const result: PollResult = { scanned: 0, matched: 0, unmatched: 0, errors: [] };

  try {
    await client.connect();
    const lock = await client.getMailboxLock(cfg.mailbox ?? "INBOX");
    try {
      // Only look back as far as our oldest unanswered send.
      const since = new Date(opts.sinceMs ?? Date.now() - 30 * 24 * 3600_000);
      for await (const msg of client.fetch({ since }, { envelope: true, headers: ["in-reply-to", "references"], source: false, bodyStructure: false, uid: true })) {
        result.scanned++;
        const env = msg.envelope;
        const messageId = env?.messageId;
        if (messageId && db.prepare("SELECT 1 FROM reply WHERE message_id=?").get(messageId)) continue;

        const headerText = msg.headers?.toString() ?? "";
        const refs = [
          ...idsFrom(env?.inReplyTo),
          ...idsFrom(/in-reply-to:\s*([^\r\n]+)/i.exec(headerText)?.[1]),
          ...idsFrom(/references:\s*([\s\S]*?)\r?\n(?!\s)/i.exec(headerText)?.[1]),
        ];
        if (refs.length === 0) continue;

        let send: any;
        for (const ref of refs) {
          send = db.prepare("SELECT * FROM send_log WHERE message_id=?").get(ref);
          if (send) break;
        }
        if (!send) { result.unmatched++; continue; }

        const from = env?.from?.[0]?.address ?? "";
        tx(db, () => {
          db.prepare(
            `INSERT INTO reply (id,send_log_id,campaign_id,contact_id,from_email,subject,body_text,
               message_id,in_reply_to,received_at,handled,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,?)`,
          ).run(ulid(), send.id, send.campaign_id, send.contact_id, from,
                env?.subject ?? "", "", messageId ?? null, refs[0] ?? null,
                env?.date ? new Date(env.date).getTime() : now(), now());
          // A reply stops any further outreach to this person, immediately.
          db.prepare("UPDATE campaign_company SET status='replied', updated_at=? WHERE id=(SELECT campaign_company_id FROM email_draft WHERE id=?)")
            .run(now(), send.draft_id);
          db.prepare("UPDATE email_draft SET status='sent' WHERE id=? AND status='approved'").run(send.draft_id);
        });
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
