/* coldcall UI — plain JS, no build step. */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const state = { campaign: null, product: null, companies: [], drafts: [] };

async function api(path, body) {
  const res = await fetch(path, body === undefined
    ? {}
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { error: text }; }
  if (!res.ok) throw Object.assign(new Error(json.error || `HTTP ${res.status}`), json);
  return json;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $("#toast");
  t.textContent = msg; t.className = `toast${bad ? " bad" : ""}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add("hidden"), bad ? 7000 : 3000);
}
const fail = (e) => toast(e.message || String(e), true);

/* ------------------------------------------------------------------ tabs */
function show(name) {
  $$(".tab").forEach((s) => s.classList.add("hidden"));
  $(`#tab-${name}`).classList.remove("hidden");
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  ({ campaign: loadCampaigns, review: loadDrafts, send: loadSend, replies: loadReplies,
     logs: loadLogs, setup: loadSettings, product: loadProduct }[name] || (() => {}))();
}
$$("#tabs button").forEach((b) => b.onclick = () => show(b.dataset.tab));

/* ---------------------------------------------------------------- health */
async function loadHealth() {
  try {
    const h = await api("/api/health");
    const dot = $("#statusDot"), txt = $("#statusText"), banner = $("#banner");
    const oc = h.opencode.status;
    if (oc === "ready" && h.model.writing.status === "ok") {
      dot.className = "dot ok";
      txt.textContent = `${h.model.writing.active?.modelID ?? ""} · research ${h.model.research.active?.modelID ?? "none"}`;
      banner.classList.add("hidden");
    } else if (oc === "not_installed") {
      dot.className = "dot bad"; txt.textContent = "opencode not found";
      banner.className = "banner";
      banner.innerHTML = `opencode isn't installed. Run <code>curl -fsSL https://opencode.ai/install | bash</code> in a terminal, then restart coldcall.`;
      banner.classList.remove("hidden");
    } else if (oc !== "ready") {
      dot.className = "dot warn"; txt.textContent = `opencode ${oc}`;
      banner.className = "banner warn"; banner.textContent = `opencode is ${oc}…`;
      banner.classList.remove("hidden");
    } else {
      dot.className = "dot warn"; txt.textContent = "no model yet";
      banner.className = "banner warn";
      banner.innerHTML = `No usable model. If you've never signed in, run <code>opencode auth login</code> in a terminal, then hit Re-probe in Setup.`;
      banner.classList.remove("hidden");
    }
    const jobs = h.jobs || [];
    $("#jobbar").classList.toggle("hidden", jobs.length === 0);
    if (jobs.length) $("#jobtext").textContent = jobs.map((j) => j.label).join(" · ");
    return h;
  } catch { $("#statusDot").className = "dot bad"; $("#statusText").textContent = "server unreachable"; }
}
setInterval(loadHealth, 5000);

/* ------------------------------------------------------------------- SSE */
const evt = new EventSource("/api/events");
evt.addEventListener("job:start", (e) => { const d = JSON.parse(e.data); $("#jobbar").classList.remove("hidden"); $("#jobtext").textContent = d.label; });
evt.addEventListener("job:end", () => { $("#jobbar").classList.add("hidden"); loadHealth(); });
evt.addEventListener("job:error", (e) => { const d = JSON.parse(e.data); toast(`${d.label}: ${d.error}`, true); });
evt.addEventListener("job:done", (e) => {
  const d = JSON.parse(e.data); const r = d.result || {};
  if (r.added !== undefined) toast(`${d.label}: ${r.added} added${r.skipped?.length ? `, ${r.skipped.length} skipped` : ""}`);
  else if (r.drafts !== undefined) toast(`Done: ${r.enriched} researched, ${r.contacts} contacts, ${r.drafts} drafts`);
  else toast(`${d.label} finished`);
});
evt.addEventListener("run:progress", (e) => {
  const d = JSON.parse(e.data);
  $("#jobbar").classList.remove("hidden");
  $("#jobtext").textContent = `${d.index}/${d.total} · ${d.company ?? ""} — ${d.stage}`;
});
evt.addEventListener("companies:changed", () => loadCompanies());
evt.addEventListener("drafts:changed", () => { if (!$("#tab-review").classList.contains("hidden")) loadDrafts(); });
evt.addEventListener("replies:changed", () => { if (!$("#tab-replies").classList.contains("hidden")) loadReplies(); });
evt.addEventListener("models:changed", () => { loadHealth(); loadSettings(); });

