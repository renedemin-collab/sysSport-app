// Admin actions that need the auth admin API: lock, unlock, reset access.
// Does its own auth check (caller must be an active admin).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const newCode = () => {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const b = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(b, (x) => a[x % a.length]).join("");
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = Deno.env.get("SUPABASE_URL")!;
  const svc = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Nicht angemeldet" }, 401);
  const { data: who } = await svc.auth.getUser(token);
  if (!who?.user) return json({ error: "Nicht angemeldet" }, 401);
  const { data: me } = await svc.from("profiles").select("role, active").eq("id", who.user.id).maybeSingle();
  if (!me || !me.active || me.role !== "admin") return json({ error: "Keine Berechtigung" }, 403);

  let body: { action?: string; id?: string };
  try { body = await req.json(); } catch { return json({ error: "Ungültige Anfrage" }, 400); }
  const id = String(body.id || "");
  if (!id) return json({ error: "Trainer fehlt" }, 400);
  if (id === who.user.id) return json({ error: "Das eigene Konto kann hier nicht geändert werden" }, 400);
  const { data: p } = await svc.from("profiles").select("*").eq("id", id).maybeSingle();
  if (!p) return json({ error: "Trainer nicht gefunden" }, 404);

  if (body.action === "lock") {
    await svc.auth.admin.updateUserById(id, { ban_duration: "876000h" });
    await svc.from("profiles").update({ active: false }).eq("id", id);
    return json({ ok: true });
  }
  if (body.action === "unlock") {
    await svc.auth.admin.updateUserById(id, { ban_duration: "none" });
    await svc.from("profiles").update({ active: true }).eq("id", id);
    return json({ ok: true });
  }
  if (body.action === "reset") {
    // Remove the account and issue a fresh invite code; trainer sets a new password.
    const code = newCode();
    await svc.from("invites").upsert({ email: p.email, name: p.name, role: p.role, zeiterfassung: p.zeiterfassung, code, used_at: null });
    const { error } = await svc.auth.admin.deleteUser(id);
    if (error) return json({ error: "Zurücksetzen fehlgeschlagen" }, 500);
    return json({ ok: true, code });
  }
  return json({ error: "Unbekannte Aktion" }, 400);
});
