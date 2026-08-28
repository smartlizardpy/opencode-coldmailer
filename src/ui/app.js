/* coldcall — app shell. Plain ES modules, no build step, no framework.
   Every screen is a render function returning a DOM string; state lives in `S`. */

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icon = (n, cls = "") => `<svg class="${cls}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const num = (n) => new Intl.NumberFormat().format(n ?? 0);
const pct = (n) => n == null ? "—" : `${Math.round(n * 100)}%`;
const isMac = navigator.platform.toUpperCase().includes("MAC");

function ago(ts) {
  if (!ts) return "";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(ts);
}
function when(ts) {
  if (!ts) return "—";
  const d = Math.round((ts - Date.now()) / 86400000);
  if (d < 0) return "due now";
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  return `in ${d} days`;
}
const dt = (ts) => ts ? new Intl.DateTimeFormat(undefined,
  { dateStyle: "medium", timeStyle: "short" }).format(ts) : "—";

/* ───────────────────────────────────────────────────────── state + api */

const S = {
  route: "dashboard", campaign: null, health: null, stats: null,
  campaigns: [], companies: [], drafts: [], replies: [], product: null,
  reviewIndex: 0, filter: "", companyFilter: "all", draftFilter: "needs_review",
  selection: new Set(), loading: false,
};

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { error: text || `HTTP ${res.status}` }; }
  if (!res.ok) throw Object.assign(new Error(json.error || `HTTP ${res.status}`), json);
  return json;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast${bad ? " bad" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), bad ? 7000 : 3200);
}
const fail = (e) => { console.error(e); toast(e?.message || String(e), true); };

/* ───────────────────────────────────────────────────────── navigation */

const NAV = [
  { group: "Overview", items: [
    { id: "dashboard", label: "Dashboard", icon: "view-grid" },
  ]},
  { group: "Pipeline", items: [
    { id: "campaigns", label: "Campaigns", icon: "binocular" },
    { id: "review", label: "Review", icon: "page-edit", badge: "needsReview", tone: "attn" },
    { id: "outbox", label: "Outbox", icon: "send", badge: "approvedWaiting" },
    { id: "replies", label: "Replies", icon: "message-text", badge: "repliesUnhandled", tone: "attn" },
  ]},
  { group: "Setup", items: [
    { id: "product", label: "Product", icon: "building" },
    { id: "settings", label: "Settings", icon: "settings" },
  ]},
  { group: "System", items: [
    { id: "activity", label: "Activity", icon: "graph-up" },
  ]},
];

const TITLES = {
  dashboard: ["Dashboard", "What needs your attention, and whether anything is broken."],
  campaigns: ["Campaigns", "Find companies, research them, and write the emails."],
  review:    ["Review", "Every personalised claim shows the page it came from. Nothing sends without you."],
  outbox:    ["Outbox", "Approved emails, the daily cap, and scheduled follow-ups."],
  replies:   ["Replies", "Matched to the thread they answer. Draft a response or write your own."],
  product:   ["Product", "What you sell, in your own words. Everything downstream reads this."],
  settings:  ["Settings", "Mailbox, models, sending limits and the never-contact list."],
  activity:  ["Activity", "Every model call, including the ones that failed and what they returned."],
};

function renderNav() {
  const st = S.stats ?? {};
  $("#nav").innerHTML = NAV.map((g) => `
    <div>
      <div class="nav-group-title">${esc(g.group)}</div>
      ${g.items.map((it) => {
        const n = it.badge ? (st[it.badge] ?? 0) : 0;
        return `<button class="nav-item" data-route="${it.id}" type="button"
          ${S.route === it.id ? 'aria-current="page"' : ""} title="${esc(it.label)}">
          ${icon(it.icon)}<span class="nav-label">${esc(it.label)}</span>
          ${n > 0 ? `<span class="nav-badge" ${it.tone ? `data-tone="${it.tone}"` : ""}>${num(n)}</span>` : ""}
        </button>`;
      }).join("")}
    </div>`).join("");
  $$("#nav .nav-item").forEach((b) => b.onclick = () => go(b.dataset.route));
}

function go(route, opts = {}) {
  if (!TITLES[route]) route = "dashboard";
  S.route = route;
  S.selection.clear();
  if (opts.campaign) S.campaign = opts.campaign;
  history.replaceState(null, "", `#${route}${S.campaign ? `/${S.campaign}` : ""}`);
  renderNav();
  renderCrumb();
  render();
}

function renderCrumb() {
  const camp = S.campaigns.find((c) => c.id === S.campaign);
  const [title] = TITLES[S.route] ?? ["coldcall"];
  const parts = [`<b>${esc(title)}</b>`];
  if (camp && ["campaigns", "review", "outbox"].includes(S.route)) {
    parts.push(`${icon("nav-arrow-right")}<span>${esc(camp.name)}</span>`);
  }
  $("#crumb").innerHTML = parts.join("");
}

/* ───────────────────────────────────────────────────────── theme */

function applyTheme(mode) {
  if (mode === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", mode);
  try { localStorage.setItem("cc-theme", mode); } catch { /* private mode */ }
  const cur = mode === "system"
    ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : mode;
  $("#themeBtn").innerHTML = `<svg aria-hidden="true"><use href="#i-${cur === "dark" ? "sun-light" : "half-moon"}"/></svg>`;
  $("#themeBtn").title = `Theme: ${mode}`;
}
function cycleTheme() {
  let cur = "system";
  try { cur = localStorage.getItem("cc-theme") || "system"; } catch { /* ignore */ }
  applyTheme({ system: "light", light: "dark", dark: "system" }[cur]);
  toast(`Theme: ${{ system: "light", light: "dark", dark: "system" }[cur]}`);
}

/* ───────────────────────────────────────────────────────── command palette */

function paletteCommands() {
  const cmds = [
    ...Object.entries(TITLES).map(([id, [label]]) => ({
      label: `Go to ${label}`, icon: "arrow-right", hint: "Navigate", run: () => go(id),
    })),
    { label: "New campaign", icon: "plus", hint: "Campaign", run: () => { go("campaigns"); setTimeout(() => $("#btnNewCampaign")?.click(), 60); } },
    { label: "Check for replies now", icon: "refresh", hint: "Replies", run: async () => { await api("/api/replies/poll", {}); toast("Checking…"); } },
    { label: "Re-probe models", icon: "refresh", hint: "Settings", run: async () => { await api("/api/models/probe", {}); toast("Probing…"); } },
    { label: "Toggle theme", icon: "half-moon", hint: "View", run: cycleTheme },
    { label: "Collapse sidebar", icon: "menu", hint: "View", run: toggleCollapse },
  ];
  for (const c of S.campaigns) {
    cmds.push({ label: `Open campaign: ${c.name}`, icon: "binocular", hint: `${c.companies} companies`,
      run: () => { S.campaign = c.id; go("campaigns"); } });
  }
  for (const co of S.companies.slice(0, 40)) {
    cmds.push({ label: co.name, icon: "building", hint: co.domain,
      run: () => { go("campaigns"); setTimeout(() => showCompany(co.id), 80); } });
  }
  return cmds;
}

let paletteState = null;
function openPalette() {
  const cmds = paletteCommands();
  paletteState = { cmds, filtered: cmds, index: 0 };
  $("#modal").innerHTML = `
    <div class="scrim" id="scrim">
      <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input id="palInput" placeholder="Search commands, campaigns, companies…" aria-label="Search commands"
               autocomplete="off" spellcheck="false" aria-controls="palList">
        <div class="palette-list" id="palList" role="listbox"></div>
      </div>
    </div>`;
  drawPalette();
  const inp = $("#palInput");
  inp.focus();
  inp.oninput = () => {
    const q = inp.value.toLowerCase().trim();
    paletteState.filtered = q
      ? paletteState.cmds.filter((c) => c.label.toLowerCase().includes(q) || (c.hint ?? "").toLowerCase().includes(q))
      : paletteState.cmds;
    paletteState.index = 0;
    drawPalette();
  };
  inp.onkeydown = (e) => {
    const n = paletteState.filtered.length;
    if (e.key === "Escape") { closePalette(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); paletteState.index = (paletteState.index + 1) % n; drawPalette(); }
    if (e.key === "ArrowUp") { e.preventDefault(); paletteState.index = (paletteState.index - 1 + n) % n; drawPalette(); }
    if (e.key === "Enter") { e.preventDefault(); runPalette(paletteState.index); }
  };
  $("#scrim").onclick = (e) => { if (e.target.id === "scrim") closePalette(); };
}
function drawPalette() {
  const { filtered, index } = paletteState;
  $("#palList").innerHTML = filtered.length
    ? filtered.map((c, i) => `<div class="palette-item" role="option" data-i="${i}"
        ${i === index ? 'aria-selected="true"' : ""}>${icon(c.icon)}<span>${esc(c.label)}</span>
        ${c.hint ? `<span class="pi-sub">${esc(c.hint)}</span>` : ""}</div>`).join("")
    : `<div class="palette-empty">Nothing matches.</div>`;
  $$("#palList .palette-item").forEach((el) => {
    el.onmouseenter = () => { paletteState.index = +el.dataset.i; drawPalette(); };
    el.onclick = () => runPalette(+el.dataset.i);
  });
  $(`#palList [aria-selected="true"]`)?.scrollIntoView({ block: "nearest" });
}
async function runPalette(i) {
  const cmd = paletteState?.filtered[i];
  closePalette();
  if (cmd) { try { await cmd.run(); } catch (e) { fail(e); } }
}
function closePalette() { $("#modal").innerHTML = ""; paletteState = null; }

function toggleCollapse() {
  const app = $("#app");
  const next = app.dataset.collapsed === "1" ? "0" : "1";
  app.dataset.collapsed = next;
  try { localStorage.setItem("cc-collapsed", next); } catch { /* ignore */ }
}

/* ───────────────────────────────────────────────────────── keyboard */

document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); return; }
  if (e.key === "Escape" && paletteState) { closePalette(); return; }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

  // Review-screen shortcuts. Deliberately single-key: reviewing forty emails with a mouse is
  // the difference between using this tool and abandoning it.
  if (S.route === "review" && S.drafts.length) {
    const d = S.drafts[S.reviewIndex];
    if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); selectDraft(S.reviewIndex + 1); }
    if (e.key === "k" || e.key === "ArrowUp")   { e.preventDefault(); selectDraft(S.reviewIndex - 1); }
    if (e.key === "a" && d) { e.preventDefault(); approveDraft(d.draft_id); }
    if (e.key === "s" && d) { e.preventDefault(); skipDraft(d.draft_id); }
    if (e.key === "e" && d) { e.preventDefault(); $("#btnEdit")?.click(); }
    if (e.key === "r" && d) { e.preventDefault(); $("#btnRewrite")?.click(); }
  }
  if (e.key === "?") { e.preventDefault(); showShortcuts(); }
});