/* ----------------------------------------------------------------- setup */
async function loadSettings() {
  const s = await api("/api/settings").catch(() => null);
  if (!s) return;
  const m = s.smtp || {};
  $("#smtpUser").value = m.user ?? ""; $("#smtpFromName").value = m.fromName ?? "";
  $("#smtpHost").value = m.host ?? s.defaults.smtp.host; $("#smtpPort").value = m.port ?? s.defaults.smtp.port;
  $("#imapHost").value = m.imapHost ?? s.defaults.imap.host;
  const g = s.sending || {};
  $("#dailyLimit").value = g.dailyLimit ?? 30; $("#minGap").value = g.minGapSeconds ?? 60;
  $("#maxGap").value = g.maxGapSeconds ?? 180;
  $("#footerEnabled").checked = !!g.footerEnabled; $("#footerText").value = g.footerText ?? "";
  $("#secretNote").textContent = s.hasPassword
    ? (s.secretStorage === "keychain"
        ? "Password is in your macOS login Keychain. Any process running as you can still read it — that's unavoidable for an app that sends mail unattended."
        : "Password is stored UNENCRYPTED in ~/.coldcall/secrets.json (file mode 0600).")
    : "No password saved yet.";
  const h = await api("/api/health").catch(() => null);
  if (h) {
    const r = h.model.research, w = h.model.writing;
    $("#modelInfo").innerHTML = `<div><b>Research:</b> ${r.active ? esc(r.active.providerID + "/" + r.active.modelID) : "<span class='tag bad'>none — web search unavailable</span>"}</div>
      <div><b>Writing:</b> ${w.active ? esc(w.active.providerID + "/" + w.active.modelID) : "<span class='tag bad'>none</span>"}</div>`;
  }
  const sup = await api("/api/suppression").catch(() => []);
  $("#supList").innerHTML = sup.length
    ? `<div class="scroll"><table><tr><th>Pattern</th><th>Reason</th><th></th></tr>${sup.map((x) =>
        `<tr><td><code>${esc(x.pattern)}</code></td><td>${esc(x.reason)}</td>
         <td><button class="secondary small" data-unsup="${esc(x.id)}">Remove</button></td></tr>`).join("")}</table></div>`
    : `<p class="muted">Empty.</p>`;
  $$("[data-unsup]").forEach((b) => b.onclick = async () => {
    await api(`/api/suppression/${b.dataset.unsup}/delete`, {}); loadSettings();
  });
}
$("#btnProbe").onclick = async () => { try { await api("/api/models/probe", {}); toast("Probing models…"); } catch (e) { fail(e); } };
$("#btnTestSmtp").onclick = async () => {
  const btn = $("#btnTestSmtp"); btn.disabled = true; $("#smtpResult").textContent = "Testing…";
  try {
    const r = await api("/api/settings/test", { smtp: {
      user: $("#smtpUser").value.trim(), password: $("#smtpPass").value,
      fromName: $("#smtpFromName").value, fromEmail: $("#smtpUser").value.trim(),
      host: $("#smtpHost").value.trim(), port: Number($("#smtpPort").value),
      secure: Number($("#smtpPort").value) === 465, imapHost: $("#imapHost").value.trim(),
    } });
    $("#smtpResult").innerHTML = `SMTP ${r.smtp.ok ? "<span class='tag good'>ok</span>" : `<span class='tag bad'>${esc(r.smtp.error)}</span>`} ·
      IMAP ${r.imap.ok ? "<span class='tag good'>ok</span>" : `<span class='tag warn'>${esc(r.imap.error)}</span>`}`;
    if (r.smtp.ok) { $("#smtpPass").value = ""; toast("Mailbox connected"); }
    loadSettings();
  } catch (e) { fail(e); $("#smtpResult").textContent = ""; } finally { btn.disabled = false; }
};
$("#btnSaveSending").onclick = async () => {
  try {
    await api("/api/settings", { sending: {
      dailyLimit: Number($("#dailyLimit").value), minGapSeconds: Number($("#minGap").value),
      maxGapSeconds: Number($("#maxGap").value), footerEnabled: $("#footerEnabled").checked,
      footerText: $("#footerText").value,
    } });
    toast("Saved");
  } catch (e) { fail(e); }
};
$("#btnSuppress").onclick = async () => {
  const p = $("#supPattern").value.trim(); if (!p) return;
  try { await api("/api/suppression", { pattern: p, reason: "manual" }); $("#supPattern").value = ""; loadSettings(); toast("Added"); }
  catch (e) { fail(e); }
};

