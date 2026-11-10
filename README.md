# Kathrins CRM – doTERRA Dashboard & Strategieassistent

Lokales CRM für Kathrins doTERRA-Business. Läuft ausschließlich auf ihrem Rechner (`127.0.0.1`), liest Daten **nur lesend** aus dem doTERRA Office und verbindet sie mit eigenen Notizen, Aufgaben, Veranstaltungen und Zielen.

```
Chrome-Erweiterung ──(liest im eingeloggten Office)──▶ lokaler Server ──▶ data/db.json (+ Sicherungen)
                                                            │
                                    Oberfläche im Browser ◀─┘──▶ Claude-API (nur berechnete Fakten)
```

## Einrichtung (einmalig, ca. 10 Minuten)

1. **Node.js installieren:** LTS-Version von <https://nodejs.org> (Version 20 oder neuer).
2. **Ordner ablegen:** z. B. `~/Documents/Kathrins-CRM`.
3. **Claude-Schlüssel (optional, für Assistent und Entwürfe):**
   - `.env.example` kopieren und als `.env` speichern.
   - Den Schlüssel bei `ANTHROPIC_API_KEY=` eintragen.
   - Ohne Schlüssel funktioniert alles außer Assistent und Entwürfen.
4. **Starten:**
   - Doppelklick auf `start.command`. Beim ersten Mal: Rechtsklick → Öffnen → Öffnen, macOS fragt einmal nach.
   - Alternativ im Terminal: `npm start`.
   - Der Browser öffnet <http://127.0.0.1:8787>.
5. **PIN festlegen:** 6–12 Ziffern. Die PIN schützt die Oberfläche, gespeichert wird nur ein Hash.
6. **Chrome-Erweiterung laden:**
   - In Chrome `chrome://extensions` öffnen.
   - Oben rechts „Entwicklermodus" einschalten.
   - „Entpackte Erweiterung laden" klicken und den Ordner `extension` wählen.
7. **Erweiterung verbinden:**
   - Im CRM unter **Daten** den Abgleich-Schlüssel kopieren.
   - Im Popup der Erweiterung unter „Einrichtung" einfügen und speichern.
8. **Erster Abgleich:**
   - Im doTERRA Office anmelden.
   - Im Erweiterungs-Popup „Jetzt abgleichen" klicken.
   - Der erste vollständige Lauf dauert etwa 5 Minuten (Bestellhistorie von 334 Mitgliedern). Danach werden nur Änderungen nachgeladen.

## Täglich

- **Abgleich:** Erweiterung → „Jetzt abgleichen". Kathrin muss im doTERRA Office angemeldet sein. Ist die Anmeldung abgelaufen, erscheint ein roter Hinweis im CRM und eine Chrome-Meldung.
- **Startseite „Heute":** drei nächste Schritte, Fälliges, Änderungen seit dem letzten Abgleich, Kennzahlen, Ziele.
- **„+ Notiz":** in eigenen Worten schreiben oder diktieren. Das CRM schlägt Kontakt, Notiz und Aufgabe vor. Gespeichert wird erst nach Bestätigung.

## Testversion als einzelne HTML-Datei

`dist/kathrins-crm-test.html` enthält das komplette System und läuft per Doppelklick im Browser, ohne Installation. Sie startet mit Beispieldaten.

Echte Daten laden:
1. In der Erweiterung „Als Datei speichern (ohne CRM-Server)" klicken. Das erzeugt `doterra-abgleich-JJJJ-MM-TT.json` im Download-Ordner.
2. In der Testversion unter **Daten → Abgleich-Datei importieren** diese Datei wählen.

Die Daten liegen danach nur in der IndexedDB dieses Browsers. Vorher im 🧪 Testlabor eine eigene PIN setzen.

Neu bauen: `node scripts/build-standalone.mjs`

## Auf GitHub zeigen

Nur den **Code** hochladen (Repository privat halten). `.gitignore` schließt `data/`, `.env` und alle Export- und Abgleich-Dateien aus. Echte Kundendaten gehören nicht in ein Repository und nicht auf GitHub Pages. Sie werden immer lokal per Datei-Import oder Erweiterung geladen.

## Beispieldaten ansehen (getrennt vom echten Bestand)

```
npm run demo        # erzeugt ./data-demo mit erfundenen Personen, PIN 123456
```

## Befehle

| Befehl | Zweck |
|---|---|
| `npm start` | CRM starten (echte Daten in `./data`) |
| `npm test` | Abnahmetests ausführen |
| `npm run demo` | Beispiel-Instanz starten (`./data-demo`) |

Weitere Unterlagen: [Architektur](docs/ARCHITEKTUR.md) · [Datenmodell](docs/DATENMODELL.md) · [Betrieb](docs/BETRIEB.md) · [Testbericht](docs/TESTBERICHT.md)