function showShortcuts() {
  const rows = [
    ["⌘K / Ctrl+K", "Command palette"], ["?", "This list"],
    ["j / k", "Next / previous draft in Review"], ["a", "Approve draft"],
    ["e", "Edit draft"], ["r", "Rewrite draft"], ["s", "Skip draft"],
  ];
  $("#modal").innerHTML = `<div class="scrim" id="scrim"><div class="palette" role="dialog" aria-modal="true">
    <div style="padding:var(--s5)"><h2 style="margin-bottom:var(--s4)">Keyboard shortcuts</h2>
    <table><tbody>${rows.map(([k, v]) =>
      `<tr><td class="mono" style="width:130px">${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}
    </tbody></table></div></div></div>`;
  $("#scrim").onclick = (e) => { if (e.target.id === "scrim") $("#modal").innerHTML = ""; };
}

/* ───────────────────────────────────────────────────────── page frame */

function page(body, actions = "") {
  const [title, sub] = TITLES[S.route];
  return `<div class="page">
    <div class="page-head">
      <div><h1 class="page-title">${esc(title)}</h1><p class="page-sub">${esc(sub)}</p></div>
      ${actions ? `<div class="page-actions">${actions}</div>` : ""}
    </div>
    ${body}
  </div>`;
}
const empty = (ic, title, text, action = "") =>
  `<div class="empty"><div class="empty-icon">${icon(ic)}</div>
   <h3>${esc(title)}</h3><p>${esc(text)}</p>${action}</div>`;
const skeleton = (rows = 4) =>
  `<div class="card">${Array.from({ length: rows }, (_, i) =>
    `<div class="skel skel-row" style="width:${[92, 76, 84, 60, 70][i % 5]}%"></div>`).join("")}</div>`;

async function render() {
  const c = $("#content");
  c.scrollTop = 0;
  const fn = {
    dashboard: renderDashboard, campaigns: renderCampaigns, review: renderReview,
    outbox: renderOutbox, replies: renderReplies, product: renderProduct,
    settings: renderSettings, activity: renderActivity,
  }[S.route];
  c.innerHTML = page(skeleton());
  try { await fn(); } catch (e) { fail(e); c.innerHTML = page(empty("warning-triangle", "Couldn't load this", e.message)); }
}

/* ───────────────────────────────────────────────────────── dashboard */

// The unit changes halfway down: companies become emails once drafting starts, and with
// follow-ups one company can account for several. Labelling it is the honest option.
const FUNNEL_STAGES = [
  ["discovered", "Companies found", ""], ["researched", "Researched", ""],
  ["contacted", "With a contact", ""], ["drafted", "Emails drafted", ""],
  ["approved", "Approved", "accent"], ["sent", "Sent", "ok"], ["replied", "Replies", "ok"],
];

async function renderDashboard() {
  const [stats, health] = await Promise.all([api("/api/stats"), api("/api/health")]);
  S.stats = stats; S.health = health;
  renderNav();

  const f = stats.funnel;
  const max = Math.max(1, ...FUNNEL_STAGES.map(([k]) => f[k]));
  const setupDone = {
    product: !!S.product || stats.funnel.discovered > 0,
    mailbox: health.smtp.configured,
    model: health.model.writing.status === "ok",
    campaign: stats.campaigns > 0,
  };
  const setupLeft = Object.values(setupDone).filter((v) => !v).length;

  const maxDay = Math.max(1, ...stats.sendsByDay.map((d) => d.sent + d.replies));

  $("#content").innerHTML = page(`
    ${setupLeft > 0 ? `
    <div class="card" style="border-color:var(--primary)">
      <div class="card-head"><h2>Finish setting up</h2>
        <span class="tag accent">${setupLeft} left</span></div>
      <div class="checklist">
        ${[["Describe your product", "product", "product", "Tell it what you sell, in your own words"],
           ["Connect your mailbox", "settings", "mailbox", "SMTP + an app password"],
           ["Pick a model", "settings", "model", "Free models work for research"],
           ["Create a campaign", "campaigns", "campaign", "Who to contact, and what to ask"]]
          .map(([label, route, key, hint]) => `
          <div class="cl-item" data-done="${setupDone[key] ? 1 : 0}">
            <span class="cl-mark">${icon("check")}</span>
            <span><span class="cl-text">${esc(label)}</span>
              <span class="cellsub">${esc(hint)}</span></span>
            ${setupDone[key] ? "" : `<button class="btn sm ghost cl-go" data-go="${route}">Open</button>`}
          </div>`).join("")}
      </div>
    </div>` : ""}

    <div class="statgrid stagger">
      <div class="stat ${stats.needsReview ? "attn" : ""}">
        <div class="stat-label">${icon("page-edit")} Awaiting review</div>
        <div class="stat-value">${num(stats.needsReview)}</div>
        <div class="stat-foot">${stats.flaggedDrafts ? `${num(stats.flaggedDrafts)} flagged for quality` : "nothing flagged"}</div>
      </div>
      <div class="stat">
        <div class="stat-label">${icon("send")} Sent today</div>
        <div class="stat-value">${num(stats.sentLast24h)}<small> / ${num(health.sending.dailyLimit)}</small></div>
        <div class="stat-foot">${health.sending.paused ? "sending is paused" : `${num(health.sending.remaining)} left today`}</div>
      </div>
      <div class="stat ${stats.repliesUnhandled ? "attn" : ""}">
        <div class="stat-label">${icon("message-text")} Replies</div>
        <div class="stat-value">${num(stats.funnel.replied)}</div>
        <div class="stat-foot">${stats.repliesUnhandled ? `${num(stats.repliesUnhandled)} unhandled` : "all handled"}</div>
      </div>
      <div class="stat">
        <div class="stat-label">${icon("graph-up")} Reply rate</div>
        <div class="stat-value">${pct(stats.replyRate)}</div>
        <div class="stat-foot">${stats.funnel.sent ? `${num(stats.funnel.replied)} of ${num(stats.funnel.sent)} sent` : "nothing sent yet"}</div>
      </div>
      <div class="stat">
        <div class="stat-label">${icon("shield-check")} Verified facts</div>
        <div class="stat-value">${num(stats.claimsVerified)}</div>
        <div class="stat-foot">${stats.claimsRejected ? `${num(stats.claimsRejected)} rejected as unverifiable` : "none rejected"}</div>
      </div>
      <div class="stat">
        <div class="stat-label">${icon("timer")} Follow-ups due</div>
        <div class="stat-value">${num(stats.followUpsDue)}</div>
        <div class="stat-foot">${stats.followUpsDue ? "ready to draft" : "none due"}</div>
      </div>
    </div>

    <div class="grid2" style="align-items:start">
      <div class="card">
        <div class="card-head"><h2>Pipeline <span class="tag">companies, then emails</span></h2>
          <span class="card-actions"><button class="btn sm ghost" data-go="campaigns">Open campaign</button></span></div>
        <div class="funnel">
          ${FUNNEL_STAGES.map(([k, label, tone], i) => {
            // Only compare within a unit - "3 dropped" between companies and emails is meaningless.
            const sameUnit = i !== 3;
            const prev = i > 0 && sameUnit ? f[FUNNEL_STAGES[i - 1][0]] : null;
            const drop = prev != null && prev > 0 && f[k] < prev ? prev - f[k] : 0;
            return `<div class="fstage">
              <span class="fstage-name">${esc(label)}</span>
              <span class="ftrack"><span class="fbar" ${tone ? `data-tone="${tone}"` : ""}
                style="width:${Math.max(f[k] / max * 100, f[k] ? 2 : 0)}%"></span></span>
              <span class="fstage-n">${num(f[k])}</span>
            </div>${drop ? `<div class="fdrop">${num(drop)} dropped here</div>` : ""}`;
          }).join("")}
        </div>
        ${stats.topFailures.length ? `<div class="card-note"><b>Why companies dropped out</b>${
          stats.topFailures.map((x) => `<div>${num(x.count)}× ${esc(x.reason)}</div>`).join("")}</div>` : ""}
      </div>

      <div class="card">
        <div class="card-head"><h2>Last 14 days</h2></div>
        <div class="chart">
          ${stats.sendsByDay.map((d) => `<div class="chart-col" title="${esc(d.day)}: ${d.sent} sent, ${d.replies} replies">
            ${d.replies ? `<span class="chart-bar rep" style="height:${d.replies / maxDay * 52}px"></span>` : ""}
            <span class="chart-bar" style="height:${Math.max(d.sent / maxDay * 52, d.sent ? 2 : 1)}px;${d.sent ? "" : "opacity:.25"}"></span>
          </div>`).join("")}
        </div>
        <div class="chart-axis"><span>${esc(stats.sendsByDay[0]?.day ?? "")}</span><span>today</span></div>
        <div class="card-note">
          <span class="tag" style="background:var(--primary);color:var(--on-primary)">sent</span>
          <span class="tag accent">replies</span>
          &nbsp;No open or click tracking — this product puts no pixels in email, so replies are the only honest signal.
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Recent activity</h2>
        <span class="card-actions"><button class="btn sm ghost" data-go="activity">All model calls</button></span></div>
      ${stats.recentActivity.length ? `<div class="feed">${stats.recentActivity.map((a) => `
        <div class="feed-item">
          <span class="feed-icon">${icon(a.kind === "sent" ? "send" : a.kind === "reply" ? "message-text" : "warning-triangle")}</span>
          <span>${esc(a.text)}</span>
          <span class="feed-time">${esc(ago(a.at))}</span>
        </div>`).join("")}</div>`
        : `<p class="card-note">Nothing has happened yet.</p>`}
    </div>
  `);
  $$("[data-go]").forEach((b) => b.onclick = () => go(b.dataset.go));
}

/* ───────────────────────────────────────────────────────── campaigns */

async function renderCampaigns() {
  S.campaigns = await api("/api/campaigns");
  if (!S.campaign && S.campaigns.length) S.campaign = S.campaigns[0].id;
  renderCrumb();

  if (!S.campaigns.length) {
    $("#content").innerHTML = page(empty("binocular", "No campaigns yet",
      "A campaign is one audience and one ask. Describe who you want to reach and what you want from them.",
      `<button class="btn" id="btnNewCampaign">${icon("plus")} New campaign</button>`));
    $("#btnNewCampaign").onclick = newCampaignDialog;
    return;
  }

  const camp = S.campaigns.find((c) => c.id === S.campaign) ?? S.campaigns[0];
  S.companies = await api(`/api/campaigns/${camp.id}/companies`);
  const rows = S.companies.filter((r) => {
    if (S.companyFilter === "selected") return r.selected;
    if (S.companyFilter === "rejected") return r.status === "rejected";
    if (S.companyFilter === "failed") return r.status === "failed";
    if (S.companyFilter === "ready") return ["contacts_found", "drafted"].includes(r.status);
    return r.status !== "rejected";
  }).filter((r) => !S.filter || `${r.name} ${r.domain} ${r.city ?? ""}`.toLowerCase().includes(S.filter.toLowerCase()));

  const ticked = S.companies.filter((r) => r.selected).length;

  $("#content").innerHTML = page(`
    <div class="card">
      <div class="row">
        <select id="campSelect" aria-label="Select campaign" style="max-width:340px">
          ${S.campaigns.map((c) => `<option value="${esc(c.id)}" ${c.id === camp.id ? "selected" : ""}>
            ${esc(c.name)} — ${c.companies} companies · ${c.drafts} drafts · ${c.sent} sent</option>`).join("")}
        </select>
        <button class="btn ghost sm" id="btnNewCampaign">${icon("plus")} New</button>
        <button class="btn ghost sm" id="btnCampSettings">${icon("settings")} Campaign settings</button>
        <span style="margin-left:auto" class="tag">${esc(camp.status)}</span>
      </div>
      ${camp.goal ? `<div class="card-note"><b>Ask:</b> ${esc(camp.goal)}</div>` : ""}
      ${camp.target_description ? `<div class="card-note"><b>Looking for:</b> ${esc(camp.target_description)}</div>`
        : `<div class="card-note" style="color:var(--warn)">No target set — discovery will fall back to your product's own customer profile, which is usually not who you want for a partner or press campaign.</div>`}
    </div>

    <div class="card">
      <div class="card-head"><h2>Find companies</h2></div>
      <div class="row">
        <input id="extraTargeting" aria-label="Extra targeting instructions" placeholder="Optional: narrow it, e.g. 'within 20 miles of Durham'" style="flex:1;min-width:220px">
        <button class="btn" id="btnDiscover">${icon("search")} Search the web</button>
      </div>
      <details>
        <summary>Or paste a list</summary>
        <textarea id="manualList" rows="5" aria-label="Companies to add"
          placeholder="Paste domains, one per line — or a CSV from a spreadsheet.&#10;&#10;bethellandco.co.uk Bethell &amp; Co&#10;pta.com.tr"></textarea>
        <div class="row">
          <button class="btn ghost sm" id="btnManual">${icon("plus")} Add these</button>
          <input type="file" id="csvFile" accept=".csv,.txt" aria-label="Import a CSV file"
            style="max-width:230px;padding:4px">
        </div>
        <p class="card-note">A bare list, "domain Name" lines, or a CSV with a website column — it
          works out which. Anything that is not a domain is reported, not silently dropped.</p>
      </details>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>Companies <span class="tag">${num(ticked)} of ${num(S.companies.length)} ticked</span></h2>
        <span class="card-actions">
          <button class="btn ghost sm" id="btnExport">${icon("download")} Export</button>
          <button class="btn ghost sm" id="btnTickAll">Tick all</button>
          <button class="btn ghost sm" id="btnTickNone">Untick all</button>
          <button class="btn" id="btnRun" ${ticked ? "" : "disabled"}>${icon("play")} Research &amp; write</button>
        </span>
      </div>
      <div class="row" style="margin-bottom:var(--s4)">
        <input id="coFilter" type="search" aria-label="Filter companies" placeholder="Filter by name or domain…" value="${esc(S.filter)}" style="flex:1;min-width:180px">
        <select id="coStatus" aria-label="Filter by status" style="max-width:170px">
          ${[["all", "All active"], ["selected", "Ticked only"], ["ready", "Have contacts"],
             ["failed", "Failed"], ["rejected", "Rejected"]].map(([v, l]) =>
            `<option value="${v}" ${S.companyFilter === v ? "selected" : ""}>${l}</option>`).join("")}
        </select>
      </div>
      ${rows.length ? `<div class="tablewrap"><table>
        <thead><tr>
          <th style="width:34px"></th><th>Company</th><th style="width:74px">Fit</th>
          <th style="width:88px">Status</th><th class="num" style="width:60px">Facts</th>
          <th class="num" style="width:70px">Contacts</th><th style="width:74px"></th>
        </tr></thead>
        <tbody class="stagger">${rows.map((r) => `
          <tr data-selected="${r.selected ? 1 : 0}">
            <td><input type="checkbox" data-sel="${esc(r.id)}" ${r.selected ? "checked" : ""}
                 aria-label="Include ${esc(r.name)}"></td>
            <td><div class="cellmain">${esc(r.name)}</div>
                <div class="cellsub mono">${esc(r.domain)}${r.city ? ` · ${esc(r.city)}` : ""}</div>
                ${r.rejected_reason ? `<div class="cellsub" style="color:var(--bad)">${esc(r.rejected_reason)}</div>`
                  : r.error_message ? `<div class="cellsub" style="color:var(--warn)">${esc(r.error_message)}</div>`
                  : r.relevance_reason ? `<div class="cellsub">${esc(r.relevance_reason)}</div>` : ""}</td>
            <td>${r.relevance_score != null ? `<span class="tag ${r.relevance_score >= .8 ? "ok" : r.relevance_score >= .5 ? "" : "warn"}">${Math.round(r.relevance_score * 100)}</span>` : "—"}</td>
            <td><span class="tag ${r.status === "failed" || r.status === "rejected" ? "bad" : ["drafted", "sent", "contacts_found"].includes(r.status) ? "ok" : ""}">${esc(r.status)}</span></td>
            <td class="num">${num(r.verified_claims)}</td>
            <td class="num">${num(r.contacts)}</td>
            <td><button class="btn sm ghost" data-detail="${esc(r.id)}" aria-label="Evidence for ${esc(r.name)}" title="Evidence">${icon("eye")}</button></td>
          </tr>`).join("")}</tbody></table></div>`
        : empty("binocular", "Nothing here yet",
            S.companies.length ? "No company matches this filter." : "Search the web, or paste a list of domains above.")}
    </div>
  `);

  $("#campSelect").onchange = (e) => { S.campaign = e.target.value; S.filter = ""; go("campaigns"); };
  $("#btnNewCampaign").onclick = newCampaignDialog;
  $("#btnCampSettings").onclick = () => campaignSettingsDialog(camp);
  $("#coFilter").oninput = debounce((e) => { S.filter = e.target.value; renderCampaigns(); }, 220);
  $("#coStatus").onchange = (e) => { S.companyFilter = e.target.value; renderCampaigns(); };
  $("#btnExport").onclick = () => exportDialog(camp.id);
  $("#btnDiscover").onclick = async () => {
    try { await api(`/api/campaigns/${camp.id}/discover`, { extra: $("#extraTargeting").value }); toast("Searching the web…"); }
    catch (e) { fail(e); }
  };
  $("#btnManual").onclick = async () => {
    try {
      const r = await api(`/api/campaigns/${camp.id}/manual`, { text: $("#manualList").value });
      toast(`Added ${r.added}${r.skipped.length ? `, skipped ${r.skipped.length}` : ""}`);
      renderCampaigns();
    } catch (e) { fail(e); }
  };
  $("#btnRun").onclick = async () => {
    try { await api(`/api/campaigns/${camp.id}/run`, {}); toast("Researching…"); } catch (e) { fail(e); }
  };
  const setAll = async (v) => {
    await api(`/api/campaigns/${camp.id}/select-all`, { selected: v });
    renderCampaigns();
  };
  $("#btnTickAll").onclick = () => setAll(true);
  $("#btnTickNone").onclick = () => setAll(false);
  $$("[data-sel]").forEach((cb) => cb.onchange = async () => {
    await api(`/api/companies/${cb.dataset.sel}/select`, { selected: cb.checked });
    cb.closest("tr").dataset.selected = cb.checked ? "1" : "0";
    const n = $$("[data-sel]:checked").length;
    $("#btnRun").disabled = n === 0;
  });
  $$("[data-detail]").forEach((b) => b.onclick = () => showCompany(b.dataset.detail));
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

/* ───────────────────────────────────────────────────────── review */

const FLAG_TEXT = {
  no_citations: "Nothing specific to this company is cited",
  too_long: "Longer than a cold email should be",
  too_short: "Very short — may be missing the reason or the ask",
  flattery: "Contains empty praise",
  hedging: "The offer is hedged",
  vague_ask: "The ask isn't answerable",
  no_ask: "There's no actual question",
  placeholder: "Contains an unfilled placeholder",
  subject_too_long: "Subject will be truncated",
  subject_question: "Subject is a question",
};

async function renderReview() {
  if (!S.campaigns.length) S.campaigns = await api("/api/campaigns");
  if (!S.campaign && S.campaigns.length) S.campaign = S.campaigns[0].id;
  if (!S.campaign) {
    $("#content").innerHTML = page(empty("page-edit", "No campaigns yet", "Create a campaign first."));
    return;
  }
  const all = await api(`/api/campaigns/${S.campaign}/drafts`);
  S.drafts = S.draftFilter === "all" ? all : all.filter((d) => d.status === S.draftFilter);
  if (S.reviewIndex >= S.drafts.length) S.reviewIndex = 0;

  const counts = { needs_review: 0, approved: 0, sent: 0 };
  for (const d of all) if (counts[d.status] != null) counts[d.status]++;

  $("#content").innerHTML = page(`
    <div class="row" style="margin-bottom:var(--s5)">
      <select id="draftFilter" aria-label="Filter drafts by status" style="max-width:200px">
        ${[["needs_review", `Needs review (${counts.needs_review})`],
           ["approved", `Approved (${counts.approved})`],
           ["sent", `Sent (${counts.sent})`], ["all", `All (${all.length})`]]
          .map(([v, l]) => `<option value="${v}" ${S.draftFilter === v ? "selected" : ""}>${esc(l)}</option>`).join("")}
      </select>
      ${S.draftFilter === "needs_review" && S.drafts.length ? `
        <button class="btn ghost sm" id="btnApproveClean">${icon("check")} Approve all unflagged</button>` : ""}
      <span class="tag" style="margin-left:auto">${icon("antenna-signal")} j / k to move · a to approve · ? for all keys</span>
    </div>
    ${S.drafts.length ? `<div class="review-layout">
      <div class="queue">
        <div class="queue-head">${icon("list")} ${num(S.drafts.length)} in queue</div>
        <div class="queue-list" id="queueList" role="listbox">
          ${S.drafts.map((d, i) => {
            const flags = JSON.parse(d.quality_flags || "[]");
            return `<button class="qitem" role="option" data-i="${i}"
              ${i === S.reviewIndex ? 'aria-selected="true"' : ""}>
              <div class="qitem-top">
                <span class="qitem-name">${esc(d.company)}</span>
                ${d.step_number > 1 ? `<span class="tag">#${d.step_number}</span>` : ""}
                ${flags.length ? `<span class="tag warn">${flags.length}</span>` : ""}
              </div>
              <div class="qitem-sub">${esc(d.email)}</div>
            </button>`;
          }).join("")}
        </div>
      </div>
      <div id="letterPane"></div>
    </div>` : empty("check", "Nothing to review",
        S.draftFilter === "needs_review" ? "Every draft has been dealt with." : "No drafts with this status.")}
  `);

  $("#draftFilter").onchange = (e) => { S.draftFilter = e.target.value; S.reviewIndex = 0; renderReview(); };
  $("#btnApproveClean")?.addEventListener("click", approveAllClean);
  $$("#queueList .qitem").forEach((b) => b.onclick = () => selectDraft(+b.dataset.i));
  if (S.drafts.length) drawLetter();
}

function selectDraft(i) {
  if (!S.drafts.length) return;
  S.reviewIndex = Math.max(0, Math.min(S.drafts.length - 1, i));
  $$("#queueList .qitem").forEach((b, n) =>
    b.setAttribute("aria-selected", n === S.reviewIndex ? "true" : "false"));
  $(`#queueList [aria-selected="true"]`)?.scrollIntoView({ block: "nearest" });
  drawLetter();
}

