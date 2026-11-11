// Delegiq website. Plain JavaScript, no build step.
// Security is enforced by the database rules; this file only decides what to show.
import { auth, db } from "./api.js";
import { T, LANG, LANGS, LOCALE, setLang, applyLang } from "./i18n.js";
applyLang();
const L = (en, fr, ar) => ({ fr, ar }[LANG] ?? en);

const cfg = window.HANDOFF_CONFIG || {};
const STATUS = { todo: "To do", progress: "In progress", blocked: "Blocked", review: "Waiting for approval", done: "Done" };
const SHORT = { ...STATUS, review: "Approval" };
const REPEAT = { none: "Doesn’t repeat", daily: "Every day", weekdays: "Every weekday", weekly: "Every week", monthly: "Every month" };
const STATUS_KEYS = Object.keys(STATUS);
const PRI = ["Low", "Medium", "High", "Urgent"];
// Numbered rights. "Below me" = same team, lower level number.
const RIGHTS = {
  1: "See and update my own tasks",
  2: "See the tasks of people below me in my team",
  3: "Create tasks and give them to people below me",
  4: "Edit and reassign those tasks",
  5: "Delete those tasks",
  6: "See activity and reports for people below me",
  7: "Add people below me and send them logins",
  8: "Change the level and rights of people below me",
  9: "See and manage everyone, in every team",
  10: "Change company settings and the level list",
};
const TIMEZONES = ["Asia/Qatar", "Asia/Dubai", "Asia/Riyadh", "Asia/Kuwait", "Asia/Bahrain", "Asia/Muscat", "Africa/Tunis", "Africa/Cairo", "Europe/London", "Europe/Paris", "UTC"];

const S = { session: null, uid: null, email: "", mems: [], me: null, ws: null, members: [], tasks: [], levels: [], loaded: false, recovery: false, booted: false };
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const view = () => $("#view");

