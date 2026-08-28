/**
 * HTML -> plain text, links, and candidate contact details.
 *
 * The text we extract here is what the model reads AND what we later verify its quotes
 * against, so both sides must see the same normalized string.
 */
import * as cheerio from "cheerio";
import { domainOf, normalizeUrl } from "./fetcher.ts";

/** Pages worth crawling beyond the homepage, best-first. */
const CONTACT_PATH_RE = /(contact|about|team|people|staff|leadership|our-people|meet|who-we-are|impressum|imprint|legal)/i;

/** Addresses that are never a real person and pollute the contact list. */
const JUNK_EMAIL_RE =
  /(^|@)(example|test|domain|yourdomain|email|sentry|wixpress|godaddy|squarespace|shopify|cloudflare|sentry\.io)/i;
const JUNK_LOCALPART_RE = /^(no-?reply|donotreply|postmaster|abuse|webmaster|hostmaster|privacy|dmarc|mailer-daemon|bounce|user)$/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|svg|webp|ico|css|js)$/i;

const ROLE_LOCALPARTS = new Set([
  "info", "hello", "contact", "enquiries", "enquiry", "inquiries", "sales", "admin",
  "office", "mail", "team", "hi", "ask", "support", "help", "bookings", "reception",
]);

export interface ExtractedPage {
  title: string;
  text: string;
  links: string[];
  emails: string[];
  phones: string[];
}

export function htmlToText(html: string): { title: string; text: string } {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, iframe, template").remove();
  const title = ($("title").first().text() || "").trim().slice(0, 300);
  // Block-level separators so "Jane SmithDirector" doesn't become one token.
  $("br").replaceWith("\n");
  $("p, div, li, tr, h1, h2, h3, h4, h5, h6, section, article, td").append("\n");
  const text = $("body").text().replace(/[ \t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return { title, text };
}

export function extractPage(html: string, pageUrl: string): ExtractedPage {
  const $ = cheerio.load(html);
  const { title, text } = htmlToText(html);

  const links = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || href.startsWith("#") || /^(javascript|tel|sms):/i.test(href)) return;
    if (href.toLowerCase().startsWith("mailto:")) return;
    try {
      const abs = normalizeUrl(new URL(href, pageUrl).toString());
      if (/^https?:/.test(abs) && !IMAGE_EXT_RE.test(abs)) links.add(abs);
    } catch { /* malformed href */ }
  });

  const emails = new Set<string>();
  // mailto: is the highest-signal source - a human deliberately published it.
  $('a[href^="mailto:" i]').each((_, el) => {
    const raw = ($(el).attr("href") ?? "").replace(/^mailto:/i, "").split("?")[0];
    for (const e of raw.split(",")) { const c = cleanEmail(e); if (c) emails.add(c); }
  });
  // Then anything in the visible text, including simple obfuscations.
  const deobfuscated = text
    .replace(/\s*\(at\)\s*|\s+at\s+(?=[\w.-]+\s*(\(dot\)|\.)\s*\w)/gi, "@")
    .replace(/\s*\(dot\)\s*/gi, ".");
  for (const m of deobfuscated.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []) {
    const c = cleanEmail(m); if (c) emails.add(c);
  }

  const phones = new Set<string>();
  $('a[href^="tel:" i]').each((_, el) => {
    const t = ($(el).attr("href") ?? "").replace(/^tel:/i, "").trim();
    if (t) phones.add(t);
  });

  return { title, text, links: [...links], emails: [...emails], phones: [...phones] };
}