/* --------------------------------------------------------------- product */
let productId = null;
async function loadProduct() {
  const p = await api("/api/product").catch(() => null);
  state.product = p;
  if (!p) return;
  productId = p.id;
  const turns = await api(`/api/interview/${p.id}`).catch(() => []);
  $("#chat").innerHTML = turns.map((t) => `<div class="msg ${t.role === "assistant" ? "q" : "a"}">${esc(t.content)}</div>`).join("");
  $("#chat").scrollTop = $("#chat").scrollHeight;
  if (p.status === "ready") renderBrief(p);
}
function renderBrief(p) {
  $("#briefCard").classList.remove("hidden");
  const f = [["name", "Name"], ["one_liner", "In one line"], ["description", "What you do"],
    ["job_to_be_done", "What they're trying to get done"], ["before_state", "Life before you"],
    ["price_anchor", "Price"], ["tone_sample", "Your voice"], ["sender_name", "Your name"],
    ["sender_title", "Your title"], ["sender_company", "Your business"]];
  const signals = JSON.parse(p.signals || "[]");
  $("#briefFields").innerHTML = f.map(([k, label]) =>
    `<label>${label}<textarea data-f="${k}" rows="${k === "description" || k === "tone_sample" ? 3 : 1}">${esc(p[k] ?? "")}</textarea></label>`).join("")
    + `<div class="hint">Targeting signals used to find companies:</div>`
    + (signals.length ? signals.map((s) => `<div class="cite"><b>${esc(s.signal)}</b><br>${esc(s.how_to_check ?? "")}</div>`).join("")
                      : `<p class="muted">None — the interview didn't surface any observable signals, so search will be broad.</p>`);
}
$("#btnStartInterview").onclick = async () => {
  try { const r = await api("/api/interview/start", {}); productId = r.productId; $("#chat").innerHTML = ""; await nextQuestion(""); }
  catch (e) { fail(e); }
};
async function nextQuestion(answer) {
  if (!productId) return toast("Start the interview first", true);
  const btn = $("#btnAnswer"); btn.disabled = true;
  try {
    if (answer) $("#chat").insertAdjacentHTML("beforeend", `<div class="msg a">${esc(answer)}</div>`);
    const r = await api(`/api/interview/${productId}/next`, { answer });
    if (r.done) { $("#chat").insertAdjacentHTML("beforeend", `<div class="msg q"><i>That's enough to work with — hit “Write the brief”.</i></div>`); }
    else $("#chat").insertAdjacentHTML("beforeend", `<div class="msg q">${esc(r.question)}</div>`);
    $("#chat").scrollTop = $("#chat").scrollHeight;
  } catch (e) { fail(e); } finally { btn.disabled = false; }
}
$("#btnAnswer").onclick = async () => { const v = $("#answer").value.trim(); if (!v) return; $("#answer").value = ""; await nextQuestion(v); };
$("#answer").onkeydown = (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("#btnAnswer").click(); };
$("#btnFinishInterview").onclick = async () => {
  if (!productId) return toast("Nothing to summarise", true);
  const b = $("#btnFinishInterview"); b.disabled = true; toast("Writing the brief…");
  try { renderBrief(await api(`/api/interview/${productId}/finish`, {})); toast("Brief ready"); }
  catch (e) { fail(e); } finally { b.disabled = false; }
};
$("#btnSaveBrief").onclick = async () => {
  const body = {}; $$("[data-f]").forEach((el) => body[el.dataset.f] = el.value);
  try { await api(`/api/product/${productId}`, body); toast("Saved"); } catch (e) { fail(e); }
};

