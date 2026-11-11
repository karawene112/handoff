// Delegiq AI, powered by Claude.
//   { action: "draft", workspace_id, text } → a task drafted from one sentence, with the best person to give it to
//   { action: "brief", workspace_id }       → a short plain-language brief of what needs attention today
// Reads data AS THE SIGNED-IN PERSON (their access rules apply), so the AI only ever sees what they can see.
import { createClient } from "npm:@supabase/supabase-js@2";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const PER_HOUR = 60;
const FAST = "claude-haiku-5-5";
const SMART = "claude-sonnet-5-5";

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

async function claude(model: string, system: string, user: string, maxTokens: number) {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("NO_KEY");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) { console.error(res.status, await res.text()); throw new Error("AI_FAILED"); }
  const j = await res.json();
  return (j.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("").trim();
}

function localToday(tz: string) {
  const now = new Date();
  return {
    day: new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now),
    weekday: new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(now),
  };
}
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const STATUS: Record<string, string> = { todo: "To do", progress: "In progress", blocked: "Blocked", review: "Waiting for approval", done: "Done" };

Deno.serve(async (req) => {
  cors = { "Access-Control-Allow-Origin": await origin(), "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return fail("Use POST", 405);

  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: who } = await admin.auth.getUser(jwt);
  if (!who?.user) return fail("Please sign in again.", 401);
  const uid = who.user.id;
  const asUser = createClient(URL_, ANON, { global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false } });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return fail("Bad request"); }
  const ws = String(body.workspace_id ?? "");

  // fair use: at most PER_HOUR requests per person per hour
  const { count } = await admin.from("ai_usage").select("id", { count: "exact", head: true }).eq("user_id", uid).gte("at", new Date(Date.now() - 3600e3).toISOString());
  if ((count ?? 0) >= PER_HOUR) return fail("You've used the AI a lot this hour. Try again a little later.", 429);
  await admin.from("ai_usage").insert({ user_id: uid, action: String(body.action ?? "") });

  try {
    const [{ data: wsRow }, { data: members }, { data: tasks }] = await Promise.all([
      asUser.from("workspaces").select("timezone").eq("id", ws).maybeSingle(),
      asUser.from("members").select("id,name,level,team,skills,job_title,max_open,available,status,rights,user_id").eq("workspace_id", ws),
      asUser.from("tasks").select("id,title,status,priority,deadline,assignee_id,completed_at,checklist").eq("workspace_id", ws),
    ]);
    if (!wsRow) return fail("You don't have access to this team.", 403);
    const me = (members ?? []).find((m) => m.user_id === uid);
    if (!me) return fail("You don't have access to this team.", 403);
    const { day, weekday } = localToday(wsRow.timezone);
    const open = (tasks ?? []).filter((t) => t.status !== "done");
    const load = (id: string) => open.filter((t) => t.assignee_id === id).length;

    const LANG = ({ ar: "Arabic", fr: "French", en: "English" } as Record<string, string>)[String(body.lang ?? "en")] ?? "English";

    if (body.action === "draft") {
      const text = String(body.text ?? "").trim().slice(0, 1500);
      if (!text) return fail("Write what needs doing first.");
      const r = new Set<number>(me.rights);
      const people = (members ?? []).filter((m) => m.status !== "removed" &&
        (r.has(9) || (m.id === me.id && r.has(3)) || (r.has(3) && m.team && m.team === me.team && m.level < me.level)));
      if (!people.length) return fail("You can't give tasks to anyone yet (right 3).", 403);
      const team = people.map((m) => ({ id: m.id, name: m.name, job: m.job_title ?? "", skills: m.skills ?? "", openTasks: load(m.id), maxOpen: m.max_open, away: !m.available }));

      const system = `You turn a manager's request into one well-formed work task and choose who should do it.
Reply with ONLY a JSON object, no other text:
{"title": string, "description": string, "priority": "Low"|"Medium"|"High"|"Urgent", "deadline": "YYYY-MM-DD", "assignee_id": string|null, "reason": string, "steps": string[]}
Rules:
- title: short, starts with a verb, under 80 characters.
- description: the useful details from the request, in plain words; empty string if none.
- deadline: resolve relative dates ("Tuesday", "next week", "end of month") against today. With no date given, pick one that fits the priority: Urgent 1 day, High 3 days, Medium 5 days, Low 10 days.
- assignee_id: if the request names a person on the team, use them. Otherwise match skills and job first, then the lowest openTasks/maxOpen. Avoid people who are away or at their limit unless nobody else fits. Must be one of the ids given, or null.
- reason: why this person, under 12 plain words, like "Knows Power BI and has 2 open tasks".
- steps: 0 to 5 short concrete steps; empty if the task is simple.
- Write the title, description, reason and steps in ${LANG}, even if the request is in another language. Keep people's names as they are.`;
      const user = `Today is ${weekday} ${day}.\nTeam (JSON): ${JSON.stringify(team)}\n\nRequest:\n"""${text}"""`;
      const raw = await claude(FAST, system, user, 700);
      let d: Record<string, unknown>;
      try { d = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)); } catch { return fail("The AI couldn't read that. Try rewording it."); }

      let pick = people.find((p) => p.id === d.assignee_id) ?? null;
      let reason = String(d.reason ?? "");
      if (!pick) {
        pick = people.filter((p) => p.available).sort((a, b) => load(a.id) / a.max_open - load(b.id) / b.max_open)[0] ?? people[0];
        reason = LANG === "Arabic" ? `لدى ${pick.name} أخف عبء عمل الآن.` : LANG === "French" ? `${pick.name} a la charge la plus légère en ce moment.` : `${pick.name} has the lightest load right now.`;
      }
      const deadline = /^\d{4}-\d{2}-\d{2}$/.test(String(d.deadline)) && String(d.deadline) >= day ? String(d.deadline) : new Date(Date.parse(day) + 3 * 864e5).toISOString().slice(0, 10);
      return reply({
        title: String(d.title ?? text).slice(0, 200),
        description: String(d.description ?? ""),
        priority: ["Low", "Medium", "High", "Urgent"].includes(String(d.priority)) ? d.priority : "Medium",
        deadline,
        assignee_id: pick.id,
        reason,
        steps: Array.isArray(d.steps) ? d.steps.map(String).filter(Boolean).slice(0, 8) : [],
      });
    }

    if (body.action === "brief") {
      const name = (id: string | null) => (members ?? []).find((m) => m.id === id)?.name ?? "Unassigned";
      const recent = (tasks ?? []).filter((t) => t.status !== "done" || (t.completed_at && days(t.completed_at.slice(0, 10), day) <= 7));
      if (!recent.length) return reply({ text: LANG === "Arabic" ? "- لا توجد مهام مفتوحة الآن. وقت مناسب لتخطيط المهام القادمة." : LANG === "French" ? "- Rien d’ouvert pour l’instant. Bon moment pour planifier les prochaines tâches." : "- Nothing open right now. A good moment to plan the next tasks." });
      const rows = recent.slice(0, 150).map((t) => ({
        task: t.title, who: name(t.assignee_id), status: STATUS[t.status], priority: t.priority,
        due: t.deadline, daysLeft: t.status === "done" ? null : days(day, t.deadline),
        steps: Array.isArray(t.checklist) && t.checklist.length ? `${t.checklist.filter((c: { done: boolean }) => c.done).length}/${t.checklist.length}` : null,
        finished: t.completed_at ? t.completed_at.slice(0, 10) : null,
      }));
      const people = (members ?? []).filter((m) => m.status === "active" && m.id !== me.id).map((m) => ({ name: m.name, open: load(m.id), max: m.max_open, away: !m.available }));
      const system = `You are the assistant of a manager who hands out work. Write their morning brief.
Plain text only, at most 130 words, as 3 to 6 lines that each start with "- ".
Cover, in this order: what needs action now (late, blocked, due today or tomorrow) and who to follow up with; anyone overloaded or with spare room; one concrete suggestion (a reassignment, a deadline to move, a check-in).
Write like a sharp colleague: names, task titles and dates; no filler, no praise, no headings, no other markdown. If everything is on track, say so in one line and suggest what to plan next.
Write in ${LANG}. Keep names and task titles exactly as given.`;
      const user = `Today is ${weekday} ${day}. The manager is ${me.name}.\nPeople (JSON): ${JSON.stringify(people)}\nTasks (JSON): ${JSON.stringify(rows)}`;
      const text = await claude(SMART, system, user, 500);
      return reply({ text, day });
    }

    return fail("Unknown action");
  } catch (e) {
    if (String(e).includes("NO_KEY")) return fail("AI isn't switched on yet. Add ANTHROPIC_API_KEY in Supabase → Edge Functions → Secrets.", 503);
    if (String(e).includes("AI_FAILED")) return fail("The AI didn't answer. Try again in a moment.", 502);
    console.error(e);
    return fail("Something went wrong. Try again.", 500);
  }
});
