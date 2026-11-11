// Delegiq email worker.
//   ?job=send    → sends queued emails (runs every 2 minutes)
//   ?job=hourly  → builds the morning digests / Monday report in each workspace's time zone, then sends
// Called only by the database scheduler, which proves itself with the x-cron-token header.
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

type Note = { id: number; to_email: string; subject: string; body: string; urgent: boolean; kind: string };
type Task = { id: string; title: string; status: string; priority: string; deadline: string; assignee_id: string | null; completed_at: string | null };
type Member = { id: string; name: string; email: string; role: string; team: string | null; status: string; max_open: number; notify_mode: string; level: number; rights: number[] };

const STATUS: Record<string, string> = { todo: "To do", progress: "In progress", blocked: "Blocked", review: "Waiting for approval", done: "Done" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function settings() {
  const { data } = await sb.from("app_settings").select("key,value");
  const s: Record<string, string> = {};
  for (const r of data ?? []) s[r.key] = r.value;
  return { appUrl: (s.app_url ?? "").replace(/\/$/, ""), from: s.email_from ?? "Delegiq <onboarding@resend.dev>",
    waTemplate: s.whatsapp_template ?? "delegiq_alert", waVersion: s.whatsapp_api_version ?? "v25.0" };
}

// ---------- WhatsApp (Meta WhatsApp Cloud API) ----------
// Sends the important alerts to people who turned WhatsApp on in Settings, using one approved message template
// with three variables: {{1}} the headline, {{2}} one line of detail, {{3}} the link. Plans: trial, Team, Business, Owner.
const WA_KINDS = new Set(["assigned", "due_soon", "due_today", "late", "escalation", "deadline_changed"]);
const WA_PLANS = new Set(["trial", "team", "business", "comp"]);
const oneLine = (t: string, max: number) => t.replace(/\s+/g, " ").trim().slice(0, max) || "-";

async function sendWhatsApp(appUrl: string, template: string, version: string) {
  const token = Deno.env.get("WHATSAPP_TOKEN"), phoneId = Deno.env.get("WHATSAPP_PHONE_ID");
  if (!token || !phoneId) return { wa: 0, waNote: "WhatsApp is not set up" };
  const since = new Date(Date.now() - 6 * 3600e3).toISOString();
  const { data: rows } = await sb.from("notifications").select("id,workspace_id,member_id,kind,urgent,subject,body,task_id")
    .is("wa_sent_at", null).is("wa_error", null).gte("created_at", since).order("id").limit(40);
  const todo = (rows ?? []).filter((n) => n.member_id && (WA_KINDS.has(n.kind) || (n.kind === "status" && n.urgent)));
  if (!todo.length) return { wa: 0 };
  const ids = [...new Set(todo.map((n) => n.member_id))];
  const wss = [...new Set(todo.map((n) => n.workspace_id))];
  const [{ data: people }, { data: subs }] = await Promise.all([
    sb.from("members").select("id,phone,whatsapp,lang,status").in("id", ids),
    sb.from("subscriptions").select("workspace_id,plan,status").in("workspace_id", wss),
  ]);
  let wa = 0;
  for (const n of todo) {
    const p = (people ?? []).find((x) => x.id === n.member_id);
    const sub = (subs ?? []).find((x) => x.workspace_id === n.workspace_id);
    const mark = (patch: Record<string, unknown>) => sb.from("notifications").update(patch).eq("id", n.id);
    if (!p?.whatsapp || !p.phone || p.status === "removed") { await mark({ wa_error: "not opted in" }); continue; }
    if (!sub || !WA_PLANS.has(sub.plan)) { await mark({ wa_error: "plan without WhatsApp" }); continue; }
    const link = n.task_id ? `${appUrl}/tasks/${n.task_id}` : appUrl;
    const detail = n.body.replaceAll("{{app}}", appUrl).split("\n").find((l: string) => l.trim() && !/^(Open it|Update it|Reply here|See everything)/.test(l)) ?? "";
    const res = await fetch(`https://graph.facebook.com/${version}/${phoneId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp", to: p.phone.replace(/^\+/, ""), type: "template",
        template: { name: template, language: { code: ["ar", "fr"].includes(p.lang) ? p.lang : "en" },
          components: [{ type: "body", parameters: [
            { type: "text", text: oneLine(n.subject, 120) }, { type: "text", text: oneLine(detail, 300) }, { type: "text", text: link }] }] },
      }),
    });
    if (res.ok) { await mark({ wa_sent_at: new Date().toISOString() }); wa++; }
    else await mark({ wa_error: `${res.status} ${(await res.text()).slice(0, 300)}` });
    await sleep(250);
  }
  return { wa };
}

const escapeHtml = (t: string) => t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function html(subject: string, text: string, urgent: boolean) {
  const url = text.match(/https?:\/\/\S+/g)?.at(-1);
  const body = escapeHtml(text.replace(url ?? "\u0000", "").replace(/(Open it|Update it|Reply here|Sign in with this email|Create your account with this email|Update it or explain the delay|See everything|Full report):\s*$/m, "").trim())
    .split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px;line-height:1.55">${p.replace(/\n/g, "<br>")}</p>`).join("");
  const button = url
    ? `<a href="${escapeHtml(url)}" style="display:inline-block;background:#7A4724;color:#fff;text-decoration:none;padding:10px 18px;border-radius:5px;font-weight:700">Open in Delegiq</a>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#F6F1EB;font-family:Arial,Helvetica,sans-serif;color:#2B1F17">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #E7DDD1;border-radius:8px">
<tr><td style="padding:18px 24px;border-bottom:1px solid #E7DDD1;font-weight:700;font-size:18px">Delegiq${urgent ? ' <span style="color:#9A3A20;font-size:13px">&nbsp;needs attention</span>' : ""}</td></tr>
<tr><td style="padding:22px 24px 8px"><div style="font-size:17px;font-weight:700;margin-bottom:14px">${escapeHtml(subject)}</div>${body}</td></tr>
<tr><td style="padding:0 24px 24px">${button}</td></tr></table>
<div style="font-size:12px;color:#8F7966;margin-top:12px">You get this because you're on a Delegiq team. Change how often in Settings.</div>
</td></tr></table></body></html>`;
}

async function send(appUrl: string, from: string) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return { sent: 0, note: "RESEND_API_KEY is not set yet" };
  const { data: rows, error } = await sb.from("notifications").select("id,to_email,subject,body,urgent,kind")
    .is("sent_at", null).eq("digest", false).lt("attempts", 5).order("id").limit(40);
  if (error) throw error;
  let sent = 0;
  for (const n of (rows ?? []) as Note[]) {
    const text = n.body.replaceAll("{{app}}", appUrl);
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [n.to_email], subject: n.subject, text, html: html(n.subject, text, n.urgent) }),
    });
    if (res.ok) {
      await sb.from("notifications").update({ sent_at: new Date().toISOString(), error: null }).eq("id", n.id);
      sent++;
    } else {
      const msg = (await res.text()).slice(0, 500);
      const { data: cur } = await sb.from("notifications").select("attempts").eq("id", n.id).single();
      await sb.from("notifications").update({ attempts: (cur?.attempts ?? 0) + 1, error: `${res.status} ${msg}` }).eq("id", n.id);
    }
    await sleep(600); // stay under Resend's rate limit
  }
  return { sent, queued: rows?.length ?? 0 };
}

