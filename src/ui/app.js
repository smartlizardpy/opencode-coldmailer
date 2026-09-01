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
/** How long until `ts`, in the largest unit that still reads naturally. */
function until(ts) {
  const s = Math.round((ts - Date.now()) / 1000);
  if (s <= 60) return "under a minute";
  if (s < 3600) return `${Math.round(s / 60)} minutes`;
  if (s < 86400) { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h} hour${h === 1 ? "" : "s"}`; }
  const d = Math.round(s / 86400);
  return `${d} day${d === 1 ? "" : "s"}`;
}
const dt = (ts) => ts ? new Intl.DateTimeFormat(undefined,
  { dateStyle: "medium", timeStyle: "short" }).format(ts) : "—";

/* ───────────────────────────────────────────────────────── state + api */

const S = {
  route: "dashboard", campaign: null, health: null, stats: null,
  /* Which surface this browser is on. "local" is the machine running coldcall and can do
     everything; "shared" is a teammate on the tunnel URL. The server enforces this - what the
     UI does with it is avoid offering buttons that would come back 403. */
  surface: "local", role: "owner", sessionLabel: null,
  // When run:progress last wrote to the job bar, so the health poll does not overwrite it.
  lastProgressAt: 0,
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
/**
 * `action` puts one button in the toast - used for undo, which only makes sense in the moment
 * it appears. It gets a longer life than a plain message, because three seconds is not enough
 * to notice you did the wrong thing and reach for the mouse.
 */
function toast(msg, bad = false, action) {
  const t = $("#toast");
  t.className = `toast${bad ? " bad" : ""}`;
  t.textContent = msg;
  if (action) {
    const b = document.createElement("button");
    b.className = "toast-action";
    b.textContent = action.label;
    b.onclick = () => { t.classList.add("hidden"); action.run(); };
    t.append(b);
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), action ? 9000 : bad ? 7000 : 3200);
}
const fail = (e) => { console.error(e); toast(e?.message || String(e), true); };

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TZ_NAME = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "this machine's clock"; }
  catch { return "this machine's clock"; }
})();
const hourOptions = (selected) => Array.from({ length: 24 }, (_, h) =>
  `<option value="${h}" ${h === selected ? "selected" : ""}>${String(h).padStart(2, "0")}:00</option>`).join("");

/* ───────────────────────────────────────────────────────── navigation */

/* `shared: true` means the item also appears on the tunnel URL. Everything else is the
   owner's: it either reads a credential, changes how this machine sends, or edits the brief
   that every draft is written from. */
const NAV = [
  { group: "Overview", items: [
    { id: "dashboard", label: "Dashboard", icon: "view-grid", shared: true },
  ]},
  { group: "Pipeline", items: [
    { id: "campaigns", label: "Campaigns", icon: "binocular", shared: true },
    { id: "review", label: "Review", icon: "page-edit", badge: "needsReview", tone: "attn", shared: true },
    { id: "outbox", label: "Outbox", icon: "send", badge: "approvedWaiting", shared: true },
    { id: "replies", label: "Replies", icon: "message-text", badge: "repliesUnhandled", tone: "attn", shared: true },
  ]},
  { group: "Setup", items: [
    { id: "product", label: "Product", icon: "building" },
    { id: "deliverability", label: "Deliverability", icon: "shield-check", badge: "deliverabilityIssues", tone: "attn", shared: true },
    { id: "settings", label: "Settings", icon: "settings" },
  ]},
  { group: "System", items: [
    { id: "shared", label: "Shared access", icon: "user", badge: "sharedLive" },
    { id: "activity", label: "Activity", icon: "graph-up" },
  ]},
];

const isOwner = () => S.role === "owner";
/** Routes this surface may open at all. A hash link to Settings on the tunnel goes nowhere. */
const canOpen = (route) => isOwner() || NAV.some((g) => g.items.some((i) => i.id === route && i.shared)) || route === "campaign-new";

const TITLES = {
  dashboard: ["Dashboard", "What needs your attention, and whether anything is broken."],
  campaigns: ["Campaigns", "Find companies, research them, and write the emails."],
  review:    ["Review", "Every personalised claim shows the page it came from. Nothing sends without you."],
  outbox:    ["Outbox", "Approved emails, the daily cap, and scheduled follow-ups."],
  replies:   ["Replies", "Matched to the thread they answer. Draft a response or write your own."],
  product:   ["Product", "What you sell, in your own words. Everything downstream reads this."],
  deliverability: ["Deliverability", "Whether your mail will be accepted before anyone decides whether to read it."],
  settings:  ["Settings", "Mailbox, models, sending limits and the never-contact list."],
  activity:  ["Activity", "Every model call, including the ones that failed and what they returned."],
  "campaign-new": ["New campaign", "One kind of organisation, one ask. Both are worth getting right before anything is searched."],
  shared:    ["Shared access", "Everything done through the shared link, on the machine it was done to."],
};

function renderNav() {
  const st = S.stats ?? {};
  const groups = NAV
    .map((g) => ({ ...g, items: g.items.filter((it) => isOwner() || it.shared) }))
    .filter((g) => g.items.length);
  $("#nav").innerHTML = groups.map((g) => `
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
  // A hash link, a bookmark or a palette entry from the owner's machine can name a route this
  // surface has no business opening. Send it home rather than rendering a screen whose every
  // request will come back 403.
  if (!canOpen(route)) route = "dashboard";
  // Leaving the Shared access screen stops the watch heartbeat, so the co-founder's "someone is
  // watching" note goes out within a few seconds rather than lingering after you look away.
  if (S.route === "shared" && route !== "shared") stopWatchHeartbeat();
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
/* Light by default rather than following the OS. This is a tool for reading and editing text
   all day, and the person it was built for asked for light. The toggle still cycles
   light -> dark -> system, and whatever is picked is remembered. */
const DEFAULT_THEME = "light";


/**
 * `persist` is the whole point of this signature.
 *
 * Boot used to save whatever it applied, so the old default of "system" got written to storage
 * on the first ever page load - as if it had been chosen. Changing the default then had no
 * effect on anyone who had already opened the app once, because their storage said "system"
 * and the code could not tell that apart from a real preference. Only an actual click writes.
 */
function applyTheme(mode, persist = false) {
  if (mode === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", mode);
  if (persist) { try { localStorage.setItem("cc-theme", mode); } catch { /* private mode */ } }
  const cur = mode === "system"
    ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : mode;
  $("#themeBtn").innerHTML = `<svg aria-hidden="true"><use href="#i-${cur === "dark" ? "sun-light" : "half-moon"}"/></svg>`;
  $("#themeBtn").title = `Theme: ${mode}`;
}
function cycleTheme() {
  let cur = DEFAULT_THEME;
  try { cur = localStorage.getItem("cc-theme") || DEFAULT_THEME; } catch { /* ignore */ }
  const next = { system: "light", light: "dark", dark: "system" }[cur] ?? "light";
  applyTheme(next, true);
  toast(`Theme: ${next}`);
}

/* ───────────────────────────────────────────────────────── command palette */

function paletteCommands() {
  const cmds = [
    ...Object.entries(TITLES)
      .filter(([id]) => id !== "campaign-new" && canOpen(id))
      .map(([id, [label]]) => ({
        label: `Go to ${label}`, icon: "arrow-right", hint: "Navigate", run: () => go(id),
      })),
    { label: "New campaign", icon: "plus", hint: "Campaign", run: () => go("campaign-new") },
    { label: "Check for replies now", icon: "refresh", hint: "Replies", run: async () => { await api("/api/replies/poll", {}); toast("Checking…"); } },
    ...(isOwner() ? [
      { label: "Re-probe models", icon: "refresh", hint: "Settings", run: async () => { await api("/api/models/probe", {}); toast("Probing…"); } },
    ] : []),
    { label: "Toggle theme", icon: "half-moon", hint: "View", run: cycleTheme },
    { label: "Collapse sidebar", icon: "menu", hint: "View", run: toggleCollapse },
  ];
  for (const c of S.campaigns) {
    cmds.push({ label: `Open campaign: ${c.name}`, icon: "binocular", hint: `${c.companies} companies`,
      run: () => { S.campaign = c.id; go("campaigns"); } });
  }
  for (const co of S.companies.slice(0, 200)) {
    cmds.push({ label: co.name, icon: "building", hint: co.domain,
      run: () => { go("campaigns"); setTimeout(() => showCompany(co.id), 80); } });
  }
  return cmds;
}

let paletteState = null;
async function openPalette() {
  // The palette offers to search companies, so it has to have them - they are otherwise only
  // loaded by the Campaigns screen, and searching from anywhere else found nothing.
  if (!S.companies.length && S.campaign) {
    try { S.companies = await api(`/api/campaigns/${S.campaign}/companies`); } catch { /* search fewer things */ }
  }
  if (!S.campaigns.length) {
    try { S.campaigns = await api("/api/campaigns"); } catch { /* search fewer things */ }
  }
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
    // `a` approves and `u` takes it back, so the whole review pass stays on the keyboard -
    // including the correction. Reaching for the mouse to undo defeats the point of the queue.
    if (e.key === "a" && d) { e.preventDefault(); approveDraft(d.draft_id); }
    if (e.key === "u" && d) { e.preventDefault(); unapproveDraft(d.draft_id); }
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
    ["u", "Put an approved draft back in review"],
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
    settings: renderSettings, activity: renderActivity, deliverability: renderDeliverability,
    "campaign-new": renderNewCampaign, shared: renderShared,
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
    signed: !!health.identity?.signed,
    campaign: stats.campaigns > 0,
  };
  // Every item on this list is fixed in Settings or Product, neither of which the shared
  // surface has. A checklist you cannot act on is just a list of things wrong with you.
  const setupLeft = isOwner() ? Object.values(setupDone).filter((v) => !v).length : 0;

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
           ["Sign your emails", "product", "signed", "Your name and business, at the bottom of every one"],
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
        <div class="stat-label">${icon("graph-up")} Replies</div>
        <div class="stat-value">${
          // A percentage from a handful of sends is noise wearing a number's clothes.
          // "100%" from one send is true arithmetic and a completely false impression.
          stats.replyRateIsMeaningful ? pct(stats.replyRate)
          : stats.funnel.sent ? `${num(stats.funnel.replied)}<small> of ${num(stats.funnel.sent)}</small>`
          : "—"}</div>
        <div class="stat-foot">${
          stats.replyRateIsMeaningful ? `${num(stats.funnel.replied)} of ${num(stats.funnel.sent)} sent`
          : stats.funnel.sent ? `too few sent to be a rate yet`
          : "nothing sent yet"}</div>
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

/**
 * Group the gate's rejections into something readable at a glance.
 *
 * A campaign that rejects most of what it finds is a targeting problem, not a quiet success,
 * and until this existed the only way to notice was to switch to the Rejected filter and read
 * the rows one by one. Showing the KINDS it rejected is what makes a mis-aimed campaign
 * obvious immediately - "23 rejected, mostly tennis academies" says what a count cannot.
 */
function rejectionSummary(companies) {
  const rejected = companies.filter((r) => r.status === "rejected");
  if (rejected.length === 0) return null;
  const kinds = new Map();
  let belowFloor = 0;
  for (const r of rejected) {
    const reason = r.rejected_reason ?? "";
    const m = /this is (?:an?|the) (.+)$/i.exec(reason);
    if (m) kinds.set(m[1].trim(), (kinds.get(m[1].trim()) ?? 0) + 1);
    else if (/below this campaign's floor/i.test(reason)) belowFloor++;
    else kinds.set("unclear", (kinds.get("unclear") ?? 0) + 1);
  }
  return {
    total: rejected.length,
    belowFloor,
    kinds: [...kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
    overridden: companies.filter((r) => r.gate_override).length,
  };
}

async function renderCampaigns() {
  S.campaigns = await api("/api/campaigns");
  if (!S.campaign && S.campaigns.length) S.campaign = S.campaigns[0].id;
  renderCrumb();

  if (!S.campaigns.length) {
    $("#content").innerHTML = page(empty("binocular", "No campaigns yet",
      "A campaign is one audience and one ask. Describe who you want to reach and what you want from them.",
      `<button class="btn" id="btnNewCampaign">${icon("plus")} New campaign</button>`));
    $("#btnNewCampaign").onclick = () => go("campaign-new");
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
        ${isOwner() ? `<button class="btn ghost sm" id="btnDeleteCampaign" title="Delete this campaign">${icon("trash")}</button>` : ""}
        <span style="margin-left:auto" class="tag">${esc(camp.status)}</span>
      </div>
      ${camp.goal ? `<div class="card-note"><b>Ask:</b> ${esc(camp.goal)}</div>` : ""}
      ${camp.target_description ? `<div class="card-note"><b>Looking for:</b> ${esc(camp.target_description)}</div>`
        : `<div class="card-note" style="color:var(--warn)">No target set — discovery will fall back to your product's own customer profile, which is usually not who you want for a partner or press campaign.</div>`}
      ${(() => {
        const rj = rejectionSummary(S.companies);
        if (!rj) return "";
        const share = Math.round((rj.total / Math.max(1, S.companies.length)) * 100);
        return `<div class="reject-summary${share >= 60 ? " loud" : ""}">
          <div class="rs-head">
            <b>${num(rj.total)} of ${num(S.companies.length)} rejected by the targeting gate</b>
            <button class="btn ghost sm" id="btnSeeRejected">See them</button>
          </div>
          ${rj.kinds.length ? `<ul class="rs-kinds">${rj.kinds.map(([k, n]) =>
            `<li><span class="rs-n mono">${num(n)}</span> ${esc(k)}</li>`).join("")}</ul>` : ""}
          ${rj.belowFloor ? `<div class="card-note">${num(rj.belowFloor)} were the right kind but scored below this campaign's fit floor.</div>` : ""}
          ${rj.overridden ? `<div class="card-note">${num(rj.overridden)} overruled by you.</div>` : ""}
          ${share >= 60 ? `<div class="card-note">Most of what the search found was not the right kind of
            organisation. That usually means the target needs to name the kind more plainly — check one
            site above to see how the gate is reading it.</div>` : ""}
        </div>`;
      })()}
    </div>

    <div class="card">
      <div class="card-head"><h2>Find companies</h2></div>
      <div class="row">
        <input id="extraTargeting" aria-label="Extra targeting instructions" placeholder="Optional: narrow it, e.g. 'within 20 miles of Durham'" style="flex:1;min-width:220px">
        <button class="btn" id="btnDiscover">${icon("search")} Search the web</button>
      </div>
      <p class="card-note">This text is saved as what the campaign is looking for, and the
        targeting gate judges every result against it — so be specific about the
        <em>kind</em> of organisation, not just the subject.</p>
      <details>
        <summary>Check one site before running the whole campaign</summary>
        <p class="card-note">Runs the targeting gate against a single site and shows its
          reasoning. Commits nothing, and the page is cached, so running the campaign later
          does not fetch it twice.</p>
        <div class="row">
          <input id="testDomain" aria-label="Domain to test against the targeting gate"
            placeholder="pta.com.tr" style="flex:1;min-width:200px">
          <button class="btn ghost sm" id="btnTestTarget">${icon("shield-search")} Check it</button>
        </div>
        <div id="testResult"></div>
      </details>
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
          ${rows.some((r) => ["drafted", "approved", "sent", "replied"].includes(r.status))
            ? `<button class="btn ghost sm" id="btnRedo" title="Run every ticked company again, including finished ones">${icon("refresh")} Redo</button>` : ""}
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
            <td><span class="tag ${r.status === "failed" || r.status === "rejected" ? "bad" : ["drafted", "sent", "contacts_found"].includes(r.status) ? "ok" : ""}">${esc(r.status)}</span>${
              r.gate_override ? ` <span class="tag warn" title="A person overruled the targeting gate for this company">overruled</span>` : ""}</td>
            <td class="num">${num(r.verified_claims)}</td>
            <td class="num">${num(r.contacts)}</td>
            <td class="rowacts">
              <button class="btn sm ghost" data-detail="${esc(r.id)}" aria-label="Evidence for ${esc(r.name)}" title="Evidence">${icon("eye")}</button>
              ${r.status === "rejected" ? `<button class="btn sm ghost" data-override="${esc(r.id)}"
                   aria-label="Include ${esc(r.name)} anyway, overruling the targeting gate"
                   title="The gate got this one wrong — include it anyway">Include anyway</button>` : ""}
            </td>
          </tr>`).join("")}</tbody></table></div>`
        : empty("binocular", "Nothing here yet",
            S.companies.length ? "No company matches this filter." : "Search the web, or paste a list of domains above.")}
    </div>
  `);

  $("#campSelect").onchange = (e) => { S.campaign = e.target.value; S.filter = ""; go("campaigns"); };
  $("#btnNewCampaign").onclick = () => go("campaign-new");
  $("#btnCampSettings").onclick = () => campaignSettingsDialog(camp);
  $("#btnDeleteCampaign")?.addEventListener("click", () => deleteCampaignDialog(camp));
  $$("[data-override]").forEach((b) => b.onclick = async () => {
    try {
      await api(`/api/companies/${b.dataset.override}/override`, {});
      toast("Included — the gate's verdict is kept on the record");
      renderCampaigns();
    } catch (e) { fail(e); }
  });
  $("#coFilter").oninput = debounce((e) => { S.filter = e.target.value; renderCampaigns(); }, 220);
  $("#coStatus").onchange = (e) => { S.companyFilter = e.target.value; renderCampaigns(); };
  $("#btnExport").onclick = () => exportDialog(camp.id);
  $("#btnDiscover").onclick = async () => {
    try { await api(`/api/campaigns/${camp.id}/discover`, { extra: $("#extraTargeting").value }); toast("Searching the web…"); }
    catch (e) { fail(e); }
  };
  const seeRejected = $("#btnSeeRejected");
  if (seeRejected) seeRejected.onclick = () => {
    S.companyFilter = "rejected";
    renderCampaigns();
  };
  $("#btnTestTarget").onclick = async () => {
    const website = $("#testDomain").value.trim();
    if (!website) return toast("Enter a domain first", true);
    const btn = $("#btnTestTarget"), out = $("#testResult");
    btn.disabled = true;
    out.innerHTML = `<div class="card-note">Fetching and judging ${esc(website)}…</div>`;
    try {
      const r = await api(`/api/campaigns/${camp.id}/test-target`, { website });
      if (r.error) { out.innerHTML = `<div class="flagbox">Could not read that site: ${esc(r.error)}</div>`; return; }
      out.innerHTML = `
        <div class="verdict ${r.wouldPass ? "pass" : "fail"}">
          <div class="verdict-head">
            <span class="tag ${r.wouldPass ? "ok" : "bad"}">${r.wouldPass ? "would be included" : "would be rejected"}</span>
            ${r.fitScore != null ? `<span class="tag">fit ${Math.round(r.fitScore)}</span>` : ""}
            <span class="mono">${esc(r.actualName || website)}</span>
          </div>
          <dl class="verdict-kinds">
            <dt>Looking for</dt><dd>${esc(r.targetKind || "—")}</dd>
            <dt>This site is</dt><dd>${esc(r.entityKind || "—")}</dd>
          </dl>
          ${r.reason ? `<p class="card-note">${esc(r.reason)}</p>` : ""}
          ${r.rejectedReason ? `<p class="card-note" style="color:var(--bad)">${esc(r.rejectedReason)}</p>` : ""}
        </div>`;
    } catch (e) { fail(e); out.innerHTML = ""; } finally { btn.disabled = false; }
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
  $("#btnRedo")?.addEventListener("click", async () => {
    if (!confirm("Run every ticked company again, including the ones already done?\n\nThis re-crawls their sites and rewrites their emails.")) return;
    try { await api(`/api/campaigns/${camp.id}/run`, { redo: true }); toast("Re-running everything…"); } catch (e) { fail(e); }
  });
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
function throttle(fn, ms) { let last = 0; return (...a) => { const n = Date.now(); if (n - last >= ms) { last = n; fn(...a); } }; }

/* ───────────────────────────────────────────────────────── review */

const FLAG_TEXT = {
  no_citations: "Nothing specific to this company is cited",
  too_long: "Longer than a cold email should be",
  too_short: "Very short, so it may be missing the reason or the ask",
  flattery: "Contains empty praise",
  hedging: "The offer is hedged",
  vague_ask: "The ask isn't answerable",
  no_ask: "There's no actual question",
  placeholder: "Contains an unfilled placeholder",
  subject_too_long: "Subject will be truncated",
  subject_question: "Subject is a question",
};

/**
 * Only ever rendered when something is wrong. A green "0 issues" panel on every draft
 * trains the reviewer to skip the box, which is exactly when it needs to be read.
 */
function spamBox(risk) {
  if (!risk) return "";
  const bad = risk.checks.filter((c) => c.severity !== "ok");
  if (!bad.length) return "";
  const critical = bad.some((c) => c.severity === "critical");
  return `<div class="flagbox" ${critical ? 'data-sev="critical"' : ""}>
    ${icon("shield-check")} <b>${critical ? "This will be filtered" : "Filters will notice this"}</b>
    <ul>${bad.map((c) => `<li>${esc(c.detail)}${c.fix ? ` <span style="opacity:.85">${esc(c.fix)}</span>` : ""}</li>`).join("")}</ul>
  </div>`;
}

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

  const unsigned = S.health && !S.health.identity?.signed;
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
      <span class="tag" style="margin-left:auto">${icon("antenna-signal")} j / k to move · a to approve · u to undo · ? for all keys</span>
    </div>
    ${unsigned ? `<div class="flagbox" style="margin-bottom:var(--s5)">
      ${icon("warning-triangle")} <b>These emails have no name at the bottom</b>
      <div>An unsigned message reads as automated, which is the one thing all this research is
      avoiding. ${isOwner()
        ? `Add your name and business on the Product page — it applies to every draft you
           have not sent yet, including the ones already written.
           <button class="btn sm ghost" id="btnGoSign" style="margin-left:var(--s2)">Add it</button>`
        : `The signature is set on the machine running coldcall — ask whoever set this up to add
           it. It then applies to every draft not yet sent, including these.`}</div>
    </div>` : ""}
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
  $("#btnGoSign")?.addEventListener("click", () => go("product"));
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
        ${spamBox(full.deliverability)}
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
        : d.status === "approved" ? `<span class="tag ok">${icon("check")} approved, waiting to send</span>
           <button class="btn ghost" id="btnUnapprove">${icon("refresh")} Put back in review</button>
           <button class="btn ghost" id="btnEdit">${icon("edit-pencil")} Edit</button>`
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
  $("#btnUnapprove")?.addEventListener("click", () => unapproveDraft(d.draft_id));
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
    // Review is driven from the keyboard and `a` moves straight on, so the only moment you
    // realise you approved the wrong one is right now.
    toast("Approved", false, { label: "Undo", run: () => unapproveDraft(id) });
    const at = S.reviewIndex;
    await renderReview();
    selectDraft(Math.min(at, S.drafts.length - 1));
    loadHealth();
  } catch (e) { fail(e); }
}
async function unapproveDraft(id) {
  try {
    await api(`/api/drafts/${id}/unapprove`, {});
    toast("Back in the review queue");
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
    <p class="card-note">Saved as a new version; the original is kept. What you type here is sent
      exactly as written, signature included — editing takes it out of the app's hands.</p>`,
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
          <div class="stat-value" style="font-size:17px">${
            status.paused ? "Paused" : !status.windowOpen ? "Waiting" : status.running ? "Running" : "Idle"}</div>
          <div class="stat-foot">${esc(status.lastOutcome ?? "—")}</div></div>
      </div>
      ${!status.windowOpen ? `<div class="flagbox" style="margin:var(--s4) 0 0">
        ${icon("clock")} <b>Outside your sending window (${esc(status.windowLabel)})</b>
        <div>${status.approved ? `${num(status.approved)} approved email${status.approved === 1 ? "" : "s"} will go out` : "Sending resumes"}
        ${status.windowOpensAt ? `when the window opens, ${esc(until(status.windowOpensAt))} from now — around ${esc(dt(status.windowOpensAt))}.` : "when the window opens."}
        Nothing is queued or lost.</div></div>` : ""}
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

const BOUNCE_TEXT = {
  "5.1.1": "the mailbox does not exist",
  "5.1.2": "the domain does not exist",
  "5.1.3": "the address is malformed",
  "5.2.1": "the mailbox is disabled",
  "5.2.2": "the mailbox is full",
  "5.4.4": "the domain cannot be routed to",
  "5.7.1": "the receiving server refused it on policy grounds",
};

/** The machine mail, kept apart from the people. */
function machineRow(r) {
  const bounced = r.kind === "bounce_hard" || r.kind === "bounce_soft";
  const why = BOUNCE_TEXT[r.bounce_status] ?? (r.kind === "bounce_soft" ? "a temporary failure" : "the delivery failed");
  return `<div class="feed-item">
    <span class="feed-icon ${r.kind === "bounce_hard" ? "bad" : "warn"}">${icon(bounced ? "warning-triangle" : "clock")}</span>
    <span>
      <b>${esc(bounced ? (r.bounced_recipient ?? r.contact_email ?? r.from_email) : r.from_email)}</b>
      ${bounced ? ` — ${esc(why)}` : " sent an automatic reply"}
      ${r.bounce_status ? `<span class="tag" style="margin-left:6px">${esc(r.bounce_status)}</span>` : ""}
      ${r.company ? `<div class="cellsub">${esc(r.company)}</div>` : ""}
    </span>
    <span class="feed-time">${esc(ago(r.received_at))}</span>
  </div>`;
}

async function renderReplies() {
  const all = await api("/api/replies");
  // A bounce is not a reply. Mixing them puts "MAILER-DAEMON" in a list the user reads as
  // people who answered, and hides the one thing a bounce actually needs: being noticed.
  S.replies = all.filter((r) => (r.kind ?? "reply") === "reply");
  const machine = all.filter((r) => (r.kind ?? "reply") !== "reply");
  const hardBounces = machine.filter((r) => r.kind === "bounce_hard").length;

  const machineCard = machine.length ? `<div class="card">
    <div class="card-head"><h2>Delivery problems and automatic replies</h2>
      <span class="cellsub">${num(machine.length)} message${machine.length === 1 ? "" : "s"} from mail systems, not from people.</span></div>
    <div class="feed">${machine.slice(0, 25).map(machineRow).join("")}</div>
    ${hardBounces ? `<p class="card-note" style="margin-top:var(--s3)">
      Addresses that came back as non-existent were added to the never-contact list automatically.
      Continuing to mail a dead mailbox is what costs you a sending reputation.</p>` : ""}
  </div>` : "";

  $("#content").innerHTML = page(
    (S.replies.length ? `<div class="stagger">${S.replies.map((r) => `
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
    : machine.length ? "" : empty("message-text", "No replies yet",
        "Replies are matched to the thread they answer, using the Message-ID we set before sending.",
        `<button class="btn ghost" id="btnPoll">${icon("refresh")} Check now</button>`)) + machineCard,
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

/**
 * The share panel.
 *
 * Deliberately reads as a switch with consequences rather than a feature: it says what the
 * link can do, what it cannot, and how to take it away. The URL is only useful with an invite,
 * and the invite is only shown once - so the copy button matters more than it looks.
 */
function shareCard(share) {
  if (!share) return "";
  const t = share.tunnel ?? {};
  const live = t.status === "ready" && !!t.url;
  const invites = (share.invites ?? []).filter((i) => !i.revoked_at);
  const sessions = share.sessions ?? [];

  return `
    <div class="card share-card" ${live ? 'data-live="1"' : ""}>
      <div class="card-head"><h2>Share with a teammate</h2>
        ${live ? `<span class="tag ok">${icon("check")} link open</span>`
               : t.status === "starting" ? `<span class="tag warn">opening…</span>`
               : `<span class="tag">closed</span>`}
        <span class="card-actions">
          ${live ? `<button class="btn ghost sm" id="btnShareStop">Close the link</button>`
                 : `<button class="btn sm" id="btnShareStart" ${share.cloudflared.installed ? "" : "disabled"}>${icon("globe")} Open the link</button>`}
        </span>
      </div>

      <p class="card-note" style="margin-top:0">Opens a Cloudflare tunnel to this machine and
        gives you a public URL. Whoever holds it, plus an invite, can set campaigns up, research
        companies, read the drafts, approve them and watch the replies. They cannot see your
        mailbox, your app password, your keys or your model settings, and they cannot change how
        this machine sends. It closes when coldcall stops.</p>

      ${!share.cloudflared.installed ? `
        <div class="share-install">
          <div>
            <b>cloudflared isn't installed.</b>
            <div class="cellsub">It's Cloudflare's tunnel client. coldcall can fetch it into
              <code class="mono">~/.coldcall/bin</code>, or install it yourself with
              <code class="mono">${esc(share.cloudflared.hint)}</code>.</div>
          </div>
          <button class="btn ghost sm" id="btnInstallCf">${icon("download")} Get it</button>
        </div>` : ""}

      ${t.status === "failed" && t.error ? `
        <div class="flagbox" data-sev="critical" style="margin-top:var(--s4)">
          <b>The tunnel stopped.</b> ${esc(t.error)}</div>` : ""}

      ${live ? `
        <div class="share-url">
          <span class="rf-label">Link</span>
          <a class="mono" href="${esc(t.url)}" target="_blank" rel="noreferrer">${esc(t.url)}</a>
          <button class="btn ghost sm" data-copy="${esc(t.url)}">Copy</button>
        </div>
        <p class="card-note">On its own this URL gets nobody in — it shows a sign-in screen.
          Send an invite as well.</p>` : ""}

      <div class="share-people">
        <div class="share-people-head">
          <b>Invites</b>
          <button class="btn ghost sm" id="btnInvite">${icon("plus")} Create an invite</button>
        </div>
        ${invites.length ? `<ul class="share-list">${invites.map((i) => `
          <li>
            <span>${esc(i.label)}</span>
            <span class="cellsub">${i.uses ? `used ${num(i.uses)}×` : "not used yet"}${
              i.expires_at ? ` · expires ${esc(when(i.expires_at))}` : ""}</span>
            <button class="btn sm ghost" data-revinvite="${esc(i.id)}">Revoke</button>
          </li>`).join("")}</ul>`
          : `<p class="card-note">None yet. An invite is a one-time code; revoking it signs out
             every device that used it.</p>`}

        <div class="share-people-head" style="margin-top:var(--s4)">
          <b>Signed in</b>
          ${sessions.length ? `<button class="btn ghost sm" id="btnRevokeAll">Sign everyone out</button>` : ""}
        </div>
        ${sessions.length ? `<ul class="share-list">${sessions.map((x) => `
          <li>
            <span>${esc(x.label || "Teammate")}</span>
            <span class="cellsub">${esc(shortAgent(x.user_agent))} · last seen ${esc(ago(x.last_seen_at))}</span>
            <button class="btn sm ghost" data-revsession="${esc(x.id)}">Sign out</button>
          </li>`).join("")}</ul>`
          : `<p class="card-note">Nobody is signed in.</p>`}
      </div>
    </div>`;
}

/**
 * Report this shared-surface tab's cursor, clicks and current screen so the owner can watch it
 * live. Runs only on the shared surface, only for a signed-in teammate.
 *
 * What it sends: where the pointer is (as a fraction of the window, so it renders at any size),
 * clicks, the current screen, and the LABEL of whatever field is focused. What it never sends:
 * the characters typed into that field. Watching a cursor move is co-browsing; capturing
 * keystrokes is a keylogger, and the line between them is that this function has nowhere to put
 * the text even if it wanted to.
 *
 * And it is not quiet: the response says whether anyone is watching, and when they are, a chip
 * says so. That is deliberate and not switch-off-able — a hidden version of this is the thing it
 * is written specifically not to be.
 */
function startPresenceReporting() {
  let cursor = null, clicks = [], field = "", dirty = false;

  const fieldLabel = (el) => {
    if (!el || !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return "";
    if (el.type === "password") return "a password field";      // never even name it beyond this
    const lab = el.closest("label")?.textContent?.trim()
      || el.getAttribute("aria-label")
      || el.getAttribute("placeholder")
      || el.id || "a field";
    return String(lab).replace(/\s+/g, " ").slice(0, 50);
  };

  addEventListener("mousemove", throttle((e) => {
    cursor = { x: e.clientX / innerWidth, y: e.clientY / innerHeight }; dirty = true;
  }, 60), { passive: true });
  addEventListener("click", (e) => {
    clicks.push({ x: e.clientX / innerWidth, y: e.clientY / innerHeight }); dirty = true;
  }, true);
  addEventListener("scroll", throttle(() => { dirty = true; }, 200), { passive: true, capture: true });
  document.addEventListener("focusin", (e) => { field = fieldLabel(e.target); dirty = true; }, true);
  document.addEventListener("focusout", () => { field = ""; dirty = true; }, true);

  const flush = async (force) => {
    if (!dirty && !force) return;
    dirty = false;
    const batch = { route: S.route, cursor, viewport: { w: innerWidth, h: innerHeight }, field, clicks };
    clicks = [];
    try {
      const r = await api("/api/share/presence", batch);
      setWatchedChip(!!r.watched);
    } catch { /* a dropped presence ping is nothing to bother anyone about */ }
  };
  // A quick cadence while something is changing, and a slow heartbeat so the "being watched"
  // chip is still current when the co-founder is sitting still reading.
  setInterval(() => flush(false), 150);
  setInterval(() => flush(true), 2500);
}

/** The disclosure. Present whenever the owner is actually watching this tab, and not dismissable. */
function setWatchedChip(on) {
  let chip = $("#watchChip");
  if (!on) { chip?.remove(); return; }
  if (chip) return;
  chip = document.createElement("div");
  chip.id = "watchChip";
  chip.className = "watch-chip";
  chip.innerHTML = `${icon("eye")} <span>The owner is watching this screen</span>`;
  chip.title = "The person whose machine this runs on can see your cursor, clicks and which "
    + "field you are in — live. They cannot see what you type into it.";
  document.body.append(chip);
}

/** "Chrome on macOS" beats 180 characters of version numbers in a list of devices. */
function shortAgent(ua = "") {
  const os = /Android/i.test(ua) ? "Android" : /iPhone|iPad/i.test(ua) ? "iOS"
    : /Mac OS X/i.test(ua) ? "macOS" : /Windows/i.test(ua) ? "Windows"
    : /Linux/i.test(ua) ? "Linux" : "";
  const br = /Edg\//i.test(ua) ? "Edge" : /OPR\//i.test(ua) ? "Opera"
    : /Chrome\//i.test(ua) ? "Chrome" : /Safari\//i.test(ua) ? "Safari"
    : /Firefox\//i.test(ua) ? "Firefox" : "a browser";
  return os ? `${br} on ${os}` : br;
}

async function renderSettings() {
  const [s, health, sup, integrity, company, keys, share] = await Promise.all([
    api("/api/settings"), api("/api/health"), api("/api/suppression"),
    api("/api/integrity").catch(() => ({ ok: true, violations: [] })),
    api("/api/company"), api("/api/keys"),
    api("/api/share").catch(() => null),
  ]);
  const m = s.smtp ?? {}, g = s.sending ?? {};
  const win = g.window ?? { enabled: false, startHour: 9, endHour: 17, days: [1, 2, 3, 4, 5] };
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

    ${shareCard(share)}

    <div class="card">
      <div class="card-head"><h2>Your company</h2>
        ${company.complete ? `<span class="tag ok">${icon("check")} set up</span>` : `<span class="tag warn">incomplete</span>`}</div>
      <p class="card-note" style="margin-top:0">Who is writing. This is what the opt-out footer
        identifies you as, and UK PECR expects a cold B2B email to carry it — so it is filled in
        once here rather than retyped into every campaign.</p>
      <div class="grid2" style="margin-top:var(--s4)">
        <label class="field">Your name<input id="cpSenderName" value="${esc(company.profile.sender_name)}" placeholder="Ozan Kaygusuz"></label>
        <label class="field">Your title<input id="cpSenderTitle" value="${esc(company.profile.sender_title)}" placeholder="founder"></label>
        <label class="field">Trading name<input id="cpTrading" value="${esc(company.profile.trading_name)}" placeholder="WearSide Labs"></label>
        <label class="field">Registered name<input id="cpLegal" value="${esc(company.profile.legal_name)}" placeholder="WearSide Labs Ltd"></label>
        <label class="field">Website<input id="cpWebsite" value="${esc(company.profile.website)}" placeholder="wearsidelabs.com"></label>
        <label class="field">Reply-to address<input id="cpEmail" type="email" value="${esc(company.profile.contact_email)}" placeholder="ozan@wearsidelabs.com"></label>
        <label class="field">Phone<input id="cpPhone" value="${esc(company.profile.phone)}" placeholder="optional"></label>
        <label class="field">Address<input id="cpAddress" value="${esc(company.profile.address)}" placeholder="Durham"></label>
        <label class="field">Country<input id="cpCountry" value="${esc(company.profile.country)}" placeholder="UK"></label>
        <label class="field">Company number<input id="cpCompanyNo" value="${esc(company.profile.company_number)}" placeholder="optional"></label>
        <label class="field">VAT number<input id="cpVat" value="${esc(company.profile.vat_number)}" placeholder="optional"></label>
      </div>
      ${company.identityLine ? `<div class="identity-preview">
        <span class="rf-label">Reads as</span><span class="mono">${esc(company.identityLine)}</span></div>` : ""}
      <div class="row" style="margin-top:var(--s4)">
        <button class="btn ghost" id="btnSaveCompany">Save company details</button>
        ${company.identityLine ? `<button class="btn ghost sm" id="btnUseAsFooter">Use this as the opt-out footer</button>` : ""}
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Keys</h2><span class="tag">${num(keys.keys.length)}</span></div>
      <p class="card-note" style="margin-top:0">Anything else this machine needs to remember.
        Values are encrypted with AES-256-GCM and the key that opens them is
        <code class="mono">${esc(keys.vaultKeyFile)}</code> — outside the database, so
        <code class="mono">coldcall.db</code> stays safe to back up and safe to attach to a bug
        report. It does not stop another program running as you from reading both files;
        nothing could, for an app that sends mail while you are asleep.</p>
      ${keys.keys.length ? `<div class="tablewrap" style="margin-top:var(--s4)"><table>
        <thead><tr><th>Name</th><th style="width:140px">Value</th><th style="width:120px">Last used</th><th style="width:80px"></th></tr></thead>
        <tbody>${keys.keys.map((k) => `<tr>
          <td><div class="cellmain mono">${esc(k.name)}</div>
              ${k.label && k.label !== k.name ? `<div class="cellsub">${esc(k.label)}</div>` : ""}</td>
          <td class="mono cellsub">${esc(k.hint)}</td>
          <td class="cellsub">${k.last_used_at ? esc(ago(k.last_used_at)) : "never"}</td>
          <td><button class="btn sm ghost" data-delkey="${esc(k.name)}">Remove</button></td></tr>`).join("")}
        </tbody></table></div>` : ""}
      <div class="grid3" style="margin-top:var(--s4)">
        <label class="field">Name<input id="keyName" placeholder="provider.api_key" autocomplete="off"></label>
        <label class="field">Value<input id="keyValue" type="password" placeholder="paste it here" autocomplete="off"></label>
        <label class="field">Kind<select id="keyKind">
          <option value="api_key">API key</option><option value="token">Token</option>
          <option value="password">Password</option><option value="other">Other</option></select></label>
      </div>
      <div class="row" style="margin-top:var(--s3)"><button class="btn ghost" id="btnAddKey">${icon("plus")} Store key</button></div>
      <p class="card-note">A stored key is never sent back to this page — only its last four
        characters, which is enough to tell two keys apart and not enough to use one.</p>
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
        <label class="field">Leave a company alone for (hours)
          <input id="companyGap" type="number" min="0" value="${esc(g.companyGapHours ?? 4)}"></label>
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
      <div class="card-head"><h2>When to send</h2>
        <span class="cellsub">Your local time — ${esc(TZ_NAME)}.</span></div>
      <label class="check">
        <input type="checkbox" id="winEnabled" ${win.enabled ? "checked" : ""}>
        Only send during these hours</label>
      <div class="grid3" style="margin-top:var(--s3)">
        <label class="field">From<select id="winStart">${hourOptions(win.startHour ?? 9)}</select></label>
        <label class="field">Until<select id="winEnd">${hourOptions(win.endHour ?? 17)}</select></label>
        <div class="field"><span>Days</span>
          <div class="daypick" role="group" aria-label="Days to send on">
            ${DAY_SHORT.map((d, i) => `<button type="button" class="daybtn" data-day="${i}"
              aria-pressed="${(win.days ?? [1,2,3,4,5]).includes(i)}">${esc(d)}</button>`).join("")}
          </div>
        </div>
      </div>
      <p class="card-note">A cold email that lands at 3am reads as a machine before it reads as
        anything else. Outside these hours nothing is queued or lost — approved drafts simply
        wait, and sending picks up on its own when the window opens.</p>
      <div class="row" style="margin-top:var(--s3)"><button class="btn ghost" id="btnSaveWindow">Save window</button></div>
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

  /* ------------------------------------------------------------------ share */
  const reload = () => renderSettings().catch(fail);
  $("#btnShareStart")?.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    b.disabled = true; b.innerHTML = `<span class="spinner"></span> Opening…`;
    try { const t = await api("/api/share/start", {}); toast(`Shared link open at ${t.url}`); }
    catch (err) { fail(err); }
    reload();
  });
  $("#btnShareStop")?.addEventListener("click", async () => {
    if (!confirm("Close the shared link?\n\nThe URL stops working immediately. Invites and signed-in devices are kept, so re-opening later gives everyone access again without re-inviting.")) return;
    try { await api("/api/share/stop", {}); toast("Shared link closed"); } catch (e) { fail(e); }
    reload();
  });
  $("#btnInstallCf")?.addEventListener("click", async (e) => {
    e.target.closest("button").disabled = true;
    try { await api("/api/share/install-cloudflared", {}); toast("Downloading cloudflared…"); }
    catch (err) { fail(err); reload(); }
  });
  $("#btnInvite")?.addEventListener("click", () => inviteDialog(reload));
  $$("[data-revinvite]").forEach((b) => b.onclick = async () => {
    if (!confirm("Revoke this invite?\n\nAnyone who joined with it is signed out immediately.")) return;
    try {
      const r = await api(`/api/share/invite/${b.dataset.revinvite}/revoke`, {});
      toast(r.sessionsEnded ? `Revoked — ${r.sessionsEnded} device(s) signed out` : "Revoked");
    } catch (e) { fail(e); }
    reload();
  });
  $$("[data-revsession]").forEach((b) => b.onclick = async () => {
    try { await api(`/api/share/session/${b.dataset.revsession}/revoke`, {}); toast("Signed out"); }
    catch (e) { fail(e); }
    reload();
  });
  $("#btnRevokeAll")?.addEventListener("click", async () => {
    if (!confirm("Sign everyone out and revoke every invite?\n\nThe link stays open but nobody can get in until you create a new invite.")) return;
    try { const r = await api("/api/share/revoke-all", {}); toast(`${r.sessions} signed out, ${r.invites} invite(s) revoked`); }
    catch (e) { fail(e); }
    reload();
  });
  $$("[data-copy]").forEach((b) => b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); toast("Copied"); }
    catch { toast("Couldn't copy — select it and copy by hand", true); }
  });

  /* -------------------------------------------------------------- company */
  $("#btnSaveCompany")?.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); b.disabled = true;
    try {
      await api("/api/company", {
        sender_name: $("#cpSenderName").value.trim(), sender_title: $("#cpSenderTitle").value.trim(),
        trading_name: $("#cpTrading").value.trim(), legal_name: $("#cpLegal").value.trim(),
        website: $("#cpWebsite").value.trim(), contact_email: $("#cpEmail").value.trim(),
        phone: $("#cpPhone").value.trim(), address: $("#cpAddress").value.trim(),
        country: $("#cpCountry").value.trim(), company_number: $("#cpCompanyNo").value.trim(),
        vat_number: $("#cpVat").value.trim(),
      });
      toast("Company details saved");
    } catch (err) { fail(err); }
    reload();
  });
  $("#btnUseAsFooter")?.addEventListener("click", async () => {
    const line = $(".identity-preview .mono")?.textContent ?? "";
    if (!line) return;
    const text = `${line}. Reply "no thanks" and I won't write again.`;
    $("#footerText").value = text;
    $("#footerEnabled").checked = true;
    try {
      await api("/api/settings", { sending: { footerEnabled: true, footerText: text } });
      toast("Footer set from your company details");
    } catch (e) { fail(e); }
  });

  /* ----------------------------------------------------------------- keys */
  $("#btnAddKey")?.addEventListener("click", async (e) => {
    const name = $("#keyName").value.trim(), value = $("#keyValue").value;
    if (!name) return toast("Give the key a name", true);
    if (!value.trim()) return toast("Paste the key's value", true);
    e.target.closest("button").disabled = true;
    try { await api("/api/keys", { name, value, kind: $("#keyKind").value }); toast(`Stored ${name}`); }
    catch (err) { fail(err); }
    reload();
  });
  $$("[data-delkey]").forEach((b) => b.onclick = async () => {
    if (!confirm(`Remove "${b.dataset.delkey}"?\n\nThe value is deleted and cannot be recovered from here.`)) return;
    try { await api(`/api/keys/${encodeURIComponent(b.dataset.delkey)}/delete`, {}); toast("Removed"); }
    catch (e) { fail(e); }
    reload();
  });

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
      $("#testResult").innerHTML = `
        <div class="row" style="gap:var(--s3)">
          <span>SMTP ${res.smtp.ok ? `<span class="tag ok">ok</span>` : `<span class="tag bad">failed</span>`}</span>
          <span>IMAP ${res.imap.ok ? `<span class="tag ok">ok</span>` : `<span class="tag warn">failed</span>`}</span>
        </div>
        ${[["Sending", res.smtp, "bad"], ["Replies", res.imap, "warn"]]
          .filter(([, r]) => !r.ok)
          .map(([what, r, tone]) => `<div class="flagbox" ${tone === "bad" ? 'data-sev="critical"' : ""} style="margin-top:var(--s3)">
            ${icon("warning-triangle")} <b>${esc(what)}: ${esc(r.message ?? r.error ?? "failed")}</b>
            ${r.fix ? `<div class="dcheck-fix" style="margin-top:var(--s2)">${icon("arrow-right")}${esc(r.fix)}</div>` : ""}
            ${r.raw && r.raw !== r.message ? `<details style="margin-top:var(--s2)"><summary>what the server said</summary>
              <code class="dcheck-found">${esc(r.raw)}</code></details>` : ""}
          </div>`).join("")}`;
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
        maxGapSeconds: +$("#maxGap").value, companyGapHours: +$("#companyGap").value,
        footerEnabled: $("#footerEnabled").checked,
        footerText: $("#footerText").value,
      } });
      toast("Saved");
    } catch (e) { fail(e); }
  };
  $$(".daybtn").forEach((b) => b.onclick = () =>
    b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") === "true" ? "false" : "true"));
  $("#btnSaveWindow").onclick = async () => {
    const days = $$(".daybtn").filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => +b.dataset.day);
    if ($("#winEnabled").checked && !days.length) return toast("Pick at least one day", true);
    try {
      await api("/api/settings", { sending: { window: {
        enabled: $("#winEnabled").checked, startHour: +$("#winStart").value,
        endHour: +$("#winEnd").value, days,
      } } });
      toast("Saved");
      loadHealth();
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

/* ─────────────────────────────────────────────────── deliverability */

const SEV = {
  critical: ["bad", "warning-triangle", "Fix before sending"],
  warning:  ["warn", "warning-triangle", "Worth fixing"],
  info:     ["", "eye", "For information"],
  ok:       ["ok", "check", "Passing"],
};

// A ring rather than a bar: the number is the point, and a bar invites comparison
// against other bars that do not exist on this screen.
function scoreRing(score, caption) {
  const r = 34, c = 2 * Math.PI * r;
  const tone = score >= 85 ? "var(--ok)" : score >= 60 ? "var(--warn)" : "var(--bad)";
  return `<div class="ring">
    <svg viewBox="0 0 80 80" class="ring-svg" aria-hidden="true">
      <circle cx="40" cy="40" r="${r}" class="ring-track"/>
      <circle cx="40" cy="40" r="${r}" class="ring-fill" stroke="${tone}"
        stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - score / 100)).toFixed(1)}"/>
    </svg>
    <div class="ring-mid"><span class="ring-num" style="color:${tone}">${score}</span></div>
    <div class="ring-cap">${esc(caption)}</div>
  </div>`;
}

const checkRow = (c) => {
  const [tone, ic] = SEV[c.severity] ?? SEV.info;
  return `<div class="dcheck" data-sev="${c.severity}">
    <span class="dcheck-icon ${tone}">${icon(ic)}</span>
    <div class="dcheck-body">
      <div class="dcheck-top"><b>${esc(c.label)}</b><span class="tag ${tone}">${esc(c.severity)}</span></div>
      <p class="dcheck-detail">${esc(c.detail)}</p>
      ${c.fix ? `<p class="dcheck-fix">${icon("arrow-right")}${esc(c.fix)}</p>` : ""}
      ${c.found ? `<code class="dcheck-found">${esc(c.found)}</code>` : ""}
    </div>
  </div>`;
};

async function renderDeliverability(refresh = false) {
  const [audit, stats] = await Promise.all([
    api(`/api/deliverability${refresh ? "?refresh=1" : ""}`),
    S.stats ? Promise.resolve(S.stats) : api("/api/stats"),
  ]);
  S.stats = stats;

  if (!audit.domain) {
    $("#content").innerHTML = page(isOwner()
      ? empty("shield-check", "No sending address yet",
          "Set your from address in Settings and this page will audit the domain you send from.",
          `<button class="btn" id="toSettings">Open settings</button>`)
      : empty("shield-check", "No sending address yet",
          "The mailbox hasn't been connected on the machine running coldcall, so there is no domain to audit yet."));
    $("#toSettings")?.addEventListener("click", () => go("settings"));
    return;
  }

  const bad = audit.checks.filter((c) => c.severity === "critical").length;
  const warn = audit.checks.filter((c) => c.severity === "warning").length;

  $("#content").innerHTML = page(`
    <div class="card dpanel">
      ${scoreRing(audit.score, "acceptance")}
      <div class="dpanel-text">
        <h2 class="dtitle">${esc(audit.domain)}</h2>
        <p class="dlede">${esc(
          bad ? `${bad} thing${bad === 1 ? "" : "s"} here will send your mail to spam regardless of what it says.`
          : warn ? `Nothing is broken. ${warn} thing${warn === 1 ? "" : "s"} would make you harder to filter out.`
          : "Your domain is set up correctly. What is left is what you write.")}</p>
        <p class="card-note">Checked ${esc(ago(audit.checkedAt))} over DNS. Nothing was sent and nothing left this machine except the lookups.</p>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Sender domain</h2>
        <span class="cellsub">SPF, DKIM and DMARC are what a receiving server checks before it looks at your words.</span></div>
      <div class="dchecks">${audit.checks.map(checkRow).join("")}</div>
    </div>

    <div class="card">
      <div class="card-head"><h2>What this does not check</h2></div>
      <p class="card-note">Whether you are on a blocklist, and how your address has behaved historically.
      Both are held by the receiving providers and neither is readable from here. The one signal you
      control is volume: a new address that sends thirty a day looks like a person, and one that sends
      three hundred looks like a list.</p>
    </div>`,
    `<button class="btn ghost" id="recheck">${icon("refresh")}Re-check</button>`);

  $("#recheck").onclick = async (e) => {
    e.target.closest("button").disabled = true;
    await renderDeliverability(true).catch(fail);
  };
}

/* ───────────────────────────────────────────────────────── dialogs */

function modal(title, bodyHtml, onConfirm, confirmLabel = "Save") {
  // Title and buttons stay put; only the fields scroll. A dialog taller than the window used to
  // run off the bottom of the screen with nothing to scroll - .scrim is position:fixed and
  // .palette is overflow:hidden - so the Create button was simply unreachable on a short screen.
  $("#modal").innerHTML = `
    <div class="scrim" id="scrim">
      <div class="palette dialog" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <h2 class="dialog-head">${esc(title)}</h2>
        <div id="modalBody" class="dialog-body">${bodyHtml}</div>
        <div class="dialog-foot">
          <button class="btn ghost" id="mCancel">Cancel</button>
          <button class="btn" id="mOk">${esc(confirmLabel)}</button>
        </div>
      </div>
    </div>`;
  const close = () => { $("#modal").innerHTML = ""; };
  $("#mCancel").onclick = close;
  $("#scrim").onclick = (e) => { if (e.target.id === "scrim") close(); };
  $("#modalBody").querySelector("input,textarea,select")?.focus();
  $("#mOk").onclick = async () => {
    const b = $("#mOk"); b.disabled = true; b.innerHTML = `<span class="spinner"></span>`;
    try {
      // A handler returning "keep-open" has replaced the dialog's own contents and is showing
      // something that cannot be shown twice - an invite link, say. Closing on success would
      // throw that away in the instant it appeared.
      if (await onConfirm() !== "keep-open") close();
    } catch (e) { fail(e); b.disabled = false; b.textContent = confirmLabel; }
  };
  document.addEventListener("keydown", function esckey(e) {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", esckey); }
  });
}

/* ─────────────────────────────────────────────── new campaign (its own screen)

   This was a modal, and it was the wrong container for it. The form asks for the single
   hardest thing in the product - the KIND of organisation to look for - then buries that
   question between a name field and a number input, in a box that scrolls. Two of the three
   things that help you answer it (a suggestion drawn from your own brief, and a dry run of the
   gate against a real site) had nowhere to go, so neither existed at the moment they were
   needed: before the campaign was created.

   So it is a screen. The question that matters is first and largest, the AI help sits next to
   the field it helps with rather than under a "Tidy this up" afterthought, and the right rail
   reads the campaign back as a sentence while you type - because the failure this is guarding
   against is someone writing a topic where a kind belongs and not noticing. */

const BLANK_CAMPAIGN = { name: "", goal: "", target: "", mode: "opencode_search", contacts: 3, inferred: false };

const DISCOVERY_MODES = [
  ["opencode_search", "search", "Search the web", "Free, via opencode. Every result is put through the targeting gate below."],
  ["manual", "list", "I'll paste a list", "Domains from a spreadsheet or a CSV. Still researched, still gated."],
];

async function renderNewCampaign() {
  const d = S.newCampaign ?? (S.newCampaign = { ...BLANK_CAMPAIGN });

  $("#content").innerHTML = page(`
    <div class="wizard">
      <div class="wizard-main">

        <div class="aihelp" id="aiHelp">
          <div class="aihelp-text">
            <b>${icon("sparks")} Not sure who to aim at?</b>
            <span>Read your product brief and propose three campaigns aimed at genuinely
              different kinds of organisation — usually a customer, a partner and someone who
              writes about you. Nothing is applied until you pick one.</span>
          </div>
          <button type="button" class="btn" id="btnSuggest">Suggest campaigns</button>
        </div>
        <div id="suggestOut"></div>

        <section class="step">
          <div class="step-head">
            <span class="step-n">1</span>
            <div>
              <h2>Who are you looking for?</h2>
              <p class="step-sub">Name the <b>kind</b> of organisation, not the subject. This is
                the one field discovery filters on, and the difference between "local news" and
                "small independent local news websites" is the difference between a list of news
                sites and a list of anything that mentions the town.</p>
            </div>
          </div>
          <textarea id="cTarget" rows="4" aria-label="Who you are looking for"
            placeholder="small independent local news websites that publish sports coverage — not clubs or academies">${esc(d.target)}</textarea>
          <div class="step-tools">
            <button type="button" class="btn ghost sm" id="btnReframe">${icon("sparks")} Tidy this up</button>
            <span class="cellsub">Write it however it comes out — mixed languages, half a
              sentence. This splits it into the fields the search actually uses and tells you
              what it changed.</span>
          </div>
          <div id="reframeOut"></div>
        </section>

        <section class="step">
          <div class="step-head">
            <span class="step-n">2</span>
            <div>
              <h2>What do you want from the email?</h2>
              <p class="step-sub">The ask, in one line — and something a stranger could say yes
                to in a single reply. "Explore a partnership" is not a first ask; "fifteen
                minutes on Thursday" is.</p>
            </div>
          </div>
          <input id="cGoal" aria-label="What you want from the email"
            placeholder="15 minutes to talk about rebuilding their website" value="${esc(d.goal)}">
        </section>

        <section class="step">
          <div class="step-head">
            <span class="step-n">3</span>
            <div>
              <h2>What should it be called?</h2>
              <p class="step-sub">Only you will ever see this.</p>
            </div>
          </div>
          <input id="cName" aria-label="Campaign name" placeholder="Durham trades" value="${esc(d.name)}">
        </section>

        <section class="step">
          <div class="step-head">
            <span class="step-n">4</span>
            <div>
              <h2>How should it find them?</h2>
              <p class="step-sub">Either way, nothing is researched until you tick it, and
                nothing is sent until you approve it.</p>
            </div>
          </div>
          <div class="seg" role="radiogroup" aria-label="How to find companies">
            ${DISCOVERY_MODES.map(([v, ic, label, note]) => `
              <button type="button" class="seg-opt" role="radio" data-mode="${v}"
                aria-checked="${d.mode === v}">
                ${icon(ic)}
                <span class="seg-label">${esc(label)}</span>
                <span class="seg-note">${esc(note)}</span>
              </button>`).join("")}
          </div>
          <div class="grid2 step-grid">
            <label class="field">People per company
              <input id="cContacts" type="number" min="1" max="5" value="${esc(d.contacts)}"></label>
            <label class="check step-check">
              <input type="checkbox" id="cInferred" ${d.inferred ? "checked" : ""}>
              <span>Allow guessed addresses<span class="cellsub">first.last@ patterns, when a
                company publishes none. Off is the safer default — a guess that bounces costs
                you sending reputation.</span></span></label>
          </div>
        </section>
      </div>

      <aside class="wizard-aside">
        <div class="card summary" id="summary"></div>

        <div class="card gate">
          <div class="card-head"><h2>${icon("shield-search")} Try it on a real site</h2></div>
          <p class="card-note" style="margin-top:0">Runs the targeting gate against one domain
            and shows its reasoning, before this campaign exists. One fetch, nothing saved — and
            the page is cached, so running the campaign later does not fetch it twice.</p>
          <div class="row" style="margin-top:var(--s3)">
            <input id="gateDomain" aria-label="Domain to check" placeholder="thenorthernecho.co.uk" style="flex:1;min-width:0">
            <button class="btn ghost sm" id="btnGate">Check</button>
          </div>
          <div id="gateOut"></div>
        </div>
      </aside>
    </div>`,
    `<button class="btn ghost" id="btnCancelCampaign">Cancel</button>
     <button class="btn" id="btnCreateCampaign">${icon("check")} Create campaign</button>`);

  /* Reading the fields back rather than tracking them keeps one source of truth: whatever is
     on screen is what gets created, including anything the AI help wrote into an input. */
  const read = () => ({
    name: $("#cName").value.trim(),
    goal: $("#cGoal").value.trim(),
    target: $("#cTarget").value.trim(),
    mode: $$(".seg-opt").find((b) => b.getAttribute("aria-checked") === "true")?.dataset.mode ?? "opencode_search",
    contacts: Math.min(5, Math.max(1, +$("#cContacts").value || 3)),
    inferred: $("#cInferred").checked,
  });

  const drawSummary = () => {
    const v = read();
    Object.assign(S.newCampaign, v);
    $("#summary").innerHTML = `
      <div class="card-head"><h2>This campaign will</h2></div>
      <dl class="summary-list">
        <dt>Look for</dt>
        <dd class="${v.target ? "" : "unset"}">${v.target ? esc(v.target) : "— nothing yet, and this is the one that matters"}</dd>
        <dt>Ask them for</dt>
        <dd class="${v.goal ? "" : "unset"}">${v.goal ? esc(v.goal) : "— not set"}</dd>
        <dt>Find them by</dt>
        <dd>${v.mode === "manual" ? "a list you paste" : "searching the web"}</dd>
        <dt>Contact</dt>
        <dd>up to ${num(v.contacts)} ${v.contacts === 1 ? "person" : "people"} per company${
          v.inferred ? ", guessing an address if none is published" : ", only published addresses"}</dd>
      </dl>
      <p class="card-note">Creating it researches nothing and sends nothing. You pick the
        companies afterwards, and every draft still waits for you.</p>`;
  };
  drawSummary();

  $$("#content input, #content textarea").forEach((el) => el.addEventListener("input", debounce(drawSummary, 150)));
  $("#cInferred").onchange = drawSummary;
  $$(".seg-opt").forEach((b) => b.onclick = () => {
    $$(".seg-opt").forEach((o) => o.setAttribute("aria-checked", String(o === b)));
    drawSummary();
  });

  $("#btnCancelCampaign").onclick = () => { S.newCampaign = null; go("campaigns"); };

  $("#btnCreateCampaign").onclick = async (e) => {
    const v = read();
    if (!v.target) {
      $("#cTarget").focus();
      return toast("Say who you're looking for first — it's what discovery filters on", true);
    }
    const b = e.target.closest("button");
    b.disabled = true; b.innerHTML = `<span class="spinner"></span> Creating…`;
    try {
      const c = await api("/api/campaigns", {
        name: v.name || "Untitled campaign", goal: v.goal, target_description: v.target,
        discovery_mode: v.mode, contacts_per_company: v.contacts, allow_inferred_emails: v.inferred,
      });
      S.newCampaign = null;
      S.campaign = c.id;
      toast("Campaign created");
      go("campaigns");
    } catch (err) {
      fail(err);
      b.disabled = false; b.innerHTML = `${icon("check")} Create campaign`;
    }
  };

  wireSuggest(drawSummary);
  wireReframe(drawSummary);
  wireGateCheck(read);
}

/**
 * Propose campaigns from the product brief.
 *
 * The blank version of this screen is the hardest one in the product, and placeholder text is
 * a poor teacher: it shows the shape of an answer without showing why that shape is right.
 * Three concrete proposals drawn from the user's own brief, each labelled with the relationship
 * it assumes, teach the distinction that the targeting gate later enforces.
 */
function wireSuggest(onApply) {
  const btn = $("#btnSuggest"), out = $("#suggestOut");
  if (!btn || !out) return;
  btn.onclick = async () => {
    btn.disabled = true;
    out.innerHTML = `<div class="card-note"><span class="spinner"></span> Reading your brief…</div>`;
    try {
      const r = await api("/api/campaigns/suggest", {});
      out.innerHTML = `<div class="ideas">${r.campaigns.map((c, i) => `
        <button type="button" class="idea" data-idea="${i}">
          <span class="tag ${c.relationship === "customer" ? "solid" : "accent"}">${esc(c.relationship)}</span>
          <b>${esc(c.name)}</b>
          <span class="idea-target">${esc(c.target_description)}</span>
          <span class="idea-goal">${icon("arrow-right")} ${esc(c.goal)}</span>
          <span class="idea-why">${esc(c.why)}</span>
          <span class="idea-use">Use this</span>
        </button>`).join("")}</div>`;
      $$("[data-idea]").forEach((b) => b.onclick = () => {
        const c = r.campaigns[+b.dataset.idea];
        $("#cName").value = c.name;
        $("#cGoal").value = c.goal;
        $("#cTarget").value = c.target_description;
        out.innerHTML = `<div class="card-note">Filled in from "${esc(c.name)}" — edit anything
          that is not right. Nothing is saved until you press Create.</div>`;
        onApply?.();
        $("#cTarget").focus();
      });
    } catch (e) {
      // "Finish the product interview first" is the common one, and it is actionable.
      out.innerHTML = `<div class="card-note">${esc(e?.message ?? "Couldn't suggest anything")}
        ${e?.code === "NO_PRODUCT" ? `<button class="btn ghost sm" id="toProduct" style="margin-left:var(--s2)">Open Product</button>` : ""}</div>`;
      $("#toProduct")?.addEventListener("click", () => go("product"));
    } finally { btn.disabled = false; }
  };
}

/**
 * Rewrite rough notes into the fields discovery actually uses.
 *
 * Nothing is applied automatically. The suggestion is shown next to what you wrote, with the
 * tool's own account of what it changed and what it refused to guess, and you press Use it.
 * A rewrite you did not read is how a campaign ends up aimed at something you never chose.
 */
function wireReframe(onApply) {
  const btn = $("#btnReframe"), out = $("#reframeOut");
  if (!btn || !out) return;
  btn.onclick = async () => {
    const payload = { name: $("#cName").value, goal: $("#cGoal").value, target: $("#cTarget").value };
    if (!`${payload.name}${payload.goal}${payload.target}`.trim()) {
      return toast("Write something first, however rough", true);
    }
    btn.disabled = true;
    out.innerHTML = `<div class="card-note"><span class="spinner"></span> Rewriting…</div>`;
    try {
      const r = await api("/api/campaigns/reframe", payload);
      out.innerHTML = `
        <div class="reframe">
          <div class="reframe-field"><span class="rf-label">Looking for</span><span>${esc(r.target_description)}</span></div>
          <div class="reframe-field"><span class="rf-label">Goal</span><span>${esc(r.goal)}</span></div>
          <div class="reframe-field"><span class="rf-label">Name</span><span>${esc(r.name)}</span></div>
          ${r.notes?.length ? `<ul class="rf-notes">${r.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
          <div class="row" style="margin-top:var(--s3)">
            <button type="button" class="btn sm" id="rfUse">Use it</button>
            <button type="button" class="btn ghost sm" id="rfDrop">Keep mine</button>
          </div>
        </div>`;
      $("#rfUse").onclick = () => {
        if (r.name) $("#cName").value = r.name;
        if (r.goal) $("#cGoal").value = r.goal;
        if (r.target_description) $("#cTarget").value = r.target_description;
        out.innerHTML = `<div class="card-note">Applied — edit anything that is not right.</div>`;
        onApply?.();
      };
      $("#rfDrop").onclick = () => { out.innerHTML = ""; };
    } catch (e) { fail(e); out.innerHTML = ""; }
    finally { btn.disabled = false; }
  };
}

/**
 * Dry-run the targeting gate before the campaign exists.
 *
 * This check already existed on the campaign page, which is to say it existed everywhere except
 * the screen where the target is being written. Being able to paste a domain you know the
 * answer for - one that should pass, one that should not - is the only way to find out whether
 * the words you just typed mean to a model what they mean to you.
 */
function wireGateCheck(read) {
  const btn = $("#btnGate"), out = $("#gateOut");
  if (!btn || !out) return;
  const run = async () => {
    const v = read();
    const website = $("#gateDomain").value.trim();
    if (!v.target) return toast("Describe who you're looking for first", true);
    if (!website) return toast("Enter a domain to check", true);
    btn.disabled = true;
    out.innerHTML = `<div class="card-note"><span class="spinner"></span> Fetching ${esc(website)}…</div>`;
    try {
      const r = await api("/api/campaigns/test-target", { website, target: v.target });
      out.innerHTML = r.error
        ? `<div class="card-note">Couldn't read that site: ${esc(r.error)}</div>`
        : `<div class="gate-result" data-pass="${r.wouldPass ? 1 : 0}">
             <div class="gate-verdict">
               <span class="tag ${r.wouldPass ? "ok" : "bad"}">${r.wouldPass ? "included" : "rejected"}</span>
               <span class="mono">fit ${num(r.fitScore ?? 0)}</span>
             </div>
             <div class="gate-kinds">
               <span class="rf-label">Looking for</span><span>${esc(r.targetKind ?? "—")}</span>
               <span class="rf-label">Found</span><span>${esc(r.entityKind ?? "—")}</span>
             </div>
             <p class="gate-reason">${esc(r.rejectedReason || r.reason || "")}</p>
           </div>`;
    } catch (e) { fail(e); out.innerHTML = ""; }
    finally { btn.disabled = false; }
  };
  btn.onclick = run;
  $("#gateDomain").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); run(); } };
}

