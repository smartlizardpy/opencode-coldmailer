/**
 * Sender-domain health and per-message spam risk.
 *
 * Cold email fails at the mailbox provider long before it fails at the recipient, and the
 * causes are boringly mechanical: no SPF, no DMARC, a subject that reads like a promotion,
 * six links in a 90-word note. All of it is checkable locally - DNS over the resolver you
 * already have, and plain text arithmetic - so none of it costs anything or sends anything.
 */
import { Resolver } from "node:dns/promises";

export type Severity = "critical" | "warning" | "ok" | "info";

export interface Check {
  id: string;
  label: string;
  severity: Severity;
  detail: string;
  /** What to actually do about it. Absent when the check passed. */
  fix?: string;
  /** Raw record we found, shown verbatim so the user can compare with their DNS panel. */
  found?: string;
}

/** Mailbox providers whose domains you cannot publish DNS for - the checks mean something different. */
const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "yahoo.com", "yahoo.co.uk", "icloud.com", "me.com", "aol.com", "gmx.com", "gmx.de",
  "yandex.com", "yandex.ru", "mail.com", "proton.me", "protonmail.com", "zoho.com",
  "hotmail.co.uk", "windowslive.com", "libero.it", "orange.fr", "web.de",
]);

/** Selectors worth probing. Google Workspace and Microsoft 365 between them cover most senders. */
const DKIM_SELECTORS = ["google", "selector1", "selector2", "default", "dkim", "mail", "k1", "s1", "s2"];

const TIMEOUT_MS = 6000;

/**
 * Test seam. Pointing this at an unroutable address is the only way to exercise the
 * "could not look it up" branch, which is the branch that has to be right when someone
 * runs this on a train.
 */
export interface ResolverOptions { servers?: string[]; timeoutMs?: number }
let resolverOpts: ResolverOptions = {};
export function setResolverOptions(o: ResolverOptions): void { resolverOpts = o; }

function resolver(): Resolver {
  const r = new Resolver({ timeout: resolverOpts.timeoutMs ?? TIMEOUT_MS, tries: resolverOpts.servers ? 1 : 2 });
  if (resolverOpts.servers) r.setServers(resolverOpts.servers);
  return r;
}

/**
 * "No record" and "could not ask" are different answers and must not collapse into one.
 *
 * Telling someone their domain publishes no SPF when the resolver actually timed out is a
 * confident lie about their infrastructure, and it is the kind of thing that makes a person
 * stop believing the rest of the page.
 */
interface Lookup { records: string[]; failed: boolean }

/** ENOTFOUND and ENODATA are real answers: the name resolves and has no record of this type. */
const ABSENT = new Set(["ENOTFOUND", "ENODATA", "NOTFOUND", "NODATA"]);

async function txt(name: string): Promise<Lookup> {
  try {
    const records = await resolver().resolveTxt(name);
    return { records: records.map((chunks) => chunks.join("")), failed: false };
  } catch (e) {
    return { records: [], failed: !ABSENT.has((e as NodeJS.ErrnoException).code ?? "") };
  }
}

async function mx(name: string): Promise<{ hosts: { exchange: string; priority: number }[]; failed: boolean }> {
  try { return { hosts: await resolver().resolveMx(name), failed: false }; }
  catch (e) { return { hosts: [], failed: !ABSENT.has((e as NodeJS.ErrnoException).code ?? "") }; }
}

/** The check to show when we could not get an answer at all. */
const unreachable = (id: string, label: string, domain: string): Check => ({
  id, label, severity: "info",
  detail: `Could not look up ${label} for ${domain} - the DNS query failed rather than coming back empty.`,
  fix: "Re-check when you are back online. This is not a finding about your domain.",
});

/**
 * `-all` and `~all` are both fine in practice - receivers treat softfail as a strong signal and
 * every large sender uses it. `?all` and `+all` are the ones that tell receivers to accept a
 * forgery. A record with no `all` at all is only complete if it redirects somewhere that has one.
 */
async function spfPolicy(record: string): Promise<{ qualifier: string; lookups: number; via?: string }> {
  const lookups = (record.match(/\b(include|a|mx|ptr|exists|redirect)[:=]/gi) ?? []).length;
  const all = /([-~?+])all\b/.exec(record);
  if (all) return { qualifier: all[1], lookups };

  // gmail.com is `v=spf1 redirect=_spf.google.com` - the policy lives one hop away.
  const redirect = /\bredirect=([^;\s]+)/i.exec(record)?.[1];
  if (redirect) {
    const target = (await txt(redirect)).records.find((r) => /^v=spf1\b/i.test(r));
    const inner = target ? /([-~?+])all\b/.exec(target) : null;
    if (inner) return { qualifier: inner[1], lookups, via: redirect };
  }
  return { qualifier: "none", lookups };
}

