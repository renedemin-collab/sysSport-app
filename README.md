# sysSport Trainer-App

Interne App (PWA) für das Trainer-Team von sysSport. Läuft auf iPhone und Android im Browser und lässt sich auf den Homescreen legen.

## Aufbau

| Teil | Wo | Aufgabe |
|---|---|---|
| `web/` | GitHub Pages | Die App selbst (HTML/CSS/JS, kein Build-Schritt) |
| Supabase (EU, Irland) | Projekt `iictpaiwrrnpbyxvbiyl` | Login, Datenbank, Bücherei-Dateien, Rechte (Row Level Security) |
| `supabase/migrations/` | | Datenbank-Schema |
| `supabase/functions/register` | Edge Function | Erstes Anmelden mit Einladungscode |
| `supabase/functions/admin` | Edge Function | Trainer sperren / entsperren / Zugang zurücksetzen |
| Make-Szenario „Trainer-App – Daten abgleichen“ | Make | Holt alle 30 Min. (6–22 Uhr) Kursplan (Virtuagym), Probeschüler und Schul-Aufträge (HubSpot) und schreibt sie per `rpc/ingest` in Supabase |

## Zugang

- Neue Trainer lädt der Admin in der App ein (Bücherei → Admin). Die App erzeugt einen Einladungscode.
- Der Trainer öffnet die App, tippt „Erstes Mal hier“, gibt E-Mail, Code und ein eigenes Passwort ein.
- Ohne offene Einladung ist keine Registrierung möglich (Datenbank-Trigger auf `auth.users`).
- Gesperrte Trainer verlieren sofort den Zugriff auf alle Daten.

## Datenschutz

- Daten liegen in der EU (Supabase eu-west-1). Schriften sind selbst gehostet (kein Google Fonts).
- Die App lädt nur die Felder, die Trainer brauchen (z. B. keine E-Mail-Adressen von Probeschülern).
- Der Publishable Key in `web/config.js` ist öffentlich vorgesehen; alle Tabellen sind per RLS geschützt.
