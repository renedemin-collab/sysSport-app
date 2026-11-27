/* sysSport Trainer App
   Data flow: Make pushes Virtuagym / HubSpot / Google Calendar snapshots into Supabase (table "snapshots").
   This app only reads from Supabase; every row is protected by Row Level Security (active trainers only). */
(() => {
"use strict";
const TZ = "Europe/Berlin";
const cfg = window.APP_CONFIG;
const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: "syssport-auth" }
});

const HUBSPOT_PORTAL = "26748921";
const DEAL_STAGES = { "5393823959": ["In Durchführung", "live"], "5381690591": ["Termin bestätigt", "ok"],
  "5381716172": ["Angebot angenommen", "ok"], "128535245": ["Angebot raus", "soon"], "128535244": ["Anfrage", "muted"] };
const LEAD = {
  "Probeterim vereinbart": ["Termin vereinbart", "soon"], "Probetraining absolviert": ["Absolviert", "ok"],
  "Abgesagt": ["Abgesagt", "muted"], "Nicht erschienen": ["Nicht erschienen", "warn"],
  "ATTEMPTED_TO_CONTACT": ["Mail nach Probetraining", "ok"], "UNQUALIFIED": ["Nicht qualifiziert", "muted"],
  "Vertrag zugesendet": ["Vertrag zugesendet", "live"], "Kontakt verloren": ["Kontakt verloren", "muted"],
  "Kunde geworden": ["Kunde geworden", "live"], "BAD_TIMING": ["Später vielleicht", "muted"],
  "NEW": ["Neu", "soon"], "OPEN": ["Offen", "soon"], "CONNECTED": ["Kontakt aufgenommen", "ok"],
  "IN_PROGRESS": ["In Bearbeitung", "ok"], "OPEN_DEAL": ["Offener Deal", "ok"]
};
const ZE = { timetrack: "Timetrack", crewmaster: "Crewmaster" };

const state = {
  authDraft: null, session: null, me: null, route: "heute", authMode: "login", authBusy: false, authMsg: null,
  snaps: {}, links: [], docs: [], settings: {}, loading: true, err: null,
  open: new Set(), dayFilter: "alle", trainer: "alle", probeTab: "an", wsTab: "termine", docQ: "", docCat: "Alle",
  admin: { profiles: [], invites: [], loaded: false, lastCode: null }, confirmDel: null, busy: {}
};

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
}
const fDay = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "short", day: "2-digit", month: "2-digit" });
const fDayLong = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" });
const fTime = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const fKey = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const dayKey = ts => fKey.format(new Date(ts));
const todayKey = () => dayKey(Date.now());
const addDaysKey = (key, n) => { const d = new Date(key + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const keyLabel = key => { const t = todayKey(); if (key === t) return "Heute"; if (key === addDaysKey(t, 1)) return "Morgen"; if (key === addDaysKey(t, -1)) return "Gestern"; return fDay.format(new Date(key + "T12:00:00Z")); };
function ago(ts) {
  if (!ts) return "–";
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "gerade eben"; if (m < 60) return "vor " + m + " Min.";
  const hh = Math.round(m / 60); if (hh < 24) return "vor " + hh + " Std.";
  return fDay.format(new Date(ts)) + " " + fTime.format(new Date(ts));
}
let toastT;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 2800); }
const safeUrl = u => typeof u === "string" && /^https:\/\//i.test(u.trim()) ? u.trim() : null;
const isAdmin = () => state.me && state.me.role === "admin" && state.me.active;
const parseMaybe = v => { if (typeof v !== "string") return v; try { return JSON.parse(v); } catch { return null; } };
function fmtSize(n) { if (!n) return ""; if (n < 1024 * 1024) return Math.round(n / 1024) + " KB"; return (n / 1024 / 1024).toFixed(1).replace(".", ",") + " MB"; }
function newCode() { const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; return Array.from(crypto.getRandomValues(new Uint8Array(6)), x => a[x % a.length]).join(""); }

/* ---------- shaping of synced data ---------- */
function kurse() {
  const s = state.snaps.kurse; if (!s) return null;
  const j = parseMaybe(s.data) || {};
  const evs = (j.data && j.data.events) || j.events || (Array.isArray(j) ? j : []);
  return evs.filter(e => e && !e.deleted).map(e => {
    const name = (e.activity && e.activity.activity_name) || "Kurs";
    const trial = /probetraining/i.test(name);
    const staff = (e.staff && e.staff.staff_name) || "";
    const people = [];
    for (const p of e.participants || []) if (!p.deleted) people.push({ n: String(p.name || "").replace(/\s+/g, " ").trim(), p: !!p.presence, g: false });
    for (const g of e.guests || []) if (!g.deleted) people.push({ n: String(g.name || "").replace(/\s+/g, " ").trim(), p: !!g.presence, g: true });
    return { id: String(e.event_id), s: Number(e.datetime_start), e: Number(e.datetime_end), name, trial,
      trainer: trial ? "" : staff, variant: trial ? staff : "", cap: e.capacity || 0, left: Math.max(0, e.spots_left || 0),
      loc: (e.location && e.location.location_name) || "", people };
  }).filter(e => e.s).sort((a, b) => a.s - b.s);
}
function trials() {
  const s = state.snaps.probe; if (!s) return null;
  const j = parseMaybe(s.data) || {};
  return (j.results || []).map(r => {
    const p = r.properties || {};
    return { id: String(r.id), name: [p.firstname, p.lastname].filter(Boolean).join(" ").trim() || "Ohne Namen",
      date: (p.datum_probetraining || "").slice(0, 10), time: p.uhrzeit_probetraining || "", status: p.hs_lead_status || "",
      interest: p.interesse_sport || "", phone: p.mobilephone || p.phone || "" };
  }).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}
