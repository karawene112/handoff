// Everything the website asks of the server goes through this file.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";

const cfg = window.HANDOFF_CONFIG;
const sb = createClient(cfg.supabaseUrl, cfg.supabaseKey);
const appBase = () => location.origin + location.pathname;

function check({ data, error }) {
  if (error) throw new Error(friendly(error));
  return data;
}
function friendly(e) {
  const m = e.message || String(e);
  if (/Invalid login credentials/i.test(m)) return "Wrong email or password.";
  if (/Email not confirmed/i.test(m)) return "Confirm your email first. Check your inbox for the link.";
  if (/User already registered/i.test(m)) return "There's already an account with this email. Sign in instead.";
  if (/Password should be at least/i.test(m)) return "Use a password of at least 8 characters.";
  if (/rate limit/i.test(m)) return "Too many emails sent just now. Wait a few minutes and try again.";
  if (/row-level security|permission denied/i.test(m)) return "You don't have permission to do that.";
  if (/Invalid TOTP code|invalid.*code/i.test(m)) return "That code didn't work. Wait for a new one and try again.";
  if (/mime type|not supported/i.test(m)) return "That type of file can't be attached. Use a PDF, image, Word, Excel, PowerPoint, CSV or text file.";
  return m;
}

async function callFn(name, body) {
  const { data, error } = await sb.functions.invoke(name, { body });
  if (error) {
    let msg = error.message;
    try { const j = await error.context.json(); if (j?.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

export const auth = {
  async session() { return (await sb.auth.getSession()).data.session; },
  onChange(cb) { sb.auth.onAuthStateChange((event, session) => cb(event, session)); },
  async signIn(email, password) { return check(await sb.auth.signInWithPassword({ email, password })); },
  async signUp(email, password, name) {
    return check(await sb.auth.signUp({ email, password, options: { data: { name }, emailRedirectTo: appBase() } }));
  },
  async google() { return check(await sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: appBase() } })); },
  async signOut() { await sb.auth.signOut(); },
  // The email link comes back to the site with a recovery session; app.js then shows "Choose a new password".
  async signOutEverywhere() { await sb.auth.signOut({ scope: "global" }); },
  // two-step sign-in with an authenticator app
  async aal() { const { data } = await sb.auth.mfa.getAuthenticatorAssuranceLevel(); return data || { currentLevel: "aal1", nextLevel: "aal1" }; },
  async factors() { const { data } = await sb.auth.mfa.listFactors(); return data || { all: [], totp: [] }; },
  async enroll() {
    const f = await this.factors();
    for (const old of (f.all || []).filter((x) => x.status !== "verified")) await sb.auth.mfa.unenroll({ factorId: old.id });
    return check(await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: "Delegiq " + new Date().toISOString().slice(0, 10) }));
  },
  async verify(factorId, code) {
    check(await sb.auth.mfa.challengeAndVerify({ factorId, code }));
    return (await sb.auth.getSession()).data.session;
  },
  async unenroll(factorId) { return check(await sb.auth.mfa.unenroll({ factorId })); },
  async resetPassword(email) { return check(await sb.auth.resetPasswordForEmail(email, { redirectTo: appBase() })); },
  async setPassword(password) { return check(await sb.auth.updateUser({ password, data: { must_change_password: false } })); },
};