/* -------------------------------------------------------------- campaign */
async function loadCampaigns() {
  const list = await api("/api/campaigns").catch(() => []);
  const sel = $("#campaignSelect");
  sel.innerHTML = list.length
    ? list.map((c) => `<option value="${esc(c.id)}">${esc(c.name)} — ${c.companies} companies, ${c.drafts} drafts, ${c.sent} sent</option>`).join("")
    : `<option value="">No campaigns yet</option>`;
  if (list.length) { if (!state.campaign || !list.some((c) => c.id === state.campaign)) state.campaign = list[0].id; sel.value = state.campaign; await loadCompanies(); }
  else { $("#newCampaignForm").classList.remove("hidden"); }
}
$("#campaignSelect").onchange = () => { state.campaign = $("#campaignSelect").value; loadCompanies(); };
$("#btnNewCampaign").onclick = () => $("#newCampaignForm").classList.toggle("hidden");
$("#btnCreateCampaign").onclick = async () => {
  try {
    const c = await api("/api/campaigns", {
      name: $("#cName").value.trim(), goal: $("#cGoal").value.trim(),
      discovery_mode: $("#cMode").value, contacts_per_company: Number($("#cContacts").value),
      allow_inferred_emails: $("#cInferred").checked,
    });
    state.campaign = c.id; $("#newCampaignForm").classList.add("hidden"); toast("Campaign created"); loadCampaigns();
  } catch (e) { fail(e); }
};
async function loadCompanies() {
  if (!state.campaign) return;
  const rows = await api(`/api/campaigns/${state.campaign}/companies`).catch(() => []);
  state.companies = rows;
  $("#companyCount").textContent = rows.length ? `${rows.filter((r) => r.selected).length} of ${rows.length} ticked` : "";
  $("#companyList").innerHTML = rows.length ? rows.map((r) => `
    <div class="item">
      <div class="top">
        <div>
          <h3><label class="check"><input type="checkbox" data-sel="${esc(r.id)}" ${r.selected ? "checked" : ""}>
            ${esc(r.name)}</label></h3>
          <div class="muted"><a href="${esc(r.website_url || "#")}" target="_blank" rel="noreferrer">${esc(r.domain)}</a>
            ${r.city ? " · " + esc(r.city) : ""}${r.relevance_reason ? " · " + esc(r.relevance_reason) : ""}</div>
        </div>
        <div style="text-align:right">
          ${r.relevance_score != null ? `<span class="tag">fit ${Math.round(r.relevance_score * 100)}</span> ` : ""}
          <span class="tag ${r.status === "failed" ? "bad" : r.status === "drafted" || r.status === "sent" ? "good" : ""}">${esc(r.status)}</span>
        </div>
      </div>
      <div class="muted" style="margin-top:6px">
        ${r.verified_claims} verified facts · ${r.contacts} contacts · ${r.drafts} drafts
        ${r.error_message ? ` · <span class="tag bad">${esc(r.error_message)}</span>` : ""}
      </div>
      ${r.summary ? `<div class="muted" style="margin-top:6px">${esc(r.summary.slice(0, 220))}</div>` : ""}
      <div class="row"><button class="secondary small" data-detail="${esc(r.id)}">Evidence</button></div>
      <div id="detail-${esc(r.id)}"></div>
    </div>`).join("") : `<p class="muted">Nothing yet. Search the web or paste a list above.</p>`;

  $$("[data-sel]").forEach((cb) => cb.onchange = async () => {
    await api(`/api/companies/${cb.dataset.sel}/select`, { selected: cb.checked });
    $("#companyCount").textContent = `${$$("[data-sel]:checked").length} of ${rows.length} ticked`;
  });
  $$("[data-detail]").forEach((b) => b.onclick = async () => {
    const box = $(`#detail-${b.dataset.detail}`);
    if (box.innerHTML) { box.innerHTML = ""; return; }
    const d = await api(`/api/companies/${b.dataset.detail}`);
    box.innerHTML = `
      ${d.claims.length ? d.claims.map((c) => `<div class="cite">
        ${c.verified ? "<span class='tag good'>verified</span>" : "<span class='tag bad'>rejected</span>"}
        ${esc(c.claim)}<br>“${esc(c.quote)}” — <a href="${esc(c.source_url)}" target="_blank" rel="noreferrer">source</a>
        ${c.verify_score != null ? ` <span class="muted">(${c.verify_method} ${Math.round(c.verify_score * 100)}%)</span>` : ""}
      </div>`).join("") : `<p class="muted">No facts extracted yet.</p>`}
      ${d.contacts.length ? `<div class="scroll"><table><tr><th>Email</th><th>Name</th><th>How we got it</th></tr>
        ${d.contacts.map((c) => `<tr><td><code>${esc(c.email)}</code></td><td>${esc(c.full_name ?? "")} ${esc(c.title ?? "")}</td>
        <td><span class="tag ${c.source_kind === "published" ? "good" : c.source_kind === "inferred" ? "warn" : ""}">${esc(c.source_kind)}</span>
        <a href="${esc(c.source_url)}" target="_blank" rel="noreferrer">page</a></td></tr>`).join("")}</table></div>` : ""}
      <div class="muted">Pages fetched: ${d.pages.map((p) => `<a href="${esc(p.url)}" target="_blank" rel="noreferrer">${esc(new URL(p.url).pathname)}</a>`).join(", ") || "none"}</div>`;
  });
}
$("#btnSelectAll").onclick = async () => { for (const cb of $$("[data-sel]")) { cb.checked = true; await api(`/api/companies/${cb.dataset.sel}/select`, { selected: true }); } loadCompanies(); };
$("#btnSelectNone").onclick = async () => { for (const cb of $$("[data-sel]")) { cb.checked = false; await api(`/api/companies/${cb.dataset.sel}/select`, { selected: false }); } loadCompanies(); };
$("#btnDiscover").onclick = async () => {
  if (!state.campaign) return toast("Create a campaign first", true);
  try { await api(`/api/campaigns/${state.campaign}/discover`, { extra: $("#extraTargeting").value }); toast("Searching the web…"); }
  catch (e) { fail(e); }
};
$("#btnManual").onclick = async () => {
  if (!state.campaign) return toast("Create a campaign first", true);
  try { const r = await api(`/api/campaigns/${state.campaign}/manual`, { text: $("#manualList").value });
    toast(`Added ${r.added}${r.skipped.length ? `, skipped ${r.skipped.length}` : ""}`); $("#manualList").value = ""; loadCompanies(); }
  catch (e) { fail(e); }
};
$("#btnRun").onclick = async () => {
  if (!state.campaign) return toast("Create a campaign first", true);
  try { await api(`/api/campaigns/${state.campaign}/run`, {}); toast("Researching…"); } catch (e) { fail(e); }
};