function teamName(email) {
  const local = String(email || "").toLowerCase().split("@")[0];
  const first = local.split(/[._\d-]/)[0];
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : "";
}
function isGymClass(ev) {
  const room = (ev.attendees || []).some(a => /resource\.calendar\.google\.com/.test(a.email || ""));
  const atGym = /sysSport Coaching|Boxgym|Institut-1/i.test(ev.location || "");
  const school = /boxcoaching|workshop|schule|projekttag|\bMS\b|\bGS\b|\bBS\b|SFZ|I\.W\./i.test(ev.summary || "");
  return (room || atGym) && !school;
}
function schulTermine() {
  const s = state.snaps.schulen; if (!s) return null;
  const j = parseMaybe(s.data) || {};
  const items = Array.isArray(j) ? j : (j.items || j.events || []);
  return items.filter(ev => ev && ev.status !== "cancelled" && !isGymClass(ev)).map(ev => {
    const st = ev.start || {}, en = ev.end || {};
    const allDay = !st.dateTime;
    const s0 = allDay ? Date.parse((st.date || "") + "T00:00:00") : Date.parse(st.dateTime);
    const e0 = allDay ? Date.parse((en.date || "") + "T00:00:00") : Date.parse(en.dateTime);
    const team = [...new Set((ev.attendees || []).filter(a => !/resource\.calendar/.test(a.email || "")).map(a => a.displayName || teamName(a.email)).filter(Boolean))];
    return { id: String(ev.id), s: s0, e: e0, allDay, title: String(ev.summary || "Termin").trim(), loc: String(ev.location || "").trim(), team };
  }).filter(e => !isNaN(e.s)).sort((a, b) => a.s - b.s);
}
function deals() {
  const s = state.snaps.deals; if (!s) return null;
  const j = parseMaybe(s.data) || {};
  return (j.results || []).map(r => { const p = r.properties || {};
    return { id: String(r.id), name: String(p.dealname || "Auftrag").trim(), stage: p.dealstage || "", termine: p.termine_workshops || "",
      cls: p.workshopteilnahmerart || "", tn: p.workshoptnanzahl || "" }; });
}
const snapTime = k => state.snaps[k] ? Date.parse(state.snaps[k].updated_at) : 0;

/* ---------- data loading ---------- */
async function loadAll() {
  state.loading = true; state.err = null; paint();
  const [me, snaps, links, docs, settings] = await Promise.all([
    sb.from("profiles").select("*").eq("id", state.session.user.id).maybeSingle(),
    sb.from("snapshots").select("kind, data, updated_at"),
    sb.from("links").select("*").order("sort").order("title"),
    sb.from("documents").select("*").order("category").order("title"),
    sb.from("app_settings").select("*")
  ]);
  state.me = me.data || null;
  if (!state.me || !state.me.active) { state.loading = false; paint(); return; }
  const firstErr = [snaps, links, docs, settings].find(r => r.error);
  if (firstErr) state.err = "Daten konnten nicht geladen werden (" + firstErr.error.message + ").";
  state.snaps = Object.fromEntries((snaps.data || []).map(r => [r.kind, r]));
  state.links = links.data || [];
  state.docs = docs.data || [];
  state.settings = Object.fromEntries((settings.data || []).map(r => [r.key, r.value]));
  state.loading = false; paint();
  if (isAdmin() && state.route === "mehr") loadAdmin();
}
async function loadAdmin() {
  const [p, i] = await Promise.all([
    sb.from("profiles").select("*").order("name"),
    sb.from("invites").select("*").is("used_at", null).order("created_at", { ascending: false })
  ]);
  state.admin.profiles = p.data || []; state.admin.invites = i.data || []; state.admin.loaded = true; paint();
}