async function drawLetter() {
  const d = S.drafts[S.reviewIndex];
  if (!d) return;
  const pane = $("#letterPane");
  pane.innerHTML = `<div class="letter">${skeleton(3)}</div>`;
  let full;
  try { full = await api(`/api/drafts/${d.draft_id}`); } catch (e) { return fail(e); }
  const flags = JSON.parse(full.quality_flags || "[]");

  pane.innerHTML = `
    <div class="letter">
      <div class="letter-head">
        <div class="letter-to">
          <span>To</span><span class="mono">${esc(full.contact.email)}</span>
          <span class="tag ${full.contact.source_kind === "published" ? "ok" : full.contact.source_kind === "inferred" ? "warn" : ""}">${esc(full.contact.source_kind)}</span>
          <a href="${esc(full.contact.source_url)}" target="_blank" rel="noreferrer noopener">verify source ${icon("open-new-window")}</a>
          ${d.step_number > 1 ? `<span class="tag accent">follow-up #${d.step_number}</span>` : ""}
          <span class="tag" style="margin-left:auto">v${full.version} · ${esc(full.author)} · ${num(full.word_count || full.body_text.trim().split(/\s+/).filter(Boolean).length)} words</span>
        </div>
        ${full.contact.full_name ? `<div class="cellsub">${esc(full.contact.full_name)}${full.contact.title ? ` · ${esc(full.contact.title)}` : ""}</div>` : ""}
      </div>
      <div class="letter-body">
        ${full.alreadyContacted?.contacted ? `<div class="flagbox" style="background:var(--bad-bg);border-color:var(--bad);color:var(--bad)">
          ${icon("warning-triangle")} <b>This person was already emailed from “${esc(full.alreadyContacted.campaignName)}”</b>
          <div>Sending a second unrelated cold email is the fastest way to get marked as spam.
          This draft will be refused at send time.</div></div>` : ""}
        ${flags.length ? `<div class="flagbox">${icon("warning-triangle")} <b>Worth a look before you approve</b>
          <ul>${flags.map((f) => `<li>${esc(FLAG_TEXT[f.flag] ?? f.flag)} — <span style="opacity:.85">${esc(f.detail)}</span></li>`).join("")}</ul>
        </div>` : ""}
        <div class="letter-subject">${esc(full.subject)}</div>
        <div class="letter-text">${esc(full.body_text)}</div>
        ${full.claims.length ? `<div style="margin-top:var(--s5)">
          <div class="stat-label">${icon("shield-check")} What this email claims, and where it came from</div>
          ${full.claims.map((c) => `<div class="cite"><b>${esc(c.claim)}</b>
            <q>${esc(c.quote)}</q><br><a href="${esc(c.source_url)}" target="_blank" rel="noreferrer noopener">${esc(c.source_url)}</a></div>`).join("")}
        </div>` : `<div class="cite" style="border-color:var(--warn);margin-top:var(--s5)">
          This email cites nothing specific about them — it was written without any verified fact.</div>`}
      </div>
      <div class="letter-foot">
        ${d.status === "sent" ? `<span class="tag ok">${icon("check")} sent ${esc(ago(d.sent_at))}</span>`
        : `<button class="btn" id="btnApprove">${icon("check")} Approve <kbd style="opacity:.7">a</kbd></button>
           <button class="btn ghost" id="btnEdit">${icon("edit-pencil")} Edit</button>
           <button class="btn ghost" id="btnRewrite">${icon("refresh")} Rewrite…</button>
           <button class="btn ghost" id="btnSkip">Skip</button>
           <button class="btn ghost danger" id="btnNever">Never contact</button>`}
        <span style="margin-left:auto" class="cellsub">${esc(full.company ?? "")}</span>
      </div>
    </div>
    ${full.versions.length > 1 ? `<details style="margin-top:var(--s3)">
      <summary>${full.versions.length} versions</summary>
      <div class="card">${full.versions.map((v) => `<div class="feed-item">
        <span class="tag">v${v.version}</span><span>${esc(v.subject)}</span>
        <span class="feed-time">${esc(v.author)} · ${esc(ago(v.created_at))}</span></div>`).join("")}</div>
    </details>` : ""}`;

  $("#btnApprove")?.addEventListener("click", () => approveDraft(d.draft_id));
  $("#btnSkip")?.addEventListener("click", () => skipDraft(d.draft_id));
  $("#btnEdit")?.addEventListener("click", () => editDialog(full));
  $("#btnRewrite")?.addEventListener("click", () => rewriteDialog(d.draft_id));
  $("#btnNever")?.addEventListener("click", async () => {
    if (!confirm(`Never contact ${full.contact.email}? This applies to every campaign, permanently.`)) return;
    try { await api("/api/suppression", { pattern: full.contact.email, reason: "manual" });
      toast("Added to never-contact"); renderReview(); } catch (e) { fail(e); }
  });
}

async function approveDraft(id) {
  try {
    await api(`/api/drafts/${id}/approve`, {});
    toast("Approved");
    const at = S.reviewIndex;
    await renderReview();
    selectDraft(Math.min(at, S.drafts.length - 1));
    loadHealth();
  } catch (e) { fail(e); }
}
async function skipDraft(id) {
  try {
    await api(`/api/drafts/${id}/skip`, {});
    toast("Skipped");
    const at = S.reviewIndex;
    await renderReview();
    selectDraft(Math.min(at, S.drafts.length - 1));
  } catch (e) { fail(e); }
}
async function approveAllClean() {
  const clean = S.drafts.filter((d) => {
    const f = JSON.parse(d.quality_flags || "[]").map((x) => x.flag);
    return !f.some((x) => ["placeholder", "no_citations", "too_long"].includes(x));
  });
  if (!clean.length) return toast("Every draft has a blocking flag — review them individually", true);
  if (!confirm(`Approve ${clean.length} draft${clean.length > 1 ? "s" : ""} with no blocking quality flags?\n\nThey still won't send until you start the outbox.`)) return;
  try {
    const r = await api("/api/drafts/bulk-approve", { ids: clean.map((d) => d.draft_id) });
    toast(`Approved ${r.approved}${r.skipped ? `, skipped ${r.skipped}` : ""}`);
    renderReview(); loadHealth();
  } catch (e) { fail(e); }
}

