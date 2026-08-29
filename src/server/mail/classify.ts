/**
 * Telling a human reply apart from a bounce or an out-of-office.
 *
 * All three arrive in the same mailbox, match the same thread, and until this existed all
 * three were recorded as "they replied". That is wrong three ways: the company is marked as
 * having answered, the follow-up sequence stops, and the reply drafter is pointed at
 * MAILER-DAEMON. Worst of all, an address that hard-bounced was never suppressed, so it kept
 * being mailed from other campaigns - and repeatedly mailing dead addresses is one of the
 * fastest ways to lose a sending reputation.
 *
 * Pure functions over headers and text, so every case below is a test rather than something
 * you find out about in production.
 */

export type InboundKind = "reply" | "bounce_hard" | "bounce_soft" | "auto_reply";

export interface Classification {
  kind: InboundKind;
  /** The address that bounced, when the report names one. */
  recipient?: string;
  /** RFC 3463 status, e.g. "5.1.1". */
  status?: string;
  /** Short human-readable cause, taken from the report rather than invented. */
  reason?: string;
}

/** Envelope senders that are never a person. */
const DAEMONS = [
  "mailer-daemon", "postmaster", "no-reply", "noreply", "bounce", "bounces",
  "mail-daemon", "returns", "return-path",
];

function header(headers: string, name: string): string | undefined {
  // Unfolds continuation lines, which is where Diagnostic-Code almost always wraps.
  // End of input is a terminator too. It only worked before because of the appended newline
  // below, which is the kind of thing that stays true right up until someone removes it.
  const re = new RegExp(`^${name}:[ \\t]*([\\s\\S]*?)(?:\\r?\\n(?![ \\t])|(?![\\s\\S]))`, "im");
  const m = re.exec(headers.endsWith("\n") ? headers : `${headers}\n`);
  return m ? m[1].replace(/\r?\n[ \t]+/g, " ").trim() : undefined;
}

function localPart(address: string): string {
  return (address.split("@")[0] ?? "").toLowerCase();
}

/**
 * Out-of-office and other machine replies.
 *
 * RFC 3834's `Auto-Submitted` is the reliable signal; the rest are what real mail systems
 * actually send. Deliberately does not guess from the subject alone in any language - a
 * genuine reply whose subject happens to contain "away" must not be silently discarded.
 */
export function isAutoReply(headers: string): boolean {
  const auto = header(headers, "auto-submitted");
  if (auto && !/^no\b/i.test(auto)) return true;
  if (header(headers, "x-autoreply") || header(headers, "x-autorespond")) return true;
  if (/^(auto_reply|auto-reply|bulk|list)$/i.test(header(headers, "precedence") ?? "")) return true;
  // Microsoft and Google both set this on vacation responses.
  if (/vacation|out of office/i.test(header(headers, "x-auto-response-suppress") ?? "")) return true;
  return false;
}

/** RFC 3463: 5.x.x is permanent, 4.x.x is transient. */
export function isPermanent(status: string | undefined): boolean {
  return !!status && status.startsWith("5.");
}

/**
 * Statuses that mean "this mailbox does not exist" rather than "this message was refused".
 * Only these justify suppressing an address permanently: a 5.7.1 policy rejection can be
 * about the content or a temporary block, and suppressing on it would quietly discard a
 * lead over something that is not the recipient's fault.
 */
const DEAD_MAILBOX = new Set(["5.1.1", "5.1.2", "5.1.3", "5.1.6", "5.1.10", "5.4.4"]);

export function isDeadMailbox(status: string | undefined): boolean {
  return !!status && DEAD_MAILBOX.has(status);
}

export interface ClassifyInput {
  /** Raw header block of the inbound message. */
  headers: string;
  /** Envelope from-address, lower-cased by the caller or not - either is fine. */
  from: string;
  subject: string;
  /** Message body, when available. Bounce details live here, not in the headers. */
  body?: string;
}

export function classifyInbound(input: ClassifyInput): Classification {
  const { headers, from, subject, body = "" } = input;
  const contentType = header(headers, "content-type") ?? "";

  // A delivery-status report is unambiguous and does not need heuristics.
  const isReport = /report-type\s*=\s*"?delivery-status"?/i.test(contentType)
    || /^multipart\/report/i.test(contentType);
  const fromDaemon = DAEMONS.includes(localPart(from));
  // A null return-path is what a bounce is required to carry, so it cannot itself bounce.
  const nullReturnPath = /^<>$/.test(header(headers, "return-path") ?? "");

  if (isReport || (fromDaemon && nullReturnPath) || (fromDaemon && looksLikeBounceText(subject, body))) {
    const details = bounceDetails(body);
    // A report with no parseable status is still a bounce; treating it as soft means it is
    // surfaced and counted without a dead address being suppressed on a guess.
    const hard = isPermanent(details.status);
    return { kind: hard ? "bounce_hard" : "bounce_soft", ...details };
  }

  if (isAutoReply(headers)) return { kind: "auto_reply" };

  return { kind: "reply" };
}

/** Last-resort recognition for daemons that send a plain-text report with no report-type. */
function looksLikeBounceText(subject: string, body: string): boolean {
  const s = `${subject}\n${body.slice(0, 2000)}`;
  return /undelivered mail|delivery status notification|mail delivery failed|returned to sender|delivery has failed|could not be delivered|address not found/i.test(s);
}

/** Pulls Final-Recipient, Status and Diagnostic-Code out of the message/delivery-status part. */
export function bounceDetails(body: string): { recipient?: string; status?: string; reason?: string } {
  const recipient = /^(?:final|original)-recipient:\s*(?:rfc822;)?\s*(\S+)/im.exec(body)?.[1]
    ?? /<([^<>@\s]+@[^<>\s]+)>/.exec(body)?.[1];

  const status = /^status:\s*([245]\.\d{1,3}\.\d{1,3})/im.exec(body)?.[1]
    // Some reports omit Status and only carry the SMTP reply.
    ?? /\b([245]\.\d{1,3}\.\d{1,3})\b/.exec(body)?.[1];

  // `$` is deliberately not used as the terminator: under /m it anchors to the end of a
  // LINE, which cut every folded Diagnostic-Code off after its first line. `(?![\s\S])` is
  // the end of the input and nothing else.
  const diagnostic = /^diagnostic-code:[ \t]*(?:smtp;)?[ \t]*([\s\S]*?)(?:\r?\n(?![ \t])|(?![\s\S]))/im.exec(body)?.[1];
  const reason = diagnostic?.replace(/\s+/g, " ").trim().slice(0, 200);

  return {
    recipient: recipient?.replace(/^[<]|[>]$/g, "").toLowerCase(),
    status,
    reason: reason || undefined,
  };
}
