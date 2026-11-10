# Testbericht – Stand 10.11.2026

## A. Automatische Abnahmetests (`npm test`) – 16/16 bestanden

Testdaten: erfundene Personen, aber exakt die live erfasste Spaltenstruktur der doTERRA-Berichte (`tests/fixture.mjs`).

| # | Abnahmekriterium | Ergebnis |
|---|---|---|
| 1 | Derselbe Import erzeugt keine Duplikate (auch keine Änderungsmeldungen) | ✓ |
| 2 | Geänderte Bestellung wird übernommen (offen → versandt, Artikel, Betrag), keine Doppelrechnung, Historie | ✓ |
| 3 | Unvollständiger Abruf: nichts gelöscht, niemand fälschlich ausgeschieden, letzter Erfolg bleibt | ✓ |
| 3b | Geänderte Seitenstruktur: Bereich wird nicht geschrieben | ✓ |
| 4 | Abgelaufene Sitzung → sichtbarer Status, kein vorgetäuschter Erfolg | ✓ |
| 5 | Kennzahlen = Stichproben der Quelle; leere Zelle ≠ 0 | ✓ |
| 6 | Monatsgrenzen (30.11. 23:30 UTC = 1.12. Berlin), Sommerzeit, PV-Monat aus Quelle, Währung nach Land, Wochen-Bonus ≠ Monat | ✓ |
| 7 | Manuelle Notizen und Profile bleiben beim Abgleich erhalten | ✓ |
| 8 | Teamstruktur: Platzierung ≠ Einschreibung; gebrochene Kette bleibt ungeklärt | ✓ |
| 9 | Empfehlungen ohne gültige Fakten-ID werden verworfen; unbelegte Zahlen markiert; keine Kontaktdaten an die KI | ✓ |
| 10 | Schnellnotiz: eindeutiger Kontakt, „nächsten Dienstag" korrekt, Rückfrage bei zwei gleichnamigen Personen und bei mehrdeutigem Datum, Gesundheitsangabe markiert | ✓ |
| 11 | Sicherung wiederherstellbar (auch nach Neustart von Platte); ungültige Sicherung abgelehnt | ✓ |
| 12 | Rangplanung nur mit geprüften Regeln, mit Quelle | ✓ |
| 13 | Rollenrechte: ohne Anmeldung 401; Abgleich-Schlüssel darf keine Kontakte lesen; Nur-Lesen-Rolle darf nicht schreiben; CSRF-Kennung; fremde Herkunft und fremder Host abgewiesen; PIN nicht überschreibbar | ✓ |
| 15 | Abgleich-Datei importieren: falsches Format abgelehnt, nur angemeldet, Beispieldaten ersetzt und vorher gesichert, Kennzeichnung „echt", erneuter Import ohne Duplikate, Zeitplan 05:00 gespeichert | ✓ |
| 14 | Ende-zu-Ende über die HTTP-API: Abgleich → Kontaktansicht → Notiz → erneuter Abgleich mit Namensänderung → Notiz erhalten, Änderung gemeldet; Strukturfehler 422; Export; Löschung mit Reimport-Sperre | ✓ |

Während der Tests gefunden und behoben:
- Namensänderungen wurden nicht als Änderung gemeldet.
- Ungültige Sicherungsdateien wurden zu leeren Datenbanken ergänzt statt abgelehnt.

## B. Live-Prüfung gegen das echte doTERRA Office (10.11.2026, nur lesend)

Zurückgegeben wurden nur Zählwerte und Prüfsummen, keine Personendaten.

| Prüfung | Ergebnis |
|---|---|
| Downline vollständig lesen (2 Seiten) | 335 Zeilen, 335 eindeutige IDs, Zeilen-ID = Mitglied-ID in 100 %. doTERRA zählt 334 (Mitgliedsart „S" nicht mitgezählt) → Regel „mindestens so viele wie gezählt" |
| Stichprobe Kontoinhaberin vs. Dashboard | Sep: 205,00 PV / 26.683,50 OV; Okt: 291,50 PV / 25.117,90 OV – **identisch** mit „Mein Volumen" |
| Summen-Abgleich | Summe PV Oktober aller 335 = 25.239,90 vs. OV Oktober 25.117,90 (Abweichung 122,00 – vermutlich unterschiedliche Abgrenzung von OV, nicht weiter geklärt) |
| Leer vs. 0 | 200 leere PV-Zellen, 0× „0.00" → leer = keine Angabe |
| Schlagdistanz | 331 Zeilen (Quelle: 330); Leg ID = Enroller-Kette in **330/330** Fällen; Platzierung weicht in 101 Fällen ab |
| Bestellhistorie | 4 Stichproben-Mitglieder (eins in Italien): 30 Rechnungen, alle eindeutig, LRP-Kennung „AS" erkannt, Adresse nicht übernommen; ~2,2 s je Mitglied |
| Provisionen | Primär monatlich 01–09/2026; **Sekundär wöchentlich** (bis Woche 44) – würde ohne Korrektur September verfälschen |
| Sitzungserkennung | angemeldet → ok; ohne Sitzung → erkannt (Weiterleitung zum Gigya-OIDC-Login) |
| Gefährliche Funktionen | „Veränderungen" (Sponsoränderung) und „Einreichungen zu Platzierungen" identifiziert und ausgeschlossen |

## C. Oberfläche

Headless Chrome mit Beispieldaten, Desktop 1366 px und Mobil 390 px:
- alle Ansichten fehlerfrei geladen, keine Konsolenfehler
- Anmeldung, Schnellnotiz mit Rückfrage und Teamansicht geprüft

## C2. Testversion (eine HTML-Datei)

- **Datei-Import in Originalgröße:** 335 Mitglieder, 2.720 Bestellungen (987 KB) mit erfundenen Werten in der Struktur der Erweiterung. Import in 0,2 s, alle Bereiche vollständig, Beispieldaten-Hinweis verschwindet.
- **Nach dem Neuladen:** Daten vollständig erhalten (IndexedDB, 2,2 MB), eigene PIN aktiv, alle Ansichten laden in unter 0,2 s.

## D. Noch nicht geprüft / offen

- **Kompletter Lauf echte Daten → lokaler Server auf Kathrins Rechner.**
  - Ein Teil ist geprüft: Sammelfunktionen live gegen das Office und Server-Verarbeitung mit identisch strukturierten Testdaten.
  - Der durchgehende Lauf braucht die Installation auf Kathrins Rechner. Er ist der erste Schritt der Übergabe.
- **Automatischer Abgleich (täglich 05:00, Nachholen):** implementiert, standardmäßig aus. Noch nicht im Dauerbetrieb getestet, insbesondere ob die doTERRA-Anmeldung über Nacht gültig bleibt.
- **„Als Datei speichern" in der Erweiterung:** nutzt die live geprüften Sammelfunktionen. Der vollständige Lauf auf Kathrins Rechner steht noch aus.
- **Claude-Assistent mit echtem API-Schlüssel:** Antwortprüfung getestet, der echte Aufruf noch nicht (kein Schlüssel hinterlegt).