export const db = {
  async memberships(uid) {
    return check(await sb.from("members")
      .select("id,role,level,rights,team,name,email,notify_mode,lang,phone,whatsapp,workspace_id,workspaces(id,name,timezone,escalate_after_days)")
      .eq("user_id", uid).eq("status", "active"));
  },
  async createWorkspace(name, myName) { return check(await sb.rpc("create_workspace", { p_name: name, p_my_name: myName })); },
  async updateWorkspace(id, patch) { return check(await sb.from("workspaces").update(patch).eq("id", id).select().single()); },

  async members(ws) { return check(await sb.from("members").select("*").eq("workspace_id", ws).order("name")); },
  async levels(ws) { return check(await sb.from("levels").select("*").eq("workspace_id", ws).order("level")); },
  async updateLevel(ws, level, patch) { return check(await sb.from("levels").update(patch).eq("workspace_id", ws).eq("level", level).select().single()); },
  // The manager creates the person's login; returns { temp_password } once (null if they already had an account).
  async addMember(ws, m) {
    return callFn("add-member", { action: "add", workspace_id: ws, name: m.name, email: m.email, level: Number(m.level) || 1, team: m.team || null,
      job_title: m.job_title || null, skills: m.skills || null, max_open: Number(m.max_open) || 5 });
  },
  async newPassword(memberId) { return callFn("add-member", { action: "password", member_id: memberId }); },
  // Every change to a person goes through the server, which checks the caller's own level and rights.
  // Leave a field undefined to keep it; rights: null = use the level's rights.
  async updateMember(id, p) {
    return check(await sb.rpc("update_member", {
      p_id: id, p_name: p.name ?? null, p_job_title: p.job_title ?? null, p_skills: p.skills ?? null,
      p_max_open: p.max_open ?? null, p_available: p.available ?? null, p_level: p.level ?? null,
      p_rights: p.rights === undefined ? null : p.rights, p_team: p.team ?? null, p_status: p.status ?? null,
    }));
  },
  async setNotifyMode(ws, mode) { return check(await sb.rpc("set_my_notify_mode", { p_ws: ws, p_mode: mode })); },
  async setPrefs(ws, { lang = null, phone = null, whatsapp = false }) { return check(await sb.rpc("set_my_prefs", { p_ws: ws, p_lang: lang, p_phone: phone, p_whatsapp: whatsapp })); },
  async templates(ws) { return check(await sb.from("task_templates").select("*").eq("workspace_id", ws).order("name")); },
  async saveTemplate(row) { return check(await sb.from("task_templates").insert(row).select().single()); },
  async deleteTemplate(id) { return check(await sb.from("task_templates").delete().eq("id", id)); },

  async tasks(ws) { return check(await sb.from("tasks").select("*").eq("workspace_id", ws).order("deadline")); },
  async task(id) { return check(await sb.from("tasks").select("*").eq("id", id).maybeSingle()); },
  async createTask(row) { return check(await sb.from("tasks").insert(row).select().single()); },
  async updateTask(id, patch) { return check(await sb.from("tasks").update(patch).eq("id", id).select().single()); },
  async deleteTask(id) { return check(await sb.from("tasks").delete().eq("id", id)); },

  async comments(taskId) { return check(await sb.from("comments").select("*").eq("task_id", taskId).order("created_at")); },
  async addComment(taskId, authorId, body) { return check(await sb.from("comments").insert({ task_id: taskId, author_id: authorId, body }).select().single()); },

  async files(taskId) { return check(await sb.from("task_files").select("*").eq("task_id", taskId).order("created_at")); },
  async upload(ws, taskId, memberId, file) {
    const safe = file.name.replace(/[^\w.\-]+/g, "_").slice(-80);
    const path = `${ws}/${taskId}/${crypto.randomUUID()}-${safe}`;
    check(await sb.storage.from("task-files").upload(path, file, { contentType: file.type || undefined }));
    return check(await sb.from("task_files").insert({ task_id: taskId, path, name: file.name, size: file.size, uploaded_by: memberId }).select().single());
  },
  async fileUrl(path) { return check(await sb.storage.from("task-files").createSignedUrl(path, 3600)).signedUrl; },
  async deleteFile(row) {
    await sb.storage.from("task-files").remove([row.path]);
    return check(await sb.from("task_files").delete().eq("id", row.id));
  },

  // AI (Claude). The server reads only what this person is allowed to see.
  async aiDraft(ws, text, lang = "en") { return callFn("ai", { action: "draft", workspace_id: ws, text, lang }); },
  async aiBrief(ws, lang = "en") { return callFn("ai", { action: "brief", workspace_id: ws, lang }); },

  async signupOpen() { const { data } = await sb.rpc("signup_open"); return !!data; },
  async billing(ws) { return check(await sb.rpc("billing_info", { p_ws: ws })); },
  async recordSignIn(device) { await sb.rpc("record_sign_in", { p_device: device }); },
  async mySignIns() { return check(await sb.from("sign_ins").select("*").order("at", { ascending: false }).limit(8)); },
  async peopleSecurity(ws) { return check(await sb.rpc("people_security", { p_ws: ws })); },

  async activity(ws, { taskId, limit = 100, since } = {}) {
    let q = sb.from("activity").select("*").eq("workspace_id", ws).order("created_at", { ascending: false }).limit(limit);
    if (taskId) q = q.eq("task_id", taskId);
    if (since) q = q.gte("created_at", since);
    return check(await q);
  },
};