// ---------- digests ----------
function localParts(tz: string) {
  const now = new Date();
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(now));
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(now);
  return { day, hour, weekday };
}
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const fmt = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

function dailyBody(tasks: Task[], people: Member[], today: string, appUrl: string) {
  const name = (id: string | null) => people.find((p) => p.id === id)?.name ?? "Unassigned";
  const open = tasks.filter((t) => t.status !== "done");
  const late = open.filter((t) => days(today, t.deadline) < 0).sort((a, b) => a.deadline.localeCompare(b.deadline));
  const dueToday = open.filter((t) => t.deadline === today);
  const soon = open.filter((t) => { const d = days(today, t.deadline); return d >= 1 && d <= 2; });
  const blocked = open.filter((t) => t.status === "blocked");
  const doneY = tasks.filter((t) => t.completed_at && days(t.completed_at.slice(0, 10), today) === 1);
  const line = (t: Task, extra = "") => `- ${t.title} — ${name(t.assignee_id)}${extra}`;
  const parts = [
    `Late (${late.length})`, ...(late.length ? late.map((t) => { const n = -days(today, t.deadline); return line(t, `, ${n} day${n === 1 ? "" : "s"} late`); }) : ["- None"]), "",
    `Due today (${dueToday.length})`, ...(dueToday.length ? dueToday.map((t) => line(t, `, ${STATUS[t.status]}`)) : ["- None"]), "",
    `Due in the next 2 days (${soon.length})`, ...(soon.length ? soon.map((t) => line(t, `, due ${fmt(t.deadline)}`)) : ["- None"]), "",
    `Blocked (${blocked.length})`, ...(blocked.length ? blocked.map((t) => line(t)) : ["- None"]), "",
    `Finished yesterday (${doneY.length})`, ...(doneY.length ? doneY.map((t) => line(t)) : ["- None"]), "",
    "Open tasks per person",
    ...people.filter((p) => p.status === "active" || p.status === "invited").map((p) => `- ${p.name}: ${open.filter((t) => t.assignee_id === p.id).length} of ${p.max_open}`),
    "", `See everything: ${appUrl}/overview`,
  ];
  return { body: parts.join("\n"), late: late.length, dueToday: dueToday.length, blocked: blocked.length };
}

