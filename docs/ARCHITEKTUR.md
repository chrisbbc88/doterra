# Architektur und Entscheidungen

## Aufbau

| Schicht | Datei(en) | Aufgabe |
|---|---|---|
| Integration | `extension/` | Chrome-Erweiterung (MV3). Liest im eingeloggten doTERRA Office: Downline-Bericht, Schlagdistanz, Bestellhistorie, Provisionsübersicht. Nur GET bzw. Berichtsabfragen mit `saveDefault=0`. |
| Abgleich | `lib/sync.mjs` | Strukturprüfung, Normalisierung, idempotenter Upsert, Änderungserkennung, Lauf-Protokoll, Vollständigkeitsprüfung |
| Datenbank | `lib/store.mjs` | JSON-Datei mit Schema-Version, Migrationen, atomarem Schreiben, Transaktionen, Sicherungen |
| Geschäftsregeln | `lib/kpi.mjs`, `rules/ranks.json` | Kennzahlen, Segmente, Teamstruktur, Vorschlagsregeln, versionierte Rangbedingungen |
| KI | `lib/assistant.mjs` | Fakten-Paket bauen, Claude-Aufruf, Antwortprüfung gegen Fakten-IDs, Entwurfsprüfung |
| Notizen | `lib/notes.mjs` | Natürliche Sprache → Kontaktvorschlag, Datum, Aufgabe, Rückfragen |
| Server | `server.mjs` | HTTP nur auf 127.0.0.1, Anmeldung, Rollen, CSRF- und Herkunftsschutz, REST-API, statische Oberfläche |
| Oberfläche | `public/` | Deutsche, mobile Web-App ohne Framework und ohne externe Skripte |

## Wesentliche Entscheidungen

- **Lokal statt Cloud (Phase 1).**
  - Wunsch: Betrieb nur auf Kathrins Rechner.
  - Folge: Keine Kosten und keine Weitergabe personenbezogener Daten an Dritte, außer den bewusst minimierten KI-Anfragen.
- **Node.js ohne Abhängigkeiten.**
  - Kein `npm install`, keine Lieferkettenrisiken.
  - Läuft auf jedem Mac mit Node ab Version 20.
- **JSON-Datenbank mit Tabellenstruktur.**
  - Jede Sammlung entspricht einer späteren Postgres-Tabelle, mit stabilen Schlüsseln (doTERRA-ID, Rechnungsnummer).
  - Damit ist der Umzug nach Supabase ein 1:1-Import, siehe unten.
- **Abgleich über eine Chrome-Erweiterung in Kathrins Sitzung.**
  - doTERRA bietet keine dokumentierte API.
  - Passwörter werden nie gespeichert. Ohne Anmeldung gibt es keinen Abgleich.
  - Eine unbeaufsichtigte Nacht-Synchronisierung ist damit bewusst nicht möglich.
- **Interne Rank-Tracker-API nicht genutzt.**
  - `ranktracker.doterra.com/api` ist undokumentiert.
  - Genutzt werden nur die Berichte, die Kathrin auch in der Oberfläche sieht.
- **Zwei Teamsichten.**
  - Platzierung: Sponsor-Kette, 7 Frontlines.
  - Einschreibung: Enroller-Kette, 82 Beine. Diese Sicht ist rangrelevant und wurde am 10.11.2026 zu 330/330 gegen doTERRAs „Leg ID" geprüft.

## Später: Umzug nach Supabase

1. Für jede Sammlung in `db.json` eine Tabelle anlegen:
   - `members`, `member_months` (Schlüssel: member_id, month), `legs`, `orders`, `order_items`, `commissions`
   - `profiles`, `prospects`, `notes`, `tasks`, `events`, `event_participants`, `goals`, `products`
   - `sync_runs`, `changes`, `audit`
2. Row Level Security pro Nutzerin, Anmeldung über Supabase Auth.
3. `lib/store.mjs` durch einen Supabase-Adapter mit gleicher Schnittstelle ersetzen (`transact`, `backup`, `restore`).
4. Den Claude-Aufruf in eine Edge Function verlegen, damit der Schlüssel serverseitig bleibt.
5. Die Erweiterung sendet an die Supabase-Funktion statt an localhost.
6. Vorher klären: Auftragsverarbeitung (AVV) mit Supabase, Serverstandort EU.

## Später: Instagram und WhatsApp (offen)

- **Instagram:**
  - Sauberer Weg: Instagram-Messaging-API von Meta für Business- oder Creator-Konten. Dafür sind eine Meta-App und deren Prüfung nötig.
  - Damit wären „wer wartet auf Antwort", „unbeantwortet seit X Tagen" und offene Fragen auswertbar.
- **WhatsApp:**
  - Für private Chats gibt es keine offizielle Lese-API.
  - Automatisches Mitlesen von WhatsApp Web verstößt gegen die Nutzungsbedingungen und betrifft Daten Dritter.
  - Möglich ist der WhatsApp-Business-Weg oder ein manueller Chat-Export einzelner Unterhaltungen, den das CRM einlesen kann.
- **Vor der Umsetzung:**
  - Einwilligungen der Kontakte prüfen.
  - Datenminimierung festlegen: nur Zeitstempel und Status, keine kompletten Chatverläufe.
