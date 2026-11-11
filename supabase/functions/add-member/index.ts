// Lets a manager create a team member's login.
//   { action: "add", workspace_id, name, email, level, team, job_title, skills, max_open }
//   { action: "password", member_id }   → new temporary password (or first login for older invites)
// The caller needs right 7 (add people below them in their team) or right 9 (everyone). Returns the temporary password once.
import { createClient } from "npm:@supabase/supabase-js@2";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
// Only the Delegiq website may call this from a browser: the allowed origin comes from the app_url setting.
let allowedOrigin = "";
async function origin() {
  if (!allowedOrigin) {
    const { data } = await admin.from("app_settings").select("value").eq("key", "app_url").maybeSingle();
    try { allowedOrigin = new URL(String(data?.value ?? "").replace(/#.*$/, "")).origin; } catch { allowedOrigin = "null"; }
  }
  return allowedOrigin;
}
let cors: Record<string, string> = {};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const fail = (message: string, status = 400) => reply({ error: message }, status);

function tempPassword() {
  const abc = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const s = Array.from(bytes, (b) => abc[b % abc.length]).join("");
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

Deno.serve(async (req) => {
  cors = { "Access-Control-Allow-Origin": await origin(), "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return fail("Use POST", 405);

  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: who, error: whoErr } = await admin.auth.getUser(jwt);
  if (whoErr || !who?.user) return fail("Please sign in again.", 401);
  const caller = who.user;
  // everything here needs right 7 or 9, and those rights require two-step sign-in
  let aal = "";
  try { aal = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).aal ?? ""; } catch { /* treated as aal1 */ }
  if (aal !== "aal2") return fail("Turn on two-step sign-in first, then sign in again.", 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return fail("Bad request"); }

  try {
    if (body.action === "add") {
      const ws = String(body.workspace_id ?? "");
      const email = String(body.email ?? "").trim().toLowerCase();
      const name = String(body.name ?? "").trim();
      if (!name) return fail("Add a name.");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("That email doesn't look right.");

      const level = Number(body.level) || 1;
      const { data: chk } = await admin.rpc("svc_check_add", { p_ws: ws, p_user: caller.id, p_level: level, p_team: body.team ?? null });
      const allowed = Array.isArray(chk) ? chk[0] : null;
      if (!allowed?.actor) return fail("You can only add people below your own level, in your own team (right 7).", 403);
      const actor = allowed.actor;
      // plan limits: trial over, or no seats left
      const { data: seatMsg } = await admin.rpc("svc_seat_problem", { p_ws: ws });
      if (seatMsg) return fail(String(seatMsg), 402);

      let { data: userId } = await admin.rpc("svc_user_id_by_email", { p_email: email });
      let temp: string | null = null;
      if (!userId) {
        temp = tempPassword();
        const { data: made, error } = await admin.auth.admin.createUser({
          email, password: temp, email_confirm: true, user_metadata: { name, must_change_password: true },
        });
        if (error) return fail(error.message);
        userId = made.user.id;
      }
      const { data: memberId, error } = await admin.rpc("svc_add_member", {
        p_ws: ws, p_actor: actor, p_user: userId, p_email: email, p_name: name, p_level: level,
        p_team: allowed.team, p_job_title: body.job_title ?? null, p_skills: body.skills ?? null,
        p_max_open: Number(body.max_open) || 5, p_temp: temp,
      });
      if (error) {
        if (temp) await admin.auth.admin.deleteUser(userId); // don't leave an orphan login behind
        return fail(error.message.includes("already on the team") ? "This email is already on the team." : error.message);
      }
      return reply({ member_id: memberId, email, temp_password: temp, existing_account: !temp });
    }

    if (body.action === "password") {
      const { data: m } = await admin.from("members").select("id,workspace_id,user_id,email,name,status").eq("id", String(body.member_id ?? "")).maybeSingle();
      if (!m) return fail("Person not found.", 404);
      if (m.user_id === caller.id) return fail("Change your own password in Settings.");
      const { data: actor } = await admin.rpc("svc_check_scope", { p_user: caller.id, p_member: m.id, r: 7 });
      if (!actor) return fail("You can only do this for people below you in your team (right 7).", 403);
      if (m.status === "removed") return fail("Restore this person first.");

      const temp = tempPassword();
      let userId = m.user_id ?? (await admin.rpc("svc_user_id_by_email", { p_email: m.email })).data;
      if (userId) {
        const { data: ok } = await admin.rpc("svc_can_reset", { p_manager_user: caller.id, p_target_user: userId });
        if (!ok) return fail("This person is also on a team you don't manage, so they need to reset their own password from the sign-in page.", 403);
        const { error } = await admin.auth.admin.updateUserById(userId, { password: temp, user_metadata: { must_change_password: true } });
        if (error) return fail(error.message);
      } else {
        const { data: made, error } = await admin.auth.admin.createUser({
          email: m.email, password: temp, email_confirm: true, user_metadata: { name: m.name, must_change_password: true },
        });
        if (error) return fail(error.message);
        userId = made.user.id;
      }
      const { error } = await admin.rpc("svc_set_login", { p_member: m.id, p_actor: actor, p_user: userId, p_temp: temp });
      if (error) return fail(error.message);
      return reply({ member_id: m.id, email: m.email, temp_password: temp });
    }

    return fail("Unknown action");
  } catch (e) {
    console.error(e);
    return fail("Something went wrong. Try again.", 500);
  }
});