function dmarcPolicy(record: string): { p: string; pct: number; rua: boolean } {
  const tag = (k: string): string | undefined =>
    new RegExp(`\\b${k}=([^;\\s]+)`, "i").exec(record)?.[1];
  return {
    p: (tag("p") ?? "none").toLowerCase(),
    pct: Number(tag("pct") ?? 100),
    rua: Boolean(tag("rua")),
  };
}

export interface DomainAudit {
  domain: string;
  freemail: boolean;
  checks: Check[];
  /** 0-100. Not a spam score - a "will my mail be accepted" score. */
  score: number;
  checkedAt: number;
}

export async function auditSenderDomain(fromEmail: string): Promise<DomainAudit> {
  const domain = (fromEmail.split("@")[1] ?? "").trim().toLowerCase();
  const checks: Check[] = [];
  if (!domain) {
    return { domain: "", freemail: false, checkedAt: Date.now(), score: 0, checks: [{
      id: "from", label: "Sender address", severity: "critical",
      detail: "No sending address is configured yet.",
      fix: "Set your from address in Settings.",
    }] };
  }

  const freemail = FREEMAIL.has(domain);

  const [mxLookup, rootTxt, dmarcTxt] = await Promise.all([mx(domain), txt(domain), txt(`_dmarc.${domain}`)]);
  const mxRecords = mxLookup.hosts;

  // ---- MX -----------------------------------------------------------------
  if (mxLookup.failed) {
    checks.push(unreachable("mx", "Mail exchanger", domain));
  } else if (mxRecords.length === 0) {
    checks.push({
      id: "mx", label: "Mail exchanger", severity: "critical",
      detail: `${domain} publishes no MX record, so replies to you have nowhere to go.`,
      fix: "Point MX at your mail provider before sending anything.",
    });
  } else {
    const best = [...mxRecords].sort((a, b) => a.priority - b.priority)[0];
    checks.push({
      id: "mx", label: "Mail exchanger", severity: "ok",
      detail: `${mxRecords.length} host${mxRecords.length === 1 ? "" : "s"}; replies will be delivered.`,
      found: `${best.priority} ${best.exchange}`,
    });
  }

  // ---- SPF ----------------------------------------------------------------
  const spfRecords = rootTxt.records.filter((r) => /^v=spf1\b/i.test(r));
  if (rootTxt.failed) {
    checks.push(unreachable("spf", "SPF", domain));
  } else if (spfRecords.length === 0) {
    checks.push({
      id: "spf", label: "SPF", severity: freemail ? "info" : "critical",
      detail: freemail
        ? `${domain} is a mailbox provider - its SPF is published by them and is already correct.`
        : `No SPF record on ${domain}. Receivers cannot tell your mail from a forgery.`,
      fix: freemail ? undefined : `Publish a TXT record on ${domain} listing whoever sends for you, ending in -all.`,
    });
  } else if (spfRecords.length > 1) {
    // Two SPF records is not "extra protection" - RFC 7208 says evaluation returns permerror.
    checks.push({
      id: "spf", label: "SPF", severity: "critical",
      detail: `${spfRecords.length} SPF records found. More than one is a permanent error, and receivers treat the domain as having none.`,
      fix: "Merge them into a single v=spf1 record.",
      found: spfRecords.join("  |  "),
    });
  } else {
    const { qualifier, lookups, via } = await spfPolicy(spfRecords[0]);
    const permissive = qualifier === "?" || qualifier === "+";
    const missing = qualifier === "none";
    const overLimit = lookups > 10;
    checks.push({
      id: "spf", label: "SPF",
      severity: overLimit || permissive ? "warning" : missing && !freemail ? "warning" : "ok",
      detail: overLimit
        ? `${lookups} DNS-lookup mechanisms; RFC 7208 caps it at 10 and everything past the limit is ignored.`
        : permissive
          ? `Ends in "${qualifier}all", which tells receivers to accept a forgery anyway.`
          : missing
            ? "No `all` mechanism, so the record never says what to do with mail from anywhere else."
            : `Single record, ends in ${qualifier}all${via ? ` via ${via}` : ""}.`,
      fix: overLimit ? "Flatten or drop includes until you are under 10."
        : permissive ? "Change the ending to -all, or ~all if you are not yet sure every sender is listed."
        : missing && !freemail ? "Add -all to the end once you are sure every sender is listed." : undefined,
      found: spfRecords[0].slice(0, 200),
    });
  }

  // ---- DMARC --------------------------------------------------------------
  const dmarcRecords = dmarcTxt.records.filter((r) => /^v=DMARC1\b/i.test(r));
  if (dmarcTxt.failed) {
    checks.push(unreachable("dmarc", "DMARC", domain));
  } else if (dmarcRecords.length === 0) {
    checks.push({
      id: "dmarc", label: "DMARC", severity: freemail ? "info" : "critical",
      detail: freemail
        ? `Published by ${domain}, not by you.`
        : `No _dmarc.${domain} record. Google and Yahoo both require one from bulk senders.`,
      fix: freemail ? undefined : `Publish _dmarc.${domain} as "v=DMARC1; p=none; rua=mailto:you@${domain}" and tighten it once reports look clean.`,
    });
  } else {
    const { p, pct, rua } = dmarcPolicy(dmarcRecords[0]);
    checks.push({
      id: "dmarc", label: "DMARC",
      severity: p === "none" ? "warning" : pct < 100 ? "warning" : "ok",
      detail: p === "none"
        ? "Policy is p=none - monitoring only, nothing is enforced."
        : pct < 100
          ? `p=${p} but only applied to ${pct}% of mail.`
          : `p=${p}, enforced${rua ? ", with aggregate reports" : ""}.`,
      fix: p === "none" ? "Move to p=quarantine once your reports show only your own senders passing." : undefined,
      found: dmarcRecords[0].slice(0, 200),
    });
  }

  // ---- DKIM ---------------------------------------------------------------
  // There is no way to enumerate selectors, so a miss here is genuinely inconclusive.
  const found = await Promise.all(
    DKIM_SELECTORS.map(async (s) => ({ s, ...(await txt(`${s}._domainkey.${domain}`)) })),
  );
  const live = found.filter((f) => f.records.some((r) => /v=DKIM1|k=rsa|p=/i.test(r)));
  const dkimUnreachable = live.length === 0 && found.every((f) => f.failed);
  if (dkimUnreachable) checks.push(unreachable("dkim", "DKIM", domain));
  else checks.push({
    id: "dkim", label: "DKIM",
    severity: live.length > 0 ? "ok" : freemail ? "info" : "warning",
    detail: live.length > 0
      ? `Signing key published on selector "${live[0].s}".`
      : freemail
        ? "Your provider signs on a selector we cannot guess. Nothing for you to do."
        : `No key on any of ${DKIM_SELECTORS.length} common selectors. Yours may use a different name - check your provider's console rather than trusting this line.`,
    fix: live.length > 0 || freemail ? undefined : "Turn on DKIM signing in your mail provider and publish the key it gives you.",
    found: live[0] ? `${live[0].s}._domainkey.${domain}` : undefined,
  });

  // ---- Freemail volume ceiling -------------------------------------------
  if (freemail) {
    checks.push({
      id: "freemail", label: "Sending from a mailbox provider", severity: "warning",
      detail: `${domain} caps app-password SMTP at roughly 500 messages a day, and flags cold volume from a personal account fast. The software is not your constraint here.`,
      fix: "Keep daily volume low, or move to a dedicated sending domain before scaling past it.",
    });
  }

  const weight: Record<Severity, number> = { critical: 34, warning: 12, info: 0, ok: 0 };
  const score = Math.max(0, 100 - checks.reduce((n, c) => n + weight[c.severity], 0));
  return { domain, freemail, checks, score, checkedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Message-level checks
// ---------------------------------------------------------------------------

/**
 * Phrases that filters weight heavily, kept to ones that a genuine one-to-one note would
 * never contain. Generic sales words are deliberately absent: flagging "free" or "offer"
 * in a message about pricing produces noise the user learns to ignore.
 */
const SPAM_PHRASES = [
  "act now", "limited time", "click here", "buy now", "order now", "risk free", "risk-free",
  "100% free", "no obligation", "money back", "money-back", "guaranteed", "cash bonus",
  "double your", "earn extra", "extra income", "make money", "work from home", "get paid",
  "winner", "congratulations you", "you have been selected", "exclusive deal", "special promotion",
  "dear friend", "dear sir/madam", "this is not spam", "unsubscribe here to stop",
  "increase sales", "increase traffic", "best price", "lowest price", "urgent response",
  "hemen tıkla", "ücretsiz kazan", "kaçırmayın", "son fırsat", "hemen satın al",
];

export interface MessageRisk {
  score: number;               // 0-100, higher is safer
  checks: Check[];
  words: number;
  links: number;
}

export function scoreMessage(subject: string, body: string): MessageRisk {
  const checks: Check[] = [];
  const text = `${subject}\n${body}`;
  const words = body.trim().split(/\s+/).filter(Boolean).length;
  const links = (body.match(/https?:\/\/\S+/gi) ?? []).length;

  const hits = SPAM_PHRASES.filter((p) => text.toLowerCase().includes(p));
  checks.push(hits.length === 0
    ? { id: "phrases", label: "Trigger phrases", severity: "ok", detail: "None of the phrases filters weight heavily." }
    : { id: "phrases", label: "Trigger phrases", severity: hits.length > 1 ? "critical" : "warning",
        detail: `${hits.length} phrase${hits.length === 1 ? "" : "s"} filters weight heavily: ${hits.map((h) => `"${h}"`).join(", ")}.`,
        fix: "Say the same thing the way you would out loud." });

  checks.push(links <= 1
    ? { id: "links", label: "Links", severity: "ok", detail: links === 0 ? "No links - the safest first touch." : "One link." }
    : { id: "links", label: "Links", severity: links > 2 ? "critical" : "warning",
        detail: `${links} links in a first cold email.`,
        fix: "Cut to at most one. A first message asking for a reply does not need a second." });

  // A subject in capitals is the single most reliable promotional tell in a header.
  const capsRun = /\b[A-Z]{4,}\b/.exec(subject);
  checks.push(!capsRun
    ? { id: "caps", label: "Subject case", severity: "ok", detail: "Ordinary sentence case." }
    : { id: "caps", label: "Subject case", severity: "warning",
        detail: `"${capsRun[0]}" is shouted.`, fix: "Lower-case it." });

  const bangs = (subject.match(/[!?]/g) ?? []).length;
  if (bangs > 0) {
    checks.push({ id: "punct", label: "Subject punctuation", severity: bangs > 1 ? "warning" : "info",
      detail: `${bangs} exclamation or question mark${bangs === 1 ? "" : "s"} in the subject.`,
      fix: "A flat subject reads as a person writing, not a campaign." });
  }

  const subjWords = subject.trim().split(/\s+/).filter(Boolean).length;
  checks.push(subjWords >= 2 && subjWords <= 7
    ? { id: "subject", label: "Subject length", severity: "ok", detail: `${subjWords} words - reads fully on a phone.` }
    : { id: "subject", label: "Subject length", severity: subjWords === 0 ? "critical" : "warning",
        detail: subjWords === 0 ? "No subject." : `${subjWords} words; anything past 7 truncates on a phone.`,
        fix: subjWords === 0 ? "Write one." : "Cut it to under 7 words." });

  checks.push(words > 0 && words <= 150
    ? { id: "length", label: "Body length", severity: "ok", detail: `${words} words.` }
    : { id: "length", label: "Body length", severity: words === 0 ? "critical" : "warning",
        detail: words === 0 ? "Empty body." : `${words} words. Past about 150 the reply rate falls off a cliff.`,
        fix: words === 0 ? undefined : "Cut to one specific observation, one ask." });

  if (/<[a-z][^>]*>/i.test(body)) {
    checks.push({ id: "html", label: "Markup", severity: "critical",
      detail: "The body contains HTML tags, but this sends as plain text - recipients will see the tags.",
      fix: "Remove the markup." });
  }

  const weight: Record<Severity, number> = { critical: 30, warning: 12, info: 3, ok: 0 };
  const score = Math.max(0, 100 - checks.reduce((n, c) => n + weight[c.severity], 0));
  return { score, checks, words, links };
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * One audit is ~13 DNS lookups. The dashboard badge needs the answer on every poll, so the
 * result is held here and refreshed on demand rather than looked up per request.
 */
let cache: { from: string; audit: DomainAudit } | undefined;

const TTL_MS = 30 * 60_000;

export function lastAudit(): DomainAudit | undefined {
  return cache && Date.now() - cache.audit.checkedAt < TTL_MS ? cache.audit : undefined;
}

export async function auditCached(fromEmail: string, force = false): Promise<DomainAudit> {
  if (!force && cache?.from === fromEmail) {
    const fresh = lastAudit();
    if (fresh) return fresh;
  }
  const audit = await auditSenderDomain(fromEmail);
  cache = { from: fromEmail, audit };
  return audit;
}

/** Fire-and-forget warm-up so the first dashboard load already knows. */
export function warmAudit(fromEmail: string): void {
  if (!fromEmail) return;
  void auditCached(fromEmail).catch(() => { /* offline is not an error worth surfacing here */ });
}

/**
 * How many things on the sending domain are actually broken. 0 when we have not looked yet.
 *
 * Criticals only. A warning here is advice - "gmail will cap you at 500 a day" is true and
 * worth reading once, but a permanent red number in the sidebar for something the user has
 * already decided about is a nag, and a badge that is always lit stops being a signal.
 */
export function auditIssueCount(): number {
  const a = lastAudit();
  return a ? a.checks.filter((c) => c.severity === "critical").length : 0;
}