/* ---------------------------------------------------------------- review */
async function loadDrafts() {
  if (!state.campaign) { $("#draftList").innerHTML = `<p class="muted">Pick a campaign first.</p>`; return; }
  const all = await api(`/api/campaigns/${state.campaign}/drafts`).catch(() => []);
  const f = $("#reviewFilter").value;
  const rows = f === "all" ? all : all.filter((d) => d.status === f);
  $("#draftCount").textContent = `${rows.length} of ${all.length}`;
  $("#draftList").innerHTML = rows.length ? rows.map((d) => `
    <div class="item" id="d-${esc(d.draft_id)}">
      <div class="top">
        <div><h3>${esc(d.company)}</h3>
          <div class="muted">To <code>${esc(d.email)}</code>${d.full_name ? ` · ${esc(d.full_name)}` : ""}${d.title ? `, ${esc(d.title)}` : ""}
          · <span class="tag ${d.source_kind === "published" ? "good" : d.source_kind === "inferred" ? "warn" : ""}">${esc(d.source_kind)}</span>
          <a href="${esc(d.source_url)}" target="_blank" rel="noreferrer">verify</a></div></div>
        <span class="tag ${d.status === "approved" ? "good" : d.status === "sent" ? "good" : ""}">${esc(d.status)}</span>
      </div>
      <div class="email">
        <div class="subj">${esc(d.subject)}</div>
        <pre>${esc(d.body_text)}</pre>
      </div>
      <div id="cites-${esc(d.draft_id)}"></div>
      <div class="row">
        ${d.status === "sent" ? `<span class="muted">Sent ${new Date(d.sent_at || 0).toLocaleString()}</span>` : `
        <button data-approve="${esc(d.draft_id)}">Approve</button>
        <button class="secondary small" data-edit="${esc(d.draft_id)}">Edit</button>
        <button class="secondary small" data-regen="${esc(d.draft_id)}">Rewrite…</button>
        <button class="secondary small" data-cites="${esc(d.draft_id)}">Sources</button>
        <button class="secondary small" data-skip="${esc(d.draft_id)}">Skip</button>
        <button class="danger small" data-sup="${esc(d.email)}">Never contact</button>`}
      </div>
      <div id="edit-${esc(d.draft_id)}"></div>
    </div>`).join("") : `<p class="muted">Nothing here.</p>`;

  $$("[data-approve]").forEach((b) => b.onclick = async () => {
    try { await api(`/api/drafts/${b.dataset.approve}/approve`, {}); toast("Approved"); loadDrafts(); } catch (e) { fail(e); } });
  $$("[data-skip]").forEach((b) => b.onclick = async () => { await api(`/api/drafts/${b.dataset.skip}/skip`, {}); loadDrafts(); });
  $$("[data-sup]").forEach((b) => b.onclick = async () => {
    await api("/api/suppression", { pattern: b.dataset.sup, reason: "manual" }); toast("Added to never-contact"); loadDrafts(); });
  $$("[data-cites]").forEach((b) => b.onclick = async () => {
    const box = $(`#cites-${b.dataset.cites}`);
    if (box.innerHTML) { box.innerHTML = ""; return; }
    const d = await api(`/api/drafts/${b.dataset.cites}`);
    box.innerHTML = d.claims.length ? d.claims.map((c) => `<div class="cite"><b>${esc(c.claim)}</b><br>
      “${esc(c.quote)}” — <a href="${esc(c.source_url)}" target="_blank" rel="noreferrer">${esc(c.source_url)}</a></div>`).join("")
      : `<div class="cite muted">This email cites nothing specific about them — it was written without verified facts.</div>`;
  });
  $$("[data-regen]").forEach((b) => b.onclick = async () => {
    const instruction = prompt("How should it change? e.g. “shorter”, “mention their new workshop”");
    if (instruction === null) return;
    try { await api(`/api/drafts/${b.dataset.regen}/regenerate`, { instruction }); toast("Rewritten"); loadDrafts(); } catch (e) { fail(e); }
  });
  $$("[data-edit]").forEach((b) => b.onclick = async () => {
    const id = b.dataset.edit, box = $(`#edit-${id}`);
    if (box.innerHTML) { box.innerHTML = ""; return; }
    const d = await api(`/api/drafts/${id}`);
    box.innerHTML = `<label>Subject<input id="es-${id}" value="${esc(d.subject)}"></label>
      <label>Body<textarea id="eb-${id}" rows="10">${esc(d.body_text)}</textarea></label>
      <button class="secondary small" id="save-${id}">Save as new version</button>`;
    $(`#save-${id}`).onclick = async () => {
      try { await api(`/api/drafts/${id}/edit`, { subject: $(`#es-${id}`).value, body: $(`#eb-${id}`).value }); toast("Saved"); loadDrafts(); }
      catch (e) { fail(e); }
    };
  });
}
$("#reviewFilter").onchange = loadDrafts;

