/**
 * Turn whatever the user pasted into a list of companies.
 *
 * People paste three things: a bare list of domains, a list with names beside them, and a CSV
 * exported from a spreadsheet or another tool. Asking which one it is would be a worse product
 * than working it out, so this detects the shape rather than requiring a format.
 */

export interface ImportedRow { website: string; name?: string }
export interface ImportResult { rows: ImportedRow[]; skipped: string[]; format: "csv" | "lines" }

/** RFC-4180-ish: handles quoted fields, escaped quotes, and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    if (c === "\r") continue;
    field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

const URL_LIKE = /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i;
const DOMAIN_HEADERS = ["website", "domain", "url", "site", "web", "link", "website_url", "homepage"];
const NAME_HEADERS = ["name", "company", "company name", "business", "title", "organisation", "organization"];

/** The comparable part of a URL or domain: no scheme, no www, no path, lower-case. */
function bareDomain(value: string): string {
  return stripPunctuation(value).toLowerCase()
    .replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
}

/** Trailing commas, semicolons and wrapping brackets are punctuation, not part of a domain. */
function stripPunctuation(token: string): string {
  return token.replace(/^[<([{"']+/, "").replace(/[>)\]}"'.,;:]+$/, "");
}

function firstUrlLike(cells: string[]): number {
  return cells.findIndex((c) => URL_LIKE.test(c.trim()));
}

export function parseCompanyList(text: string, limit = 500): ImportResult {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return { rows: [], skipped: [], format: "lines" };

  const table = parseCsv(trimmed);
  const looksTabular = table.length > 0 && table.some((r) => r.length > 1);

  // "a.com, b.com" parses as one row of two fields, so the table branch below would call the
  // second domain the first one's NAME and quietly import half the list under a wrong name.
  // When every cell is a DIFFERENT domain there are no names here, only companies - the
  // distinctness matters, because "Sporankara.org,sporankara.org" is one company whose name
  // happens to look like its address, not two companies.
  const cells = table.flat().map((c) => stripPunctuation(c.trim())).filter(Boolean);
  const distinct = new Set(cells.map((c) => bareDomain(c)));
  if (cells.length > 1 && distinct.size === cells.length && cells.every((c) => URL_LIKE.test(c))) {
    const rows = cells.slice(0, limit).map((website) => ({ website }));
    return { rows, skipped: [], format: cells.length === table.length ? "lines" : "csv" };
  }

  if (looksTabular) {
    const header = table[0].map((h) => h.trim().toLowerCase());
    const headerIsLabels = header.some((h) => DOMAIN_HEADERS.includes(h) || NAME_HEADERS.includes(h));
    let domainIdx = headerIsLabels ? header.findIndex((h) => DOMAIN_HEADERS.includes(h)) : -1;
    let nameIdx = headerIsLabels ? header.findIndex((h) => NAME_HEADERS.includes(h)) : -1;

    const body = headerIsLabels ? table.slice(1) : table;
    // No usable header: find the column that actually holds URLs.
    if (domainIdx < 0) {
      const sample = body.find((r) => firstUrlLike(r) >= 0);
      domainIdx = sample ? firstUrlLike(sample) : -1;
      if (nameIdx < 0 && domainIdx >= 0) nameIdx = domainIdx === 0 ? 1 : 0;
    }
    if (domainIdx >= 0) {
      const rows: ImportedRow[] = [], skipped: string[] = [];
      for (const r of body) {
        const website = (r[domainIdx] ?? "").trim();
        if (!website) continue;
        if (!URL_LIKE.test(website)) { skipped.push(`${website} - not a domain`); continue; }
        const name = nameIdx >= 0 ? (r[nameIdx] ?? "").trim() : "";
        // A cell holding a DIFFERENT domain is another company, not this one's name. One
        // holding the same domain is the company's name: plenty of outlets are called
        // "Sporankara.org", and dropping that leaves the row with no name at all.
        const isOtherDomain = !!name && URL_LIKE.test(stripPunctuation(name))
          && bareDomain(name) !== bareDomain(website);
        const usable = name && name !== website && !isOtherDomain;
        rows.push({ website, name: usable ? name : undefined });
        if (rows.length >= limit) break;
      }
      return { rows, skipped, format: "csv" };
    }
  }

  // One per line. The domain can be anywhere on the line, because people paste all of these:
  //
  //   ankaramasasi.com.tr
  //   ankaramasasi.com.tr Ankara Masasi
  //   Ankara Masasi ankaramasasi.com.tr
  //   Ankara Masasi - ankaramasasi.com.tr
  //   - ankaramasasi.com.tr
  //   1. ankaramasasi.com.tr
  //
  // Requiring the first token to be the domain rejected four of those six outright, and this
  // is the path people are on precisely when discovery has not worked for them.
  const rows: ImportedRow[] = [], skipped: string[] = [];
  for (const raw of trimmed.split(/[\n,]+/)) {
    // Leading list markers: "-", "*", "•", "1.", "1)".
    const line = raw.trim().replace(/^\s*(?:[-*\u2022\u00b7]|\d+[.)])\s+/, "").trim();
    if (!line) continue;

    const tokens = line.split(/\s+/);
    const at = tokens.findIndex((t) => URL_LIKE.test(stripPunctuation(t)));
    if (at < 0) { skipped.push(`${line.slice(0, 60)} - not a domain`); continue; }

    const website = stripPunctuation(tokens[at]);
    // Everything that is not the domain is the name, minus the separator people put between
    // them. A dash on its own is punctuation, not part of anyone's company name.
    const name = tokens.filter((_, i) => i !== at).join(" ")
      .replace(/^\s*[-\u2013\u2014:|]\s*/, "").replace(/\s*[-\u2013\u2014:|]\s*$/, "")
      // "Ankara Masasi (ankaramasasi.com.tr)" leaves the brackets behind once the domain goes.
      .replace(/^[([{"']+/, "").replace(/[)\]}"']+$/, "").trim();
    rows.push({ website, name: name && name !== website ? name : undefined });
    if (rows.length >= limit) break;
  }
  return { rows, skipped, format: "lines" };
}