function editDialog(full) {
  modal(`Edit email`, `
    <label class="field">Subject<input id="edSubject" value="${esc(full.subject)}"></label>
    <label class="field" style="margin-top:var(--s3)">Body
      <textarea id="edBody" rows="14">${esc(full.body_text)}</textarea></label>
    <p class="card-note">Saved as a new version. The original is kept.</p>`,
    async () => {
      await api(`/api/drafts/${full.draft_id}/edit`, { subject: $("#edSubject").value, body: $("#edBody").value });
      toast("Saved"); renderReview();
    }, "Save version");
}
function rewriteDialog(id) {
  modal(`Rewrite`, `
    <label class="field">What should change?
      <input id="rwInstruction" placeholder="e.g. shorter · mention their new location · less formal" autofocus></label>
    <p class="card-note">The rewrite still may only use facts we verified from their own site.</p>`,
    async () => {
      const r = await api(`/api/drafts/${id}/regenerate`, { instruction: $("#rwInstruction").value });
      toast(`Rewritten${r.flags?.length ? ` — ${r.flags.length} quality flag(s)` : ""}`);
      renderReview();
    }, "Rewrite");
}

/* ───────────────────────────────────────────────────────── outbox */

async function renderOutbox() {
  const [status, seq] = await Promise.all([
    api("/api/send/status"),
    S.campaign ? api(`/api/campaigns/${S.campaign}/sequence`) : Promise.resolve(null),
  ]);
  const capPct = Math.min(100, status.dailyLimit ? status.sentLast24h / status.dailyLimit * 100 : 0);

  $("#content").innerHTML = page(`
    <div class="card">
      <div class="card-head"><h2>Sending</h2>
        <span class="card-actions">
          ${status.running
            ? `<button class="btn ghost" id="btnPause">${icon("pause")} Pause</button>`
            : `<button class="btn" id="btnStart" ${status.approved ? "" : "disabled"}>${icon("play")} Start sending</button>`}
        </span></div>
      <div class="statgrid" style="margin-bottom:0">
        <div class="stat"><div class="stat-label">Approved &amp; waiting</div>
          <div class="stat-value">${num(status.approved)}</div>
          <div class="stat-foot">${status.approved ? "will send one at a time" : "nothing queued"}</div></div>
        <div class="stat"><div class="stat-label">Sent in last 24h</div>
          <div class="stat-value">${num(status.sentLast24h)}<small> / ${num(status.dailyLimit)}</small></div>
          <div class="progress" style="margin-top:var(--s2);max-width:none">
            <i style="clip-path:inset(0 ${100 - capPct}% 0 0)"></i></div></div>
        <div class="stat"><div class="stat-label">Status</div>
          <div class="stat-value" style="font-size:17px">${status.paused ? "Paused" : status.running ? "Running" : "Idle"}</div>
          <div class="stat-foot">${esc(status.lastOutcome ?? "—")}</div></div>
      </div>
      <p class="card-note">One email at a time, with a randomised gap. The cap counts what actually
        left in the last 24 hours, so restarting the app can't get around it. Suppression and
        replies are re-checked at the moment of sending, not when you approved.</p>
    </div>

    ${seq ? `<div class="card">
      <div class="card-head"><h2>Follow-ups</h2>
        <span class="card-actions">
          ${seq.due.length ? `<button class="btn" id="btnDraftFollowups">${icon("page-edit")} Draft ${seq.due.length} due</button>` : ""}
          <button class="btn ghost sm" id="btnEditSeq">${icon("settings")} Edit sequence</button>
        </span></div>
      ${seq.steps.length ? `<div class="funnel">
        ${seq.steps.map((s) => `<div class="fstage" style="grid-template-columns:118px 1fr auto">
          <span class="fstage-name">Step ${s.step_number}</span>
          <span class="cellsub">${esc(s.instruction.slice(0, 96))}${s.instruction.length > 96 ? "…" : ""}</span>
          <span class="tag ${s.enabled ? "" : "warn"}">${s.enabled ? `${s.delay_days}d after` : "off"}</span>
        </div>`).join("")}</div>`
        : `<p class="card-note">No follow-up steps. Most replies come from the second or third touch.</p>`}
      ${seq.upcoming.length ? `<details style="margin-top:var(--s3)"><summary>${seq.upcoming.length} scheduled</summary>
        <div class="tablewrap" style="margin-top:var(--s2)"><table><thead><tr>
          <th>Company</th><th>Contact</th><th>Step</th><th>Due</th></tr></thead><tbody>
          ${seq.upcoming.map((u) => `<tr><td>${esc(u.company)}</td><td class="mono">${esc(u.email)}</td>
            <td>#${u.step}</td><td>${esc(when(u.dueAt))}</td></tr>`).join("")}
        </tbody></table></div></details>` : ""}
      <p class="card-note">A contact who replies is dropped from the sequence immediately, and a
        suppressed address is never followed up.</p>
    </div>` : ""}

    <div class="card">
      <div class="card-head"><h2>Send log</h2>
        <span class="card-actions">${S.campaign ? `<button class="btn ghost sm" id="btnExportSends">${icon("download")} Export</button>` : ""}</span></div>
      ${status.recent.length ? `<div class="tablewrap"><table>
        <thead><tr><th>To</th><th>Subject</th><th style="width:96px">Status</th><th style="width:150px">When</th></tr></thead>
        <tbody class="stagger">${status.recent.map((r) => `<tr>
          <td class="mono">${esc(r.to_email)}</td><td>${esc(r.subject)}</td>
          <td><span class="tag ${r.status === "sent" ? "ok" : r.status === "failed" ? "bad" : ""}">${esc(r.status)}</span>
            ${r.error_message ? `<div class="cellsub" style="color:var(--bad)">${esc(r.error_message.slice(0, 70))}</div>` : ""}</td>
          <td class="cellsub">${esc(r.sent_at ? dt(r.sent_at) : "—")}</td></tr>`).join("")}</tbody>
      </table></div>` : empty("send", "Nothing sent yet", "Approve some drafts in Review, then start sending here.")}
    </div>
  `);
  $("#btnStart")?.addEventListener("click", async () => {
    if (!confirm(`Start sending?\n\n${status.approved} approved email${status.approved > 1 ? "s" : ""} will go out one at a time, up to ${status.dailyLimit} per day.`)) return;
    try { await api("/api/send/start", {}); toast("Sending started"); renderOutbox(); } catch (e) { fail(e); }
  });
  $("#btnPause")?.addEventListener("click", async () => {
    try { await api("/api/send/pause", {}); toast("Paused"); renderOutbox(); } catch (e) { fail(e); }
  });
  $("#btnDraftFollowups")?.addEventListener("click", async () => {
    try { await api(`/api/campaigns/${S.campaign}/sequence/draft-due`, {}); toast("Drafting follow-ups…"); } catch (e) { fail(e); }
  });
  $("#btnEditSeq")?.addEventListener("click", () => sequenceDialog(seq));
  $("#btnExportSends")?.addEventListener("click", () => exportDialog(S.campaign));
}

function sequenceDialog(seq) {
  const steps = seq.steps.length ? seq.steps : seq.defaults;
  modal("Follow-up sequence", `
    <p class="card-note" style="margin-top:0">Each step only sends if the person hasn't replied.
      Drafts still land in Review — nothing follows up automatically without you.</p>
    <div id="seqRows">${steps.map((s, i) => `
      <div class="card" data-step="${s.step_number}" style="margin-top:var(--s3)">
        <div class="row">
          <b>Step ${s.step_number}</b>
          <label class="check" style="margin-left:auto">
            <input type="checkbox" class="seqEnabled" ${s.enabled !== 0 && s.enabled !== false ? "checked" : ""}> enabled</label>
        </div>
        <label class="field" style="margin-top:var(--s2)">Days after the previous email
          <input type="number" class="seqDelay" min="1" max="60" value="${s.delay_days}"></label>
        <label class="field" style="margin-top:var(--s2)">How this one should differ
          <textarea class="seqInstruction" rows="3">${esc(s.instruction)}</textarea></label>
      </div>`).join("")}</div>`,
    async () => {
      const rows = $$("#seqRows [data-step]").map((el) => ({
        step_number: +el.dataset.step,
        delay_days: +$(".seqDelay", el).value,
        instruction: $(".seqInstruction", el).value,
        enabled: $(".seqEnabled", el).checked,
      }));
      await api(`/api/campaigns/${S.campaign}/sequence`, { steps: rows });
      toast("Sequence saved"); renderOutbox();
    }, "Save sequence");
}

/* ───────────────────────────────────────────────────────── replies */

async function renderReplies() {
  S.replies = await api("/api/replies");
  $("#content").innerHTML = page(
    S.replies.length ? `<div class="stagger">${S.replies.map((r) => `
      <div class="card" id="rp-${esc(r.id)}">
        <div class="card-head">
          <h2>${esc(r.company ?? r.from_email)}</h2>
          ${r.classification ? `<span class="tag ${r.classification === "interested" ? "ok" : r.classification === "unsubscribe" ? "bad" : ""}">${esc(r.classification)}</span>` : ""}
          ${r.handled ? `<span class="tag ok">handled</span>` : ""}
          <span class="card-actions cellsub">${esc(dt(r.received_at))}</span>
        </div>
        <div class="cellsub mono" style="margin-bottom:var(--s3)">${esc(r.from_email)}</div>
        <div class="letter" style="border:0">
          <div class="letter-body" style="padding:var(--s4);background:var(--surface);border-radius:var(--r)">
            <div class="letter-subject">${esc(r.subject)}</div>
            <div class="letter-text">${esc(r.body_text || "(open to load the message)")}</div>
          </div>
        </div>
        <div class="row" style="margin-top:var(--s3)">
          <button class="btn" data-draft="${esc(r.id)}">${icon("sparks")} Draft a response</button>
          ${r.handled ? "" : `<button class="btn ghost sm" data-handled="${esc(r.id)}">Mark handled</button>`}
        </div>
        <div id="rd-${esc(r.id)}"></div>
      </div>`).join("")}</div>`
    : empty("message-text", "No replies yet",
        "Replies are matched to the thread they answer, using the Message-ID we set before sending.",
        `<button class="btn ghost" id="btnPoll">${icon("refresh")} Check now</button>`),
    `<button class="btn ghost" id="btnPollTop">${icon("refresh")} Check now</button>`);

  const poll = async () => { try { await api("/api/replies/poll", {}); toast("Checking the mailbox…"); } catch (e) { fail(e); } };
  $("#btnPoll")?.addEventListener("click", poll);
  $("#btnPollTop")?.addEventListener("click", poll);
  $$("[data-handled]").forEach((b) => b.onclick = async () => {
    await api(`/api/replies/${b.dataset.handled}/handled`, {}); renderReplies(); loadHealth();
  });
  $$("[data-draft]").forEach((b) => b.onclick = async () => {
    const id = b.dataset.draft;
    b.disabled = true; b.innerHTML = `<span class="spinner"></span> Reading…`;
    try {
      const r = await api(`/api/replies/${id}/draft`, {});
      $(`#rd-${id}`).innerHTML = `
        <div class="cite" style="margin-top:var(--s4)">
          Read as <b>${esc(r.classification.classification)}</b>
          (${pct(r.classification.confidence)} confident) — ${esc(r.classification.summary)}</div>
        <div class="letter-body" style="background:var(--surface);border-radius:var(--r);padding:var(--s4);margin-top:var(--s2)">
          <div class="letter-text">${esc(r.draft)}</div></div>
        <div class="row" style="margin-top:var(--s2)">
          <button class="btn ghost sm" data-copy="${esc(id)}">${icon("copy")} Copy</button>
          ${r.suggestSuppress ? `<button class="btn danger sm" data-sup="${esc(id)}">They asked to stop — never contact</button>` : ""}
          <span class="cellsub">Nothing is sent from here. Paste it into your mail client, or write your own.</span>
        </div>`;
      $(`[data-copy="${id}"]`).onclick = async () => {
        try { await navigator.clipboard.writeText(r.draft); toast("Copied"); }
        catch { toast("Couldn't copy — select the text instead", true); }
      };
      $(`[data-sup="${id}"]`)?.addEventListener("click", async () => {
        const reply = S.replies.find((x) => x.id === id);
        await api("/api/suppression", { pattern: reply.from_email, reason: "unsubscribe" });
        toast("Added to never-contact"); renderReplies();
      });
    } catch (e) { fail(e); }
    finally { b.disabled = false; b.innerHTML = `${icon("sparks")} Draft a response`; }
  });
}

/* ───────────────────────────────────────────────────────── product */

async function renderProduct() {
  S.product = await api("/api/product");
  const p = S.product;
  const turns = p ? await api(`/api/interview/${p.id}`) : [];
  const parse = (k, d = []) => { try { return JSON.parse(p?.[k] ?? "null") ?? d; } catch { return d; } };
  const signals = parse("signals");

  $("#content").innerHTML = page(`
    <div class="grid2" style="align-items:start">
      <div class="card">
        <div class="card-head"><h2>Interview</h2>
          <span class="card-actions">
            <button class="btn ghost sm" id="btnStartInterview">${p ? "Restart" : "Start"}</button>
            ${turns.length ? `<button class="btn sm" id="btnFinish">${icon("sparks")} Write the brief</button>` : ""}
          </span></div>
        <p class="card-note" style="margin-top:0">Answer like you'd tell a friend. It asks about
          real things that happened, not about your "value proposition" — and it won't use that
          language back at you.</p>
        <div id="chat" style="max-height:400px;overflow-y:auto;display:flex;flex-direction:column;gap:var(--s3);margin:var(--s4) 0">
          ${turns.map((t) => `<div class="letter-body" style="padding:var(--s3) var(--s4);border-radius:var(--r);max-width:88%;
            ${t.role === "assistant" ? "background:var(--surface);align-self:flex-start"
                                     : "background:var(--primary);color:var(--on-primary);align-self:flex-end"}">
            <div class="letter-text" style="font-size:13.5px">${esc(t.content)}</div></div>`).join("")}
        </div>
        <div class="row">
          <textarea id="answer" rows="2" aria-label="Your answer" placeholder="Type your answer…" style="flex:1;min-width:180px"></textarea>
          <button class="btn" id="btnAnswer">Send</button>
        </div>
        <p class="card-note">⌘/Ctrl + Enter to send.</p>
      </div>

      <div class="card">
        <div class="card-head"><h2>The brief</h2>
          ${p ? `<span class="card-actions"><button class="btn ghost sm" id="btnSaveBrief">Save</button></span>` : ""}</div>
        ${p ? `
          ${[["name", "Name"], ["one_liner", "In one line"], ["description", "What you do"],
             ["job_to_be_done", "What they're trying to get done"], ["before_state", "Life before you"],
             ["price_anchor", "Price"], ["tone_sample", "Your voice"],
             ["sender_name", "Your name"], ["sender_title", "Your title"], ["sender_company", "Your business"]]
            .map(([k, label]) => `<label class="field" style="margin-bottom:var(--s3)">${esc(label)}
              <textarea data-f="${k}" rows="${["description", "tone_sample", "one_liner"].includes(k) ? 3 : 1}">${esc(p[k] ?? "")}</textarea></label>`).join("")}
          <div class="stat-label" style="margin-top:var(--s4)">${icon("binocular")} Targeting signals</div>
          ${signals.length
            ? signals.map((s) => `<div class="cite"><b>${esc(s.signal)}</b>${s.how_to_check ? esc(s.how_to_check) : ""}</div>`).join("")
            : `<p class="card-note">None yet — search will be broad until the interview surfaces some.</p>`}
          <p class="card-note">These describe your <b>customers</b>. A campaign aimed at someone
            else — partners, press, content sources — should set its own target instead.</p>
        ` : empty("building", "No product yet", "Run the interview and it will write the brief for you.")}
      </div>
    </div>
  `);

  $("#btnStartInterview").onclick = async () => {
    if (p && !confirm("Start a new interview? The existing brief is kept until you write a new one.")) return;
    try { const r = await api("/api/interview/start", {}); S.product = { id: r.productId }; await nextQuestion(""); }
    catch (e) { fail(e); }
  };
  $("#btnAnswer").onclick = async () => {
    const v = $("#answer").value.trim(); if (!v) return;
    $("#answer").value = ""; await nextQuestion(v);
  };
  $("#answer").onkeydown = (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("#btnAnswer").click(); };
  $("#btnFinish")?.addEventListener("click", async () => {
    const b = $("#btnFinish"); b.disabled = true; b.innerHTML = `<span class="spinner"></span> Writing…`;
    try { await api(`/api/interview/${S.product.id}/finish`, {}); toast("Brief written"); renderProduct(); }
    catch (e) { fail(e); b.disabled = false; }
  });
  $("#btnSaveBrief")?.addEventListener("click", async () => {
    const body = {}; $$("[data-f]").forEach((el) => body[el.dataset.f] = el.value);
    try { await api(`/api/product/${p.id}`, body); toast("Saved"); } catch (e) { fail(e); }
  });
}

async function nextQuestion(answer) {
  const btn = $("#btnAnswer"); if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`; }
  const chat = $("#chat");
  const bubble = (text, mine) => {
    chat.insertAdjacentHTML("beforeend", `<div class="letter-body" style="padding:var(--s3) var(--s4);border-radius:var(--r);max-width:88%;
      ${mine ? "background:var(--primary);color:var(--on-primary);align-self:flex-end" : "background:var(--surface);align-self:flex-start"}">
      <div class="letter-text" style="font-size:13.5px">${esc(text)}</div></div>`);
    chat.scrollTop = chat.scrollHeight;
  };
  try {
    if (answer) bubble(answer, true);
    const r = await api(`/api/interview/${S.product.id}/next`, { answer });
    bubble(r.done ? "That's enough to work with — hit “Write the brief”." : r.question, false);
  } catch (e) { fail(e); }
  finally { if (btn) { btn.disabled = false; btn.textContent = "Send"; } }
}