/* ------------------------------------------------------------------ send */
async function loadSend() {
  const s = await api("/api/send/status").catch(() => null);
  if (!s) return;
  $("#sendStats").innerHTML = `
    <div class="stat"><b>${s.approved}</b><span>approved &amp; waiting</span></div>
    <div class="stat"><b>${s.sentLast24h}/${s.dailyLimit}</b><span>sent in 24h</span></div>
    <div class="stat"><b>${s.remaining}</b><span>left today</span></div>
    <div class="stat"><b>${s.running ? "on" : "off"}</b><span>${s.paused ? "paused" : "sender"}</span></div>`;
  if (s.lastOutcome) $("#sendStats").insertAdjacentHTML("afterend", "");
  $("#sendLog").innerHTML = s.recent.length ? `<div class="scroll"><table><tr><th>To</th><th>Subject</th><th>Status</th><th>When</th></tr>
    ${s.recent.map((r) => `<tr><td><code>${esc(r.to_email)}</code></td><td>${esc(r.subject)}</td>
      <td><span class="tag ${r.status === "sent" ? "good" : r.status === "failed" ? "bad" : ""}">${esc(r.status)}</span>
      ${r.error_message ? `<div class="muted">${esc(r.error_message.slice(0, 120))}</div>` : ""}</td>
      <td class="muted">${r.sent_at ? new Date(r.sent_at).toLocaleString() : ""}</td></tr>`).join("")}</table></div>`
    : `<p class="muted">Nothing sent yet.</p>`;
}
$("#btnSendStart").onclick = async () => { try { await api("/api/send/start", {}); toast("Sending started"); loadSend(); } catch (e) { fail(e); } };
$("#btnSendPause").onclick = async () => { try { await api("/api/send/pause", {}); toast("Paused"); loadSend(); } catch (e) { fail(e); } };
setInterval(() => { if (!$("#tab-send").classList.contains("hidden")) loadSend(); }, 5000);

