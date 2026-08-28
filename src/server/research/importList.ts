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

function firstUrlLike(cells: string[]): number {
  return cells.findIndex((c) => URL_LIKE.test(c.trim()));
}

export function parseCompanyList(text: string, limit = 500): ImportResult {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return { rows: [], skipped: [], format: "lines" };

  const table = parseCsv(trimmed);
  const looksTabular = table.length > 0 && table.some((r) => r.length > 1);

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
        rows.push({ website, name: name && name !== website ? name : undefined });
        if (rows.length >= limit) break;
      }
      return { rows, skipped, format: "csv" };
    }
  }

  // One per line: "domain" or "domain Some Name".
  const rows: ImportedRow[] = [], skipped: string[] = [];
  for (const raw of trimmed.split(/[\n,]+/)) {
    const line = raw.trim();
    if (!line) continue;
    const [first, ...rest] = line.split(/\s+/);
    if (!URL_LIKE.test(first)) { skipped.push(`${line.slice(0, 60)} - not a domain`); continue; }
    rows.push({ website: first, name: rest.join(" ") || undefined });
    if (rows.length >= limit) break;
  }
  return { rows, skipped, format: "lines" };
}