/**
 * Create an invite and show the link exactly once.
 *
 * The token is not stored anywhere it can be read back - only its SHA-256 digest is - so this
 * dialog is genuinely the last chance to copy it. It says so, and it does not offer a Close
 * button until the link has been on screen.
 */
function inviteDialog(onDone) {
  modal("Invite a teammate", `
    <label class="field">Who is this for?
      <input id="invLabel" placeholder="Sam — co-founder" autofocus></label>
    <p class="card-note">A name for your own benefit: it labels their devices in the list and
      is what you will be revoking later. They never see it.</p>
    <div id="invOut"></div>`,
    async () => {
      const r = await api("/api/share/invite", { label: $("#invLabel").value.trim() });
      // Deliberately does not close: the link cannot be shown again.
      const body = $("#modalBody");
      body.innerHTML = `
        <div class="invite-done">
          <span class="tag ok">${icon("check")} Invite created</span>
          <h3>Send this to ${esc(r.invite.label)}</h3>
          ${r.link ? `
            <div class="invite-link"><code class="mono">${esc(r.link)}</code></div>
            <div class="row"><button class="btn" id="invCopy">${icon("copy")} Copy the link</button></div>
            <p class="card-note">Opening it signs them in on that device and the code disappears
              from their address bar. It is not shown again here — if it goes missing, revoke this
              invite and make another.</p>`
          : `<p class="card-note">${esc(r.hint ?? "")}</p>
             <div class="invite-link"><code class="mono">${esc(r.token)}</code></div>
             <div class="row"><button class="btn" id="invCopy">${icon("copy")} Copy the code</button></div>
             <p class="card-note">Open the shared link first, then send them the URL and this code.</p>`}
        </div>`;
      $("#invCopy").onclick = async () => {
        try { await navigator.clipboard.writeText(r.link ?? r.token); toast("Copied"); }
        catch { toast("Couldn't copy — select it and copy by hand", true); }
      };
      $("#mOk").textContent = "Done";
      $("#mOk").disabled = false;
      $("#mOk").onclick = () => { $("#modal").innerHTML = ""; onDone?.(); };
      return "keep-open";
    }, "Create invite");
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
    ${isOwner() ? `<div class="row" style="margin-top:var(--s5)">
      <button type="button" class="btn ghost sm" id="btnDeleteCamp" style="color:var(--bad)">
        ${icon("trash")} Delete this campaign</button>
    </div>` : `<p class="card-note" style="margin-top:var(--s5)">Deleting a campaign also
      deletes its send log, which is what the daily cap counts — so it happens on the machine
      running coldcall, not from the shared link.</p>`}`,
    async () => {
      await api(`/api/campaigns/${camp.id}/settings`, {
        name: $("#sName").value, goal: $("#sGoal").value, target_description: $("#sTarget").value,
        contacts_per_company: +$("#sContacts").value, daily_send_limit: +$("#sCap").value,
        allow_inferred_emails: $("#sInferred").checked ? 1 : 0,
      });
      toast("Saved"); go("campaigns");
    });
  $("#btnDeleteCamp")?.addEventListener("click", () => {
    $("#modal").innerHTML = "";
    deleteCampaignDialog(camp);
  });
}

/**
 * Delete a campaign.
 *
 * It used to live behind a <details> inside campaign settings and always demanded the exact
 * name typed out. That gate exists for one real reason - the send log goes with the campaign,
 * and the daily cap counts what is left - so it now appears only when the campaign has actually
 * sent something. Making someone transcribe "Untitled campaign" to bin a bad first draft of a
 * target is how a person learns to click through the confirmation that mattered.
 */
function deleteCampaignDialog(camp) {
  const sent = Number(camp.sent ?? 0);
  modal(`Delete "${camp.name}"?`, `
    <p class="card-note" style="margin-top:0">This removes the campaign, its
      ${num(camp.drafts ?? 0)} draft${camp.drafts === 1 ? "" : "s"}, its follow-up schedule and
      its replies.</p>
    <p class="card-note">The ${num(camp.companies ?? 0)} companies and everything researched
      about them are <b>kept</b> — they are shared with your other campaigns, and re-crawling
      sites you have already been polite to once is not free.</p>
    ${sent ? `
      <div class="flagbox" data-sev="critical" style="margin-top:var(--s4)">
        ${icon("warning-triangle")} <b>${num(sent)} email${sent === 1 ? " has" : "s have"} already gone out from this campaign.</b>
        <div>Deleting it removes them from the send log, and the daily cap is counted from what
          is left — so this frees up capacity to send more today than you meant to.</div>
      </div>
      <label class="field" style="margin-top:var(--s4)">Type <b>${esc(camp.name)}</b> to confirm
        <input id="delConfirm" autocomplete="off" placeholder="${esc(camp.name)}"></label>`
    : `<p class="card-note">Nothing has been sent from it, so there is nothing to lose but the drafts.</p>`}`,
    async () => {
      const r = await api(`/api/campaigns/${camp.id}/delete`,
        sent ? { confirm: $("#delConfirm").value } : {});
      toast(`Deleted — ${r.removed.drafts} draft(s) removed, ${r.removed.companies} companies kept`);
      S.campaign = null;
      S.campaigns = S.campaigns.filter((c) => c.id !== camp.id);
      go("campaigns");
    }, "Delete");
  // The confirm button is the dangerous one here, so it should look like it.
  $("#mOk").classList.add("danger");
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

/* ─────────────────────────────────────────────── shared access (owner only)

   The send log records that this machine sent something. Once the link is open it cannot record
   who decided to, and that is now a different person. This screen is that missing half: who is
   connected, what they have done, and one button to end it. */

/** Actions worth colouring. Everything else is ordinary work and should stay quiet. */
const LOUD = [
  [/^Sent an email/, "bad", "send"],
  [/^Started sending/, "accent", "send"],
  [/^Approved|^Bulk-approved/, "ok", "check"],
  [/^Exported/, "accent", "download"],
  [/^Added an address to never-contact/, "warn", "shield-check"],
  [/^Overruled/, "warn", "warning-triangle"],
  [/^Joined with an invite/, "ok", "user"],
  [/^Signed out/, "", "xmark"],
];
const loudness = (action) => LOUD.find(([re]) => re.test(action)) ?? [null, "", "arrow-right"];

/** Last seen inside two minutes reads as "here now" without needing a heartbeat of its own. */
const isOnline = (s) => Date.now() - s.last_seen_at < 120_000;

async function renderShared() {
  const a = await api(`/api/share/activity${S.auditFailedOnly ? "?failed=1" : ""}`);
  S.audit = a;
  const t = a.tunnel ?? {};
  const live = t.status === "ready" && !!t.url;
  const online = a.sessions.filter(isOnline);

  $("#content").innerHTML = page(`
    <div class="statgrid stagger">
      <div class="stat ${online.length ? "attn" : ""}">
        <div class="stat-label">${icon("user")} Connected now</div>
        <div class="stat-value">${num(online.length)}</div>
        <div class="stat-foot">${a.sessions.length
          ? `${num(a.sessions.length)} device${a.sessions.length === 1 ? "" : "s"} signed in`
          : "nobody has joined"}</div>
      </div>
      <div class="stat">
        <div class="stat-label">${icon("graph-up")} Actions today</div>
        <div class="stat-value">${num(a.summary.today)}</div>
        <div class="stat-foot">${a.summary.lastAt ? `last ${esc(ago(a.summary.lastAt))}` : "nothing yet"}</div>
      </div>
      <div class="stat ${a.summary.sends ? "attn" : ""}">
        <div class="stat-label">${icon("send")} Sent by hand today</div>
        <div class="stat-value">${num(a.summary.sends)}</div>
        <div class="stat-foot">${num(a.summary.approvals)} approved</div>
      </div>
      <div class="stat ${a.summary.refused ? "attn" : ""}">
        <div class="stat-label">${icon("shield-check")} Refused today</div>
        <div class="stat-value">${num(a.summary.refused)}</div>
        <div class="stat-foot">${a.summary.refused
          ? "reached for something owner-only"
          : "nothing was turned away"}</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>The link</h2>
        ${live ? `<span class="tag ok">${icon("check")} open</span>` : `<span class="tag">closed</span>`}
        <span class="card-actions">
          ${live ? `<button class="btn ghost sm" id="btnCloseFromHere">Close the link</button>` : ""}
          <button class="btn ghost sm" id="btnToShareSettings">${icon("settings")} Invites</button>
        </span></div>
      ${live ? `<div class="share-url"><span class="rf-label">URL</span>
          <a class="mono" href="${esc(t.url)}" target="_blank" rel="noreferrer">${esc(t.url)}</a>
          <button class="btn ghost sm" data-copy="${esc(t.url)}">Copy</button></div>`
        : `<p class="card-note" style="margin-top:0">The link is closed, so nobody can reach this
           machine through it. Everything below still happened.</p>`}

      ${a.sessions.length ? `<ul class="share-list" style="margin-top:var(--s4)">${a.sessions.map((x) => `
        <li>
          <span class="dot ${isOnline(x) ? "ok pulse" : ""}"></span>
          <span>${esc(x.label || "Teammate")}</span>
          <span class="cellsub">${esc(shortAgent(x.user_agent))} · ${isOnline(x) ? "here now" : `last seen ${esc(ago(x.last_seen_at))}`}</span>
          <button class="btn sm ghost" data-revsession="${esc(x.id)}">Sign out</button>
        </li>`).join("")}</ul>` : ""}
    </div>

    <div class="card liveview-card" id="liveViewCard">
      <div class="card-head"><h2>${icon("eye")} Live view</h2>
        <span class="cellsub">Their cursor and clicks inside the tab, as they happen.</span></div>
      <div id="liveView" class="liveview"></div>
      <p class="card-note">You see where they point, what they click and which field they are in —
        not what they type into it. They are shown a “someone is watching” note while this screen
        is open, which is on purpose and cannot be turned off.</p>
    </div>

    <div class="card">
      <div class="card-head"><h2>What they did</h2>
        <span class="card-actions">
          <label class="check"><input type="checkbox" id="auditFailed" ${S.auditFailedOnly ? "checked" : ""}>
            Only what was refused</label>
        </span></div>
      ${a.entries.length ? `<div class="feed" id="auditFeed">${a.entries.map(auditRow).join("")}</div>`
        : empty("user", S.auditFailedOnly ? "Nothing was refused" : "Nothing yet",
            S.auditFailedOnly
              ? "Every request over the shared link has been something it is allowed to do."
              : "Approvals, sends, campaign changes and exports made over the shared link show up here as they happen.")}
      <p class="card-note">Reading is not recorded — a row every time somebody opened the review
        queue would bury the six lines that matter. Everything that changes something is, and so
        is every CSV export, because that is the only way data leaves through the link.</p>
    </div>`);

  startWatchHeartbeat();
  S.presenceMap = {};
  for (const pstate of (a.presence ?? [])) S.presenceMap[pstate.sessionId] = pstate;
  updateLiveView();

  $("#btnToShareSettings").onclick = () => go("settings");
  $("#btnCloseFromHere")?.addEventListener("click", async () => {
    if (!confirm("Close the shared link?\n\nThe URL stops working immediately. Signed-in devices are kept, so re-opening later lets them back in without a new invite.")) return;
    try { await api("/api/share/stop", {}); toast("Shared link closed"); } catch (e) { fail(e); }
    renderShared().catch(fail);
  });
  $("#auditFailed").onchange = (e) => { S.auditFailedOnly = e.target.checked; renderShared().catch(fail); };
  $$("[data-revsession]").forEach((b) => b.onclick = async () => {
    try { await api(`/api/share/session/${b.dataset.revsession}/revoke`, {}); toast("Signed out"); }
    catch (e) { fail(e); }
    renderShared().catch(fail);
  });
  $$("[data-copy]").forEach((b) => b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); toast("Copied"); }
    catch { toast("Couldn't copy — select it and copy by hand", true); }
  });
}

function auditRow(e) {
  const [, tone, ic] = loudness(e.action);
  const refused = !e.ok;
  return `<div class="feed-item">
    <span class="feed-icon ${refused ? "bad" : tone}">${icon(refused ? "shield-check" : ic)}</span>
    <span class="audit-body">
      <span class="audit-line">${refused ? `<span class="tag bad">refused</span> ` : ""}${esc(e.action)}</span>
      ${e.detail ? `<span class="cellsub">${esc(e.detail)}</span>` : ""}
      ${refused ? `<span class="cellsub mono">${esc(e.method)} ${esc(e.path)}</span>` : ""}
    </span>
    <span class="feed-time" title="${esc(dt(e.created_at))}">${esc(e.label)} · ${esc(ago(e.created_at))}</span>
  </div>`;
}

/* The owner's heartbeat that says "I am watching", so the co-founder's chip stays lit. Decays
   on its own server-side, and is stopped the moment the owner leaves this screen. */
let _watchTimer = null;
function startWatchHeartbeat() {
  stopWatchHeartbeat();
  const beat = () => { api("/api/share/watch", {}).catch(() => {}); };
  beat();
  _watchTimer = setInterval(beat, 4000);
}
function stopWatchHeartbeat() { if (_watchTimer) { clearInterval(_watchTimer); _watchTimer = null; } }

/**
 * Draw the live view from S.presenceMap.
 *
 * Updates in place rather than re-rendering: a fresh innerHTML every frame would kill the CSS
 * transition that makes the cursor glide instead of teleport. Each session gets a box whose
 * aspect matches their window, a dot that eases to the new position, and a ripple on each click.
 */
function updateLiveView() {
  const host = $("#liveView");
  if (!host) return;
  const fresh = Object.values(S.presenceMap ?? {}).filter((p) => Date.now() - p.at < 20000);

  if (!fresh.length) {
    host.innerHTML = `<div class="liveview-idle">${icon("user")}
      <span>Nobody is moving around right now. When someone is using the shared link, their
      cursor shows up here.</span></div>`;
    return;
  }

  for (const p of fresh) {
    let panel = host.querySelector(`[data-live="${cssq(p.sessionId)}"]`);
    if (!panel) {
      panel = document.createElement("div");
      panel.className = "liveview-panel";
      panel.dataset.live = p.sessionId;
      panel.innerHTML = `
        <div class="lv-head"><span class="lv-who">${esc(p.label || "Teammate")}</span>
          <span class="lv-where cellsub"></span></div>
        <div class="lv-screen"><div class="lv-cursor"></div><div class="lv-ripples"></div></div>
        <div class="lv-field cellsub"></div>`;
      host.append(panel);
    }
    const screen = panel.querySelector(".lv-screen");
    const ar = p.viewport ? p.viewport.w / p.viewport.h : 16 / 9;
    screen.style.aspectRatio = `${Math.max(0.4, Math.min(3, ar))}`;
    panel.querySelector(".lv-where").textContent = TITLES[p.route]?.[0] ? `on ${TITLES[p.route][0]}` : "";
    const dot = panel.querySelector(".lv-cursor");
    if (p.cursor) {
      dot.style.opacity = "1";
      dot.style.left = `${(p.cursor.x * 100).toFixed(2)}%`;
      dot.style.top = `${(p.cursor.y * 100).toFixed(2)}%`;
    } else dot.style.opacity = "0";
    const field = panel.querySelector(".lv-field");
    field.textContent = p.field ? `typing in ${p.field}` : "";
    field.classList.toggle("hidden", !p.field);
    // Ripples: one per click, self-removing so they do not pile up.
    const layer = panel.querySelector(".lv-ripples");
    for (const c of (p.clicks ?? [])) {
      if (layer.dataset.last && Number(layer.dataset.last) >= c.at) continue;
      const r = document.createElement("span");
      r.className = "lv-ripple";
      r.style.left = `${(c.x * 100).toFixed(2)}%`;
      r.style.top = `${(c.y * 100).toFixed(2)}%`;
      layer.append(r);
      setTimeout(() => r.remove(), 650);
    }
    if (p.clicks?.length) layer.dataset.last = String(Math.max(...p.clicks.map((c) => c.at)));
  }

  // Drop panels for sessions that have gone quiet.
  const live = new Set(fresh.map((p) => p.sessionId));
  host.querySelectorAll("[data-live]").forEach((el) => { if (!live.has(el.dataset.live)) el.remove(); });
}

/** Escape a value for use inside a CSS attribute selector. */
const cssq = (s) => String(s).replace(/["\\\]]/g, "\\$&");

/* ───────────────────────────────────────────────────────── shared surface */

/**
 * Make it obvious, at a glance and permanently, that this is not the owner's machine.
 *
 * A tool that looks identical on both surfaces is a tool where someone eventually goes looking
 * for the mailbox settings, cannot find them, and assumes it is broken. The strip says whose
 * machine the work actually happens on, and the sign-out button is the only thing here that
 * the owner's copy does not have.
 */
function markSharedSurface(me) {
  document.querySelector(".brand-name").textContent = "coldcall";
  const foot = document.querySelector(".sidebar-foot");
  const who = document.createElement("div");
  who.className = "shared-badge";
  who.title = "You are working on someone else's machine. What you approve, send, change or "
    + "export is recorded there.";
  who.innerHTML = `
    <span class="shared-dot" aria-hidden="true"></span>
    <span class="sidebar-foot-text shared-text">
      <b>Shared link</b>
      <span>${esc(me.label || "Teammate")}</span>
    </span>`;
  foot.prepend(who);

  const out = document.createElement("button");
  out.className = "health-row";
  out.type = "button";
  out.innerHTML = `<svg width="14" height="14" aria-hidden="true"><use href="#i-xmark"/></svg>
    <span class="sidebar-foot-text">Sign out</span>`;
  out.onclick = async () => {
    if (!confirm("Sign out of the shared link on this device?")) return;
    try { await api("/api/share/leave", {}); } catch { /* the cookie is cleared either way */ }
    location.reload();
  };
  foot.append(out);
}

/* ───────────────────────────────────────────────────────── health + events */

async function loadHealth() {
  try {
    const h = await api("/api/health");
    S.health = h;
    const dot = $("#hDot"), text = $("#hText"), banner = $("#banner");
    const oc = h.opencode.status;
    // While the probe runs we do not yet know whether a model exists, so saying "no model"
    // contradicts the "Probing models" bar directly below it.
    const probing = (h.jobs ?? []).some((j) => j.key === "probe");
    let cls = "dot", label = "";
    if (oc === "not_installed") { cls = "dot bad"; label = "opencode missing"; }
    else if (oc === "starting") { cls = "dot warn pulse"; label = "starting opencode…"; }
    else if (oc !== "ready") { cls = "dot bad"; label = `opencode ${oc}`; }
    else if (probing) { cls = "dot warn pulse"; label = "checking models…"; }
    else if (h.model.writing.status !== "ok") { cls = "dot warn"; label = "no model"; }
    else if (!h.smtp.configured) { cls = "dot warn"; label = isOwner() ? "mailbox not set up" : "mailbox not connected"; }
    else { cls = "dot ok"; label = "all systems ready"; }
    dot.className = cls; text.textContent = label;

    if (!isOwner()) {
      // The teammate cannot fix any of this and cannot run a terminal on that machine. Say
      // what it means for them - work will not progress - and who has to do something.
      banner.className = (oc === "ready" && h.model.writing.status === "ok") ? "banner hidden" : "banner warn";
      if (banner.className !== "banner hidden") {
        banner.innerHTML = `${icon("warning-triangle")} The machine running coldcall can't write
          emails at the moment${oc === "ready" ? "" : ` (opencode is ${esc(oc)})`}. Approving and
          sending still work; researching and drafting will wait. Ask whoever set this up to look.`;
      }
    } else if (oc === "not_installed") {
      banner.className = "banner";
      banner.innerHTML = `${icon("warning-triangle")} opencode isn't installed. Run
        <code class="mono">curl -fsSL https://opencode.ai/install | bash</code> then restart coldcall.`;
    } else if (oc === "ready" && h.model.writing.status !== "ok" && !probing) {
      banner.className = "banner warn";
      banner.innerHTML = `${icon("warning-triangle")} No usable model. Run
        <code class="mono">opencode auth login</code> in a terminal, then re-probe.
        <button class="btn sm ghost" id="bannerProbe">Re-probe</button>`;
    } else banner.className = "banner hidden";
    $("#bannerProbe")?.addEventListener("click", () => api("/api/models/probe", {}).then(() => toast("Probing…")));

    const jobs = h.jobs ?? [];
    $("#jobbar").classList.toggle("hidden", jobs.length === 0);
    // The health poll knows only the job's name; run:progress knows which step it is on. This
    // poll runs every 6 seconds, so writing the bare label unconditionally wiped the detailed
    // line each time and the bar flickered between "1/5 - searching..." and "Finding companies".
    const detailed = Date.now() - S.lastProgressAt < 20_000;
    if (jobs.length && !detailed) $("#jobText").textContent = jobs.map((j) => j.label).join(" · ");

    // Badges live on the nav, so keep the counts fresh without a full stats fetch.
    if (!S.stats) S.stats = {};
    Object.assign(S.stats, {
      needsReview: h.review?.needsReview ?? S.stats.needsReview ?? 0,
      approvedWaiting: h.sending?.approved ?? S.stats.approvedWaiting ?? 0,
      repliesUnhandled: h.replies?.unhandled ?? S.stats.repliesUnhandled ?? 0,
      sharedLive: h.share?.online ?? 0,
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
  ev.addEventListener("job:end", () => {
    S.lastProgressAt = 0;
    bar.classList.add("hidden"); prog.classList.add("hidden"); loadHealth();
  });
  ev.addEventListener("job:error", (e) => {
    const d = JSON.parse(e.data);
    toast(`${d.label}: ${d.error}`, true);
    // A toast disappears; the reason a whole stage failed should not. Campaigns is where the
    // user is standing when discovery dies, so put it there and leave it there.
    if (S.route === "campaigns") renderCampaigns();
  });
  ev.addEventListener("job:done", (e) => {
    const { label, result: r = {} } = JSON.parse(e.data);
    if (r.drafts !== undefined) toast(`Done — ${r.enriched} researched, ${r.contacts} contacts, ${r.drafts} drafts`);
    else if (r.added !== undefined) {
      toast(r.added === 0
        // "0 added" alone reads as "your target is wrong". Say which it was.
        ? `${label}: nothing matched${r.skipped?.length ? ` — ${r.skipped.length} candidate${r.skipped.length === 1 ? "" : "s"} rejected` : ""}`
        : `${label}: ${r.added} added${r.skipped?.length ? `, ${r.skipped.length} skipped` : ""}`, r.added === 0);
      if (r.skipped?.length) console.info("[coldcall] discovery skipped:", r.skipped);
    }
    else if (r.matched !== undefined) toast(`${r.matched} repl${r.matched === 1 ? "y" : "ies"} matched`);
    else toast(`${label} finished`);
    if (["campaigns", "review", "dashboard", "outbox", "replies"].includes(S.route)) render();
  });
  ev.addEventListener("run:progress", (e) => {
    const d = JSON.parse(e.data);
    S.lastProgressAt = Date.now();
    bar.classList.remove("hidden");
    $("#jobText").textContent = `${d.index}/${d.total} · ${d.company ?? ""} — ${d.stage}`;
    prog.classList.remove("hidden");
    prog.querySelector("i").style.clipPath = `inset(0 ${100 - (d.index / d.total * 100)}% 0 0)`;
  });
  ev.addEventListener("companies:changed", () => { if (S.route === "campaigns") renderCampaigns(); });
  ev.addEventListener("drafts:changed", () => { if (S.route === "review") renderReview(); loadHealth(); });
  ev.addEventListener("replies:changed", () => { if (S.route === "replies") renderReplies(); loadHealth(); });
  ev.addEventListener("models:changed", () => { loadHealth(); if (S.route === "settings") renderSettings(); });
  ev.addEventListener("share:changed", () => {
    if (S.route === "settings") renderSettings();
    if (S.route === "shared") renderShared().catch(() => {});
  });
  ev.addEventListener("share:presence", (e) => {
    const p = JSON.parse(e.data);
    if (S.route !== "shared") return;
    (S.presenceMap ??= {})[p.sessionId] = p;
    updateLiveView();
  });
  // Live, because "what are they doing" is a present-tense question. Prepending rather than
  // re-rendering keeps the scroll position where the reader put it.
  ev.addEventListener("share:activity", (e) => {
    const row = JSON.parse(e.data);
    if (S.route !== "shared") { loadHealth(); return; }
    const feed = $("#auditFeed");
    if (!feed || (S.auditFailedOnly && row.ok)) return;
    feed.insertAdjacentHTML("afterbegin", auditRow(row));
    feed.firstElementChild?.classList.add("audit-new");
  });
  ev.onerror = () => { /* EventSource reconnects on its own */ };
}

/* ───────────────────────────────────────────────────────── boot */

/**
 * The join screen, shown on the shared link before anyone has redeemed an invite.
 *
 * It is a screen rather than an error, because arriving here is the normal first thing that
 * happens to the person the link was sent to. If the link carries a token in its fragment -
 * which is where the invite puts it, so it never reaches a server log - it redeems itself and
 * this is on screen for about as long as it takes to read the title.
 */
async function renderJoin(autoToken) {
  document.body.dataset.surface = "join";
  const paint = (state, message) => {
    $("#content").innerHTML = `
      <div class="join">
        <div class="join-card">
          <span class="join-mark">${icon("send")}</span>
          <h1>coldcall</h1>
          <p class="join-lede">${state === "working"
            ? "Signing you in…"
            : "This is a shared link. Paste the invite you were sent to get in."}</p>
          ${state === "working" ? `<div class="join-spin"><span class="spinner"></span></div>` : `
            <label class="field join-field">Invite code
              <input id="joinToken" autocomplete="off" spellcheck="false" placeholder="paste the code from your invite link"></label>
            <button class="btn join-btn" id="joinGo">${icon("arrow-right")} Continue</button>`}
          ${message ? `<p class="join-error">${esc(message)}</p>` : ""}
          <p class="join-foot">Everything you do here happens on your teammate's machine.
            The mailbox, the keys and the model settings stay there — this link cannot read them.
            What you approve, send, change or export is recorded on that machine, for them to see.</p>
        </div>
      </div>`;
    if (state !== "working") {
      const go = async () => {
        const raw = $("#joinToken").value.trim();
        if (!raw) return;
        paint("working");
        try {
          await api("/api/share/redeem", { token: tokenFromAnything(raw) });
          location.hash = "";
          location.reload();
        } catch (e) { paint("form", e?.message || "that invite is not valid"); }
      };
      $("#joinGo").onclick = go;
      $("#joinToken").onkeydown = (e) => { if (e.key === "Enter") go(); };
      $("#joinToken").focus();
    }
  };

  if (autoToken) {
    paint("working");
    try {
      await api("/api/share/redeem", { token: autoToken });
      // Drop the token out of the address bar before anything else can copy it out of there.
      history.replaceState(null, "", location.pathname);
      location.reload();
      return;
    } catch (e) { paint("form", e?.message || "that invite is not valid"); return; }
  }
  paint("form");
}

/** Accept the whole invite link, or just the code out of it. People paste both. */
function tokenFromAnything(text) {
  const m = /[#&?]join=([A-Za-z0-9_-]+)/.exec(text);
  return m ? m[1] : text.replace(/^.*[#/]/, "").trim();
}

async function boot() {
  // Load the icon sprite before first paint so nothing flashes an empty box.
  try { $("#sprite").innerHTML = await (await fetch("/icons.svg")).text(); } catch { /* icons degrade to blanks */ }

  let theme = DEFAULT_THEME, collapsed = "0";
  try {
    const stored = localStorage.getItem("cc-theme");
    // Same reasoning as the inline script in index.html: a stored "system" predates this
    // default and was written by the app, not chosen by anyone.
    if (stored && stored !== "system") theme = stored;
    collapsed = localStorage.getItem("cc-collapsed") || "0";
  } catch { /* ignore */ }
  applyTheme(theme);
  $("#app").dataset.collapsed = collapsed;
  $("#kbdHint").textContent = isMac ? "⌘K" : "Ctrl K";

  $("#themeBtn").onclick = cycleTheme;
  $("#collapseBtn").onclick = toggleCollapse;
  $("#searchBtn").onclick = openPalette;

  /* Which surface is this, and are we allowed in? Asked before anything else, because on the
     shared link every other request would 401 and the user would see a wall of failures
     instead of the one screen that can actually help them. */
  const joinToken = /[#&]join=([A-Za-z0-9_-]+)/.exec(location.hash)?.[1];
  let me;
  try { me = await api("/api/share/me"); } catch { me = { surface: "local", role: "owner", authenticated: true }; }
  S.surface = me.surface; S.sessionLabel = me.label ?? null;

  if (!me.authenticated) { await renderJoin(joinToken); return; }
  if (joinToken) history.replaceState(null, "", location.pathname);
  S.role = me.role === "sender" ? "sender" : "owner";
  document.body.dataset.surface = S.surface;

  $("#healthBtn").onclick = () => { if (isOwner()) go("settings"); };
  if (S.surface === "shared") { markSharedSurface(me); startPresenceReporting(); }

  connectEvents();
  await loadHealth();

  try { S.campaigns = await api("/api/campaigns"); } catch { /* shown by health */ }
  try { S.product = await api("/api/product"); } catch { /* optional */ }

  const [hashRoute, hashCampaign] = location.hash.replace(/^#/, "").split("/");
  if (hashCampaign) S.campaign = hashCampaign;
  if (!S.campaign && S.campaigns.length) S.campaign = S.campaigns[0].id;
  go(TITLES[hashRoute] && canOpen(hashRoute) ? hashRoute : "dashboard");

  // Without this, the browser back button and any direct #hash link silently do nothing:
  // the URL changes and the page keeps rendering whatever it was already showing.
  addEventListener("hashchange", () => {
    const [route, campaign] = location.hash.replace(/^#/, "").split("/");
    if (campaign && campaign !== S.campaign) S.campaign = campaign;
    if (TITLES[route] && canOpen(route) && route !== S.route) go(route);
  });

  setInterval(loadHealth, 6000);
}

boot();