/* --------------------------------------------------------------- replies */
async function loadReplies() {
  const rows = await api("/api/replies").catch(() => []);
  $("#replyList").innerHTML = rows.length ? rows.map((r) => `
    <div class="item">
      <div class="top"><div><h3>${esc(r.company ?? r.from_email)}</h3>
        <div class="muted">${esc(r.from_email)} · ${new Date(r.received_at).toLocaleString()}</div></div>
        ${r.classification ? `<span class="tag ${r.classification === "interested" ? "good" : r.classification === "unsubscribe" ? "bad" : ""}">${esc(r.classification)}</span>` : ""}</div>
      <div class="email"><div class="subj">${esc(r.subject)}</div><pre>${esc(r.body_text || "(open to load)")}</pre></div>
      <div class="row"><button class="secondary small" data-reply="${esc(r.id)}">Draft a response</button>
        <button class="secondary small" data-handled="${esc(r.id)}">Mark handled</button></div>
      <div id="rd-${esc(r.id)}"></div>
    </div>`).join("") : `<p class="muted">No replies yet.</p>`;
  $$("[data-reply]").forEach((b) => b.onclick = async () => {
    const id = b.dataset.reply; b.disabled = true; toast("Reading and drafting…");
    try {
      const r = await api(`/api/replies/${id}/draft`, {});
      $(`#rd-${id}`).innerHTML = `<div class="cite">Read as <b>${esc(r.classification.classification)}</b> (${Math.round(r.classification.confidence * 100)}%) — ${esc(r.classification.summary)}</div>
        <div class="email"><pre>${esc(r.draft)}</pre></div>
        <p class="hint">Copy this into your mail client, or just write your own. Nothing is sent from here.</p>
        ${r.suggestSuppress ? `<button class="danger small" id="sup-${id}">They asked to stop — add to never-contact</button>` : ""}`;
      if (r.suggestSuppress) $(`#sup-${id}`).onclick = async () => {
        const email = rows.find((x) => x.id === id)?.from_email;
        await api("/api/suppression", { pattern: email, reason: "unsubscribe" }); toast("Added"); };
    } catch (e) { fail(e); } finally { b.disabled = false; }
  });
  $$("[data-handled]").forEach((b) => b.onclick = async () => { await api(`/api/replies/${b.dataset.handled}/handled`, {}); loadReplies(); });
}
$("#btnPoll").onclick = async () => { try { await api("/api/replies/poll", {}); toast("Checking…"); } catch (e) { fail(e); } };

/* ------------------------------------------------------------------ logs */
async function loadLogs() {
  const rows = await api(`/api/llm-calls${$("#failedOnly").checked ? "?failed=1" : ""}`).catch(() => []);
  $("#logList").innerHTML = rows.length ? `<div class="scroll"><table>
    <tr><th>Task</th><th>Model</th><th>Result</th><th>ms</th><th>When</th></tr>
    ${rows.map((r) => `<tr><td>${esc(r.task)}${r.search_calls ? ` <span class="tag">${r.search_calls} search</span>` : ""}</td>
      <td class="muted">${esc(r.model_id)}</td>
      <td>${r.ok ? "<span class='tag good'>ok</span>" : `<span class='tag bad'>${esc(r.error_code ?? "failed")}</span>`}
        ${r.attempts > 1 ? `<span class="tag warn">${r.attempts} attempts</span>` : ""}
        ${!r.ok && r.response_text ? `<details><summary>raw output</summary><pre style="white-space:pre-wrap;font-size:12px">${esc(r.response_text)}</pre></details>` : ""}</td>
      <td class="muted">${r.duration_ms}</td><td class="muted">${new Date(r.created_at).toLocaleTimeString()}</td></tr>`).join("")}</table></div>`
    : `<p class="muted">No calls yet.</p>`;
}
$("#btnRefreshLogs").onclick = loadLogs;
$("#failedOnly").onchange = loadLogs;

/* ------------------------------------------------------------------ boot */
// Land on Setup until there is a product, then on Campaign - so a first run starts where the
// work starts, and a returning user lands where they left off.
(async () => {
  await loadHealth();
  const p = await api("/api/product").catch(() => null);
  show(p && p.status === "ready" ? "campaign" : "setup");
})();