function weeklyBody(tasks: Task[], people: Member[], today: string, appUrl: string) {
  const rows = people.filter((p) => p.status !== "removed").map((p) => {
    const mine = tasks.filter((t) => t.assignee_id === p.id);
    const done = mine.filter((t) => t.completed_at && days(t.completed_at.slice(0, 10), today) <= 7);
    const onTime = done.filter((t) => t.completed_at!.slice(0, 10) <= t.deadline).length;
    const lateOpen = mine.filter((t) => t.status !== "done" && days(today, t.deadline) < 0).length;
    return `- ${p.name}: ${done.length} done${done.length ? ` (${Math.round((onTime / done.length) * 100)}% on time)` : ""}, ${lateOpen} late, ${mine.filter((t) => t.status !== "done").length} open`;
  });
  return ["Last 7 days, per person:", ...rows, "", `Full report: ${appUrl}/reports`].join("\n");
}

async function digests(appUrl: string) {
  const { data: wss } = await sb.from("workspaces").select("id,name,timezone");
  const made: string[] = [];
  for (const ws of wss ?? []) {
    const { day, hour, weekday } = localParts(ws.timezone);
    if (hour < 8) continue;
    const { error: dup } = await sb.from("digest_runs").insert({ workspace_id: ws.id, day });
    if (dup) continue; // already done today

    const { data: people } = await sb.from("members").select("id,name,email,role,team,status,max_open,notify_mode,level,rights").eq("workspace_id", ws.id);
    const since = new Date(Date.now() - 8 * 864e5).toISOString();
    const { data: tasks } = await sb.from("tasks").select("id,title,status,priority,deadline,assignee_id,completed_at")
      .eq("workspace_id", ws.id).or(`status.neq.done,completed_at.gte."${since}"`);
    const all = (people ?? []) as Member[], ts = (tasks ?? []) as Task[];
    const rows: Record<string, unknown>[] = [];

    // summaries go to people with right 9 (everyone) or right 2 (the people below them in their team)
    for (const boss of all.filter((p) => p.status === "active" && (p.rights.includes(9) || (p.rights.includes(2) && p.team)))) {
      const everyone = boss.rights.includes(9);
      const team = everyone ? all : all.filter((p) => p.team === boss.team && p.level < boss.level);
      if (!team.length) continue;
      const ids = new Set(team.map((p) => p.id));
      const mine = everyone ? ts : ts.filter((t) => t.assignee_id && ids.has(t.assignee_id));
      const d = dailyBody(mine, team, day, appUrl);
      rows.push({ workspace_id: ws.id, member_id: boss.id, to_email: boss.email, kind: "daily", urgent: false,
        subject: `${ws.name} today: ${d.late} late, ${d.dueToday} due, ${d.blocked} blocked`, body: d.body });
      if (weekday === "Mon" && (everyone || boss.rights.includes(6))) {
        rows.push({ workspace_id: ws.id, member_id: boss.id, to_email: boss.email, kind: "weekly", urgent: false,
          subject: `${ws.name}: weekly report`, body: weeklyBody(mine, team, day, appUrl) });
      }
    }

    // people who chose one summary a day get their queued messages bundled
    const { data: queued } = await sb.from("notifications").select("id,member_id,to_email,subject,body")
      .eq("workspace_id", ws.id).eq("digest", true).is("sent_at", null).order("id");
    const byMember = new Map<string, { email: string; items: { id: number; subject: string; body: string }[] }>();
    for (const q of queued ?? []) {
      const g = byMember.get(q.member_id) ?? { email: q.to_email, items: [] };
      g.items.push(q);
      byMember.set(q.member_id, g);
    }
    for (const [mid, g] of byMember) {
      rows.push({ workspace_id: ws.id, member_id: mid, to_email: g.email, kind: "summary", urgent: false,
        subject: `Your Delegiq summary: ${g.items.length} update${g.items.length > 1 ? "s" : ""}`,
        body: g.items.map((i) => `${i.subject}\n${i.body}`).join("\n\n———\n\n") });
      await sb.from("notifications").update({ sent_at: new Date().toISOString(), error: "bundled into daily summary" }).in("id", g.items.map((i) => i.id));
    }
    if (rows.length) await sb.from("notifications").insert(rows);
    made.push(`${ws.name}: ${rows.length}`);
  }
  return made;
}

Deno.serve(async (req) => {
  const { data: ok } = await sb.rpc("cron_token_ok", { t: req.headers.get("x-cron-token") ?? "" });
  if (!ok) return new Response("Forbidden", { status: 403 });
  try {
    const job = new URL(req.url).searchParams.get("job") ?? "send";
    const { appUrl, from, waTemplate, waVersion } = await settings();
    const digestResult = job === "hourly" ? await digests(appUrl) : [];
    const sendResult = await send(appUrl, from);
    const waResult = await sendWhatsApp(appUrl, waTemplate, waVersion);
    return Response.json({ job, digests: digestResult, ...sendResult, ...waResult });
  } catch (e) {
    console.error(e);
    return Response.json({ error: String(e) }, { status: 500 });
  }
});