/* ---------- small helpers ---------- */
function toast(msg) { const t = $("#toast"); t.textContent = T(msg); t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), 3000); }
function today() { return new Intl.DateTimeFormat("en-CA", { timeZone: S.ws?.timezone || undefined, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
const dd = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const addDays = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
const fmtD = (d) => (d ? new Date(String(d).slice(0, 10) + "T00:00:00Z").toLocaleDateString(LOCALE(), { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }) : "—");
const fmtT = (t) => { const d = new Date(t); return d.toLocaleDateString(LOCALE(), { day: "numeric", month: "short" }) + " " + d.toLocaleTimeString(LOCALE(), { hour: "2-digit", minute: "2-digit" }); };
const isOpen = (t) => t.status !== "done";
const isLate = (t) => isOpen(t) && dd(today(), t.deadline) < 0;
function dueText(t) {
  if (!isOpen(t)) return fmtD(t.deadline);
  const d = dd(today(), t.deadline);
  if (d < 0) return L(`${-d} day${d === -1 ? "" : "s"} late`, `${-d} j de retard`, -d === 1 ? "متأخرة يومًا" : -d === 2 ? "متأخرة يومين" : `متأخرة ${-d} أيام`);
  if (d === 0) return L("Due today", "Pour aujourd’hui", "مستحقة اليوم");
  if (d === 1) return L("Tomorrow", "Demain", "غدًا");
  if (d < 7) return L(`In ${d} days`, `Dans ${d} jours`, d === 2 ? "بعد يومين" : `بعد ${d} أيام`);
  return fmtD(t.deadline);
}
const dueCls = (t) => { if (!isOpen(t)) return ""; const d = dd(today(), t.deadline); return d < 0 ? "late" : d <= 1 ? "soon" : ""; };
const member = (id) => S.members.find((m) => m.id === id) || null;
const nameOf = (id) => member(id)?.name || null;
const openCount = (id) => S.tasks.filter((t) => t.assignee_id === id && isOpen(t)).length;
const has = (r) => !!S.me?.rights?.includes(r);
const isManager = () => has(9);
const isBoss = () => has(2) || has(9);
// does my right r reach this person? (right 9 reaches everyone; otherwise same team, lower level)
const reaches = (m, r) => !!m && has(r) && (has(9) || (!!m.team && m.team === S.me.team && m.level < S.me.level));
const levelName = (n) => S.levels.find((l) => l.level === n)?.name || `Level ${n}`;
const levelTag = (m) => `L${m.level} · ${levelName(m.level)}`;
const rightsList = (arr) => (arr || []).slice().sort((a, b) => a - b).join(", ");
function hash(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }
function av(name) {
  if (!name) return `<span class="av none" aria-hidden="true">?</span>`;
  const ini = String(name).trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  const h = hash(name);
  return `<span class="av" style="background:hsl(${18 + (h % 22)} ${28 + (h % 14)}% ${30 + ((h >> 5) % 14)}%)" aria-hidden="true">${esc(ini)}</span>`;
}
const stLabel = (s) => `<span class="st pill-${s}"><span class="dot s-${s}"></span>${STATUS[s]}</span>`;
function busy(btn, on, label) { if (!btn) return; if (on) { btn.dataset.l = btn.textContent; btn.textContent = label || "Working…"; btn.disabled = true; } else { btn.textContent = btn.dataset.l || btn.textContent; btn.disabled = false; } }
function formData(form) { return Object.fromEntries(new FormData(form).entries()); }

/* ---------- routing ---------- */
function route() {
  let h = location.hash.replace(/^#/, "");
  if (/^(access_token|error|type=)/.test(h)) h = "";
  const [path, qs] = h.replace(/^\//, "").split("?");
  return { parts: path.split("/").filter(Boolean), q: new URLSearchParams(qs || "") };
}
const go = (p) => { location.hash = "#/" + p; };
window.addEventListener("hashchange", () => render());

function navItems() {
  if (!S.me) return [];
  const n = [];
  if (isBoss()) n.push(["overview", "Overview"], ["tasks", has(9) ? "Tasks" : "Team tasks"]);
  n.push(["my", "My tasks"]);
  if (has(7) || has(8) || has(9)) n.push(["people", "People"]);
  if (has(6) || has(9)) n.push(["activity", "Activity"], ["reports", "Reports"]);
  n.push(["settings", "Settings"]);
  return n;
}
const homePage = () => (isBoss() ? "overview" : "my");

/* ---------- boot ---------- */
async function boot() {
  auth.onChange(async (event, session) => {
    if (event === "PASSWORD_RECOVERY") { S.recovery = true; S.session = session; go("new-password"); return; }
    if (event === "SIGNED_OUT") { Object.assign(S, { session: null, uid: null, mems: [], me: null, ws: null, members: [], tasks: [], loaded: false }); render(); return; }
    if (event === "SIGNED_IN" && session && session.user.id !== S.uid && !starting) { await startSession(session); render(); }
  });
  let session = await auth.session();
  if (session && Date.now() - lastActive() > IDLE_MS) { await auth.signOut(); session = null; S.idleOut = true; }
  touch(); watchIdle();
  if (session) await startSession(session);
  S.booted = true;
  render();
  setInterval(() => { if (S.ws && !document.hidden && !isTyping()) reload(true); }, 60000);
  window.addEventListener("focus", () => { if (S.ws && !isTyping()) reload(true); });
}
const isTyping = () => { const a = document.activeElement; return a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.value; };

// only one sign-in setup at a time (the boot check and the sign-in event can arrive together)
let starting = null;
function startSession(session) { return starting || (starting = onSession(session).finally(() => { starting = null; })); }
async function onSession(session) {
  S.session = session; S.uid = session.user.id; S.email = session.user.email;
  S.mustChange = !!session.user.user_metadata?.must_change_password;
  try {
    S.mems = await db.memberships(S.uid);
  } catch (e) { S.mems = []; toast(e.message); }
  let pick = null;
  try { pick = localStorage.getItem("handoff.ws"); } catch {}
  S.me = S.mems.find((m) => m.workspace_id === pick) || S.mems[0] || null;
  // two-step sign-in: required for rights 7-10, optional for everyone else
  try { [S.aal, S.factors] = await Promise.all([auth.aal(), auth.factors()]); } catch { S.aal = { currentLevel: "aal1" }; S.factors = { totp: [] }; }
  const hasFactor = (S.factors.totp || []).length > 0;
  S.needs2fa = !!S.me?.rights?.some((r) => r >= 7);
  S.gate = S.needs2fa && !hasFactor ? "setup" : hasFactor && S.aal.currentLevel !== "aal2" ? "code" : null;
  S.ws = S.gate ? null : S.me?.workspaces || null;
  S.loaded = false;
  if (S.ws) { await reload(); recordSignInOnce(session); }
}

function deviceName() {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Android/.test(ua) ? "Android" : /Mac OS/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Other";
  const br = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${br} on ${os}`;
}
function recordSignInOnce(session) {
  const key = "handoff.signin." + session.user.id + "." + (session.user.last_sign_in_at || "");
  try { if (localStorage.getItem(key)) return; localStorage.setItem(key, "1"); } catch {}
  db.recordSignIn(deviceName()).catch(() => {});
}

/* ---------- automatic sign-out after inactivity ---------- */
const IDLE_MS = (Number(cfg.idleMinutes) || 30) * 60000;
const touch = () => { try { localStorage.setItem("handoff.active", String(Date.now())); } catch {} };
const lastActive = () => { try { return Number(localStorage.getItem("handoff.active")) || Date.now(); } catch { return Date.now(); } };
function watchIdle() {
  ["pointerdown", "keydown", "scroll", "touchstart"].forEach((ev) => window.addEventListener(ev, () => { if (Date.now() - (watchIdle.t || 0) > 15000) { watchIdle.t = Date.now(); touch(); } }, { passive: true }));
  setInterval(async () => {
    if (S.session && Date.now() - lastActive() > IDLE_MS) { S.idleOut = true; await auth.signOut(); }
  }, 30000);
}

async function reload(quiet) {
  try {
    const [members, tasks, levels] = await Promise.all([db.members(S.ws.id), db.tasks(S.ws.id), db.levels(S.ws.id)]);
    S.members = members; S.tasks = tasks; S.levels = levels; S.loaded = true; S.loadErr = "";
    const mine = members.find((m) => m.user_id === S.uid);
    if (mine) S.me = { ...S.me, ...mine };
    if (quiet) { const r = route(); if (!["new", "people", "settings"].includes(r.parts[0]) && r.parts[0] !== "tasks" || (r.parts[0] === "tasks" && !r.parts[1])) render(); }
  } catch (e) { if (!S.loaded) S.loadErr = e.message; if (!quiet) toast(e.message); }
}

/* ---------- icons (outline, 24px grid) ---------- */
const P = {
  overview: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  tasks: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M3.5 6l1.5 1.5L7.5 5M3.5 12l1.5 1.5L7.5 11M3.5 18l1.5 1.5L7.5 17"/>',
  my: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4.5-6 8-6s7 2 8 6"/>',
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><circle cx="17.5" cy="9" r="2.5"/><path d="M17 14.5c2.3 0 4 1.5 4.5 4"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  reports: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  tpl: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  wa: '<path d="M4 20l1.3-3.9A8 8 0 1 1 8 19z"/><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1-1.5-2-1-1 .8a4 4 0 0 1-1.8-1.8l.8-1-1-2z"/>',
  spark: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  board: '<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="10" rx="1.5"/><rect x="17" y="4" width="4" height="13" rx="1.5"/>',
  alert: '<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17.5v.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>',
  block: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
  inbox: '<path d="M3 13l3-8h12l3 8v6H3z"/><path d="M3 13h5l1.5 2.5h5L16 13h5"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  out: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11"/>',
};
const ic = (k, cls = "") => `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[k] || ""}</svg>`;

/* ---------- chrome ---------- */
function renderChrome(active) {
  const side = $("#sidebar"), mtop = $("#mtop"), tab = $("#tabbar");
  const on = !!(S.me && S.ws);
  document.body.classList.toggle("in-app", on);
  side.hidden = mtop.hidden = tab.hidden = !on;
  if (!on) return;
  const wsPick = S.mems.length > 1
    ? `<select class="ws-pick" id="wsPick" aria-label="Switch team">${S.mems.map((m) => `<option value="${esc(m.workspace_id)}" ${m.workspace_id === S.ws.id ? "selected" : ""}>${esc(m.workspaces.name)}</option>`).join("")}</select>`
    : `<span>${esc(S.ws.name)}</span>`;
  $("#wsName").innerHTML = wsPick;
  const items = navItems();
  $("#nav").innerHTML = (canCreate() ? `<a class="nav-new" href="#/new">${ic("plus")}<span>New task</span></a>` : "") +
    items.map(([k, l]) => `<a href="#/${k}" ${k === active ? 'aria-current="page"' : ""}>${ic(k)}<span>${l}</span></a>`).join("");
  $("#who").innerHTML = `<a class="me-card" href="#/settings">${av(S.me.name)}<span class="me-txt"><b>${esc(S.me.name)}</b><span>${esc(levelTag(S.me))}</span></span></a>
    <button class="icon-btn" id="sideOut" type="button" title="Sign out" aria-label="Sign out">${ic("out")}</button>`;
  $("#sideOut").onclick = () => auth.signOut();
  mtop.innerHTML = `<a class="brand" href="#/"><img src="icon.svg" alt="" width="26" height="26"><span>Delegiq</span></a><span class="ws">${esc(S.ws.name)}</span><a href="#/settings" aria-label="Settings">${av(S.me.name)}</a>`;
  // phone tab bar: the four most-used places, plus a big + in the middle when you can create tasks
  const main = items.filter(([k]) => ["overview", "tasks", "my", "people"].includes(k)).slice(0, 4);
  const rest = items.filter(([k]) => !main.some(([m]) => m === k));
  const cells = main.map(([k, l]) => `<a href="#/${k}" ${k === active ? 'aria-current="page"' : ""}>${ic(k)}<span>${l.replace("Team tasks", "Team")}</span></a>`);
  if (canCreate()) cells.splice(Math.min(2, cells.length), 0, `<a class="tab-new" href="#/new" aria-label="New task">${ic("plus")}</a>`);
  if (rest.length) cells.push(`<a href="#/more" ${["more", ...rest.map(([k]) => k)].includes(active) ? 'aria-current="page"' : ""}>${ic("more")}<span>More</span></a>`);
  tab.innerHTML = cells.join("");
}
function vMore() {
  view().innerHTML = `<div class="page-head"><h1>More</h1></div><div class="more-list">${navItems().map(([k, l]) => `<a href="#/${k}">${ic(k)}<span>${l}</span></a>`).join("")}
    <button type="button" id="moreOut">${ic("out")}<span>Sign out</span></button></div>`;
  $("#moreOut").onclick = () => auth.signOut();
}

/* ---------- main render ---------- */
async function render() {
  if (!S.booted) return;
  const { parts, q } = route();
  const page = parts[0] || "";

  if (!S.session) {
    renderChrome();
    if (page === "signup") return vSignup(q);
    if (page === "forgot") return vForgot();
    return vLogin();
  }
  if (S.recovery || S.mustChange || page === "new-password") { renderChrome(); return vNewPassword(); }
  if (S.gate === "setup") { renderChrome(); return vMfaSetup(true); }
  if (S.gate === "code") { renderChrome(); return vMfaCode(); }
  if (!S.me) { renderChrome(); return vSetup(); }
  if (!S.loaded) {
    view().innerHTML = S.loadErr
      ? `<div class="pad"><p class="err">${esc(S.loadErr)}</p><button class="btn" id="retryLoad" type="button">Try again</button></div>`
      : `<p class="muted pad">Loading…</p>`;
    const again = () => { S.loadErr = ""; reload().then(render); };
    if (S.loadErr) $("#retryLoad").onclick = again;
    else if (S.ws && !starting && !render.waiting) { render.waiting = true; setTimeout(() => { render.waiting = false; if (!S.loaded && !starting) again(); }, 1500); }
    return;
  }

  const allowed = navItems().map((n) => n[0]).concat(has(3) || has(9) ? ["new"] : []).concat(["tasks", "more"]);
  const p = page && allowed.includes(page) ? page : (["login", "signup", ""].includes(page) ? homePage() : page);
  if (!allowed.includes(p)) { go(homePage()); return; }
  renderChrome(p === "tasks" && parts[1] ? (isBoss() ? "tasks" : "my") : p);
  window.scrollTo(0, 0);
  try {
    if (p === "overview") return await vOverview();
    if (p === "tasks" && parts[1]) return await vTask(parts[1]);
    if (p === "tasks") return isBoss() ? vTasks(q) : go("my");
    if (p === "new") return vNew(q);
    if (p === "my") return vMy();
    if (p === "people") return vPeople();
    if (p === "activity") return await vActivity(q);
    if (p === "reports") return vReports(q);
    if (p === "settings") return vSettings();
    if (p === "more") return vMore();
  } catch (e) {
    view().innerHTML = `<div class="pad"><h1>Something went wrong</h1><p class="err">${esc(e.message)}</p><a class="btn" href="#/${homePage()}">Back</a></div>`;
  }
}

/* ---------- sign in / up ---------- */
function authShell(inner) {
  view().innerHTML = `<div class="auth-wrap">
    <section class="auth-art" aria-hidden="true">
      <div class="brand light"><img src="icon.svg" alt="" width="34" height="34"><span>Delegiq</span></div>
      <div class="art-copy"><h2>Hand out work.<br>Know when it slips.</h2>
        <ul><li>${ic("spark")}Describe a task in one sentence, AI picks the right person</li><li>${ic("clock")}Reminders before every deadline, alerts when it’s late</li><li>${ic("people")}Each person sees exactly what their level allows</li></ul></div>
      <div class="art-cards"><div class="mini"><span class="dot s-progress"></span>Q4 sales report<span class="due">Tomorrow</span></div><div class="mini"><span class="dot s-blocked"></span>Venue booking<span class="due late">1 day late</span></div><div class="mini"><span class="dot s-done"></span>Supplier list<span class="due">Done</span></div></div>
    </section>
    <section class="auth"><div class="lang-pick" role="group" aria-label="Language">${Object.entries(LANGS).map(([k, v]) => `<button type="button" data-lang="${k}" lang="${k}" aria-pressed="${LANG === k}">${v}</button>`).join("")}</div><div class="brand mobile-only"><img src="icon.svg" alt="" width="30" height="30"><span>Delegiq</span></div>${inner}</section></div>`;
  view().querySelectorAll(".lang-pick [data-lang]").forEach((x) => (x.onclick = () => { setLang(x.dataset.lang); render(); }));
}
function googleBtn() { return cfg.googleSignIn ? `<div class="or">or</div><button class="btn" type="button" id="google">Continue with Google</button>` : ""; }
function wireGoogle() { const g = $("#google"); if (g) g.onclick = async () => { try { await auth.google(); } catch (e) { toast(e.message); } }; }

function vLogin() {
  authShell(`${S.idleOut ? `<p class="notice-line">You were signed out after ${Math.round(IDLE_MS / 60000)} minutes without activity.</p>` : ""}<h1>Welcome back</h1><p>Sign in to see your tasks.</p>
    <form id="f" novalidate>
      <label class="lb">Email<input class="field" name="email" type="email" autocomplete="email" required></label>
      <label class="lb">Password<input class="field" name="password" type="password" autocomplete="current-password" required></label>
      <span class="err" id="err"></span>
      <button class="btn primary" type="submit">Sign in</button>
    </form>${googleBtn()}
    <p class="small"><a href="#/forgot">Forgot your password?</a></p>
    <p class="small" id="newHere" hidden>New to Delegiq? <a href="#/signup">Start your free 14-day trial</a></p>
    <p class="small muted">Joining a team? Your manager sends you a login.</p>`);
  wireGoogle();
  db.signupOpen().then((o) => { const n = $("#newHere"); if (n) n.hidden = !o; }).catch(() => {});
  $("#f").onsubmit = async (e) => {
    e.preventDefault(); const f = formData(e.target), b = e.target.querySelector("button");
    if (!f.email || !f.password) { $("#err").textContent = "Enter your email and password."; return; }
    busy(b, true, "Signing in…");
    try { const r = await auth.signIn(f.email.trim(), f.password); S.idleOut = false; touch(); await onSession(r.session); go(homePage()); render(); }
    catch (err) { $("#err").textContent = err.message; busy(b, false); }
  };
}

async function vSignup(q) {
  const invited = q.get("email") || "";
  let open = false; try { open = await db.signupOpen(); } catch {}
  if (!open) { authShell(`<h1>Accounts are created by your manager</h1><p>Ask your manager to add you on the People page. You’ll get an email with a temporary password.</p><a class="btn" href="#/login">Back to sign in</a>`); return; }
  authShell(`<p>${invited ? "Your manager added you to a team. Create your account with this email to see your tasks." : "Start your free 14-day trial. No card needed. Joining a team? Your manager sends you a login instead."}</p>
    <form id="f" novalidate>
      <label class="lb">Your name<input class="field" name="name" autocomplete="name" required></label>
      <label class="lb">Email<input class="field" name="email" type="email" autocomplete="email" value="${esc(invited)}" required></label>
      <label class="lb">Password <span class="hint">at least 8 characters</span><input class="field" name="password" type="password" autocomplete="new-password" minlength="8" required></label>
      <span class="err" id="err"></span>
      <button class="btn primary" type="submit">Create account</button>
    </form>${googleBtn()}
    <p class="small">Already have an account? <a href="#/login">Sign in</a></p>`);
  wireGoogle();
  $("#f").onsubmit = async (e) => {
    e.preventDefault(); const f = formData(e.target), b = e.target.querySelector("button");
    if (!f.name.trim() || !f.email.trim()) { $("#err").textContent = "Fill in your name and email."; return; }
    if ((f.password || "").length < 8) { $("#err").textContent = "Use a password of at least 8 characters."; return; }
    busy(b, true, "Creating…");
    try {
      const r = await auth.signUp(f.email.trim(), f.password, f.name.trim());
      if (r.session) { await onSession(r.session); go(homePage()); render(); return; }
      authShell(`<h1>Check your email</h1><p>We sent a link to <b>${esc(f.email)}</b>. Open it to confirm your account, then sign in.</p><a class="btn" href="#/login">Back to sign in</a>`);
    } catch (err) { $("#err").textContent = err.message; busy(b, false); }
  };
}

function vForgot() {
  authShell(`<p>We’ll email you a link to choose a new password.</p>
    <form id="f" novalidate><label class="lb">Email<input class="field" name="email" type="email" autocomplete="email" required></label>
    <span class="err" id="err"></span><button class="btn primary" type="submit">Send link</button></form>
    <p class="small"><a href="#/login">Back to sign in</a></p>`);
  $("#f").onsubmit = async (e) => {
    e.preventDefault(); const f = formData(e.target), b = e.target.querySelector("button");
    if (!f.email) { $("#err").textContent = "Enter your email."; return; }
    busy(b, true, "Sending…");
    try { await auth.resetPassword(f.email.trim()); authShell(`<h1>Check your email</h1><p>If there’s an account for <b>${esc(f.email)}</b>, a link is on its way.</p><a class="btn" href="#/login">Back to sign in</a>`); }
    catch (err) { $("#err").textContent = err.message; busy(b, false); }
  };
}

function vNewPassword() {
  authShell(`<h1>${S.mustChange ? "Choose your own password" : "Choose a new password"}</h1>
    ${S.mustChange ? `<p>You signed in with a temporary password from your manager. Pick one only you know.</p>` : ""}
    <form id="f" novalidate><label class="lb">New password<input class="field" name="p1" type="password" autocomplete="new-password" minlength="8"></label>
    <label class="lb">Type it again<input class="field" name="p2" type="password" autocomplete="new-password"></label>
    <span class="err" id="err"></span><button class="btn primary" type="submit">Save password</button></form>`);
  $("#f").onsubmit = async (e) => {
    e.preventDefault(); const f = formData(e.target), b = e.target.querySelector("button");
    if ((f.p1 || "").length < 8) { $("#err").textContent = "Use at least 8 characters."; return; }
    if (f.p1 !== f.p2) { $("#err").textContent = "The two passwords don’t match."; return; }
    busy(b, true, "Saving…");
    try { await auth.setPassword(f.p1); S.recovery = false; S.mustChange = false; toast("Password saved"); await onSession(await auth.session()); go(homePage()); render(); }
    catch (err) { $("#err").textContent = err.message; busy(b, false); }
  };
}

async function vMfaSetup(required) {
  authShell(`<p class="muted">Getting your code ready…</p>`);
  let f;
  try { f = await auth.enroll(); } catch (e) { authShell(`<h1>Two-step sign-in</h1><p class="err">${esc(e.message)}</p><p class="small"><a href="#" id="out">Sign out</a></p>`); $("#out").onclick = (ev) => { ev.preventDefault(); auth.signOut(); }; return; }
  authShell(`<h1>Set up two-step sign-in</h1>
    <p>${required ? "Your access level can add people or see the whole company, so it needs a second step. " : ""}Scan this code with an authenticator app such as Google Authenticator or Microsoft Authenticator, then type the 6-digit code it shows.</p>
    <div class="qr"><img src="${esc(f.totp.qr_code)}" alt="QR code for your authenticator app" width="200" height="200"></div>
    <p class="small">Can’t scan it? Type this key into the app: <span class="mono key">${esc(f.totp.secret)}</span></p>
    <form id="f" novalidate><label class="lb">6-digit code<input class="field code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*"></label>
    <span class="err" id="err"></span><button class="btn primary" type="submit">Turn on</button></form>
    <p class="small">${required ? `<a href="#" id="out">Sign out</a>` : `<a href="#/settings">Not now</a>`}</p>`);
  const out = $("#out"); if (out) out.onclick = (e) => { e.preventDefault(); auth.signOut(); };
  wireCode(f.id, "Two-step sign-in is on");
}
function vMfaCode() {
  const factor = (S.factors.totp || [])[0];
  authShell(`<h1>Enter your code</h1><p>Open your authenticator app and type the 6-digit code for Delegiq.</p>
    <form id="f" novalidate><label class="lb">6-digit code<input class="field code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*" autofocus></label>
    <span class="err" id="err"></span><button class="btn primary" type="submit">Continue</button></form>
    <p class="small muted">Lost your phone? Ask whoever runs Delegiq for your company to reset your two-step sign-in.</p>
    <p class="small"><a href="#" id="out">Sign out</a></p>`);
  $("#out").onclick = (e) => { e.preventDefault(); auth.signOut(); };
  wireCode(factor.id);
}
function wireCode(factorId, okMsg) {
  const input = $("#f [name=code]"); input.focus();
  input.oninput = () => { input.value = input.value.replace(/\D/g, "").slice(0, 6); if (input.value.length === 6) $("#f").requestSubmit(); };
  $("#f").onsubmit = async (e) => {
    e.preventDefault(); const b = e.target.querySelector("button"), code = input.value;
    if (!/^\d{6}$/.test(code)) { $("#err").textContent = "Type the 6 digits from the app."; return; }
    busy(b, true, "Checking…");
    try { const s = await auth.verify(factorId, code); await onSession(s); if (okMsg) toast(okMsg); go(homePage()); render(); }
    catch (err) { $("#err").textContent = err.message; busy(b, false); input.select(); }
  };
}

function vSetup() {
  const nm = S.session.user.user_metadata?.name || "";
  view().innerHTML = `<div class="auth">
    <div class="brand">Delegiq</div>
    <h1>Set up your team</h1>
    <p>You’ll be the manager: you add people, hand out tasks and see everyone’s progress.</p>
    <form id="f" novalidate>
      <label class="lb">Team or company name<input class="field" name="team" placeholder="Al Noor Events" required></label>
      <label class="lb">Your name<input class="field" name="name" value="${esc(nm)}" required></label>
      <span class="err" id="err"></span>
      <button class="btn primary" type="submit">Create team</button>
    </form>
    <p class="small muted">Joining someone else’s team instead? Ask your manager to add <b>${esc(S.email)}</b>, then <a href="#" id="refresh">refresh</a>.</p>
    <p class="small"><a href="#" id="out">Sign out</a></p></div>`;
  $("#out").onclick = (e) => { e.preventDefault(); auth.signOut(); };
  $("#refresh").onclick = async (e) => { e.preventDefault(); await onSession(S.session); render(); };
  $("#f").onsubmit = async (e) => {
    e.preventDefault(); const f = formData(e.target), b = e.target.querySelector("button");
    if (!f.team.trim() || !f.name.trim()) { $("#err").textContent = "Fill in both fields."; return; }
    busy(b, true, "Creating…");
    try { await db.createWorkspace(f.team.trim(), f.name.trim()); await onSession(S.session); go("people"); render(); toast("Team created. Now add people."); }
    catch (err) { $("#err").textContent = err.message; busy(b, false); }
  };
}

/* ---------- overview (manager, lead) ---------- */
function visibleTeam() {
  return S.members.filter((m) => m.status !== "removed" && (m.id === S.me.id || reaches(m, 2)));
}
const canCreate = () => has(3) || has(9);
const newBtn = () => (canCreate() ? `<a class="btn primary" href="#/new">${ic("plus")}New task</a>` : "");
function greeting() {
  const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: S.ws?.timezone || undefined, hour: "2-digit", hourCycle: "h23" }).format(new Date()));
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}
const firstName = (n) => String(n || "").trim().split(/\s+/)[0];
const longDate = () => new Date().toLocaleDateString(LOCALE(), { weekday: "long", day: "numeric", month: "long", timeZone: S.ws?.timezone || undefined });
function briefKey() { return `handoff.brief.${S.ws.id}.${S.me.id}.${today()}`; }
function briefHtml(text) {
  return String(text || "").split(/\n+/).map((l) => l.replace(/^[-•]\s*/, "").trim()).filter(Boolean).map((l) => `<li>${esc(l)}</li>`).join("");
}
async function vOverview() {
  const t0 = today();
  const tasks = S.tasks;
  const open = tasks.filter(isOpen);
  const late = open.filter(isLate).sort((a, b) => a.deadline.localeCompare(b.deadline));
  const blocked = open.filter((t) => t.status === "blocked");
  const dueToday = open.filter((t) => t.deadline === t0);
  const week = open.filter((t) => { const d = dd(t0, t.deadline); return d >= 0 && d <= 7; });
  const done7 = tasks.filter((t) => t.completed_at && dd(t.completed_at.slice(0, 10), t0) <= 7);
  const doneAll = tasks.filter((t) => t.completed_at);
  const onTime = doneAll.length ? Math.round((doneAll.filter((t) => t.completed_at.slice(0, 10) <= t.deadline).length / doneAll.length) * 100) : null;
  const toApprove = open.filter((t) => t.status === "review" && t.assignee_id !== S.me.id && bossOf(t));
  const attention = [...toApprove, ...late.filter((t) => t.status !== "review"), ...blocked.filter((t) => !isLate(t)), ...dueToday.filter((t) => t.status !== "blocked" && t.status !== "review")];
  const team = visibleTeam();

  let cached = null; try { cached = localStorage.getItem(briefKey()); } catch {}
  const kpi = (icon, v, l, cls = "") => `<div class="panel kpi ${cls}"><span class="kpi-ic">${ic(icon)}</span><div><div class="v">${v}</div><div class="l">${l}</div></div></div>`;
  view().innerHTML = `<div class="hello"><div><p class="eyebrow">${esc(longDate())}</p><h1>${T(greeting())}${L(", ", ", ", "، ")}<span data-notr>${esc(firstName(S.me.name))}</span></h1>
      <p class="muted">${L(`${late.length ? `${late.length} late, ` : ""}${blocked.length ? `${blocked.length} blocked, ` : ""}${dueToday.length} due today across ${isManager() ? "the company" : "your team"}.`,
        `${late.length ? `${late.length} en retard, ` : ""}${blocked.length ? `${blocked.length} bloquée(s), ` : ""}${dueToday.length} pour aujourd’hui dans ${isManager() ? "l’entreprise" : "votre équipe"}.`,
        `${late.length ? `${late.length} متأخرة، ` : ""}${blocked.length ? `${blocked.length} متوقفة، ` : ""}${dueToday.length} مستحقة اليوم في ${isManager() ? "الشركة" : "فريقك"}.`)}</p></div>${newBtn()}</div>
  <div class="panel brief-card">
    <div class="brief-h"><span class="ai-badge">${ic("spark")}AI brief</span><span class="muted small">${cached ? "Today" : "What needs your attention, in a few lines"}</span>
      <button class="btn small ${cached ? "" : "primary"}" id="briefBtn" type="button">${ic("spark")}${cached ? "Rewrite" : "Write today’s brief"}</button></div>
    <ul class="brief-list" id="brief">${cached ? briefHtml(cached) : ""}</ul><p class="err small" id="briefErr" style="margin:0"></p>
  </div>
  <div class="grid kpis">
    ${kpi("inbox", open.length, "Open")}
    ${kpi("alert", late.length, "Late", late.length ? "bad" : "")}
    ${kpi("block", blocked.length, "Blocked", blocked.length ? "warn" : "")}
    ${kpi("clock", week.length, "Due this week")}
    ${kpi("check", done7.length, "Done this week", "ok")}
    ${kpi("target", onTime == null ? "–" : onTime + "%", "Finished on time")}
  </div>
  <div class="grid two">
    <div class="grid" style="align-content:start">
      <div class="panel"><h2>Needs attention</h2><div class="att">${attention.map((t) => `<a href="#/tasks/${t.id}">
        <span class="dot s-${t.status}"></span><span class="tt">${esc(t.title)}</span><span class="muted small">${esc(nameOf(t.assignee_id) || "Unassigned")}</span>
        <span class="meta due ${dueCls(t)}">${t.status === "review" ? "Approve" : t.status === "blocked" && !isLate(t) ? "Blocked" : esc(dueText(t))}</span></a>`).join("") || `<p class="muted" style="margin:0">Nothing late, blocked or due today.</p>`}</div></div>
      <div class="panel"><h2>Latest updates</h2><div class="feed" id="feed"><p class="muted" style="margin:0">Loading…</p></div>
        <p class="small" style="margin:10px 0 0"><a href="#/activity">All activity</a></p></div>
    </div>
    <div class="panel"><h2>Workload</h2>
      ${team.map((m) => { const n = openCount(m.id), mx = m.max_open || 5, c = n >= mx ? "var(--bad)" : n / mx >= 0.7 ? "var(--warn)" : "var(--accent)";
        const l = S.tasks.filter((t) => t.assignee_id === m.id && isLate(t)).length;
        return `<div class="load"><span class="n">${esc(m.name)}${m.status === "invited" ? ' <span class="muted small">(invited)</span>' : ""}${!m.available ? ' <span class="muted small">(away)</span>' : ""}</span><span class="bar"><i style="width:${Math.min(100, (n / mx) * 100)}%;background:${c}"></i></span><span class="mono" style="text-align:right">${n}/${mx}${l ? ` <span style="color:var(--bad)">${l}!</span>` : ""}</span></div>`; }).join("") || `<p class="muted">No one yet. <a href="#/people">Add people</a>.</p>`}
      <p class="small muted" style="margin:10px 0 0">Open tasks against each person’s limit. A red number is late tasks.</p>
    </div>
  </div>`;
  trialBanner();
  $("#briefBtn").onclick = async () => {
    const b = $("#briefBtn"), list = $("#brief"); $("#briefErr").textContent = "";
    busy(b, true, "Thinking…"); list.innerHTML = `<li class="shimmer"></li><li class="shimmer"></li><li class="shimmer short"></li>`;
    try { const r = await db.aiBrief(S.ws.id, LANG); try { localStorage.setItem(briefKey(), r.text); } catch {} list.innerHTML = briefHtml(r.text); b.textContent = "Rewrite"; b.disabled = false; b.classList.remove("primary"); b.insertAdjacentHTML("afterbegin", ic("spark")); }
    catch (e) { list.innerHTML = cached ? briefHtml(cached) : ""; $("#briefErr").textContent = e.message; busy(b, false); }
  };
  const acts = await db.activity(S.ws.id, { limit: 12 });
  const feed = $("#feed"); if (feed) feed.innerHTML = acts.map(feedItem).join("") || `<p class="muted" style="margin:0">Nothing yet.</p>`;
}

/* ---------- activity sentences ---------- */
function sentence(a) {
  const who = a.actor_id ? (nameOf(a.actor_id) || L("Someone", "Quelqu’un", "شخص ما")) : "Delegiq";
  const d = a.detail || {};
  const t = a.task_id ? `<a href="#/tasks/${a.task_id}" data-notr>${esc(a.task_title || L("a task", "une tâche", "مهمة"))}</a>` : `“<span data-notr>${esc(a.task_title || L("a task", "une tâche", "مهمة"))}</span>”`;
  const nm = (v) => (v && v !== "Someone" ? `<span data-notr>${esc(v)}</span>` : L("nobody", "personne", "لا أحد"));
  const W = `<span data-notr>${esc(who)}</span>`, M = `<span data-notr>${esc(d.member || "")}</span>`;
  const st = (x) => esc(T(x || ""));
  switch (a.action) {
    case "created": return L(`${W} created ${t} for ${nm(d.assignee)}, due ${fmtD(d.deadline)}`, `${W} a créé ${t} pour ${nm(d.assignee)}, échéance ${fmtD(d.deadline)}`, `${W} أنشأ ${t} لـ ${nm(d.assignee)}، الموعد ${fmtD(d.deadline)}`);
    case "status": return L(`${W} moved ${t} from ${st(d.from)} to <b>${st(d.to)}</b>`, `${W} a passé ${t} de ${st(d.from)} à <b>${st(d.to)}</b>`, `${W} نقل ${t} من ${st(d.from)} إلى <b>${st(d.to)}</b>`);
    case "reassigned": return L(`${W} handed ${t} from ${nm(d.from)} to ${nm(d.to)}`, `${W} a transmis ${t} de ${nm(d.from)} à ${nm(d.to)}`, `${W} نقل ${t} من ${nm(d.from)} إلى ${nm(d.to)}`);
    case "deadline": return L(`${W} moved the deadline of ${t} from ${fmtD(d.from)} to ${fmtD(d.to)}`, `${W} a déplacé l’échéance de ${t} du ${fmtD(d.from)} au ${fmtD(d.to)}`, `${W} غيّر موعد ${t} من ${fmtD(d.from)} إلى ${fmtD(d.to)}`);
    case "priority": return L(`${W} set ${t} to ${st(d.to)} priority`, `${W} a mis ${t} en priorité ${st(d.to)}`, `${W} جعل أولوية ${t} ${st(d.to)}`);
    case "edited": return L(`${W} edited ${t}`, `${W} a modifié ${t}`, `${W} عدّل ${t}`);
    case "steps": return L(`${W} updated the steps on ${t} (${d.done}/${d.total} done)`, `${W} a mis à jour les étapes de ${t} (${d.done}/${d.total} faites)`, `${W} حدّث خطوات ${t} (${d.done}/${d.total} منجزة)`);
    case "commented": return L(`${W} commented on ${t}: “<span data-notr>${esc(d.text)}</span>”`, `${W} a commenté ${t} : « <span data-notr>${esc(d.text)}</span> »`, `${W} علّق على ${t}: «<span data-notr>${esc(d.text)}</span>»`);
    case "attached": return L(`${W} attached <span data-notr>${esc(d.file)}</span> to ${t}`, `${W} a joint <span data-notr>${esc(d.file)}</span> à ${t}`, `${W} أرفق <span data-notr>${esc(d.file)}</span> بـ ${t}`);
    case "deleted": return L(`${W} deleted ${t}`, `${W} a supprimé ${t}`, `${W} حذف ${t}`);
    case "invited": return L(`${W} added ${M}${d.level ? ` at level ${esc(d.level)} (${st(levelName(d.level))})` : ""}`, `${W} a ajouté ${M}${d.level ? ` au niveau ${esc(d.level)} (${st(levelName(d.level))})` : ""}`, `${W} أضاف ${M}${d.level ? ` في المستوى ${esc(d.level)} (${st(levelName(d.level))})` : ""}`);
    case "level": return L(`${W} moved ${M} from level ${esc(d.from)} to level ${esc(d.to)} (${st(levelName(d.to))})`, `${W} a passé ${M} du niveau ${esc(d.from)} au niveau ${esc(d.to)} (${st(levelName(d.to))})`, `${W} نقل ${M} من المستوى ${esc(d.from)} إلى المستوى ${esc(d.to)} (${st(levelName(d.to))})`);
    case "rights": return L(`${W} set ${M}’s rights to ${esc(rightsList(d.rights))}`, `${W} a fixé les droits de ${M} à ${esc(rightsList(d.rights))}`, `${W} حدّد صلاحيات ${M}: ${esc(rightsList(d.rights))}`);
    case "team": return L(`${W} moved ${M} from ${esc(d.from || "no team")} to ${esc(d.to || "no team")}`, `${W} a déplacé ${M} de ${esc(d.from || "aucune équipe")} vers ${esc(d.to || "aucune équipe")}`, `${W} نقل ${M} من ${esc(d.from || "بلا فريق")} إلى ${esc(d.to || "بلا فريق")}`);
    case "password_sent": return L(`${W} sent ${M} a new password`, `${W} a envoyé un nouveau mot de passe à ${M}`, `${W} أرسل كلمة مرور جديدة إلى ${M}`);
    case "role": return L(`${W} changed ${M}’s access`, `${W} a modifié l’accès de ${M}`, `${W} غيّر صلاحيات وصول ${M}`);
    case "member_active": return L(`${M} joined the team`, `${M} a rejoint l’équipe`, `${M} انضم إلى الفريق`);
    case "member_removed": return L(`${W} removed ${M}`, `${W} a retiré ${M}`, `${W} أزال ${M}`);
    case "member_invited": return L(`${W} re-invited ${M}`, `${W} a réinvité ${M}`, `${W} أعاد دعوة ${M}`);
    case "workspace_created": return L(`Team “<span data-notr>${esc(d.name)}</span>” created`, `Équipe « <span data-notr>${esc(d.name)}</span> » créée`, `تم إنشاء فريق «<span data-notr>${esc(d.name)}</span>»`);
    case "submitted": return L(`${W} submitted ${t} for approval`, `${W} a soumis ${t} pour validation`, `${W} أرسل ${t} للموافقة`);
    case "sent_back": return L(`${W} sent ${t} back for changes`, `${W} a renvoyé ${t} pour corrections`, `${W} أعاد ${t} للتعديل`);
    case "repeat_skipped": return L(`The next copy of ${t} wasn’t created: ${esc(d.reason || "")}`, `La prochaine occurrence de ${t} n’a pas été créée : ${esc(d.reason || "")}`, `لم تُنشأ النسخة التالية من ${t}: ${esc(d.reason || "")}`);
    case "billing": return L(`Plan changed to ${esc(d.plan)} (${esc(d.status)})`, `Forfait changé : ${esc(d.plan)} (${esc(d.status)})`, `تغيّرت الخطة إلى ${esc(d.plan)} (${esc(d.status)})`);
    default: return `${W}: ${esc(a.action)}`;
  }
}
const feedItem = (a) => `<div class="it"><span>${sentence(a)}</span><span class="when">${esc(fmtT(a.created_at))}</span></div>`;

async function vActivity(q) {
  const who = q.get("who") || "";
  view().innerHTML = `<div class="page-head"><h1>Activity</h1>
    <select class="field" id="who" style="width:auto" aria-label="Filter by person"><option value="">Everyone</option>${S.members.map((m) => `<option value="${esc(m.id)}" ${who === m.id ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select></div>
    <div class="panel"><div class="feed" id="feed"><p class="muted" style="margin:0">Loading…</p></div></div>`;
  $("#who").onchange = (e) => go("activity" + (e.target.value ? "?who=" + e.target.value : ""));
  let acts = await db.activity(S.ws.id, { limit: 300 });
  if (who) acts = acts.filter((a) => a.actor_id === who);
  $("#feed").innerHTML = acts.map(feedItem).join("") || `<p class="muted" style="margin:0">Nothing here yet.</p>`;
}

/* ---------- task lists ---------- */
function taskRow(t, showWho = true) {
  const n = nameOf(t.assignee_id);
  return `<a class="row" href="#/tasks/${t.id}"><span class="t">${esc(t.title)}</span>${showWho ? `<span class="p">${av(n)}<span>${esc(n || "Unassigned")}</span></span>` : "<span></span>"}
    <span class="c-pri pri ${esc(t.priority)}">${esc(t.priority)}</span><span class="c-due due ${dueCls(t)}">${esc(dueText(t))}</span><span class="c-st">${stLabel(t.status)}</span></a>`;
}
const listHead = (who = "Assigned to") => `<div class="row head"><span>Task</span><span>${who}</span><span class="c-pri">Priority</span><span class="c-due">Deadline</span><span class="c-st">Status</span></div>`;

function vTasks(q) {
  const f = { q: q.get("q") || "", who: q.get("who") || "", st: q.get("st") || "open", pri: q.get("pri") || "" };
  const t0 = today();
  const pass = {
    open: isOpen, late: isLate, blocked: (t) => t.status === "blocked", today: (t) => isOpen(t) && t.deadline === t0,
    week: (t) => isOpen(t) && dd(t0, t.deadline) >= 0 && dd(t0, t.deadline) <= 7, done: (t) => t.status === "done", all: () => true,
  }[f.st] || isOpen;
  let rows = S.tasks.filter(pass);
  if (f.who === "none") rows = rows.filter((t) => !t.assignee_id); else if (f.who) rows = rows.filter((t) => t.assignee_id === f.who);
  if (f.pri) rows = rows.filter((t) => t.priority === f.pri);
  if (f.q) { const s = f.q.toLowerCase(); rows = rows.filter((t) => (t.title + " " + t.description).toLowerCase().includes(s)); }
  rows.sort((a, b) => (isOpen(a) === isOpen(b) ? 0 : isOpen(a) ? -1 : 1) || a.deadline.localeCompare(b.deadline) || PRI.indexOf(b.priority) - PRI.indexOf(a.priority));
  const opts = (list, cur) => list.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(l)}</option>`).join("");
  let mode = "list"; try { mode = localStorage.getItem("handoff.taskview") || "list"; } catch {}
  if (mode === "board" && f.st === "open") rows = S.tasks.filter((t) => rows.includes(t) || (t.status === "done" && t.completed_at && dd(t.completed_at.slice(0, 10), t0) <= 7 && (!f.who || t.assignee_id === f.who)));
  view().innerHTML = `<div class="page-head"><h1>${isManager() ? "Tasks" : "Team tasks"}</h1>
    <div class="seg-toggle" role="group" aria-label="View"><button type="button" data-mode="list" aria-pressed="${mode === "list"}">${ic("list")}List</button><button type="button" data-mode="board" aria-pressed="${mode === "board"}">${ic("board")}Board</button></div>${newBtn()}</div>
  <form class="toolbar" id="flt">
    <input class="field search" name="q" type="search" placeholder="Search" value="${esc(f.q)}" aria-label="Search">
    <select class="field" name="who" aria-label="Person">${opts([["", "Everyone"], ...visibleTeam().map((m) => [m.id, m.name]), ...(isManager() ? [["none", "Unassigned"]] : [])], f.who)}</select>
    <select class="field" name="st" aria-label="Status">${opts([["open", "Open"], ["late", "Late"], ["blocked", "Blocked"], ["today", "Due today"], ["week", "Due this week"], ["done", "Done"], ["all", "All"]], f.st)}</select>
    <select class="field" name="pri" aria-label="Priority">${opts([["", "Any priority"], ...PRI.map((p) => [p, p])], f.pri)}</select>
  </form>
  ${mode === "board" ? boardHtml(rows) : `<div class="list">${listHead()}${rows.map((t) => taskRow(t)).join("") || `<div class="empty-row">No tasks match.</div>`}</div>`}
  <p class="small muted">${rows.length} task${rows.length === 1 ? "" : "s"}</p>`;
  view().querySelectorAll("[data-mode]").forEach((b) => (b.onclick = () => { try { localStorage.setItem("handoff.taskview", b.dataset.mode); } catch {} vTasks(q); }));
  if (mode === "board") wireBoard();
  const form = $("#flt");
  const apply = () => { const d = formData(form); const p = new URLSearchParams(Object.entries(d).filter(([, v]) => v)); history.replaceState(null, "", "#/tasks" + (p.toString() ? "?" + p : "")); vTasks(p); const s = $("#flt [name=q]"); if (d.q && s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } };
  form.onchange = apply;
  form.querySelector("[name=q]").oninput = () => { clearTimeout(apply.h); apply.h = setTimeout(apply, 250); };
  form.onsubmit = (e) => { e.preventDefault(); apply(); };
}

/* board: four status columns; drag a card to change its status (if you're allowed to) */
const canMove = (t) => t.assignee_id === S.me.id || has(9) || (has(4) && reaches(member(t.assignee_id), 4));
const bossOf = (t) => has(9) || (has(4) && (t.assignee_id === S.me.id || reaches(member(t.assignee_id), 4)));
function boardCard(t) {
  const n = nameOf(t.assignee_id), steps = t.checklist || [];
  return `<a class="bcard ${isLate(t) ? "is-late" : ""}" href="#/tasks/${t.id}" draggable="${canMove(t)}" data-id="${t.id}">
    <span class="bc-top"><span class="pri ${esc(t.priority)}">${esc(t.priority)}</span><span class="due ${dueCls(t)}">${esc(dueText(t))}</span></span>
    <span class="bc-title">${esc(t.title)}</span>${t.repeat && t.repeat !== "none" ? `<span class="small muted">↻ ${esc(REPEAT[t.repeat])}</span>` : ""}
    <span class="bc-foot">${av(n)}<span>${esc(n || "Unassigned")}</span>${steps.length ? `<span class="mono muted">${steps.filter((x) => x.done).length}/${steps.length}</span>` : ""}</span></a>`;
}
function boardHtml(rows) {
  return `<div class="board-scroll"><div class="board">${STATUS_KEYS.map((st) => { const col = rows.filter((t) => t.status === st);
    return `<section class="bcol" data-col="${st}"><header><span class="dot s-${st}"></span>${SHORT[st]}<span class="mono">${col.length}</span></header>${col.map(boardCard).join("") || `<p class="bempty">Nothing here</p>`}</section>`; }).join("")}</div></div>`;
}
function wireBoard() {
  let dragId = null;
  view().querySelectorAll(".bcard[draggable=true]").forEach((c) => { c.ondragstart = (e) => { dragId = c.dataset.id; e.dataTransfer.effectAllowed = "move"; c.classList.add("dragging"); }; c.ondragend = () => c.classList.remove("dragging"); });
  view().querySelectorAll(".bcol").forEach((col) => {
    col.ondragover = (e) => { if (dragId) { e.preventDefault(); col.classList.add("drop"); } };
    col.ondragleave = () => col.classList.remove("drop");
    col.ondrop = async (e) => {
      e.preventDefault(); col.classList.remove("drop"); const id = dragId; dragId = null;
      const t = S.tasks.find((x) => x.id === id); if (!t || t.status === col.dataset.col) return;
      try { const u = await db.updateTask(id, { status: col.dataset.col }); Object.assign(t, u); toast(`Moved to ${STATUS[u.status]}`); render(); } catch (err) { toast(err.message); }
    };
  });
}

function vMy() {
  const t0 = today();
  const mine = S.tasks.filter((t) => t.assignee_id === S.me.id);
  const open = mine.filter(isOpen);
  const groups = [
    ["Late", open.filter(isLate)],
    ["Due today", open.filter((t) => t.deadline === t0)],
    ["This week", open.filter((t) => { const d = dd(t0, t.deadline); return d >= 1 && d <= 7; })],
    ["Later", open.filter((t) => dd(t0, t.deadline) > 7)],
    ["Done in the last 2 weeks", mine.filter((t) => t.status === "done" && t.completed_at && dd(t.completed_at.slice(0, 10), t0) <= 14)],
  ];
  view().innerHTML = `<div class="page-head"><h1>My tasks</h1>${newBtn()}</div>
  ${open.length ? "" : `<div class="panel"><h2>Nothing on your plate</h2><p class="muted" style="margin:0">New tasks from your manager will show up here, and you’ll get an email.</p></div>`}
  ${groups.filter(([, l]) => l.length).map(([label, l]) => `<div class="section-label">${label} <span class="mono">${l.length}</span></div>
    <div class="list">${l.sort((a, b) => a.deadline.localeCompare(b.deadline)).map((t) => taskRow(t, false)).join("")}</div>`).join("")}`;
}

/* ---------- new task ---------- */
function assignable() {
  return S.members.filter((m) => m.status !== "removed" && ((m.id === S.me.id && canCreate()) || reaches(m, 3)));
}
function vNew(q) {
  const people = assignable().sort((a, b) => openCount(a.id) / (a.max_open || 5) - openCount(b.id) / (b.max_open || 5));
  const pre = q.get("who") || "";
  view().innerHTML = `<a class="back" href="#/${isBoss() ? "tasks" : "my"}">← Back</a>
  <div class="page-head"><h1>New task</h1></div>
  <div class="ai-box" style="max-width:760px">
    <label for="aiText"><span class="ai-badge">${ic("spark")}AI</span> Describe the task in your own words</label>
    <textarea class="field" id="aiText" placeholder="Sara should prepare the Q4 sales report for the board by next Tuesday, it’s urgent"></textarea>
    <div class="actions"><button class="btn primary" type="button" id="aiGo">${ic("spark")}Write it for me</button><button class="btn" type="button" id="mic" hidden>${ic("mic")}<span>Speak</span></button><span class="small muted" id="aiStatus">AI fills in the form and picks the best person. You check it before it’s sent.</span></div>
  </div>
  <div class="tpl-row" id="tplRow" hidden style="max-width:760px"><label class="lb">${ic("tpl")} Start from a template<select class="field" id="tplPick"><option value="">Choose a template…</option></select></label></div>
  <form class="panel form" id="f" novalidate style="max-width:760px">
    <div class="full" id="aiReason"></div>
    <label class="lb full">Title<input class="field" name="title" maxlength="200" placeholder="Prepare the Q4 sales report" required></label>
    <label class="lb full">Details <span class="hint">what “done” looks like, links, context</span><textarea class="field" name="description"></textarea></label>
    <label class="lb">Assign to<select class="field" name="assignee_id">${isManager() ? `<option value="">Unassigned for now</option>` : ""}
      ${people.map((m) => `<option value="${esc(m.id)}" ${pre === m.id ? "selected" : ""}>${esc(m.name)} — ${openCount(m.id)}/${m.max_open} open${m.available ? "" : ", away"}${m.status === "invited" ? ", invited" : ""}</option>`).join("")}</select></label>
    <label class="lb">Deadline<input class="field" name="deadline" type="date" value="${addDays(today(), 3)}" required></label>
    <label class="lb">Priority<select class="field" name="priority">${PRI.map((p) => `<option ${p === "Medium" ? "selected" : ""}>${p}</option>`).join("")}</select></label>
    <label class="lb">Repeats<select class="field" name="repeat">${Object.entries(REPEAT).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
    <label class="lb full">Steps <span class="hint">one per line, optional</span><textarea class="field" name="steps" style="min-height:96px"></textarea></label>
    <label class="lb full" style="flex-direction:row;gap:10px;align-items:center;font-weight:400;color:var(--ink)"><input type="checkbox" name="needs_approval"> I approve it before it counts as done</label>
    <div class="full actions"><button class="btn primary" type="submit">Assign task</button><button class="btn" type="button" id="tplSave">${ic("tpl")}Save as template</button><a class="btn ghost" href="#/${isBoss() ? "tasks" : "my"}">Cancel</a><span class="err" id="err"></span></div>
    <div class="full tpl-name" id="tplName" hidden><input class="field" id="tplNameIn" maxlength="80" placeholder="Template name, for example Monthly close" aria-label="Template name"><button class="btn primary small" type="button" id="tplNameGo">Save template</button></div>
    <p class="full small muted" style="margin:0">The person gets an email right away, a reminder 2 days before, and on the day. If it runs late, you’re told too.</p>
  </form>`;
  $("#aiText").onkeydown = (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("#aiGo").click(); };
  wireVoice($("#mic"), $("#aiText"), $("#aiStatus"));
  wireTemplates();
  $("#aiGo").onclick = async () => {
    const text = $("#aiText").value.trim(), b = $("#aiGo"), st = $("#aiStatus");
    if (!text) { st.innerHTML = `<span class="err">Write what needs doing first.</span>`; $("#aiText").focus(); return; }
    busy(b, true, "Writing…"); st.textContent = "Reading your request and checking who has room…";
    try {
      const d = await db.aiDraft(S.ws.id, text, LANG), F = $("#f");
      F.title.value = d.title; F.description.value = d.description || ""; F.deadline.value = d.deadline; F.priority.value = d.priority;
      if (d.assignee_id && [...F.assignee_id.options].some((o) => o.value === d.assignee_id)) F.assignee_id.value = d.assignee_id;
      F.steps.value = (d.steps || []).join("\n");
      $("#aiReason").innerHTML = d.assignee_id ? `<div class="reason">${ic("spark")}<span><b>${esc(nameOf(d.assignee_id) || "")}</b> · ${esc(d.reason)}</span></div>` : "";
      F.classList.add("filled"); setTimeout(() => F.classList.remove("filled"), 1200);
      st.textContent = "Done. Check it over, then assign."; busy(b, false); b.innerHTML = `${ic("spark")}Write it again`;
    } catch (err) { st.innerHTML = `<span class="err">${esc(err.message)}</span>`; busy(b, false); }
  };
  $("#f").onsubmit = async (e) => {
    e.preventDefault(); const f = formData(e.target), b = e.target.querySelector("[type=submit]");
    if (!f.title.trim()) { $("#err").textContent = "Add a title."; return; }
    if (!f.deadline) { $("#err").textContent = "Pick a deadline."; return; }
    busy(b, true, "Saving…");
    try {
      const t = await db.createTask({ workspace_id: S.ws.id, title: f.title.trim(), description: f.description.trim(), assignee_id: f.assignee_id || null,
        deadline: f.deadline, priority: f.priority, repeat: f.repeat || "none", needs_approval: !!e.target.needs_approval.checked, checklist: f.steps.split("\n").map((s) => s.trim()).filter(Boolean).map((text) => ({ text, done: false })) });
      S.tasks.push(t); toast(f.assignee_id ? `Sent to ${nameOf(f.assignee_id)}` : "Task saved"); go("tasks/" + t.id);
    } catch (err) { $("#err").textContent = err.message; busy(b, false); }
  };
}

/* ---------- voice note → task (speech is turned into text by the browser) ---------- */
function wireVoice(btn, box, status) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR || !btn) return;
  btn.hidden = false;
  let rec = null, base = "";
  const stop = () => { if (rec) rec.stop(); };
  btn.onclick = () => {
    if (rec) { stop(); return; }
    rec = new SR();
    rec.lang = { ar: "ar-SA", fr: "fr-FR", en: "en-US" }[LANG] || "en-US";
    rec.interimResults = true; rec.continuous = true;
    base = box.value.trim() ? box.value.trim() + " " : "";
    rec.onresult = (e) => { let txt = ""; for (const r of e.results) txt += r[0].transcript; box.value = base + txt.trim(); };
    rec.onerror = (e) => { status.innerHTML = `<span class="err">${esc(e.error === "not-allowed" ? T("Allow the microphone in your browser to speak a task.") : T("Couldn’t hear that. Try again."))}</span>`; };
    rec.onend = () => { rec = null; btn.classList.remove("rec"); btn.querySelector("span").textContent = T("Speak"); if (box.value.trim()) { status.textContent = T("Got it. Press Write it for me."); } };
    rec.start(); btn.classList.add("rec"); btn.querySelector("span").textContent = T("Stop");
    status.textContent = T("Listening… say who, what and by when. Press Stop when you’re done.");
  };
}

/* ---------- task templates ---------- */
async function wireTemplates() {
  const F = $("#f"), pick = $("#tplPick");
  let list = [];
  const load = async () => {
    try { list = await db.templates(S.ws.id); } catch { list = []; }
    pick.innerHTML = `<option value="">${esc(T("Choose a template…"))}</option>` + list.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("");
    $("#tplRow").hidden = !list.length;
  };
  await load();
  pick.onchange = () => {
    const x = list.find((y) => y.id === pick.value); if (!x) return;
    F.title.value = x.title; F.description.value = x.description || ""; F.priority.value = x.priority; F.repeat.value = x.repeat;
    F.needs_approval.checked = !!x.needs_approval; F.deadline.value = addDays(today(), x.days_to_deadline);
    F.steps.value = (x.checklist || []).map((c) => c.text).join("\n");
    F.classList.add("filled"); setTimeout(() => F.classList.remove("filled"), 1200);
  };
  $("#tplSave").onclick = () => {
    if (!F.title.value.trim()) { $("#err").textContent = T("Add a title first."); return; }
    $("#tplName").hidden = false; $("#tplNameIn").value = F.title.value.trim().slice(0, 80); $("#tplNameIn").focus();
  };
  $("#tplNameGo").onclick = async () => {
    const name = $("#tplNameIn").value.trim(); if (!name) return;
    const days = F.deadline.value ? Math.max(0, dd(today(), F.deadline.value)) : 3;
    try {
      await db.saveTemplate({ workspace_id: S.ws.id, name, title: F.title.value.trim(), description: F.description.value, priority: F.priority.value,
        repeat: F.repeat.value || "none", needs_approval: !!F.needs_approval.checked, days_to_deadline: Math.min(365, days), created_by: S.me.id,
        checklist: F.steps.value.split("\n").map((t) => t.trim()).filter(Boolean).map((text) => ({ text, done: false })) });
      $("#tplName").hidden = true; toast(T("Template saved")); await load();
    } catch (err) { $("#err").textContent = err.message; }
  };
}

/* status buttons: tasks that need approval are submitted by the doer and approved by their boss */
function statusControls(t, canEdit) {
  const btn = (s, label, cls = "") => `<button type="button" class="${cls}" data-st="${s}" aria-pressed="${t.status === s}"><span class="dot s-${s}"></span>${label}</button>`;
  if (t.needs_approval && t.status === "review") {
    return canEdit
      ? `<div class="approve-bar"><span><b>Waiting for your approval.</b> Check the work, then approve it or send it back with a comment.</span><span class="actions"><button type="button" class="btn primary small" data-st="done">Approve</button><button type="button" class="btn small" data-st="progress">Send back</button></span></div>`
      : `<div class="approve-bar"><span><b>Submitted for approval.</b> Your manager has been told.</span><span class="actions"><button type="button" class="btn small" data-st="progress">Take it back</button></span></div>`;
  }
  const keys = ["todo", "progress", "blocked"];
  if (t.needs_approval && !(canEdit && t.status === "done")) {
    const last = canEdit ? btn("done", "Done") : btn("review", "Submit for approval");
    return `<div class="seg" role="group" aria-label="Status">${keys.map((s) => btn(s, STATUS[s])).join("")}${t.status === "done" ? btn("done", "Done") : last}</div>`;
  }
  return `<div class="seg" role="group" aria-label="Status">${[...keys, "done"].map((s) => btn(s, STATUS[s])).join("")}</div>`;
}

/* ---------- one task ---------- */
async function vTask(id) {
  let t = S.tasks.find((x) => x.id === id) || (await db.task(id));
  if (!t) { view().innerHTML = `<div class="pad"><h1>Task not found</h1><p class="muted">It may have been deleted, or it isn’t yours to see.</p><a class="btn" href="#/${homePage()}">Back</a></div>`; return; }
  const [comments, files, history] = await Promise.all([db.comments(id), db.files(id), db.activity(S.ws.id, { taskId: id, limit: 50 })]);
  const assignee = member(t.assignee_id);
  const canEdit = has(9) || (has(4) && (t.assignee_id === S.me.id || reaches(assignee, 4)));
  const canDelete = has(9) || (has(5) && reaches(assignee, 5));
  const back = isBoss() ? "tasks" : "my";
  const steps = t.checklist || [];
  const people = assignable();
  if (t.assignee_id && !people.some((m) => m.id === t.assignee_id) && member(t.assignee_id)) people.push(member(t.assignee_id));

  view().innerHTML = `<a class="back" href="#/${back}">← ${isBoss() ? "Tasks" : "My tasks"}</a>
  <div class="task">
    <div>
      ${canEdit ? `<input class="title-input" id="title" value="${esc(t.title)}" maxlength="200" aria-label="Title">` : `<h1>${esc(t.title)}</h1>`}
      ${statusControls(t, canEdit)}
      <div class="sec"><div class="sec-h"><h2>Details</h2></div>
        ${canEdit ? `<textarea class="field" id="desc" placeholder="What “done” looks like, links, context">${esc(t.description)}</textarea>` : `<p style="white-space:pre-wrap;margin:0">${esc(t.description) || '<span class="muted">No details.</span>'}</p>`}</div>
      <div class="sec"><div class="sec-h"><h2>Steps</h2><span class="mono muted">${steps.length ? `${steps.filter((s) => s.done).length}/${steps.length}` : ""}</span></div>
        <div id="steps">${steps.map((s, i) => `<div class="ck ${s.done ? "done" : ""}"><input type="checkbox" data-ck="${i}" ${s.done ? "checked" : ""} aria-label="Done: ${esc(s.text)}"><span>${esc(s.text)}</span>${canEdit ? `<button class="x" type="button" data-ckdel="${i}" aria-label="Remove step">×</button>` : ""}</div>`).join("") || `<p class="muted small" style="margin:0">No steps.</p>`}</div>
        <form class="addrow" id="addStep"><input class="field" name="s" placeholder="Add a step" aria-label="Add a step"><button class="btn small" type="submit">Add</button></form></div>
      <div class="sec"><div class="sec-h"><h2>Files</h2><label class="btn small r" for="file">Attach file</label><input type="file" id="file" hidden accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.heic,.txt,.csv,.doc,.docx,.xls,.xlsx,.ppt,.pptx"></div>
        <div>${files.map((f) => `<div class="file"><a href="#" data-file="${esc(f.path)}">${esc(f.name)}</a><span class="mono muted">${f.size ? Math.max(1, Math.round(f.size / 1024)) + " KB" : ""}</span>${f.uploaded_by === S.me.id || isManager() ? `<button class="x" type="button" data-fdel="${esc(f.id)}" aria-label="Remove file">×</button>` : ""}</div>`).join("") || `<p class="muted small" style="margin:0">No files.</p>`}</div>
        <p class="small muted" id="fstat" style="margin:6px 0 0"></p></div>
      <div class="sec"><div class="sec-h"><h2>Comments</h2></div>
        <div>${comments.map((c) => `<div class="cm">${av(nameOf(c.author_id) || "?")}<div class="b"><div class="h">${esc(nameOf(c.author_id) || "Someone")}<span class="mono">${esc(fmtT(c.created_at))}</span></div><div class="txt">${esc(c.body)}</div></div></div>`).join("") || `<p class="muted small" style="margin:0">No comments yet.</p>`}</div>
        <form id="cmf" style="margin-top:10px"><textarea class="field" name="body" style="min-height:70px" placeholder="${isBoss() ? "Write a comment" : "Give an update or ask a question"}" aria-label="Comment"></textarea>
        <div class="actions" style="margin-top:8px"><button class="btn primary small" type="submit">Post</button><span class="small muted">${t.assignee_id === S.me.id ? "Your manager gets an email." : "They get an email."}</span></div></form></div>
    </div>
    <aside class="side">
      <div class="panel"><dl class="facts">
        <dt>Assigned to</dt><dd>${canEdit ? `<select class="field" id="who">${isManager() ? `<option value="">Unassigned</option>` : ""}${people.map((m) => `<option value="${esc(m.id)}" ${m.id === t.assignee_id ? "selected" : ""}>${esc(m.name)} (${openCount(m.id)}/${m.max_open})</option>`).join("")}</select>` : esc(nameOf(t.assignee_id) || (t.assignee_id === S.me.id ? S.me.name : "Unassigned"))}</dd>
        <dt>Deadline</dt><dd>${canEdit ? `<input class="field" type="date" id="due" value="${esc(t.deadline)}">` : esc(fmtD(t.deadline))} <div class="due ${dueCls(t)}" style="margin-top:4px">${isOpen(t) ? esc(dueText(t)) : ""}</div></dd>
        <dt>Priority</dt><dd>${canEdit ? `<select class="field" id="pri">${PRI.map((p) => `<option ${p === t.priority ? "selected" : ""}>${p}</option>`).join("")}</select>` : `<span class="pri ${esc(t.priority)}">${esc(t.priority)}</span>`}</dd>
        <dt>Repeats</dt><dd>${canEdit ? `<select class="field" id="rep">${Object.entries(REPEAT).map(([k, v]) => `<option value="${k}" ${k === (t.repeat || "none") ? "selected" : ""}>${v}</option>`).join("")}</select>` : esc(REPEAT[t.repeat || "none"])}</dd>
        <dt>Approval</dt><dd>${canEdit ? `<label class="small" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="appr" ${t.needs_approval ? "checked" : ""}> Needs approval before it’s done</label>` : t.needs_approval ? "Needs approval before it’s done" : "Not needed"}</dd>
        <dt>Created</dt><dd class="small">${esc(fmtT(t.created_at))}${t.created_by ? ` ${L("by", "par", "بواسطة")} <span data-notr>${esc(nameOf(t.created_by) || "a manager")}</span>` : ""}</dd>
        ${t.completed_at ? `<dt>Finished</dt><dd class="small">${esc(fmtT(t.completed_at))} ${t.completed_at.slice(0, 10) <= t.deadline ? '<span class="chip ok">On time</span>' : '<span class="chip bad">Late</span>'}</dd>` : ""}
      </dl>${canEdit ? `<div class="actions" style="margin-top:12px"><button class="btn primary small" id="save" type="button" hidden>Save changes</button><span class="err" id="serr"></span></div>` : ""}</div>
      <div class="panel"><h2>History</h2><div class="feed">${history.map(feedItem).join("") || `<p class="muted small" style="margin:0">Nothing yet.</p>`}</div></div>
      ${canDelete ? `<button class="btn danger small" id="del" type="button" style="margin-top:12px">Delete task</button>` : ""}
    </aside>
  </div>`;

  const refresh = async (patch, msg) => {
    try { t = await db.updateTask(id, patch); const i = S.tasks.findIndex((x) => x.id === id); if (i >= 0) S.tasks[i] = t; else S.tasks.push(t); if (msg) toast(msg); await vTask(id); }
    catch (e) { toast(e.message); }
  };
  view().querySelectorAll("[data-st]").forEach((b) => (b.onclick = () => b.dataset.st !== t.status && refresh({ status: b.dataset.st }, b.dataset.st === "review" ? "Sent for approval" : t.status === "review" && b.dataset.st === "done" ? "Approved" : t.status === "review" ? "Sent back" : `Marked ${STATUS[b.dataset.st]}`)));
  view().querySelectorAll("[data-ck]").forEach((c) => (c.onchange = () => refresh({ checklist: steps.map((s, i) => (i === +c.dataset.ck ? { ...s, done: c.checked } : s)) })));
  view().querySelectorAll("[data-ckdel]").forEach((c) => (c.onclick = () => refresh({ checklist: steps.filter((_, i) => i !== +c.dataset.ckdel) })));
  $("#addStep").onsubmit = (e) => { e.preventDefault(); const v = e.target.s.value.trim(); if (v) refresh({ checklist: [...steps, { text: v, done: false }] }); };
  $("#cmf").onsubmit = async (e) => {
    e.preventDefault(); const body = e.target.body.value.trim(); if (!body) return;
    const b = e.target.querySelector("button"); busy(b, true, "Posting…");
    try { await db.addComment(id, S.me.id, body); toast("Posted"); await vTask(id); } catch (err) { toast(err.message); busy(b, false); }
  };
  $("#file").onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    if (file.size > 20 * 1024 * 1024) { $("#fstat").textContent = "That file is over 20 MB."; return; }
    if (!/\.(pdf|png|jpe?g|gif|webp|heic|txt|csv|docx?|xlsx?|pptx?)$/i.test(file.name)) { $("#fstat").textContent = "That type of file can’t be attached. Use a PDF, image, Word, Excel, PowerPoint, CSV or text file."; return; }
    $("#fstat").textContent = `Uploading ${file.name}…`;
    try { await db.upload(S.ws.id, id, S.me.id, file); toast("File attached"); await vTask(id); } catch (err) { $("#fstat").textContent = err.message; }
  };
  view().querySelectorAll("[data-file]").forEach((a) => (a.onclick = async (e) => { e.preventDefault(); try { window.open(await db.fileUrl(a.dataset.file), "_blank", "noopener"); } catch (err) { toast(err.message); } }));
  view().querySelectorAll("[data-fdel]").forEach((b) => (b.onclick = async () => { const f = files.find((x) => x.id === b.dataset.fdel); try { await db.deleteFile(f); await vTask(id); } catch (err) { toast(err.message); } }));

  if (canEdit) {
    const save = $("#save");
    const dirty = () => { save.hidden = !($("#title").value.trim() !== t.title || $("#desc").value !== t.description || $("#who").value !== (t.assignee_id || "") || $("#due").value !== t.deadline || $("#pri").value !== t.priority || $("#rep").value !== (t.repeat || "none") || $("#appr").checked !== !!t.needs_approval); };
    ["#title", "#desc", "#who", "#due", "#pri", "#rep", "#appr"].forEach((s) => { $(s).oninput = dirty; $(s).onchange = dirty; });
    save.onclick = async () => {
      const title = $("#title").value.trim(); if (!title) { $("#serr").textContent = "The title can’t be empty."; return; }
      if (!$("#due").value) { $("#serr").textContent = "Pick a deadline."; return; }
      busy(save, true, "Saving…");
      await refresh({ title, description: $("#desc").value, assignee_id: $("#who").value || null, deadline: $("#due").value, priority: $("#pri").value, repeat: $("#rep").value, needs_approval: $("#appr").checked }, "Saved");
    };
  }
  const del = $("#del");
  if (del) del.onclick = async () => {
    if (del.dataset.sure !== "1") { del.dataset.sure = "1"; del.textContent = "Click again to delete"; return; }
    try { await db.deleteTask(id); S.tasks = S.tasks.filter((x) => x.id !== id); toast("Task deleted"); go("tasks"); } catch (e) { toast(e.message); }
  };
}

/* ---------- people (rights 7, 8, 9) ---------- */
// level choices I may give: everything for right 9; otherwise below my level, and only levels whose rights I have myself
function levelChoices() {
  return S.levels.filter((l) => has(9) || (l.level < S.me.level && l.rights.every((r) => S.me.rights.includes(r))));
}
function rightsBoxes(name, checked, disabled) {
  return Object.entries(RIGHTS).map(([n, label]) => {
    const r = Number(n), mine = has(9) || S.me.rights.includes(r);
    return `<label class="rt"><input type="checkbox" name="${name}" value="${r}" ${checked.includes(r) ? "checked" : ""} ${disabled || !mine || r === 1 ? "disabled" : ""}><b>${r}</b> ${esc(label)}</label>`;
  }).join("");
}
function vPeople() {
  if (!(has(7) || has(8) || has(9))) return go(homePage());
  const teams = [...new Set(S.members.map((m) => m.team).filter(Boolean))];
  const rows = S.members.slice().sort((a, b) => (a.status === "removed") - (b.status === "removed") || b.level - a.level || a.name.localeCompare(b.name));
  const statusChip = (m) => (m.status === "active" ? `<span class="chip ok">Active</span>` : m.status === "invited" ? `<span class="chip warn">Invited</span>` : `<span class="chip">Removed</span>`);
  const choices = levelChoices();
  const L = S.lastLogin;
  const loginBox = L ? `<div class="panel login-box" style="margin-bottom:14px">
      <h2>${L.temp ? `Login for ${esc(L.name)}` : `${esc(L.name)} is on the team`}</h2>
      ${L.temp ? `<dl class="facts"><dt>Email</dt><dd class="mono">${esc(L.email)}</dd><dt>Temporary password</dt><dd><span class="mono pw" id="pw">${esc(L.temp)}</span> <button class="btn small" type="button" id="copyLogin">Copy login</button></dd></dl>
        <p class="small muted" style="margin:10px 0 0">We emailed this to ${esc(L.email)}. You can also send it by WhatsApp. It won’t be shown again. They’ll choose their own password the first time they sign in.</p>`
      : `<p class="small muted" style="margin:0">They already had a Delegiq account, so they sign in with their usual password. We emailed them.</p>`}
      <div class="actions" style="margin-top:10px"><button class="btn ghost small" type="button" id="closeLogin">Done</button></div></div>` : "";
  const addForm = (has(7) || has(9)) && choices.length ? `<div class="panel" style="margin-bottom:14px"><h2>Add someone</h2>
    <p class="small muted" style="margin:-6px 0 12px">Delegiq creates their login and emails them a temporary password.${has(9) ? "" : ` They join your team (${esc(S.me.team || "none")}) below your level.`}</p>
    <form class="form" id="inv" novalidate>
      <label class="lb">Name<input class="field" name="name" required></label>
      <label class="lb">Email<input class="field" name="email" type="email" required></label>
      <label class="lb">Level<select class="field" name="level">${choices.map((l) => `<option value="${l.level}" ${l.level === 1 ? "selected" : ""}>${l.level} · ${esc(l.name)} (rights ${rightsList(l.rights)})</option>`).join("")}</select></label>
      ${has(9) ? `<label class="lb">Team <span class="hint">people only manage others in the same team</span><input class="field" name="team" list="teams" placeholder="Sales"></label>` : `<label class="lb">Team<input class="field" value="${esc(S.me.team || "")}" disabled></label>`}
      <label class="lb">Job title<input class="field" name="job_title"></label>
      <label class="lb">Max open tasks<input class="field" name="max_open" type="number" min="1" max="100" value="5"></label>
      <label class="lb full">Skills <span class="hint">comma-separated</span><input class="field" name="skills" placeholder="reporting, Excel, Arabic"></label>
      <div class="full actions"><button class="btn primary" type="submit">Add and send login</button><span class="err" id="ierr"></span></div>
      <p class="full small muted" style="margin:0">You can hand-pick their rights after adding them, with Edit.</p>
    </form><datalist id="teams">${teams.map((t) => `<option value="${esc(t)}">`).join("")}</datalist></div>` : "";

  view().innerHTML = `<div class="page-head"><h1>People</h1></div>${loginBox}${addForm}
  <div class="table-wrap"><table class="ppl"><thead><tr><th>Person</th><th>Level</th><th>Rights</th><th>Team</th><th>Open</th><th>Status</th><th></th></tr></thead><tbody>
  ${rows.map((m) => {
    const mine = m.user_id === S.uid, can7 = !mine && reaches(m, 7), can8 = (!mine && reaches(m, 8)) || (mine && has(9));
    const acts = [
      can7 || can8 || (mine && has(9)) ? `<button class="btn ghost small" data-edit="${esc(m.id)}">Edit</button>` : "",
      can7 && m.status !== "removed" ? `<button class="btn ghost small" data-pw="${esc(m.id)}">${m.user_id ? "Send new password" : "Create login"}</button>` : "",
      can7 ? (m.status === "removed" ? `<button class="btn ghost small" data-restore="${esc(m.id)}">Restore</button>` : `<button class="btn ghost small danger" data-remove="${esc(m.id)}">Remove</button>`) : "",
    ].join("");
    return `<tr data-id="${esc(m.id)}"><td>${esc(m.name)}${mine ? ' <span class="muted small">(you)</span>' : ""}<div class="sub">${esc(m.email)}${m.job_title ? " · " + esc(m.job_title) : ""}</div>${m.skills ? `<div class="sub">${esc(m.skills)}</div>` : ""}<div class="sub sec-info" data-sec="${esc(m.id)}"></div></td>
    <td><b>${m.level}</b> · ${esc(levelName(m.level))}</td><td class="mono">${rightsList(m.rights)}${m.custom_rights ? ' <span class="chip">custom</span>' : ""}</td><td>${esc(m.team || "—")}</td>
    <td class="mono">${openCount(m.id)}/${m.max_open}</td><td>${statusChip(m)}${!m.available && m.status !== "removed" ? ' <span class="chip">Away</span>' : ""}</td>
    <td style="white-space:nowrap">${acts || '<span class="muted small">—</span>'}</td></tr>`;
  }).join("")}
  </tbody></table></div>
  <div class="grid two" style="margin-top:14px">
    <div class="panel"><h2>The rights</h2><ol class="rights-ref">${Object.entries(RIGHTS).map(([n, l]) => `<li value="${n}"${has(Number(n)) ? ' class="have"' : ""}>${esc(l)}</li>`).join("")}</ol>
      <p class="small muted" style="margin:8px 0 0">“Below me” means the same team and a lower level number. Bold rights are the ones you have.</p></div>
    <div class="panel"><h2>Levels</h2><table class="ppl"><tbody>${S.levels.map((l) => `<tr><td><b>${l.level}</b></td><td>${esc(l.name)}</td><td class="mono">${rightsList(l.rights)}</td></tr>`).join("")}</tbody></table>
      <p class="small muted" style="margin:8px 0 0">${has(10) ? 'Rename levels or change their rights in <a href="#/settings">Settings</a>.' : "Someone with right 10 can change these."}</p></div>
  </div>`;

  db.peopleSecurity(S.ws.id).then((rows) => rows.forEach((r) => {
    const el = view().querySelector(`[data-sec="${r.member_id}"]`);
    if (el) el.innerHTML = `${r.last_sign_in ? `Last sign-in ${esc(fmtT(r.last_sign_in))}${r.last_device ? " · " + esc(r.last_device) : ""}` : "Never signed in"} · ${r.two_step ? '<span class="ok-txt">2-step on</span>' : '<span class="warn-txt">2-step off</span>'}`;
  })).catch(() => {});
  const inv = $("#inv");
  if (inv) inv.onsubmit = async (e) => {
    e.preventDefault(); const f = formData(inv), b = inv.querySelector("button");
    if (!f.name.trim() || !f.email.trim()) { $("#ierr").textContent = "Add a name and email."; return; }
    const lv = S.levels.find((l) => l.level === Number(f.level));
    if (has(9) && lv && lv.rights.some((r) => [2, 3, 7, 8].includes(r)) && !lv.rights.includes(9) && !(f.team || "").trim()) { $("#ierr").textContent = "Someone who leads others needs a team name."; return; }
    busy(b, true, "Adding…");
    try {
      const r = await db.addMember(S.ws.id, f);
      S.lastLogin = { name: f.name.trim(), email: r.email, temp: r.temp_password };
      await reload(); vPeople(); window.scrollTo(0, 0);
    } catch (err) { $("#ierr").textContent = err.message; busy(b, false); }
  };
  view().querySelectorAll("[data-pw]").forEach((b) => (b.onclick = async () => {
    const m = member(b.dataset.pw);
    if (b.dataset.sure !== "1") { b.dataset.sure = "1"; b.textContent = m.user_id ? "Their old password stops working. Continue?" : "Create login now?"; return; }
    busy(b, true, "Sending…");
    try { const r = await db.newPassword(m.id); S.lastLogin = { name: m.name, email: r.email, temp: r.temp_password }; await reload(); vPeople(); window.scrollTo(0, 0); }
    catch (e) { toast(e.message); busy(b, false); }
  }));
  if ($("#closeLogin")) $("#closeLogin").onclick = () => { S.lastLogin = null; vPeople(); };
  if ($("#copyLogin")) $("#copyLogin").onclick = async () => {
    const text = `Your Delegiq login\nWebsite: ${location.origin + location.pathname}\nEmail: ${L.email}\nTemporary password: ${L.temp}\nYou'll choose your own password when you first sign in.`;
    try { await navigator.clipboard.writeText(text); toast("Copied. Paste it into WhatsApp or a message."); }
    catch { const r = document.createRange(); r.selectNodeContents($("#pw")); getSelection().removeAllRanges(); getSelection().addRange(r); toast("Select and copy the password"); }
  };
  view().querySelectorAll("[data-restore]").forEach((b) => (b.onclick = async () => {
    const m = member(b.dataset.restore);
    try { await db.updateMember(m.id, { status: "active" }); await reload(); toast(`${m.name} restored`); vPeople(); } catch (e) { toast(e.message); }
  }));
  view().querySelectorAll("[data-remove]").forEach((b) => (b.onclick = async () => {
    const m = member(b.dataset.remove), open = S.tasks.filter((t) => t.assignee_id === m.id && isOpen(t));
    if (b.dataset.sure !== "1") { b.dataset.sure = "1"; b.textContent = open.length ? `Remove and unassign ${open.length} task${open.length > 1 ? "s" : ""}?` : "Click again to remove"; return; }
    try {
      for (const t of open) { try { await db.updateTask(t.id, { assignee_id: has(9) ? null : S.me.id }); } catch {} }
      await db.updateMember(m.id, { status: "removed" }); await reload(); toast(`${m.name} removed`); vPeople();
    } catch (e) { toast(e.message); }
  }));
  view().querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => {
    const m = member(b.dataset.edit), tr = b.closest("tr"), mine = m.user_id === S.uid;
    if (tr.nextElementSibling?.classList.contains("edit-row")) { tr.nextElementSibling.remove(); return; }
    const can7 = has(9) || reaches(m, 7), can8 = has(9) || (!mine && reaches(m, 8));
    const lvls = has(9) ? S.levels : levelChoices();
    tr.insertAdjacentHTML("afterend", `<tr class="edit-row"><td colspan="7"><form class="form" novalidate>
      <label class="lb">Name<input class="field" name="name" value="${esc(m.name)}" ${can7 ? "" : "disabled"}></label>
      <label class="lb">Level<select class="field" name="level" ${can8 ? "" : "disabled"}>${(lvls.some((l) => l.level === m.level) ? lvls : [...lvls, S.levels.find((l) => l.level === m.level)].filter(Boolean)).map((l) => `<option value="${l.level}" ${l.level === m.level ? "selected" : ""}>${l.level} · ${esc(l.name)}</option>`).join("")}</select></label>
      <label class="lb">Team${has(9) ? "" : ' <span class="hint">only right 9 can move people</span>'}<input class="field" name="team" list="teams" value="${esc(m.team || "")}" ${has(9) ? "" : "disabled"}></label>
      <label class="lb">Job title<input class="field" name="job_title" value="${esc(m.job_title || "")}" ${can7 ? "" : "disabled"}></label>
      <label class="lb">Max open tasks<input class="field" name="max_open" type="number" min="1" max="100" value="${esc(m.max_open)}" ${can7 ? "" : "disabled"}></label>
      <label class="lb">Available<select class="field" name="available" ${can7 ? "" : "disabled"}><option value="true" ${m.available ? "selected" : ""}>Yes, can take new work</option><option value="false" ${!m.available ? "selected" : ""}>Away</option></select></label>
      <label class="lb full">Skills<input class="field" name="skills" value="${esc(m.skills || "")}" ${can7 ? "" : "disabled"}></label>
      <div class="full"><div class="lb" style="margin-bottom:6px">Rights</div>
        <label class="check-line"><input type="checkbox" name="uselevel" ${m.custom_rights ? "" : "checked"} ${can8 ? "" : "disabled"}> Use the rights of their level</label>
        <div class="rights-grid" data-rights>${rightsBoxes("r", m.rights, !can8 || !m.custom_rights)}</div></div>
      <div class="full actions"><button class="btn primary small" type="submit">Save</button><span class="err"></span></div></form></td></tr>`);
    const form = tr.nextElementSibling.querySelector("form");
    const syncBoxes = () => {
      const use = form.uselevel.checked, lv = S.levels.find((l) => l.level === Number(form.level.value));
      form.querySelectorAll('[name="r"]').forEach((c) => {
        const r = Number(c.value), mine = has(9) || S.me.rights.includes(r);
        if (use) c.checked = !!lv?.rights.includes(r);
        c.disabled = !can8 || use || !mine || r === 1;
      });
    };
    form.uselevel.onchange = syncBoxes; form.level.onchange = syncBoxes;
    form.onsubmit = async (e) => {
      e.preventDefault(); const f = formData(form);
      const patch = {};
      if (can7) Object.assign(patch, { name: f.name.trim() || m.name, job_title: f.job_title.trim(), skills: f.skills.trim(), max_open: Number(f.max_open) || 5, available: f.available === "true" });
      if (has(9)) patch.team = (f.team || "").trim();
      if (can8) {
        patch.level = Number(form.level.value);
        patch.rights = form.uselevel.checked ? null : [...new Set([1, ...[...form.querySelectorAll('[name="r"]:checked')].map((c) => Number(c.value))])].sort((x, y) => x - y);
      }
      try { await db.updateMember(m.id, patch); await reload(); if (mine) { await onSession(S.session); } toast("Saved"); vPeople(); }
      catch (err) { form.querySelector(".err").textContent = err.message; }
    };
  }));
}

/* ---------- reports (right 6 or 9) ---------- */
function vReports(q) {
  if (!(has(6) || has(9))) return go(homePage());
  const month = q.get("m") || today().slice(0, 7);
  const inMonth = (d) => d && d.slice(0, 7) === month;
  const rows = S.members.filter((m) => (m.id === S.me.id || reaches(m, 6))).filter((m) => m.status !== "removed" || S.tasks.some((t) => t.assignee_id === m.id && (inMonth(t.created_at) || inMonth(t.completed_at)))).map((m) => {
    const mine = S.tasks.filter((t) => t.assignee_id === m.id);
    const given = mine.filter((t) => inMonth(t.created_at)).length;
    const done = mine.filter((t) => inMonth(t.completed_at));
    const onTime = done.filter((t) => t.completed_at.slice(0, 10) <= t.deadline).length;
    const lateDays = done.filter((t) => t.completed_at.slice(0, 10) > t.deadline).map((t) => dd(t.deadline, t.completed_at.slice(0, 10)));
    return { name: m.name, role: levelTag(m), given, done: done.length, onTime, pct: done.length ? Math.round((onTime / done.length) * 100) : null,
      avgLate: lateDays.length ? (lateDays.reduce((a, b) => a + b, 0) / lateDays.length).toFixed(1) : null, lateNow: mine.filter(isLate).length, open: mine.filter(isOpen).length };
  });
  const label = new Date(month + "-01T00:00:00Z").toLocaleDateString(LOCALE(), { month: "long", year: "numeric", timeZone: "UTC" });
  view().innerHTML = `<div class="page-head"><h1>Report · ${esc(label)}</h1>
    <input class="field no-print" type="month" id="m" value="${esc(month)}" style="width:auto" aria-label="Month">
    <button class="btn no-print" id="csv" type="button">Download for Excel</button><button class="btn no-print" id="pr" type="button">Print or save as PDF</button></div>
  <div class="table-wrap"><table class="ppl"><thead><tr><th>Person</th><th>Given this month</th><th>Finished</th><th>On time</th><th>Avg. days late</th><th>Late right now</th><th>Open</th></tr></thead><tbody>
  ${rows.map((r) => `<tr><td>${esc(r.name)}<div class="sub">${esc(r.role)}</div></td><td class="mono">${r.given}</td><td class="mono">${r.done}</td><td class="mono">${r.pct == null ? "–" : r.onTime + " (" + r.pct + "%)"}</td><td class="mono">${r.avgLate ?? "–"}</td><td class="mono" ${r.lateNow ? 'style="color:var(--bad)"' : ""}>${r.lateNow}</td><td class="mono">${r.open}</td></tr>`).join("") || `<tr><td colspan="7" class="muted">No one yet.</td></tr>`}
  </tbody></table></div>
  <p class="small muted">“Given” counts tasks created this month. “Finished” and “on time” count tasks completed this month against their deadline.</p>`;
  $("#m").onchange = (e) => go("reports?m=" + e.target.value);
  $("#pr").onclick = () => window.print();
  $("#csv").onclick = () => {
    const head = ["Person", "Level", "Given", "Finished", "On time", "On time %", "Avg days late", "Late now", "Open"];
    const lines = [head, ...rows.map((r) => [r.name, r.role, r.given, r.done, r.onTime, r.pct ?? "", r.avgLate ?? "", r.lateNow, r.open])]
      .map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
    const url = URL.createObjectURL(new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `delegiq-report-${month}.csv` });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
}

/* ---------- settings ---------- */
function vSettings() {
  view().innerHTML = `<div class="page-head"><h1>Settings</h1></div>
  <div class="grid" style="max-width:760px">
    <div class="panel"><h2>Your emails</h2>
      <form id="nf" class="form">
        <label class="lb full" style="flex-direction:row;gap:10px;font-weight:400;color:var(--ink)"><input type="radio" name="mode" value="instant" ${S.me.notify_mode !== "digest" ? "checked" : ""}> Send each update as it happens</label>
        <label class="lb full" style="flex-direction:row;gap:10px;font-weight:400;color:var(--ink)"><input type="radio" name="mode" value="digest" ${S.me.notify_mode === "digest" ? "checked" : ""}> One summary each morning</label>
      </form>
      <p class="small muted" style="margin:8px 0 0">Late, blocked and invite emails always arrive right away. Emails go to ${esc(S.email)}.</p></div>
    <div class="panel"><h2>${ic("wa")} WhatsApp reminders</h2>
      <form id="waf" class="form" novalidate>
        <label class="lb">Your WhatsApp number<input class="field" name="phone" inputmode="tel" placeholder="+974 5555 1234" value="${esc(S.me.phone || "")}"></label>
        <label class="lb full" style="flex-direction:row;gap:10px;font-weight:400;color:var(--ink)"><input type="checkbox" name="wa" ${S.me.whatsapp ? "checked" : ""}> Send me new tasks, deadline reminders and late or blocked tasks on WhatsApp too</label>
        <div class="full actions"><button class="btn primary small" type="submit">Save</button><span class="err" id="waerr"></span></div>
      </form>
      <p class="small muted" style="margin:8px 0 0">Write the number with the country code. You can turn this off anytime. WhatsApp reminders come with the free trial and the Team and Business plans.</p></div>
    <div class="panel"><h2>Language</h2>
      <div class="seg" role="group" aria-label="Language">${Object.entries(LANGS).map(([k, v]) => `<button type="button" data-lang="${k}" aria-pressed="${LANG === k}" lang="${k}">${v}</button>`).join("")}</div>
      <p class="small muted" style="margin:8px 0 0">Changes the screens and the AI’s answers for you only.</p></div>
    ${has(3) || has(9) ? `<div class="panel" id="tplPanel"><h2>${ic("tpl")} Task templates</h2><p class="muted" style="margin:0">Loading…</p></div>` : ""}
    ${has(10) ? `<div class="panel" id="billing"><h2>Plan &amp; billing</h2><p class="muted" style="margin:0">Loading…</p></div>` : ""}
    ${has(10) ? `<div class="panel"><h2>Company settings</h2>
      <form id="wf" class="form" novalidate>
        <label class="lb full">Team name<input class="field" name="name" value="${esc(S.ws.name)}"></label>
        <label class="lb">Time zone <span class="hint">for deadlines and the 8am summary</span><select class="field" name="timezone">${[...new Set([S.ws.timezone, ...TIMEZONES])].map((z) => `<option ${z === S.ws.timezone ? "selected" : ""}>${esc(z)}</option>`).join("")}</select></label>
        <label class="lb">Tell me again when a task is this many days late<input class="field" name="escalate_after_days" type="number" min="1" max="30" value="${esc(S.ws.escalate_after_days)}"></label>
        <div class="full actions"><button class="btn primary small" type="submit">Save</button><span class="err" id="werr"></span></div>
      </form></div>` : ""}
    ${has(10) ? `<div class="panel"><h2>Levels</h2>
      <p class="small muted" style="margin:-6px 0 12px">Name each level and choose its rights. Everyone at that level gets these rights, unless you hand-picked theirs on the People page.</p>
      <div class="lvl-list">${S.levels.map((l) => `<form class="lvl" data-level="${l.level}" novalidate>
        <div class="lvl-h"><span class="lvl-n">${l.level}</span><input class="field" name="name" value="${esc(l.name)}" maxlength="60" aria-label="Name of level ${l.level}">
          <button class="btn small" type="submit">Save</button><span class="err"></span></div>
        <div class="rights-grid">${Object.entries(RIGHTS).map(([n, label]) => `<label class="rt"><input type="checkbox" name="r" value="${n}" ${l.rights.includes(Number(n)) ? "checked" : ""} ${n === "1" ? "disabled" : ""}><b>${n}</b> ${esc(label)}</label>`).join("")}</div>
      </form>`).join("")}</div></div>` : ""}
    <div class="panel"><h2>Security</h2>
      <div class="sec-row"><div><b>Two-step sign-in</b><div class="small muted">${(S.factors.totp || []).length ? "On. You’re asked for a code from your authenticator app when you sign in." : "Off. Turn it on so a stolen password isn’t enough to get in."}</div></div>
        ${(S.factors.totp || []).length ? (S.needs2fa ? `<span class="chip ok">On · required for your rights</span>` : `<button class="btn small" id="mfaOff" type="button">Turn off</button>`) : `<button class="btn primary small" id="mfaOn" type="button">Turn on</button>`}</div>
      <div class="sec-row"><div><b>Sign out on all devices</b><div class="small muted">Use this if you lost a phone or signed in on a shared computer.</div></div><button class="btn small" id="outAll" type="button">Sign out everywhere</button></div>
      <div class="sec-row" style="display:block"><b>Your recent sign-ins</b><div class="feed" id="signins" style="margin-top:6px"><p class="muted small" style="margin:0">Loading…</p></div></div>
      <p class="small muted" style="margin:10px 0 0">You’re signed out automatically after ${Math.round(IDLE_MS / 60000)} minutes without activity.</p></div>
    <div class="panel"><h2>Account</h2><div class="actions"><span>${esc(S.email)}</span><button class="btn small" id="out" type="button">Sign out</button></div></div>
  </div>`;
  $("#nf").onchange = async (e) => {
    try { await db.setNotifyMode(S.ws.id, e.target.value); S.me.notify_mode = e.target.value; toast("Saved"); } catch (err) { toast(err.message); }
  };
  if (has(10)) loadBilling();
  if (has(3) || has(9)) loadTemplatePanel();
  $("#waf").onsubmit = async (e) => {
    e.preventDefault(); const f = e.target;
    try { await db.setPrefs(S.ws.id, { lang: LANG, phone: f.phone.value.trim() || null, whatsapp: f.wa.checked });
      S.me.phone = f.phone.value.trim(); S.me.whatsapp = f.wa.checked; $("#waerr").textContent = ""; toast(T("Saved")); }
    catch (err) { $("#waerr").textContent = err.message; }
  };
  view().querySelectorAll("[data-lang]").forEach((b) => (b.onclick = async () => {
    setLang(b.dataset.lang);
    try { await db.setPrefs(S.ws.id, { lang: b.dataset.lang, phone: S.me.phone || null, whatsapp: !!S.me.whatsapp }); S.me.lang = b.dataset.lang; } catch {}
    render();
  }));
  $("#out").onclick = () => auth.signOut();
  $("#outAll").onclick = async (e) => { if (e.target.dataset.sure !== "1") { e.target.dataset.sure = "1"; e.target.textContent = "Sign out of every device, including this one?"; return; } await auth.signOutEverywhere(); };
  if ($("#mfaOn")) $("#mfaOn").onclick = () => vMfaSetup(false);
  if ($("#mfaOff")) $("#mfaOff").onclick = async (e) => {
    if (e.target.dataset.sure !== "1") { e.target.dataset.sure = "1"; e.target.textContent = "Click again to turn off"; return; }
    try { for (const f of S.factors.totp || []) await auth.unenroll(f.id); S.factors = await auth.factors(); toast("Two-step sign-in is off"); vSettings(); } catch (err) { toast(err.message); }
  };
  db.mySignIns().then((rows) => { const el = $("#signins"); if (el) el.innerHTML = rows.map((r) => `<div class="it"><span>${esc(r.device || "Unknown device")}${r.mfa ? ' <span class="chip ok">2-step</span>' : ""}</span><span class="when">${esc(fmtT(r.at))}</span></div>`).join("") || '<p class="muted small" style="margin:0">None recorded yet.</p>'; }).catch(() => {});
  view().querySelectorAll("form.lvl").forEach((form) => (form.onsubmit = async (e) => {
    e.preventDefault();
    const level = Number(form.dataset.level), name = form.name.value.trim();
    if (!name) { form.querySelector(".err").textContent = "Give the level a name."; return; }
    const rights = [1, ...[...form.querySelectorAll('[name="r"]:checked')].map((c) => Number(c.value))].filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b);
    if (level === Math.max(...S.levels.map((l) => l.level)) && !rights.includes(10) && !S.members.some((m) => m.status === "active" && m.custom_rights && m.rights.includes(10))) {
      if (!confirmOnce(form, "Nobody else may have right 10 after this. Click Save again to try anyway.")) return;
    }
    try { await db.updateLevel(S.ws.id, level, { name, rights }); await reload(); await onSession(S.session); toast(`Level ${level} saved`); vSettings(); }
    catch (err) { form.querySelector(".err").textContent = err.message; }
  }));
  const wf = $("#wf");
  if (wf) wf.onsubmit = async (e) => {
    e.preventDefault(); const f = formData(wf);
    if (!f.name.trim()) { $("#werr").textContent = "The team needs a name."; return; }
    try {
      const w = await db.updateWorkspace(S.ws.id, { name: f.name.trim(), timezone: f.timezone, escalate_after_days: Number(f.escalate_after_days) || 3 });
      S.ws = { ...S.ws, ...w }; S.me.workspaces = S.ws; toast("Saved"); renderChrome("settings");
    } catch (err) { $("#werr").textContent = err.message; }
  };
}

async function loadTemplatePanel() {
  const el = $("#tplPanel"); if (!el) return;
  let list = []; try { list = await db.templates(S.ws.id); } catch (err) { el.innerHTML = `<h2>${esc(T("Task templates"))}</h2><p class="err">${esc(err.message)}</p>`; return; }
  el.innerHTML = `<h2>${ic("tpl")} ${esc(T("Task templates"))}</h2>${list.length ? `<div class="tpl-list">${list.map((x) => `<div class="tpl-item"><div><b>${esc(x.name)}</b><div class="small muted">${esc(x.title)} · ${x.checklist.length} ${esc(T("steps"))}${x.repeat !== "none" ? " · " + esc(T(REPEAT[x.repeat])) : ""}</div></div>${x.created_by === S.me.id || has(9) ? `<button class="btn small danger" type="button" data-tdel="${esc(x.id)}">${esc(T("Delete"))}</button>` : ""}</div>`).join("")}</div>`
    : `<p class="muted" style="margin:0">${esc(T("No templates yet. On New task, fill in a task and press Save as template."))}</p>`}`;
  el.querySelectorAll("[data-tdel]").forEach((b) => (b.onclick = async () => { try { await db.deleteTemplate(b.dataset.tdel); toast(T("Deleted")); loadTemplatePanel(); } catch (err) { toast(err.message); } }));
}

/* ---------- plan & billing ---------- */
const fmtDay = (iso) => iso ? new Date(iso).toLocaleDateString(LOCALE(), { day: "numeric", month: "short", year: "numeric" }) : "";
const daysLeft = (iso) => Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 864e5));
function planLine(b) {
  if (b.status === "comp") return "Owner account · free";
  if (b.status === "trialing") return b.active ? `Free trial · ${daysLeft(b.trial_ends_at)} day${daysLeft(b.trial_ends_at) === 1 ? "" : "s"} left` : "Your free trial has ended";
  if (b.status === "active") return `${b.plan_name}${b.period_end ? ` · renews ${fmtDay(b.period_end)}` : ""}`;
  if (b.status === "past_due") return `${b.plan_name} · the last payment failed. Update your card to keep your plan.`;
  if (b.status === "cancelled" && b.active) return `${b.plan_name} · cancelled, ends ${fmtDay(b.period_end)}`;
  return "No active plan";
}
function checkoutUrl(p) {
  const u = p.checkout_url;
  return `${u}${u.includes("?") ? "&" : "?"}checkout[custom][workspace_id]=${encodeURIComponent(S.ws.id)}&checkout[email]=${encodeURIComponent(S.email || "")}`;
}
async function loadBilling() {
  const el = $("#billing"); if (!el) return;
  let b; try { b = await db.billing(S.ws.id); } catch (err) { el.innerHTML = `<h2>Plan &amp; billing</h2><p class="err">${esc(err.message)}</p>`; return; }
  const paying = ["active", "past_due"].includes(b.status) || (b.status === "cancelled" && b.active);
  el.innerHTML = `<h2>Plan &amp; billing</h2>
    <div class="bill-now ${b.active ? "" : "off"}"><div><b>${esc(planLine(b))}</b>
      <div class="small muted">${b.seats_used} of ${b.seat_limit} people on your plan${!b.active ? " · you can still see and update your work, but not add tasks or people" : ""}</div></div>
      ${b.portal_url ? `<a class="btn small" href="${esc(b.portal_url)}" target="_blank" rel="noopener">Manage subscription</a>` : ""}</div>
    ${b.status === "comp" ? "" : `<div class="plans">${(b.plans || []).map((p) => {
      const current = paying && b.plan === p.id;
      return `<div class="plan ${current ? "cur" : ""}"><div class="pn" data-notr>${esc(p.name)}</div><div class="pp"><b>$${p.price_usd}</b><span class="muted small">/month</span></div>
        <div class="small muted">Up to ${p.seat_limit} people</div>
        ${current ? `<span class="chip ok">Your plan</span>`
          : paying ? (b.portal_url ? `<a class="btn small" href="${esc(b.portal_url)}" target="_blank" rel="noopener">Switch to ${esc(p.name)}</a>` : "")
          : p.checkout_url ? `<a class="btn small primary" href="${esc(checkoutUrl(p))}" target="_blank" rel="noopener">Choose ${esc(p.name)}</a>`
          : `<span class="small muted">Payments open soon</span>`}</div>`; }).join("")}</div>
    <p class="small muted" style="margin:10px 0 0">Prices in US dollars. Sales tax is added where required. Cancel anytime from Manage subscription. ${paying ? "Plan changes are made in Manage subscription, and the price difference is worked out for you." : ""}</p>`}`;
}
async function trialBanner() {
  if (!has(10)) return;
  let b; try { b = await db.billing(S.ws.id); } catch { return; }
  const soon = b.status === "trialing" && b.active && daysLeft(b.trial_ends_at) <= 5;
  if (!(soon || !b.active || b.status === "past_due")) return;
  const msg = !b.active ? "Your free trial has ended. You can still see your work, but you can’t add tasks or people until you choose a plan."
    : b.status === "past_due" ? "Your last payment didn’t go through. Update your card to keep Delegiq running."
    : `Your free trial ends in ${daysLeft(b.trial_ends_at)} day${daysLeft(b.trial_ends_at) === 1 ? "" : "s"}.`;
  const v = view(); if (!v || v.querySelector(".trial-bar")) return;
  v.insertAdjacentHTML("afterbegin", `<div class="trial-bar ${b.active ? "" : "off"}"><span>${esc(msg)}</span><a class="btn small primary" href="#/settings">${b.status === "past_due" ? "Update card" : "Choose a plan"}</a></div>`);
}

function confirmOnce(el, msg) { if (el.dataset.sure === "1") return true; el.dataset.sure = "1"; el.querySelector(".err").textContent = msg; return false; }

/* ---------- team switcher ---------- */
document.addEventListener("change", async (e) => {
  if (e.target.id !== "wsPick") return;
  try { localStorage.setItem("handoff.ws", e.target.value); } catch {}
  await onSession(S.session); go(homePage()); render();
});

boot();