/* ───────────────────────────────────────────────────────── settings */

async function renderSettings() {
  const [s, health, sup, integrity] = await Promise.all([
    api("/api/settings"), api("/api/health"), api("/api/suppression"),
    api("/api/integrity").catch(() => ({ ok: true, violations: [] })),
  ]);
  const m = s.smtp ?? {}, g = s.sending ?? {};
  const r = health.model.research, w = health.model.writing;

  $("#content").innerHTML = page(`
    ${integrity.ok ? "" : `<div class="card" style="border-color:var(--bad)">
      <div class="card-head"><h2>Database integrity</h2><span class="tag bad">needs attention</span></div>
      <p class="card-note" style="margin-top:0">
        ${num(integrity.violations.reduce((n, v) => n + v.count, 0))} row(s) point at something that no longer
        exists (${integrity.violations.map((v) => `${num(v.count)} in ${esc(v.table)}`).join(", ")}).
        coldcall cannot create these — it always opens the database with foreign keys on — so something
        else edited the file. Repairing clears the reference where it is optional and keeps the row;
        only genuinely unreachable rows are deleted.</p>
      <div class="row"><button class="btn danger" id="btnRepair">${icon("shield-check")} Repair</button></div>
    </div>` }
    <div class="card">
      <div class="card-head"><h2>Models</h2>
        <span class="card-actions"><button class="btn ghost sm" id="btnProbe">${icon("refresh")} Re-probe</button></span></div>
      <div class="grid2">
        <div><div class="stat-label">Research ${r.status === "ok" ? `<span class="tag ok">ready</span>` : `<span class="tag bad">none</span>`}</div>
          <div class="mono" style="margin-top:4px">${r.active ? esc(`${r.active.providerID}/${r.active.modelID}`) : "—"}</div></div>
        <div><div class="stat-label">Writing ${w.status === "ok" ? `<span class="tag ok">ready</span>` : `<span class="tag bad">none</span>`}</div>
          <div class="mono" style="margin-top:4px">${w.active ? esc(`${w.active.providerID}/${w.active.modelID}`) : "—"}</div></div>
      </div>
      <p class="card-note">Web search is only offered to the free <code class="mono">opencode/*</code>
        models — that's how opencode gates it — so research runs free and your own provider does
        the writing. If neither is ready, run <code class="mono">opencode auth login</code> in a terminal.</p>
    </div>

    <div class="card">
      <div class="card-head"><h2>Mailbox</h2>
        ${m.configured ? `<span class="tag ok">${icon("check")} connected</span>` : `<span class="tag warn">not connected</span>`}</div>
      <p class="card-note" style="margin-top:0">Gmail needs an <b>app password</b>, not your normal
        one: Google Account → Security → 2-Step Verification → App passwords.</p>
      <div class="grid2" style="margin-top:var(--s4)">
        <label class="field">Your email<input id="smtpUser" type="email" value="${esc(m.user ?? "")}" placeholder="you@gmail.com" autocomplete="username"></label>
        <label class="field">App password<input id="smtpPass" type="password" placeholder="${s.hasPassword ? "•••••••• (saved)" : "16 characters"}" autocomplete="current-password"></label>
        <label class="field">From name<input id="smtpFromName" value="${esc(m.fromName ?? "")}" placeholder="Ozan"></label>
        <label class="field">SMTP host<input id="smtpHost" value="${esc(m.host ?? s.defaults.smtp.host)}"></label>
        <label class="field">SMTP port<input id="smtpPort" type="number" value="${esc(m.port ?? s.defaults.smtp.port)}"></label>
        <label class="field">IMAP host<input id="imapHost" value="${esc(m.imapHost ?? s.defaults.imap.host)}"></label>
      </div>
      <div class="row" style="margin-top:var(--s4)">
        <button class="btn" id="btnTest">${icon("shield-check")} Save &amp; test connection</button>
        ${m.configured ? `<button class="btn ghost" id="btnSendTest">${icon("send")} Send a test to myself</button>` : ""}
        <span id="testResult" class="cellsub"></span>
      </div>
      ${m.configured ? `<p class="card-note">The test message goes to <b>${esc(m.user ?? "")}</b> and nowhere else.
        Testing the connection proves the credentials work; only a real message proves it arrives.</p>` : ""}
      <p class="card-note">${s.hasPassword
        ? esc(s.secretStorage === "keychain"
            ? "Password is in your macOS login Keychain. Any process running as you can still read it — unavoidable for an app that sends mail unattended."
            : "Password is stored UNENCRYPTED in ~/.coldcall/secrets.json (file mode 0600).")
        : "No password saved yet."}</p>
    </div>

    <div class="card">
      <div class="card-head"><h2>Sending limits</h2></div>
      <div class="grid3">
        <label class="field">Max per day<input id="dailyLimit" type="number" min="1" value="${esc(g.dailyLimit ?? 30)}"></label>
        <label class="field">Min gap (seconds)<input id="minGap" type="number" min="10" value="${esc(g.minGapSeconds ?? 60)}"></label>
        <label class="field">Max gap (seconds)<input id="maxGap" type="number" min="10" value="${esc(g.maxGapSeconds ?? 180)}"></label>
      </div>
      <label class="check" style="margin-top:var(--s4)">
        <input type="checkbox" id="footerEnabled" ${g.footerEnabled ? "checked" : ""}>
        Append an opt-out footer to every email</label>
      <textarea id="footerText" rows="2" aria-label="Opt-out footer text" placeholder="e.g. I'm Ozan at WearSide Labs, Durham. Reply 'no thanks' and I won't write again."
        style="margin-top:var(--s2)">${esc(g.footerText ?? "")}</textarea>
      <p class="card-note">Off by default. UK PECR expects an identifiable sender and a way to opt
        out for B2B cold email — it's one checkbox if you want it.</p>
      <div class="row" style="margin-top:var(--s3)"><button class="btn ghost" id="btnSaveSending">Save limits</button></div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Never contact</h2><span class="tag">${num(sup.length)}</span></div>
      <div class="row">
        <input id="supPattern" aria-label="Address or domain to never contact" placeholder="someone@example.com or @example.com" style="flex:1;min-width:200px">
        <button class="btn ghost" id="btnSuppress">${icon("plus")} Add</button>
      </div>
      <p class="card-note">Checked again at the moment of sending, not just when you approve.
        Start with @ to block a whole domain.</p>
      ${sup.length ? `<div class="tablewrap" style="margin-top:var(--s3)"><table>
        <thead><tr><th>Pattern</th><th style="width:110px">Reason</th><th style="width:130px">Added</th><th style="width:80px"></th></tr></thead>
        <tbody>${sup.map((x) => `<tr><td class="mono">${esc(x.pattern)}</td>
          <td><span class="tag">${esc(x.reason)}</span></td>
          <td class="cellsub">${esc(ago(x.created_at))}</td>
          <td><button class="btn sm ghost" data-unsup="${esc(x.id)}">Remove</button></td></tr>`).join("")}
        </tbody></table></div>` : ""}
    </div>
  `);

  $("#btnRepair")?.addEventListener("click", async () => {
    if (!confirm("Resolve references that point at something no longer in the database?\n\nRows whose reference is optional are kept and the reference cleared; only genuinely unreachable rows are deleted. This cannot be undone.")) return;
    try { const r = await api("/api/integrity/repair", {}); toast(`Resolved ${r.resolved} dangling reference(s)`); renderSettings(); }
    catch (e) { fail(e); }
  });
  $("#btnProbe").onclick = async () => { try { await api("/api/models/probe", {}); toast("Probing models…"); } catch (e) { fail(e); } };
  $("#btnTest").onclick = async () => {
    const b = $("#btnTest"); b.disabled = true; $("#testResult").textContent = "Testing…";
    try {
      const res = await api("/api/settings/test", { smtp: {
        user: $("#smtpUser").value.trim(), password: $("#smtpPass").value || undefined,
        fromName: $("#smtpFromName").value, fromEmail: $("#smtpUser").value.trim(),
        host: $("#smtpHost").value.trim(), port: +$("#smtpPort").value,
        secure: +$("#smtpPort").value === 465, imapHost: $("#imapHost").value.trim(),
      } });
      $("#testResult").innerHTML =
        `SMTP ${res.smtp.ok ? `<span class="tag ok">ok</span>` : `<span class="tag bad">${esc(res.smtp.error)}</span>`}
         IMAP ${res.imap.ok ? `<span class="tag ok">ok</span>` : `<span class="tag warn">${esc(res.imap.error)}</span>`}`;
      if (res.smtp.ok) { toast("Mailbox connected"); loadHealth(); }
    } catch (e) { fail(e); $("#testResult").textContent = ""; }
    finally { b.disabled = false; }
  };
  $("#btnSendTest")?.addEventListener("click", async () => {
    if (!confirm(`Send one test message to ${m.user}?\n\nIt goes to your own address only, and is not recorded against your daily cap.`)) return;
    const b = $("#btnSendTest"); b.disabled = true; b.innerHTML = `<span class="spinner"></span> Sending…`;
    try { const r = await api("/api/settings/send-test", {}); toast(`Sent to ${r.to} — check your inbox`); }
    catch (e) { fail(e); }
    finally { b.disabled = false; b.innerHTML = `${icon("send")} Send a test to myself`; }
  });
  $("#btnSaveSending").onclick = async () => {
    try {
      await api("/api/settings", { sending: {
        dailyLimit: +$("#dailyLimit").value, minGapSeconds: +$("#minGap").value,
        maxGapSeconds: +$("#maxGap").value, footerEnabled: $("#footerEnabled").checked,
        footerText: $("#footerText").value,
      } });
      toast("Saved");
    } catch (e) { fail(e); }
  };
  $("#btnSuppress").onclick = async () => {
    const p = $("#supPattern").value.trim(); if (!p) return;
    try { await api("/api/suppression", { pattern: p, reason: "manual" }); toast("Added"); renderSettings(); }
    catch (e) { fail(e); }
  };
  $$("[data-unsup]").forEach((b) => b.onclick = async () => {
    await api(`/api/suppression/${b.dataset.unsup}/delete`, {}); renderSettings();
  });
}

