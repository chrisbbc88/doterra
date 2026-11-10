# Betriebsanleitung

## Abgleich

- **Manuell:** Im doTERRA Office anmelden, dann in der Erweiterung „Jetzt abgleichen" klicken. Das ist der empfohlene Normalfall.
- **Automatisch (optional):** im CRM unter Daten → „Automatischer Abgleich" aktivieren. Modus **täglich um 05:00** (Standard, Uhrzeit wählbar) oder alle n Stunden (mindestens 2).
  - Hat der Rechner zur geplanten Zeit geschlafen, startet der Lauf beim Aufwachen bzw. beim nächsten Chrome-Start. Ist der letzte vollständige Abgleich älter als 24 Stunden, wird er nachgeholt.
  - **Noch zu prüfen:** ob die doTERRA-Anmeldung über Nacht bestehen bleibt. Läuft sie ab, meldet der 5-Uhr-Lauf „sitzung_abgelaufen" (sichtbar im CRM und als Chrome-Meldung). Dann muss Kathrin sich morgens anmelden und „Jetzt abgleichen" klicken.
- **Als Datei:** In der Erweiterung „Als Datei speichern" erzeugt eine Abgleich-Datei ohne laufenden CRM-Server. Sie wird im CRM bzw. in der Testversion unter Daten importiert und durchläuft dieselben Prüfungen wie der Live-Abgleich. Die Datei enthält Personendaten und gehört nicht in Git, Cloud-Ordner oder Chats.
  - Die Erweiterung übernimmt die Einstellung beim nächsten Öffnen des Popups oder beim Chrome-Start.
  - Der Abgleich läuft nur, solange Chrome geöffnet und Kathrin angemeldet ist.
  - **Standard: aus.** Erst einschalten, wenn mehrere manuelle Läufe erfolgreich waren.
- **Was passiert bei Problemen?**

  | Situation | Verhalten |
  |---|---|
  | doTERRA-Anmeldung abgelaufen | Status „sitzung_abgelaufen". Roter Hinweis im CRM, Chrome-Benachrichtigung, Office-Tab wird geöffnet. Keine Daten verändert. |
  | Seite unvollständig geladen | Status „teilweise". Gelesene Datensätze werden ergänzt, niemand wird als ausgeschieden markiert, „letzter vollständiger Abgleich" bleibt alt. |
  | doTERRA ändert eine Seite | Status „struktur_geändert". Der betroffene Bereich wird **nicht** geschrieben. Hinweis im CRM; die Spaltenzuordnung in `lib/sync.mjs` bzw. `extension/collectors.js` muss angepasst werden. |
  | Vorübergehender Fehler (Netz, 5xx) | bis zu 3 Wiederholungen mit wachsender Wartezeit |

- **Veraltet:** Ein Bereich gilt nach 26 Stunden ohne vollständigen Abgleich als veraltet (einstellbar). Das wird oben und unter „Daten" angezeigt.

## Sicherungen

- **Automatisch:**
  - beim Start
  - täglich, solange der Server läuft
  - vor jedem Abgleich, jeder Wiederherstellung und jeder Löschung
- **Ablage:** `data/backups/`. Die letzten 60 werden behalten.
- **Manuell:** Daten → „Jetzt sichern" oder „Gesamtexport (JSON)".
- **Wiederherstellen:**
  - Daten → Sicherung wählen, oder eine exportierte JSON-Datei einspielen.
  - Der aktuelle Stand wird vorher automatisch gesichert.
  - Die Datei wird vorher geprüft (Schema, Pflichtsammlungen).
- **Zusätzliche Kopie empfohlen:** den Ordner `data/backups` regelmäßig auf ein externes Laufwerk kopieren, oder Time Machine nutzen.
  - **Nicht** in einen öffentlich geteilten Cloud-Ordner legen.

## Sicherheit

- Der Server lauscht nur auf `127.0.0.1` und akzeptiert nur lokale Host-Namen.
- Anmeldung mit PIN:
  - gespeichert als scrypt-Hash
  - nach 5 Fehlversuchen 60 Sekunden Sperre
  - Sitzungscookie HttpOnly und SameSite=Strict, 12 Stunden gleitend
- Schreibzugriffe brauchen eine CRM-Kennung im Header. Fremde Webseiten (andere Herkunft) werden abgewiesen.
- **Rollen:**
  - `owner`: Kathrin, darf alles.
  - `viewer`: nur lesen, vorbereitet.
  - `sync`: Erweiterung, nur Abgleich-Endpunkte, keine Kontakte lesen.
- **Geheimnisse:**
  - Der Claude-Schlüssel steht nur in `.env`.
  - Der Abgleich-Schlüssel steht in `data/config.json`.
  - Beide erscheinen nicht im Quellcode oder in Protokollen. Das doTERRA-Passwort wird nie berührt.
- Das Protokoll (`audit`) enthält keine Personeninhalte.
- **PIN vergessen:** Server stoppen, in `data/config.json` die Zeile `pinHash` entfernen und neu starten. Danach wird eine neue PIN vergeben.

## KI-Nutzung

- **Übertragen:** Namen, doTERRA-IDs, berechnete Kennzahlen und Regelergebnisse.
- **Nicht übertragen:** Telefonnummern, E-Mails, Adressen, Notiztexte.
- Die Tokenzahl pro Monat steht unter Daten → Betriebskosten. Die Kosten richten sich nach der Preisliste von Anthropic für das eingestellte Modell.
- Nachrichtenentwürfe werden auf Heil- und Einkommensversprechen geprüft und **nie automatisch versendet**.

## Datenschutz-Funktionen

- **Export:** Gesamt-JSON, Kontakte als CSV, einzelne Person als JSON (Kontaktansicht).
- **Berichtigung:** CRM-Felder direkt editierbar. doTERRA-Felder werden im Office geändert und beim nächsten Abgleich übernommen.
- **Löschung:**
  - „CRM-Daten löschen" entfernt Notizen, Aufgaben, Profil und Entwürfe.
  - „Lokal komplett löschen" entfernt zusätzlich die Quelldaten und sperrt den Reimport.
  - Im doTERRA-Konto ändert sich nichts.
- **Sensible Notizen:** nur nach ausdrücklicher Bestätigung und gekennzeichnet. Aus Käufen werden keine Gesundheitsangaben abgeleitet.
  - Vor regelmäßiger Nutzung die rechtliche Grundlage klären (Einwilligung nach Art. 9 DSGVO).

## Wartung

- **Updates:** Ordner ersetzen, `data/` und `.env` behalten. Datenbankmigrationen laufen beim Start automatisch (`lib/store.mjs`, `SCHEMA_VERSION`).
- **Tests:** `npm test`.
- **Rangregeln:** In `rules/ranks.json` eine **neue Version** mit Quelle, Gültigkeit und Prüfdatum anlegen. Alte Versionen nicht überschreiben.
