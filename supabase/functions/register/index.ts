// First login for invited trainers: email + one-time invite code + chosen password.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Nur POST" }, 405);
  let body: { email?: string; code?: string; password?: string };
  try { body = await req.json(); } catch { return json({ error: "Ungültige Anfrage" }, 400); }
  const email = String(body.email || "").trim().toLowerCase();
  const code = String(body.code || "").trim().toUpperCase();
  const password = String(body.password || "");
  if (!email || !code) return json({ error: "E-Mail und Code angeben" }, 400);
  if (password.length < 10) return json({ error: "Passwort muss mindestens 10 Zeichen haben" }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  const { data: inv } = await admin.from("invites").select("email, code, used_at").eq("email", email).maybeSingle();
  // Same answer for unknown email and wrong code
  if (!inv || inv.used_at || inv.code !== code) return json({ error: "E-Mail oder Code stimmt nicht" }, 403);

  const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) return json({ error: "Konto konnte nicht angelegt werden" }, 500);
  return json({ ok: true });
});