/* ───────────────────────────────────────────────────────── activity */

async function renderActivity() {
  const failedOnly = S.filter === "failed";
  const rows = await api(`/api/llm-calls${failedOnly ? "?failed=1" : ""}`);
  $("#content").innerHTML = page(
    rows.length ? `<div class="tablewrap"><table>
      <thead><tr><th>Task</th><th style="width:180px">Model</th><th>Result</th>
        <th class="num" style="width:70px">ms</th><th style="width:110px">When</th></tr></thead>
      <tbody class="stagger">${rows.map((r) => `<tr>
        <td><span class="cellmain">${esc(r.task)}</span>
          ${r.search_calls ? `<div class="cellsub">${r.search_calls} web search${r.search_calls > 1 ? "es" : ""}</div>` : ""}</td>
        <td class="mono cellsub">${esc(r.model_id)}</td>
        <td>${r.ok ? `<span class="tag ok">ok</span>` : `<span class="tag bad">${esc(r.error_code ?? "failed")}</span>`}
          ${r.attempts > 1 ? `<span class="tag warn">${r.attempts} attempts</span>` : ""}
          ${r.repaired ? `<span class="tag">repaired</span>` : ""}
          ${!r.ok && r.response_text ? `<details><summary>raw output</summary>
            <div class="letter-text mono" style="font-size:11.5px;margin-top:var(--s2)">${esc(r.response_text)}</div></details>` : ""}
          ${r.error_message && !r.ok ? `<div class="cellsub" style="color:var(--bad)">${esc(r.error_message.slice(0, 110))}</div>` : ""}</td>
        <td class="num">${num(r.duration_ms)}</td>
        <td class="cellsub">${esc(ago(r.created_at))}</td></tr>`).join("")}</tbody>
    </table></div>` : empty("graph-up", "No model calls yet", "Every call is logged here, including what a failed one returned."),
    `<label class="check"><input type="checkbox" id="failedOnly" ${failedOnly ? "checked" : ""}> Failures only</label>`);
  $("#failedOnly").onchange = (e) => { S.filter = e.target.checked ? "failed" : ""; renderActivity(); };
}