export function cleanEmail(raw: string): string | undefined {
  const e = raw.trim().toLowerCase().replace(/^[<("']+|[>)"'.,;]+$/g, "");
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)) return undefined;
  if (JUNK_EMAIL_RE.test(e)) return undefined;
  if (IMAGE_EXT_RE.test(e)) return undefined;
  const [local] = e.split("@");
  if (JUNK_LOCALPART_RE.test(local)) return undefined;
  if (e.length > 254) return undefined;
  return e;
}

export function isRoleAccount(email: string): boolean {
  return ROLE_LOCALPARTS.has(email.split("@")[0].toLowerCase());
}

/**
 * Pick the pages worth fetching next: same registrable domain, contact-ish path, best first.
 * Bounded hard - we are a guest on someone else's server.
 */
export function pickContactPages(links: string[], baseUrl: string, limit = 6): string[] {
  const base = domainOf(baseUrl);
  const scored = new Map<string, number>();
  for (const link of links) {
    if (domainOf(link) !== base) continue;
    let path: string;
    try { path = new URL(link).pathname; } catch { continue; }
    if (path === "/" || path === "") continue;
    if (!CONTACT_PATH_RE.test(path)) continue;
    if (path.split("/").filter(Boolean).length > 3) continue;   // avoid deep blog archives
    // Prefer /contact over /about over the rest, and shorter paths over longer.
    let score = 100 - path.length;
    if (/contact/i.test(path)) score += 60;
    else if (/team|people|staff|our-people|leadership/i.test(path)) score += 45;
    else if (/about|who-we-are/i.test(path)) score += 30;
    else if (/impressum|imprint|legal/i.test(path)) score += 20;
    scored.set(normalizeUrl(link), Math.max(scored.get(normalizeUrl(link)) ?? 0, score));
  }
  return [...scored.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([u]) => u);
}

/** Normalization used on BOTH sides of quote verification. Must stay symmetrical. */
export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/­/g, "")
    .replace(/&nbsp;?/g, " ")
    .replace(/&amp;?/g, "&")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Does `quote` actually appear in `text`?
 *
 * Exact after normalization, else a token-overlap ratio to tolerate entity decoding and
 * whitespace noise. Anything below the threshold is treated as fabricated.
 */
export function quoteAppearsIn(quote: string, text: string, threshold = 0.9):
  { ok: boolean; method: "exact" | "fuzzy" | "failed"; score: number } {
  const q = normalizeForMatch(quote);
  const t = normalizeForMatch(text);
  if (!q) return { ok: false, method: "failed", score: 0 };
  if (t.includes(q)) return { ok: true, method: "exact", score: 1 };

  const qTokens = q.split(" ").filter(Boolean);
  if (qTokens.length === 0) return { ok: false, method: "failed", score: 0 };
  // Slide a window the size of the quote across the page and take the best overlap.
  const tTokens = t.split(" ").filter(Boolean);
  const qSet = new Set(qTokens);
  let best = 0;
  const win = qTokens.length;
  for (let i = 0; i + 1 <= tTokens.length; i += Math.max(1, Math.floor(win / 4))) {
    const slice = tTokens.slice(i, i + win);
    if (slice.length === 0) break;
    let hit = 0;
    for (const tok of new Set(slice)) if (qSet.has(tok)) hit++;
    best = Math.max(best, hit / qSet.size);
    if (best >= 1) break;
  }
  return best >= threshold ? { ok: true, method: "fuzzy", score: best } : { ok: false, method: "failed", score: best };
}

/**
 * Infer the address pattern a domain uses, from addresses it actually publishes.
 * Only ever used for the explicitly-opt-in `inferred` tier, and never on role accounts.
 */
export function inferEmailPattern(published: Array<{ email: string; fullName?: string }>): string | undefined {
  for (const { email, fullName } of published) {
    if (!fullName) continue;
    const [local] = email.split("@");
    const parts = fullName.toLowerCase().split(/\s+/).filter(Boolean);
    if (parts.length < 2) continue;
    const first = parts[0].replace(/[^a-z]/g, "");
    const last = parts[parts.length - 1].replace(/[^a-z]/g, "");
    if (!first || !last) continue;
    const l = local.toLowerCase();
    if (l === `${first}.${last}`) return "first.last";
    if (l === `${first}${last}`) return "firstlast";
    if (l === `${first[0]}${last}`) return "flast";
    if (l === `${first[0]}.${last}`) return "f.last";
    if (l === first) return "first";
    if (l === `${last}${first[0]}`) return "lastf";
  }
  return undefined;
}

export function applyEmailPattern(pattern: string, fullName: string, domain: string): string | undefined {
  const parts = fullName.toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return undefined;
  const first = parts[0].replace(/[^a-z]/g, "");
  const last = parts[parts.length - 1].replace(/[^a-z]/g, "");
  if (!first || !last) return undefined;
  const local = {
    "first.last": `${first}.${last}`,
    firstlast: `${first}${last}`,
    flast: `${first[0]}${last}`,
    "f.last": `${first[0]}.${last}`,
    first,
    lastf: `${last}${first[0]}`,
  }[pattern];
  return local ? `${local}@${domain}` : undefined;
}
