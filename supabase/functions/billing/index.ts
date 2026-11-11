// Lemon Squeezy webhook: keeps each company's plan in sync with what they pay for.
// In Lemon Squeezy → Settings → Webhooks, point a webhook at this function's URL with the
// subscription_* events ticked, and put the same signing secret in the Supabase secret LEMONSQUEEZY_WEBHOOK_SECRET.
import { createClient } from "npm:@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const enc = new TextEncoder();

async function hmacHex(secret: string, body: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}
function sameText(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const say = (msg: string, status = 200) => new Response(JSON.stringify({ msg }), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return say("Use POST", 405);
  const secret = Deno.env.get("LEMONSQUEEZY_WEBHOOK_SECRET");
  if (!secret) return say("Webhook secret not set", 500);

  const raw = await req.text();
  const given = (req.headers.get("X-Signature") ?? "").toLowerCase();
  if (!given || !sameText(await hmacHex(secret, raw), given)) return say("Bad signature", 401);

  let evt: any;
  try { evt = JSON.parse(raw); } catch { return say("Bad JSON", 400); }
  const name = String(evt?.meta?.event_name ?? "");
  const data = evt?.data;
  // Only subscription objects change a company's plan; invoices and orders are ignored.
  if (!name.startsWith("subscription_") || data?.type !== "subscriptions") return say("ignored");

  const ws = String(evt?.meta?.custom_data?.workspace_id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(ws)) return say("No workspace_id in custom data", 200);

  const a = data.attributes ?? {};
  const { data: result, error } = await admin.rpc("svc_apply_subscription", {
    p_ws: ws,
    p_variant: a.variant_id ?? null,
    p_status: String(a.status ?? ""),
    p_customer: a.customer_id ?? null,
    p_sub: Number(data.id) || null,
    p_renews: a.renews_at ?? null,
    p_ends: a.ends_at ?? null,
    p_portal: a.urls?.customer_portal ?? null,
  });
  if (error) { console.error(error); return say("Database error", 500); }
  return say(String(result));
});