/* ───────────────────────────────────────────────────────── dialogs */

function modal(title, bodyHtml, onConfirm, confirmLabel = "Save") {
  $("#modal").innerHTML = `
    <div class="scrim" id="scrim">
      <div class="palette" role="dialog" aria-modal="true" aria-label="${esc(title)}" style="width:min(620px,94vw)">
        <div style="padding:var(--s5)">
          <h2 style="margin-bottom:var(--s4);font-family:var(--display);font-size:16px">${esc(title)}</h2>
          <div id="modalBody">${bodyHtml}</div>
          <div class="row" style="margin-top:var(--s5);justify-content:flex-end">
            <button class="btn ghost" id="mCancel">Cancel</button>
            <button class="btn" id="mOk">${esc(confirmLabel)}</button>
          </div>
        </div>
      </div>
    </div>`;
  const close = () => { $("#modal").innerHTML = ""; };
  $("#mCancel").onclick = close;
  $("#scrim").onclick = (e) => { if (e.target.id === "scrim") close(); };
  $("#modalBody").querySelector("input,textarea,select")?.focus();
  $("#mOk").onclick = async () => {
    const b = $("#mOk"); b.disabled = true; b.innerHTML = `<span class="spinner"></span>`;
    try { await onConfirm(); close(); } catch (e) { fail(e); b.disabled = false; b.textContent = confirmLabel; }
  };
  document.addEventListener("keydown", function esckey(e) {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", esckey); }
  });
}

function newCampaignDialog() {
  modal("New campaign", `
    <label class="field">Name<input id="cName" placeholder="Durham trades" autofocus></label>
    <label class="field" style="margin-top:var(--s3)">What do you want from this email?
      <input id="cGoal" placeholder="15 minutes to talk about rebuilding their website"></label>
    <label class="field" style="margin-top:var(--s3)">Who are you looking for?
      <textarea id="cTarget" rows="3" placeholder="e.g. small independent local news websites that publish sports coverage — not clubs or academies"></textarea></label>
    <p class="card-note" style="margin-top:var(--s2)">Be specific about the <b>kind</b> of
      organisation. This is what discovery filters on, and it's how a search for news sites
      avoids coming back full of sports clubs.</p>
    <div class="grid2" style="margin-top:var(--s4)">
      <label class="field">How to find them<select id="cMode">
        <option value="opencode_search">Search the web (free)</option>
        <option value="manual">I'll paste a list</option></select></label>
      <label class="field">People per company<input id="cContacts" type="number" min="1" max="5" value="3"></label>
    </div>
    <label class="check" style="margin-top:var(--s3)">
      <input type="checkbox" id="cInferred"> Allow guessed addresses (first.last@) when nobody publishes one</label>`,
    async () => {
      const c = await api("/api/campaigns", {
        name: $("#cName").value.trim() || "Untitled campaign",
        goal: $("#cGoal").value.trim(), target_description: $("#cTarget").value.trim(),
        discovery_mode: $("#cMode").value, contacts_per_company: +$("#cContacts").value,
        allow_inferred_emails: $("#cInferred").checked,
      });
      S.campaign = c.id; toast("Campaign created"); go("campaigns");
    }, "Create");
}

function campaignSettingsDialog(camp) {
  modal("Campaign settings", `
    <label class="field">Name<input id="sName" value="${esc(camp.name)}"></label>
    <label class="field" style="margin-top:var(--s3)">The ask<input id="sGoal" value="${esc(camp.goal ?? "")}"></label>
    <label class="field" style="margin-top:var(--s3)">Who you're looking for
      <textarea id="sTarget" rows="3">${esc(camp.target_description ?? "")}</textarea></label>
    <div class="grid2" style="margin-top:var(--s4)">
      <label class="field">People per company<input id="sContacts" type="number" min="1" max="5" value="${esc(camp.contacts_per_company)}"></label>
      <label class="field">Daily send cap<input id="sCap" type="number" min="1" value="${esc(camp.daily_send_limit)}"></label>
    </div>
    <label class="check" style="margin-top:var(--s3)">
      <input type="checkbox" id="sInferred" ${camp.allow_inferred_emails ? "checked" : ""}>
      Allow guessed addresses when nobody publishes one</label>
    <details style="margin-top:var(--s5)">
      <summary style="color:var(--bad)">Delete this campaign</summary>
      <p class="card-note">Removes its drafts, send log and replies. The companies and the facts
        researched about them are kept — they are shared with your other campaigns.</p>
      <div class="row">
        <input id="sConfirm" aria-label="Type the campaign name to confirm"
          placeholder="Type &ldquo;${esc(camp.name)}&rdquo; to confirm" style="flex:1;min-width:200px">
        <button class="btn danger" id="btnDeleteCamp">Delete</button>
      </div>
    </details>`,
    async () => {
      await api(`/api/campaigns/${camp.id}/settings`, {
        name: $("#sName").value, goal: $("#sGoal").value, target_description: $("#sTarget").value,
        contacts_per_company: +$("#sContacts").value, daily_send_limit: +$("#sCap").value,
        allow_inferred_emails: $("#sInferred").checked ? 1 : 0,
      });
      toast("Saved"); go("campaigns");
    });
  $("#btnDeleteCamp")?.addEventListener("click", async () => {
    try {
      const r = await api(`/api/campaigns/${camp.id}/delete`, { confirm: $("#sConfirm").value });
      toast(`Deleted — ${r.removed.companies} companies unlinked, ${r.removed.drafts} drafts removed`);
      $("#modal").innerHTML = "";
      S.campaign = null;
      go("campaigns");
    } catch (e) { fail(e); }
  });
}

function exportDialog(campaignId) {
  modal("Export CSV", `
    <p class="card-note" style="margin-top:0">Downloads to your machine. Nothing is uploaded.</p>
    <div class="row" style="margin-top:var(--s3)">
      ${[["companies", "Companies"], ["contacts", "Contacts"], ["drafts", "Drafts"], ["sends", "Send log"]]
        .map(([k, l]) => `<a class="btn ghost" href="/api/campaigns/${encodeURIComponent(campaignId)}/export/${k}"
          download>${icon("download")} ${l}</a>`).join("")}
    </div>`,
    async () => {}, "Done");
}