/* ---------- auth ---------- */
function viewAuth() {
  const m = state.authMode;
  const msg = state.authMsg ? h("p", { class: "note " + (state.authMsg.ok ? "ok" : "err") }, state.authMsg.text) : null;
  const form = h("form", { class: "box", novalidate: true },
    h("label", { class: "f" }, "E-Mail", h("input", { type: "email", id: "aEmail", autocomplete: "username", required: true, inputmode: "email", value: (state.authDraft && state.authDraft.email) || "" })),
    m === "register" ? h("label", { class: "f" }, "Einladungscode (von René)", h("input", { type: "text", id: "aCode", autocomplete: "one-time-code", autocapitalize: "characters", required: true, maxlength: 12, style: "text-transform:uppercase;letter-spacing:.12em", value: (state.authDraft && state.authDraft.code) || "" })) : null,
    h("label", { class: "f" }, m === "register" ? "Neues Passwort (mind. 10 Zeichen)" : "Passwort",
      h("input", { type: "password", id: "aPass", autocomplete: m === "register" ? "new-password" : "current-password", required: true, minlength: m === "register" ? 10 : null })),
    h("button", { class: "btn cta big", type: "submit", disabled: state.authBusy }, state.authBusy ? "Moment …" : (m === "register" ? "Zugang einrichten" : "Anmelden")));
  form.addEventListener("submit", async e => {
    e.preventDefault();
    // Read every field before repainting (paint() rebuilds the form).
    const email = $("#aEmail").value.trim().toLowerCase(), pass = $("#aPass").value;
    const code = ($("#aCode") ? $("#aCode").value : "").trim().toUpperCase();
    state.authDraft = { email, code };
    if (!email || !pass || (m === "register" && !code)) { state.authMsg = { text: m === "register" ? "Bitte E-Mail, Code und Passwort eingeben." : "Bitte E-Mail und Passwort eingeben." }; paint(); return; }
    if (m === "register" && pass.length < 10) { state.authMsg = { text: "Das Passwort braucht mindestens 10 Zeichen." }; paint(); return; }
    state.authBusy = true; state.authMsg = null; paint();
    try {
      if (m === "register") {
        const r = await fetch(cfg.supabaseUrl + "/functions/v1/register", { method: "POST",
          headers: { "Content-Type": "application/json", apikey: cfg.supabaseKey }, body: JSON.stringify({ email, code, password: pass }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || "Einrichten fehlgeschlagen");
      }
      const { error } = await sb.auth.signInWithPassword({ email, password: pass });
      if (error) throw new Error(/invalid/i.test(error.message) ? "E-Mail oder Passwort stimmt nicht." : /banned/i.test(error.message) ? "Dieser Zugang ist gesperrt." : error.message);
    } catch (err) { state.authMsg = { text: err.message || String(err) }; }
    state.authBusy = false; paint();
  });
  return h("div", { class: "auth-wrap" },
    h("h1", null, "sysSport ", h("span", null, "Trainer")),
    h("p", { class: "sub", style: "margin-top:8px" }, "Interne App für das Trainer-Team. Zugang nur mit Einladung."),
    h("div", { class: "seg", role: "group", "aria-label": "Anmeldung" },
      h("button", { type: "button", "aria-pressed": m === "login" ? "true" : "false", onclick: () => { state.authMode = "login"; state.authMsg = null; paint(); } }, "Anmelden"),
      h("button", { type: "button", "aria-pressed": m === "register" ? "true" : "false", onclick: () => { state.authMode = "register"; state.authMsg = null; paint(); } }, "Erstes Mal hier")),
    msg, form,
    h("p", { class: "sub", style: "margin-top:16px" }, m === "register"
      ? "Den Einladungscode bekommst du von René. Danach meldest du dich nur noch mit E-Mail und Passwort an."
      : "Passwort vergessen? René kann deinen Zugang zurücksetzen und dir einen neuen Code geben."));
}

/* ---------- shared view parts ---------- */
function noData(kind) {
  if (state.loading) return h("div", { class: "list" }, [1, 2, 3].map(() => h("div", { class: "skel" })));
  return h("p", { class: "empty" }, "Noch keine Daten – der automatische Abgleich (" + kind + ") ist noch nicht gelaufen.");
}
function evStatus(ev, now = Date.now()) {
  if (now >= ev.s && now < ev.e) return ["Läuft", "live"];
  if (ev.s > now && ev.s - now < 60 * 60000) return ["In " + Math.max(1, Math.round((ev.s - now) / 60000)) + " Min.", "soon"];
  if (now >= ev.e) return ["Vorbei", "muted"];
  if (ev.left === 0 && ev.cap) return ["Ausgebucht", "warn"];
  return ["Geplant", "muted"];
}
const booked = ev => Math.max(ev.people.length, ev.cap - ev.left);
function eventCard(ev, showDay) {
  const [st, cls] = evStatus(ev);
  const b = booked(ev), pct = ev.cap ? Math.min(100, Math.round(b / ev.cap * 100)) : 0;
  const isOpen = state.open.has(ev.id);
  const sub = ev.trial ? ["Probetraining", ev.variant].filter(Boolean).join(" · ") : [ev.trainer, ev.loc].filter(Boolean).join(" · ");
  const card = h("div", { class: "card" + (Date.now() >= ev.e ? " past" : "") },
    h("button", { class: "card-head", type: "button", "aria-expanded": isOpen ? "true" : "false",
      onclick: () => { isOpen ? state.open.delete(ev.id) : state.open.add(ev.id); paint(); } },
      h("div", { class: "time" }, fTime.format(new Date(ev.s)), h("small", null, showDay ? keyLabel(dayKey(ev.s)) : "bis " + fTime.format(new Date(ev.e)))),
      h("div", { style: "min-width:0" }, h("div", { class: "ttl" }, ev.name), h("div", { class: "sub" }, sub || "–")),
      h("div", { class: "right" }, h("div", { class: "occ" }, String(b), h("span", null, "/" + ev.cap)), h("span", { class: "pill " + cls }, st)),
      h("div", { class: "meter", "aria-hidden": "true" }, h("i", { class: pct >= 100 ? "full" : "", style: "width:" + pct + "%" }))));
  if (isOpen) {
    const ppl = h("div", { class: "people" });
    if (!ev.people.length) ppl.append(h("div", { class: "sub" }, "Noch keine Anmeldungen."));
    for (const p of ev.people) ppl.append(h("div", { class: "person" },
      h("span", { class: "mark" + (p.p ? " yes" : ""), "aria-label": p.p ? "anwesend" : "nicht abgehakt" }, p.p ? "✓" : ""),
      h("span", { class: "nm" }, p.n || "–"), p.g ? h("span", { class: "tag" }, "Probe") : null));
    card.append(ppl);
  }
  return card;
}
function wsCard(w) {
  const time = w.allDay ? "Ganztags" : fTime.format(new Date(w.s));
  return h("div", { class: "ws" + (w.e < Date.now() ? " past" : "") },
    h("div", { class: "time" }, w.allDay ? h("small", { style: "margin:0" }, "Ganztags") : time, h("small", null, keyLabel(dayKey(w.s)))),
    h("div", { class: "ttl" }, w.title),
    w.loc ? h("div", { class: "loc" }, h("a", { href: "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(w.loc), target: "_blank", rel: "noopener" }, w.loc)) : null,
    w.team.length ? h("div", { class: "team" }, w.team.map(n => h("span", null, n))) : null);
}
function trialCard(l) {
  const [st, cls] = LEAD[l.status] || [l.status || "–", "muted"];
  const tel = l.phone ? l.phone.replace(/[^\d+]/g, "") : "";
  return h("div", { class: "lead" },
    h("div", { class: "head" },
      h("div", { style: "min-width:0" }, h("div", { class: "when" }, keyLabel(l.date) + (l.time ? ", " + l.time : "")), h("div", { class: "ttl" }, l.name),
        l.interest ? h("div", { class: "sub" }, l.interest) : null),
      h("span", { class: "pill " + cls }, st)),
    tel ? h("div", { class: "actions" }, h("a", { class: "btn", href: "tel:" + tel }, "Anrufen"), h("a", { class: "btn", href: "https://wa.me/" + tel.replace(/^\+/, "").replace(/^0/, "49") , target: "_blank", rel: "noopener" }, "WhatsApp")) : null);
}
const upcomingTrials = () => (trials() || []).filter(l => l.date >= todayKey() && l.status !== "Abgesagt");
function zeitButton() {
  const z = state.me && state.me.zeiterfassung;
  if (!z) return null;
  const url = safeUrl(state.settings[z + "_url"]);
  if (!url) return h("p", { class: "note" }, "Zeiterfassung: " + ZE[z] + " (Link ist noch nicht hinterlegt).");
  return h("a", { class: "btn cta big", href: url, target: "_blank", rel: "noopener", style: "margin-top:16px" }, "Zeiterfassung · " + ZE[z]);
}
function tile(l, cls) {
  return h("a", { class: "tile" + (cls ? " " + cls : ""), href: safeUrl(l.url), target: "_blank", rel: "noopener" },
    h("div", null, h("div", { class: "t" }, l.title), l.note ? h("div", { class: "n" }, l.note) : null), h("div", { class: "sub", style: "color:inherit;opacity:.8;font-weight:800;font-size:11px;letter-spacing:.1em;text-transform:uppercase" }, "Öffnen →"));
}

/* ---------- views ---------- */
function viewHeute() {
  const t = todayKey(), now = Date.now();
  const ks = kurse(), tr = trials(), ws = schulTermine();
  const todayK = (ks || []).filter(e => dayKey(e.s) === t && !e.trial);
  const trialsToday = (tr || []).filter(l => l.date === t && l.status !== "Abgesagt");
  const wsToday = (ws || []).filter(w => dayKey(w.s) === t || (w.allDay && w.s <= now && w.e > now));
  const ha = state.links.filter(l => l.cat === "ha");
  const v = [h("h1", null, "Hallo " + ((state.me && state.me.name) || "") + "!"), h("p", { class: "sub", style: "margin:6px 0 0" }, fDayLong.format(new Date()))];
  v.push(zeitButton());
  v.push(h("div", { class: "stats" },
    [["#gym", todayK.length, "Kurse im Gym heute"], ["#probe", trialsToday.length, "Probetrainings heute"],
     ["#schulen", wsToday.length, "Schul-Termine heute"], ["#probe", upcomingTrials().filter(l => l.date <= addDaysKey(t, 7)).length, "Probetrainings 7 Tage"]]
      .map(([href, n, l]) => h("a", { class: "stat", href }, h("span", { class: "bar" }), h("div", null, h("div", { class: "num" }, String(n)), h("div", { class: "lbl" }, l))))));
  v.push(h("div", { class: "kicker" }, "Als Nächstes im Gym"));
  if (!ks) v.push(noData("Virtuagym"));
  else { const next = todayK.filter(e => e.e > now); v.push(next.length ? h("div", { class: "list" }, next.map(e => eventCard(e))) : h("p", { class: "empty" }, "Heute keine Kurse mehr.")); }
  if (trialsToday.length) { v.push(h("div", { class: "kicker" }, "Probetrainings heute")); v.push(h("div", { class: "list" }, trialsToday.map(trialCard))); }
  if (wsToday.length) { v.push(h("div", { class: "kicker" }, "An Schulen heute")); v.push(h("div", { class: "list" }, wsToday.map(wsCard))); }
  if (ha.length) { v.push(h("div", { class: "kicker" }, "Home Assistant")); v.push(h("div", { class: "tiles" }, ha.map(l => tile(l, "ha")))); }
  return v;
}
function viewGym() {
  const ks = kurse();
  const v = [h("h1", null, "Kurse im Gym")];
  if (!ks) return v.concat(noData("Virtuagym"));
  const t = todayKey();
  const days = [...new Set(ks.map(e => dayKey(e.s)))].filter(d => d >= t);
  const trainers = [...new Set(ks.map(e => e.trainer).filter(Boolean))].sort();
  v.push(h("div", { class: "chips", role: "group", "aria-label": "Tag" },
    ["alle", ...days].map(d => h("button", { class: "chip", type: "button", "aria-pressed": state.dayFilter === d ? "true" : "false",
      onclick: () => { state.dayFilter = d; paint(); } }, d === "alle" ? "Alle Tage" : keyLabel(d)))));
  const sel = h("select", { "aria-label": "Trainer filtern", style: "margin-top:8px", onchange: e => { state.trainer = e.target.value; paint(); } },
    h("option", { value: "alle" }, "Alle Trainer"), trainers.map(x => h("option", { value: x }, x)));
  sel.value = trainers.includes(state.trainer) ? state.trainer : "alle";
  v.push(sel);
  let list = ks.filter(e => dayKey(e.s) >= t && !e.trial);
  if (state.dayFilter !== "alle") list = list.filter(e => dayKey(e.s) === state.dayFilter);
  if (sel.value !== "alle") list = list.filter(e => e.trainer === sel.value);
  if (!list.length) v.push(h("p", { class: "empty", style: "margin-top:12px" }, "Keine Kurse für diese Auswahl."));
  let cur = null;
  for (const e of list) {
    const k = dayKey(e.s);
    if (k !== cur) { cur = k; v.push(h("div", { class: "day" }, keyLabel(k) === fDay.format(new Date(e.s)) ? keyLabel(k) : keyLabel(k) + " · " + fDay.format(new Date(e.s)))); }
    v.push(h("div", { style: "margin-bottom:8px" }, eventCard(e)));
  }
  v.push(h("p", { class: "sub", style: "margin-top:16px" }, "Stand Virtuagym: " + ago(snapTime("kurse")) + ". Tippen zeigt die Teilnehmer."));
  return v;
}
function viewSchulen() {
  const ws = schulTermine(), ds = deals();
  const v = [h("h1", null, "Kurse an Schulen")];
  v.push(h("div", { class: "chips", role: "group" },
    [["termine", "Termine"], ["auftraege", "Aufträge"]].map(([k, l]) => h("button", { class: "chip", type: "button", "aria-pressed": state.wsTab === k ? "true" : "false",
      onclick: () => { state.wsTab = k; paint(); } }, l))));
  if (state.wsTab === "termine") {
    if (!ws) return v.concat(noData("Google Kalender"));
    const now = Date.now();
    const list = ws.filter(w => w.e > now - 12 * 3600e3);
    if (!list.length) v.push(h("p", { class: "empty", style: "margin-top:12px" }, "Keine Schul-Termine in den nächsten Wochen."));
    let cur = null;
    for (const w of list) {
      const k = dayKey(w.s);
      if (k !== cur) { cur = k; v.push(h("div", { class: "day" }, keyLabel(k))); }
      v.push(h("div", { style: "margin-bottom:8px" }, wsCard(w)));
    }
    v.push(h("p", { class: "sub", style: "margin-top:16px" }, "Stand Kalender: " + ago(snapTime("schulen")) + "."));
  } else {
    if (!ds) return v.concat(noData("HubSpot"));
    const order = Object.keys(DEAL_STAGES);
    const list = ds.slice().sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage));
    v.push(h("div", { class: "list", style: "margin-top:12px" }, list.map(d => {
      const [st, cls] = DEAL_STAGES[d.stage] || ["–", "muted"];
      return h("div", { class: "lead" }, h("div", { class: "head" }, h("div", { style: "min-width:0" }, h("div", { class: "ttl" }, d.name),
        h("div", { class: "sub" }, [d.cls, d.tn ? d.tn + " TN" : ""].filter(Boolean).join(" · "))), h("span", { class: "pill " + cls }, st)),
        d.termine ? h("div", { class: "sub" }, d.termine) : null,
        isAdmin() ? h("div", { class: "actions" }, h("a", { class: "btn small", href: "https://app.hubspot.com/contacts/" + HUBSPOT_PORTAL + "/record/0-3/" + encodeURIComponent(d.id), target: "_blank", rel: "noopener" }, "In HubSpot öffnen")) : null);
    })));
  }
  return v;
}
function viewProbe() {
  const tr = trials();
  const v = [h("h1", null, "Probeschüler")];
  if (!tr) return v.concat(noData("HubSpot"));
  const t = todayKey();
  v.push(h("div", { class: "chips", role: "group" },
    [["an", "Kommen noch"], ["war", "Waren da (30 Tage)"]].map(([k, l]) => h("button", { class: "chip", type: "button", "aria-pressed": state.probeTab === k ? "true" : "false",
      onclick: () => { state.probeTab = k; paint(); } }, l))));
  const list = state.probeTab === "an" ? tr.filter(l => l.date >= t && l.status !== "Abgesagt") : tr.filter(l => l.date < t).reverse();
  v.push(list.length ? h("div", { class: "list", style: "margin-top:12px" }, list.map(trialCard)) : h("p", { class: "empty", style: "margin-top:12px" }, "Niemand in dieser Liste."));
  v.push(h("p", { class: "sub", style: "margin-top:16px" }, "Stand HubSpot: " + ago(snapTime("probe")) + "."));
  return v;
}
async function openDoc(d) {
  const w = window.open("", "_blank");
  const { data, error } = await sb.storage.from("bibliothek").createSignedUrl(d.file_path, 600);
  if (error || !data) { if (w) w.close(); toast("Datei konnte nicht geöffnet werden"); return; }
  if (w) w.location = data.signedUrl; else location.href = data.signedUrl;
}
function docKind(d) { const x = (d.file_name.split(".").pop() || "").toUpperCase(); return x.length <= 4 ? x : "DATEI"; }
function viewMehr() {
  const v = [h("h1", null, "Bücherei & Tools")];
  // Library
  const cats = ["Alle", ...[...new Set(state.docs.map(d => d.category))].sort()];
  const q = state.docQ.trim().toLowerCase();
  const docs = state.docs.filter(d => (state.docCat === "Alle" || d.category === state.docCat) &&
    (!q || (d.title + " " + (d.note || "") + " " + d.file_name).toLowerCase().includes(q)));
  v.push(h("div", { class: "kicker" }, "Bücherei", h("span", { class: "cnt" }, String(state.docs.length))));
  const search = h("input", { type: "search", id: "docSearch", placeholder: "Unterlage suchen", value: state.docQ, "aria-label": "Unterlagen durchsuchen" });
  search.addEventListener("input", e => { state.docQ = e.target.value; paintKeepFocus("docSearch"); });
  v.push(search);
  if (cats.length > 2) v.push(h("div", { class: "chips" }, cats.map(c => h("button", { class: "chip", type: "button", "aria-pressed": state.docCat === c ? "true" : "false", onclick: () => { state.docCat = c; paint(); } }, c))));
  v.push(h("div", { style: "height:8px" }));
  v.push(docs.length ? h("div", { class: "list" }, docs.map(d => {
    const btn = h("button", { class: "doc", type: "button", onclick: () => openDoc(d) }, h("span", { class: "ic" }, docKind(d)),
      h("div", { class: "body" }, h("div", { class: "t" }, d.title), h("div", { class: "n" }, [d.category, d.note, fmtSize(d.size)].filter(Boolean).join(" · "))));
    if (!isAdmin()) return btn;
    return h("div", { class: "docrow" }, btn, state.confirmDel === d.id
      ? h("button", { class: "btn danger", type: "button", onclick: () => deleteDoc(d) }, "Löschen?")
      : h("button", { class: "del", type: "button", "aria-label": d.title + " löschen", onclick: () => { state.confirmDel = d.id; paint(); } }, "✕"));
  })) : h("p", { class: "empty" }, q ? "Nichts gefunden." : "Noch keine Unterlagen."));
  if (isAdmin()) v.push(uploadForm());
  // Tools
  const z = state.me && state.me.zeiterfassung;
  const tools = state.links.filter(l => l.cat === "tools"), ha = state.links.filter(l => l.cat === "ha");
  v.push(h("div", { class: "kicker" }, "Zeiterfassung"));
  v.push(z ? zeitButton() : h("p", { class: "empty" }, "Für dich ist noch keine Zeiterfassung hinterlegt."));
  v.push(h("div", { class: "kicker" }, "Home Assistant"));
  v.push(ha.length ? h("div", { class: "tiles" }, ha.map(l => tile(l, "ha"))) : h("p", { class: "empty" }, "Noch keine Home-Assistant-Links."));
  if (tools.length) { v.push(h("div", { class: "kicker" }, "Apps & Links")); v.push(h("div", { class: "tiles" }, tools.map(l => tile(l)))); }
  if (isAdmin()) v.push(...adminView());
  v.push(h("div", { class: "kicker" }, "Konto"));
  v.push(h("p", { class: "sub" }, "Angemeldet als " + (state.me ? state.me.email : "")));
  v.push(h("button", { class: "btn", type: "button", style: "margin-top:8px", onclick: async () => { await sb.auth.signOut(); } }, "Abmelden"));
  return v;
}
function uploadForm() {
  const cats = [...new Set(state.docs.map(d => d.category))].sort();
  const dl = h("datalist", { id: "catList" }, cats.map(c => h("option", { value: c })));
  const f = h("form", { class: "box" },
    h("div", { class: "kicker", style: "margin:0" }, "Unterlage hochladen"),
    h("input", { type: "file", id: "upFile", required: true }),
    h("input", { type: "text", id: "upTitle", placeholder: "Titel, z. B. Notfallplan Gym", maxlength: 100 }),
    h("div", { class: "row" }, h("input", { type: "text", id: "upCat", placeholder: "Kategorie, z. B. Abläufe", list: "catList", maxlength: 40 }), dl,
      h("input", { type: "text", id: "upNote", placeholder: "Kurzinfo (optional)", maxlength: 140 })),
    h("button", { class: "btn cta", type: "submit", disabled: !!state.busy.upload }, state.busy.upload ? "Lade hoch …" : "Hochladen"));
  f.addEventListener("submit", async e => {
    e.preventDefault();
    const file = f.querySelector("#upFile").files[0];
    if (!file) { toast("Bitte eine Datei auswählen"); return; }
    if (file.size > 50 * 1024 * 1024) { toast("Datei ist größer als 50 MB"); return; }
    const title = f.querySelector("#upTitle").value.trim() || file.name.replace(/\.[^.]+$/, "");
    const category = f.querySelector("#upCat").value.trim() || "Allgemein";
    const note = f.querySelector("#upNote").value.trim() || null;
    const safe = file.name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w.-]+/g, "_").slice(-80);
    const path = crypto.randomUUID() + "/" + safe;
    state.busy.upload = true; paint();
    const up = await sb.storage.from("bibliothek").upload(path, file, { contentType: file.type || "application/octet-stream" });
    if (up.error) { state.busy.upload = false; toast("Hochladen fehlgeschlagen: " + up.error.message); paint(); return; }
    const ins = await sb.from("documents").insert({ title, category, note, file_path: path, file_name: file.name, mime: file.type, size: file.size, uploaded_by: state.me.id }).select().single();
    state.busy.upload = false;
    if (ins.error) { await sb.storage.from("bibliothek").remove([path]); toast("Speichern fehlgeschlagen"); paint(); return; }
    state.docs.push(ins.data); state.docs.sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
    toast("Hochgeladen – alle Trainer sehen es jetzt"); paint();
  });
  return f;
}
async function deleteDoc(d) {
  state.confirmDel = null;
  const r = await sb.from("documents").delete().eq("id", d.id);
  if (r.error) { toast("Löschen nicht möglich"); paint(); return; }
  await sb.storage.from("bibliothek").remove([d.file_path]);
  state.docs = state.docs.filter(x => x.id !== d.id); toast("Gelöscht"); paint();
}

/* ---------- admin ---------- */
async function adminCall(action, id) {
  const { data: s } = await sb.auth.getSession();
  const r = await fetch(cfg.supabaseUrl + "/functions/v1/admin", { method: "POST",
    headers: { "Content-Type": "application/json", apikey: cfg.supabaseKey, Authorization: "Bearer " + (s.session && s.session.access_token) },
    body: JSON.stringify({ action, id }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "Fehler");
  return j;
}
function shareCode(name, email, code) {
  const appUrl = location.origin + location.pathname;
  const text = "Hallo " + name + "! Dein Zugang zur sysSport Trainer-App:\n" + appUrl + "\nAuf „Erstes Mal hier“ tippen, E-Mail " + email + " und Code " + code + " eingeben und ein Passwort wählen. Danach im Browser-Menü „Zum Startbildschirm hinzufügen“.";
  return h("div", { class: "actions" },
    h("button", { class: "btn small", type: "button", onclick: async () => { try { await navigator.clipboard.writeText(text); toast("Text kopiert"); } catch { toast("Kopieren nicht möglich"); } } }, "Text kopieren"),
    h("a", { class: "btn small", href: "https://wa.me/?text=" + encodeURIComponent(text), target: "_blank", rel: "noopener" }, "Per WhatsApp senden"));
}
function zeSelect(value, onchange) {
  const s = h("select", { "aria-label": "Zeiterfassung", onchange: e => onchange(e.target.value || null) },
    h("option", { value: "" }, "Keine Zeiterfassung"), h("option", { value: "timetrack" }, "Timetrack"), h("option", { value: "crewmaster" }, "Crewmaster"));
  s.value = value || ""; return s;
}
function adminView() {
  const a = state.admin;
  const v = [h("div", { class: "kicker" }, "Admin · Trainer", h("span", { class: "cnt" }, a.loaded ? String(a.profiles.length) : ""))];
  if (!a.loaded) { v.push(h("p", { class: "sub" }, "Lade …")); return v; }
  if (a.lastCode) v.push(h("div", { class: "note ok" }, h("div", null, "Einladungscode für " + a.lastCode.name + ":"), h("div", { class: "code" }, a.lastCode.code), shareCode(a.lastCode.name, a.lastCode.email, a.lastCode.code)));
  v.push(h("div", { class: "list" }, a.profiles.map(p => h("div", { class: "lead" },
    h("div", { class: "head" }, h("div", { style: "min-width:0" }, h("div", { class: "ttl" }, p.name), h("div", { class: "sub" }, p.email)),
      h("span", { class: "pill " + (p.active ? (p.role === "admin" ? "live" : "ok") : "muted") }, p.active ? (p.role === "admin" ? "Admin" : "Trainer") : "Gesperrt")),
    zeSelect(p.zeiterfassung, async val => {
      const r = await sb.from("profiles").update({ zeiterfassung: val }).eq("id", p.id);
      if (r.error) toast("Speichern nicht möglich"); else { p.zeiterfassung = val; if (p.id === state.me.id) state.me.zeiterfassung = val; toast("Gespeichert"); paint(); }
    }),
    p.id === state.me.id ? null : h("div", { class: "actions" },
      h("button", { class: "btn small", type: "button", onclick: async () => {
        try { const j = await adminCall("reset", p.id); a.lastCode = { name: p.name, email: p.email, code: j.code }; await loadAdmin(); toast("Zugang zurückgesetzt"); } catch (e) { toast(e.message); } } }, "Zugang zurücksetzen"),
      h("button", { class: "btn small " + (p.active ? "danger" : ""), type: "button", onclick: async () => {
        try { await adminCall(p.active ? "lock" : "unlock", p.id); await loadAdmin(); toast(p.active ? "Gesperrt" : "Entsperrt"); } catch (e) { toast(e.message); } } }, p.active ? "Sperren" : "Entsperren"))))));
  if (a.invites.length) {
    v.push(h("div", { class: "day" }, "Offene Einladungen"));
    v.push(h("div", { class: "list" }, a.invites.map(i => h("div", { class: "lead" },
      h("div", { class: "head" }, h("div", { style: "min-width:0" }, h("div", { class: "ttl" }, i.name), h("div", { class: "sub" }, i.email)), h("span", { class: "code", style: "font-size:20px" }, i.code)),
      shareCode(i.name, i.email, i.code),
      h("div", { class: "actions" }, h("button", { class: "btn small danger", type: "button", onclick: async () => { await sb.from("invites").delete().eq("email", i.email); loadAdmin(); } }, "Einladung löschen"))))));
  }
  const f = h("form", { class: "box" },
    h("div", { class: "kicker", style: "margin:0" }, "Trainer einladen"),
    h("div", { class: "row" }, h("input", { type: "text", id: "invName", placeholder: "Vorname", required: true, maxlength: 40 }),
      h("input", { type: "email", id: "invEmail", placeholder: "E-Mail", required: true })),
    h("div", { class: "row" }, zeSelect(null, () => {}), h("select", { id: "invRole", "aria-label": "Rolle" }, h("option", { value: "trainer" }, "Trainer"), h("option", { value: "admin" }, "Admin"))),
    h("button", { class: "btn cta", type: "submit" }, "Einladung erstellen"));
  f.querySelector("select").id = "invZe";
  f.addEventListener("submit", async e => {
    e.preventDefault();
    const name = f.querySelector("#invName").value.trim(), email = f.querySelector("#invEmail").value.trim().toLowerCase();
    if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast("Bitte Name und gültige E-Mail angeben"); return; }
    const code = newCode();
    const r = await sb.from("invites").upsert({ email, name, role: f.querySelector("#invRole").value, zeiterfassung: f.querySelector("#invZe").value || null, code, used_at: null });
    if (r.error) { toast("Einladung nicht möglich: " + r.error.message); return; }
    a.lastCode = { name, email, code }; await loadAdmin(); window.scrollTo(0, 0); paint();
  });
  v.push(f);
  // Settings: Zeiterfassung URLs
  const sf = h("form", { class: "box" },
    h("div", { class: "kicker", style: "margin:0" }, "Links Zeiterfassung"),
    h("label", { class: "f" }, "Timetrack-Adresse", h("input", { type: "url", id: "setTT", value: state.settings.timetrack_url || "", placeholder: "https://…" })),
    h("label", { class: "f" }, "Crewmaster-Adresse", h("input", { type: "url", id: "setCM", value: state.settings.crewmaster_url || "", placeholder: "https://…" })),
    h("button", { class: "btn cta", type: "submit" }, "Speichern"));
  sf.addEventListener("submit", async e => {
    e.preventDefault();
    const tt = sf.querySelector("#setTT").value.trim(), cm = sf.querySelector("#setCM").value.trim();
    if ((tt && !safeUrl(tt)) || (cm && !safeUrl(cm))) { toast("Adressen müssen mit https:// beginnen"); return; }
    const r1 = await sb.from("app_settings").update({ value: tt }).eq("key", "timetrack_url");
    const r2 = await sb.from("app_settings").update({ value: cm }).eq("key", "crewmaster_url");
    if (r1.error || r2.error) { toast("Speichern nicht möglich"); return; }
    state.settings.timetrack_url = tt; state.settings.crewmaster_url = cm; toast("Gespeichert"); paint();
  });
  v.push(sf);
  // Links
  const lf = h("form", { class: "box" },
    h("div", { class: "kicker", style: "margin:0" }, "Link hinzufügen"),
    h("input", { type: "text", id: "lTitle", placeholder: "Titel, z. B. Licht Halle", required: true, maxlength: 60 }),
    h("input", { type: "url", id: "lUrl", placeholder: "https://…", required: true }),
    h("div", { class: "row" }, h("select", { id: "lCat", "aria-label": "Bereich" }, h("option", { value: "ha" }, "Home Assistant"), h("option", { value: "tools" }, "Apps & Links")),
      h("input", { type: "text", id: "lNote", placeholder: "Kurzinfo (optional)", maxlength: 80 })),
    h("button", { class: "btn cta", type: "submit" }, "Speichern"));
  lf.addEventListener("submit", async e => {
    e.preventDefault();
    const url = safeUrl(lf.querySelector("#lUrl").value), title = lf.querySelector("#lTitle").value.trim();
    if (!title || !url) { toast("Titel und https://-Adresse angeben"); return; }
    const r = await sb.from("links").insert({ title, url, cat: lf.querySelector("#lCat").value, note: lf.querySelector("#lNote").value.trim() || null }).select().single();
    if (r.error) { toast("Speichern nicht möglich"); return; }
    state.links.push(r.data); toast("Gespeichert"); paint();
  });
  v.push(lf);
  if (state.links.length) v.push(h("div", { class: "list", style: "margin-top:8px" }, state.links.map(l => h("div", { class: "docrow" },
    h("a", { class: "doc", href: safeUrl(l.url), target: "_blank", rel: "noopener" }, h("span", { class: "ic" }, l.cat === "ha" ? "HA" : "LINK"), h("div", { class: "body" }, h("div", { class: "t" }, l.title), h("div", { class: "n" }, l.url))),
    h("button", { class: "del", type: "button", "aria-label": l.title + " löschen", onclick: async () => {
      const r = await sb.from("links").delete().eq("id", l.id); if (r.error) toast("Löschen nicht möglich"); else { state.links = state.links.filter(x => x.id !== l.id); paint(); } } }, "✕")))));
  const st = ["kurse", "probe", "schulen", "deals"].map(k => (({ kurse: "Virtuagym", probe: "Probeschüler", schulen: "Kalender Schulen", deals: "Schul-Aufträge" })[k]) + ": " + (state.snaps[k] ? ago(snapTime(k)) : "noch nie"));
  v.push(h("div", { class: "kicker" }, "Abgleich (Make)"), h("p", { class: "sub" }, st.join(" · ")));
  return v;
}

/* ---------- shell ---------- */
const ICONS = {
  heute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  gym: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="17"/><path d="M3 9h18M8 2v4M16 2v4"/></svg>',
  schulen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11v5c0 1.5 3 3 6 3s6-1.5 6-3v-5"/></svg>',
  probe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-7 7-7s7 3 7 7M19 8v6M16 11h6"/></svg>',
  mehr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/></svg>'
};
ICONS.refresh = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>';
const TABS = [["heute", "Heute"], ["gym", "Gym"], ["schulen", "Schulen"], ["probe", "Probe"], ["mehr", "Bücherei"]];
function icon(k) { const s = document.createElement("span"); s.innerHTML = ICONS[k]; return s.firstChild; }

function paint() {
  const app = $("#app");
  if (!state.session) { document.body.className = "auth"; app.replaceChildren(viewAuth()); return; }
  document.body.className = "";
  if (!state.loading && (!state.me || !state.me.active)) {
    app.replaceChildren(h("div", { class: "auth-wrap" }, h("h1", null, "Kein Zugriff"),
      h("p", { class: "note err" }, "Dein Zugang ist gesperrt oder noch nicht freigeschaltet. Bitte melde dich bei René."),
      h("button", { class: "btn", type: "button", onclick: () => sb.auth.signOut() }, "Abmelden")));
    return;
  }
  const parts = [];
  if (state.snaps.kurse) parts.push("Virtuagym " + ago(snapTime("kurse")));
  if (state.snaps.probe) parts.push("HubSpot " + ago(snapTime("probe")));
  const header = h("header", { class: "top" }, h("div", { class: "wrap" },
    h("div", { class: "brand" }, h("b", null, "sysSport ", h("span", null, "Trainer")), h("span", { class: "stand" }, state.loading ? "Lade …" : (parts.length ? "Stand: " + parts.join(" · ") : "Noch kein Abgleich"))),
    h("button", { class: "iconbtn" + (state.loading ? " spin" : ""), type: "button", "aria-label": "Neu laden", onclick: loadAll },
      icon("refresh"))));
  const r = state.route;
  const nodes = r === "gym" ? viewGym() : r === "schulen" ? viewSchulen() : r === "probe" ? viewProbe() : r === "mehr" ? viewMehr() : viewHeute();
  const main = h("main", { class: "wrap" }, state.err ? h("p", { class: "note err" }, state.err) : null, nodes);
  const n = upcomingTrials().filter(l => l.date <= addDaysKey(todayKey(), 1)).length;
  const nav = h("nav", { class: "tabs", "aria-label": "Bereiche" }, h("div", { class: "wrap" }, TABS.map(([k, l]) =>
    h("a", { href: "#" + k, "aria-current": r === k ? "page" : null }, icon(k), l, k === "probe" && n ? h("span", { class: "badge" }, String(n)) : null))));
  app.replaceChildren(header, main, nav);
}
function paintKeepFocus(id) {
  const el = document.getElementById(id); const pos = el ? el.selectionStart : null;
  paint(); const n = document.getElementById(id); if (n) { n.focus(); try { if (pos != null) n.setSelectionRange(pos, pos); } catch {} }
}
function route() {
  const r = (location.hash || "").slice(1);
  state.route = TABS.some(([k]) => k === r) ? r : "heute";
  paint(); window.scrollTo(0, 0);
  if (state.route === "mehr" && isAdmin() && !state.admin.loaded) loadAdmin();
}
window.addEventListener("hashchange", route);
// Refresh when the app comes back to the foreground (data changes every 15 min).
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && state.session && !state.loading) loadAll(); });
setInterval(() => { if (state.session && document.visibilityState === "visible") paint(); }, 60000);

sb.auth.onAuthStateChange((ev, session) => {
  const had = !!state.session;
  state.session = session;
  if (session && !had) { route(); loadAll(); }
  if (!session) { state.me = null; state.admin = { profiles: [], invites: [], loaded: false, lastCode: null }; paint(); }
});
sb.auth.getSession().then(({ data }) => { if (!data.session) { state.loading = false; paint(); } });

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
