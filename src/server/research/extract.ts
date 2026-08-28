/**
 * HTML -> plain text, links, and candidate contact details.
 *
 * The text we extract here is what the model reads AND what we later verify its quotes
 * against, so both sides must see the same normalized string.
 */
import * as cheerio from "cheerio";
import { domainOf, normalizeUrl } from "./fetcher.ts";

/**
 * Pages worth crawling beyond the homepage, best-first.
 *
 * Multilingual on purpose. An English-only matcher silently reduces the crawl to the homepage
 * on every non-English site, which looks exactly like "this company publishes no address"
 * while the address sits on /iletisim. That failure is invisible unless you check the crawl
 * log, so the vocabulary below is part of the correctness of the whole pipeline.
 */
const CONTACT_WORDS = [
  // English
  "contact", "about", "team", "people", "staff", "leadership", "our-people", "meet",
  "who-we-are", "management", "board", "directory",
  // Turkish
  "iletisim", "iletisim-bilgileri", "bize-ulasin", "hakkimizda", "hakkinda", "kurumsal",
  "ekibimiz", "ekip", "kadro", "antrenorler", "egitmenler", "biz-kimiz", "kunye", "yonetim",
  // German / Dutch
  "impressum", "kontakt", "ueber-uns", "team-ueber-uns", "contactgegevens", "over-ons",
  // French / Spanish / Italian / Portuguese
  "contacto", "contatti", "contato", "quienes-somos", "nosotros", "chi-siamo",
  "a-propos", "qui-sommes-nous", "equipe", "equipo",
  // legal pages that must carry contact details in the EU/TR
  "imprint", "legal", "mentions-legales", "aviso-legal",
];
const CONTACT_PATH_RE = new RegExp(`(${CONTACT_WORDS.join("|")})`, "i");

/**
 * Fold a URL path to plain ASCII so "/İletişim" and "/iletisim" match the same words.
 * Percent-decoded first, because that is how these paths usually arrive.
 */
export function foldPath(path: string): string {
  let p = path;
  try { p = decodeURIComponent(p); } catch { /* keep the raw form */ }
  return p
    .toLowerCase()
    .replace(/ı/g, "i").replace(/İ/g, "i").replace(/ş/g, "s").replace(/ğ/g, "g")
    .replace(/ü/g, "u").replace(/ö/g, "o").replace(/ç/g, "c")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[_\s]+/g, "-");
}

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
  /** True when the page offers a contact form. Distinguishes "won't say" from "nothing here". */
  hasContactForm: boolean;
}

/**
 * Decode a Cloudflare-obfuscated email.
 *
 * Cloudflare's "Email Address Obfuscation" replaces addresses with a hex string in
 * `data-cfemail` (or the fragment of a /cdn-cgi/l/email-protection link) and decodes it with
 * JavaScript in the browser. The encoding is a single-byte XOR: the first byte is the key.
 *
 * This is not an edge case. Of six Turkish news sites tested, three published their address
 * this way and every one of them was reported as having no contact at all.
 */
export function decodeCfEmail(hex: string): string | undefined {
  if (!/^[0-9a-f]{6,}$/i.test(hex) || hex.length % 2 !== 0) return undefined;
  const key = parseInt(hex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < hex.length; i += 2) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  }
  return out;
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

  // Cloudflare obfuscation, in both the forms it ships in.
  $("[data-cfemail]").each((_, el) => {
    const decoded = decodeCfEmail($(el).attr("data-cfemail") ?? "");
    const c = decoded ? cleanEmail(decoded) : undefined;
    if (c) emails.add(c);
  });
  $('a[href*="/cdn-cgi/l/email-protection#"]').each((_, el) => {
    const hex = ($(el).attr("href") ?? "").split("#")[1] ?? "";
    const decoded = decodeCfEmail(hex);
    const c = decoded ? cleanEmail(decoded) : undefined;
    if (c) emails.add(c);
  });

  // JSON-LD. News sites and local businesses very often carry the address here and nowhere
  // else a human would see.
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text();
    if (!raw || raw.length > 200_000) return;
    for (const m of raw.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []) {
      const c = cleanEmail(m);
      if (c) emails.add(c);
    }
  });

  const phones = new Set<string>();
  $('a[href^="tel:" i]').each((_, el) => {
    const t = ($(el).attr("href") ?? "").replace(/^tel:/i, "").trim();
    if (t) phones.add(t);
  });

  // A form means they can be contacted, just not by us automatically - worth telling the user
  // rather than reporting the same "nothing found" as a dead site.
  const hasContactForm = $("form").toArray().some((el) => {
    const html = $.html(el).toLowerCase();
    return /type=["']?email|name=["']?(email|e-?posta|mail)/.test(html);
  });

  return { title, text, links: [...links], emails: [...emails], phones: [...phones], hasContactForm };
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

/** Free mailbox providers - a legitimate address for a small business, but not proof of domain. */
const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com",
  "yandex.com", "yandex.com.tr", "icloud.com", "protonmail.com", "proton.me", "mail.ru", "gmx.com",
]);

/**
 * Is this address plausibly the company's own?
 *
 * Pages routinely carry a CMS vendor's or web agency's support address in the footer -
 * sporankara.org publishes destek@haberyazilimi.com next to its own address. Emailing the
 * vendor instead of the company is worse than sending nothing, so an off-domain, non-freemail
 * address is demoted rather than treated as the contact.
 */
export function emailOwnership(email: string, companyDomain: string): "own-domain" | "freemail" | "third-party" {
  const host = (email.split("@")[1] ?? "").toLowerCase();
  const base = companyDomain.toLowerCase().replace(/^www\./, "");
  if (host === base || host.endsWith(`.${base}`) || base.endsWith(`.${host}`)) return "own-domain";
  if (FREEMAIL.has(host)) return "freemail";
  return "third-party";
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
    let rawPath: string;
    try { rawPath = new URL(link).pathname; } catch { continue; }
    if (rawPath === "/" || rawPath === "") continue;
    const path = foldPath(rawPath);
    if (!CONTACT_PATH_RE.test(path)) continue;
    if (path.split("/").filter(Boolean).length > 3) continue;   // avoid deep blog archives

    let score = 100 - path.length;
    // Keep these bands in step with CONTACT_WORDS: a word that is crawled but scores in the
    // wrong band gets ranked below weaker pages and falls off the end of the limit.
    if (/(contact|iletisim|bize-ulasin|kontakt|contacto|contatti|contato)/.test(path)) score += 60;
    else if (/(team|eki[pb]|kadro|people|staff|antrenor|egitmen|our-people|equipe|equipo|leadership|management|board)/.test(path)) score += 45;
    else if (/(about|hakkimizda|hakkinda|kurumsal|who-we-are|biz-kimiz|ueber-uns|over-ons|nosotros|chi-siamo|a-propos|qui-sommes-nous)/.test(path)) score += 30;
    else score += 20;                                            // imprint / legal / kunye
    const norm = normalizeUrl(link);
    scored.set(norm, Math.max(scored.get(norm) ?? 0, score));
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