async function showCompany(ccId) {
  let d;
  try { d = await api(`/api/companies/${ccId}`); } catch (e) { return fail(e); }
  modal(d.name, `
    <div class="row" style="margin-top:0">
      <a class="mono" href="${esc(d.website_url ?? "#")}" target="_blank" rel="noreferrer noopener">${esc(d.domain)} ${icon("open-new-window")}</a>
      <span class="tag ${d.status === "failed" || d.status === "rejected" ? "bad" : ""}">${esc(d.status)}</span>
      ${d.relevance_score != null ? `<span class="tag">fit ${Math.round(d.relevance_score * 100)}</span>` : ""}
    </div>
    ${d.summary ? `<p class="card-note">${esc(d.summary)}</p>` : ""}
    ${d.rejected_reason ? `<div class="flagbox" style="margin-top:var(--s3)">${esc(d.rejected_reason)}</div>` : ""}

    <div class="stat-label" style="margin-top:var(--s4)">${icon("shield-check")} Facts (${d.claims.filter((c) => c.verified).length} verified of ${d.claims.length})</div>
    ${d.claims.length ? d.claims.map((c) => `<div class="cite" style="border-color:${c.verified ? "var(--ok)" : "var(--bad)"}">
      <b>${c.verified ? "" : `<span class="tag bad">rejected</span> `}${esc(c.claim)}</b><q>${esc(c.quote)}</q><br>
      <a href="${esc(c.source_url)}" target="_blank" rel="noreferrer noopener">source</a>
      <span class="mono" style="opacity:.7"> ${esc(c.verify_method)} ${c.verify_score != null ? Math.round(c.verify_score * 100) + "%" : ""}</span>
    </div>`).join("") : `<p class="card-note">Not researched yet.</p>`}

    <div class="stat-label" style="margin-top:var(--s4)">${icon("mail")} Contacts</div>
    ${d.contacts.length ? `<div class="tablewrap" style="margin-top:var(--s2)"><table><tbody>
      ${d.contacts.map((c) => `<tr><td class="mono">${esc(c.email)}</td>
        <td>${esc(c.full_name ?? "")} ${esc(c.title ?? "")}</td>
        <td><span class="tag ${c.source_kind === "published" ? "ok" : c.source_kind === "inferred" || c.source_kind === "manual" ? "warn" : ""}">${esc(c.source_kind)}</span></td>
        <td><a href="${esc(c.source_url)}" target="_blank" rel="noreferrer noopener">page</a></td>
        <td><button class="btn sm ghost" data-draftfor="${esc(c.id)}">Write email</button></td></tr>`).join("")}
    </tbody></table></div>` : `<p class="card-note">${esc(d.error_code === "CONTACT_FORM_ONLY"
        ? "They publish no address - enquiries go through a form on their site."
        : "No publishable address was found on their site.")}</p>`}

    <details style="margin-top:var(--s3)"><summary>Add a contact by hand</summary>
      <div class="grid2" style="margin-top:var(--s2)">
        <label class="field">Email<input id="mcEmail" type="email" placeholder="name@company.com"></label>
        <label class="field">Name (optional)<input id="mcName" placeholder="Jane Smith"></label>
        <label class="field">Title (optional)<input id="mcTitle" placeholder="Editor"></label>
      </div>
      <div class="row"><button class="btn ghost sm" id="btnAddContact">${icon("plus")} Add contact</button>
        <span class="cellsub">Recorded as added by hand, not as something they published.</span></div>
    </details>

    ${(() => { let n = []; try { n = JSON.parse(d.contact_notes || "[]"); } catch { n = []; }
      return n.length ? `<div class="stat-label" style="margin-top:var(--s4)">${icon("list")} What happened when looking for contacts</div>
        ${n.map((x) => `<div class="cellsub" style="padding:2px 0">${esc(x)}</div>`).join("")}` : ""; })()}

    ${d.status === "failed" || d.status === "rejected" ? `<div class="row" style="margin-top:var(--s4)">
      <button class="btn ghost" id="btnRetryCo">${icon("refresh")} Try this company again</button>
      <span class="cellsub">Clears the cached pages and puts it back in the queue.</span></div>` : ""}

    <details style="margin-top:var(--s4)"><summary>${d.pages.length} pages fetched</summary>
      ${d.pages.map((p) => `<div class="cellsub mono"><a href="${esc(p.url)}" target="_blank" rel="noreferrer noopener">${esc(p.url)}</a></div>`).join("")}
    </details>`,
    async () => {}, "Close");
  $("#btnAddContact")?.addEventListener("click", async () => {
    try {
      await api(`/api/companies/${ccId}/contacts`, {
        email: $("#mcEmail").value, full_name: $("#mcName").value, title: $("#mcTitle").value,
      });
      toast("Contact added"); $("#modal").innerHTML = ""; renderCampaigns();
    } catch (e) { fail(e); }
  });
  $$("[data-draftfor]").forEach((b) => b.onclick = async () => {
    try { await api(`/api/companies/${ccId}/draft/${b.dataset.draftfor}`, {}); toast("Writing the email…"); $("#modal").innerHTML = ""; }
    catch (e) { fail(e); }
  });
  $("#btnRetryCo")?.addEventListener("click", async () => {
    try { await api(`/api/companies/${ccId}/retry`, {}); toast("Queued for another try"); $("#modal").innerHTML = ""; renderCampaigns(); }
    catch (e) { fail(e); }
  });
}

/* ───────────────────────────────────────────────────────── health + events */

async function loadHealth() {
  try {
    const h = await api("/api/health");
    S.health = h;
    const dot = $("#hDot"), text = $("#hText"), banner = $("#banner");
    const oc = h.opencode.status;
    let cls = "dot", label = "";
    if (oc === "not_installed") { cls = "dot bad"; label = "opencode missing"; }
    else if (oc === "starting") { cls = "dot warn pulse"; label = "starting opencode…"; }
    else if (oc !== "ready") { cls = "dot bad"; label = `opencode ${oc}`; }
    else if (h.model.writing.status !== "ok") { cls = "dot warn"; label = "no model"; }
    else if (!h.smtp.configured) { cls = "dot warn"; label = "mailbox not set up"; }
    else { cls = "dot ok"; label = "all systems ready"; }
    dot.className = cls; text.textContent = label;

    if (oc === "not_installed") {
      banner.className = "banner";
      banner.innerHTML = `${icon("warning-triangle")} opencode isn't installed. Run
        <code class="mono">curl -fsSL https://opencode.ai/install | bash</code> then restart coldcall.`;
    } else if (oc === "ready" && h.model.writing.status !== "ok") {
      banner.className = "banner warn";
      banner.innerHTML = `${icon("warning-triangle")} No usable model. Run
        <code class="mono">opencode auth login</code> in a terminal, then re-probe.
        <button class="btn sm ghost" id="bannerProbe">Re-probe</button>`;
    } else banner.className = "banner hidden";
    $("#bannerProbe")?.addEventListener("click", () => api("/api/models/probe", {}).then(() => toast("Probing…")));

    const jobs = h.jobs ?? [];
    $("#jobbar").classList.toggle("hidden", jobs.length === 0);
    if (jobs.length) $("#jobText").textContent = jobs.map((j) => j.label).join(" · ");

    // Badges live on the nav, so keep the counts fresh without a full stats fetch.
    if (!S.stats) S.stats = {};
    Object.assign(S.stats, {
      needsReview: h.review?.needsReview ?? S.stats.needsReview ?? 0,
      approvedWaiting: h.sending?.approved ?? S.stats.approvedWaiting ?? 0,
      repliesUnhandled: h.replies?.unhandled ?? S.stats.repliesUnhandled ?? 0,
    });
    renderNav();
  } catch { $("#hDot").className = "dot bad"; $("#hText").textContent = "server unreachable"; }
}

function connectEvents() {
  const ev = new EventSource("/api/events");
  const bar = $("#jobbar"), prog = $("#jobProgress");
  ev.addEventListener("job:start", (e) => {
    const d = JSON.parse(e.data);
    bar.classList.remove("hidden"); $("#jobText").textContent = d.label; prog.classList.add("hidden");
  });
  ev.addEventListener("job:end", () => { bar.classList.add("hidden"); prog.classList.add("hidden"); loadHealth(); });
  ev.addEventListener("job:error", (e) => { const d = JSON.parse(e.data); toast(`${d.label}: ${d.error}`, true); });
  ev.addEventListener("job:done", (e) => {
    const { label, result: r = {} } = JSON.parse(e.data);
    if (r.drafts !== undefined) toast(`Done — ${r.enriched} researched, ${r.contacts} contacts, ${r.drafts} drafts`);
    else if (r.added !== undefined) toast(`${label}: ${r.added} added${r.skipped?.length ? `, ${r.skipped.length} skipped` : ""}`);
    else if (r.matched !== undefined) toast(`${r.matched} repl${r.matched === 1 ? "y" : "ies"} matched`);
    else toast(`${label} finished`);
    if (["campaigns", "review", "dashboard", "outbox", "replies"].includes(S.route)) render();
  });
  ev.addEventListener("run:progress", (e) => {
    const d = JSON.parse(e.data);
    bar.classList.remove("hidden");
    $("#jobText").textContent = `${d.index}/${d.total} · ${d.company ?? ""} — ${d.stage}`;
    prog.classList.remove("hidden");
    prog.querySelector("i").style.clipPath = `inset(0 ${100 - (d.index / d.total * 100)}% 0 0)`;
  });
  ev.addEventListener("companies:changed", () => { if (S.route === "campaigns") renderCampaigns(); });
  ev.addEventListener("drafts:changed", () => { if (S.route === "review") renderReview(); loadHealth(); });
  ev.addEventListener("replies:changed", () => { if (S.route === "replies") renderReplies(); loadHealth(); });
  ev.addEventListener("models:changed", () => { loadHealth(); if (S.route === "settings") renderSettings(); });
  ev.onerror = () => { /* EventSource reconnects on its own */ };
}

/* ───────────────────────────────────────────────────────── boot */

async function boot() {
  // Load the icon sprite before first paint so nothing flashes an empty box.
  try { $("#sprite").innerHTML = await (await fetch("/icons.svg")).text(); } catch { /* icons degrade to blanks */ }

  let theme = "system", collapsed = "0";
  try { theme = localStorage.getItem("cc-theme") || "system"; collapsed = localStorage.getItem("cc-collapsed") || "0"; } catch { /* ignore */ }
  applyTheme(theme);
  $("#app").dataset.collapsed = collapsed;
  $("#kbdHint").textContent = isMac ? "⌘K" : "Ctrl K";

  $("#themeBtn").onclick = cycleTheme;
  $("#collapseBtn").onclick = toggleCollapse;
  $("#searchBtn").onclick = openPalette;
  $("#healthBtn").onclick = () => go("settings");

  connectEvents();
  await loadHealth();

  try { S.campaigns = await api("/api/campaigns"); } catch { /* shown by health */ }
  try { S.product = await api("/api/product"); } catch { /* optional */ }

  const [hashRoute, hashCampaign] = location.hash.replace(/^#/, "").split("/");
  if (hashCampaign) S.campaign = hashCampaign;
  if (!S.campaign && S.campaigns.length) S.campaign = S.campaigns[0].id;
  go(TITLES[hashRoute] ? hashRoute : "dashboard");

  // Without this, the browser back button and any direct #hash link silently do nothing:
  // the URL changes and the page keeps rendering whatever it was already showing.
  addEventListener("hashchange", () => {
    const [route, campaign] = location.hash.replace(/^#/, "").split("/");
    if (campaign && campaign !== S.campaign) S.campaign = campaign;
    if (TITLES[route] && route !== S.route) go(route);
  });

  setInterval(loadHealth, 6000);
}

boot();
