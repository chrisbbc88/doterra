# Datenmodell und Feldbeschreibung

Grundsatz: **Quelldaten** (aus doTERRA, nur lesend) und **CRM-Daten** (von Kathrin gepflegt) liegen in getrennten Sammlungen. Ein Abgleich verändert CRM-Daten nie.

- Zeitzone für „heute" und Monatsgrenzen: **Europe/Berlin**.
- doTERRA zeigt Zeitstempel in CET. Datumswerte im Office sind US-Format (MM/TT/JJJJ) und werden in ISO (`JJJJ-MM-TT`) umgewandelt.
- Zahlen: US-Format (`26,683.50`) → `26683.5`.
- **Leere Zelle = fehlend (`null`), nicht 0.**
  - Live geprüft am 10.11.2026: doTERRA lässt bei fehlendem Volumen die Zelle leer und schreibt keine `0.00`.
  - Kennzahlen zählen nur Personen mit Wert > 0 als „aktiv".
- Unsichtbare Steuerzeichen (U+00AD u. a.) in doTERRA-Zellen werden entfernt.

## Quelldaten

### `members` – Downline-Bericht (Office → Mein Team → Downline, Detaillierter Bericht)
Schlüssel: **doTERRA-Mitglied-ID** (stabil, auch als Zeilen-ID `DetailGen<ID>` geprüft). Abruf: Sponsor-Sicht, Level 0–10, alle Mitgliedsarten, alle Spalten, seitenweise à 200.

| Feld | Quelle (Spalte) | Bedeutung / Hinweise |
|---|---|---|
| `id` | Mitglied-ID | eindeutige Kennung |
| `name` | Name | „Nachname, Vorname"; nie Grundlage für Zusammenführungen |
| `memberType` | Mitgliedsart | Wellness Advocate → Beraterin; Vorteilskunde → Vorteilskundin; Retail Customer → Einzelhandelskundin; „S" → Sonstige (S). doTERRAs Gesamtzählung schließt „S" offenbar aus (335 Zeilen vs. 334 gezählt). |
| `level` | Levels | Tiefe im **Sponsor**baum; Kontoinhaberin = leer |
| `currentRank` | Derzeitiger Rang | Anzeige-Rang laut Office, ≠ Monatsqualifikation, ≠ bezahlter Rang |
| `highestRank` | Höchster Rang | jemals erreichter Rang |
| `nextLrpPv`, `nextLrpDate` | PV der nächsten Treuebestellung / Nächster LRP-Termin | **geplante** Treuebestellung. Liegt das Datum in der Vergangenheit, wurde sie nicht verarbeitet. |
| `lastOrderDate` | Letztes Bestelldatum | letzte ausgeführte Bestellung |
| `entryDate` | Registrierungsdatum | |
| `sponsorId` / `sponsorName` | ID/Name Sponsor*in | **Platzierung** |
| `enrollerId` / `enrollerName` | ID/Name Enroller*in | **Einschreibung** (nicht verwechseln mit Sponsor) |
| `contact.*` | Telefon, Adresse, E-Mail, Ort, PLZ, Land | personenbezogen; wird **nicht** an die KI übertragen |
| `inDownline`, `missingSince` | berechnet | nur nach **vollständigem** Lauf gesetzt; nie gelöscht |
| `history` | berechnet | letzte 50 Änderungen überwachter Felder |

### `memberMonths` – Monatsvolumen
Schlüssel: `ID|JJJJ-MM`. Quelle: Monatsspalten des Downline-Berichts (laufender Monat und 6 Vormonate).

| Feld | Bedeutung |
|---|---|
| `pv` | Persönliches Volumen. Volumenpunkte, **kein Geld** |
| `qualPv` | qualifizierendes PV |
| `lrpPv` | PV aus Treuebestellungen |
| `ov` | Organisationsvolumen. Volumen, kein Geld |
| `pgv`, `tgv` | Persönliches bzw. Team-Wachstumsvolumen (Power of 3 / Rangbedingungen) |
| `previous`, `changedAt` | Vorwert bei Änderung (laufender Monat ändert sich bis Monatsende) |

### `legs` – Schlagdistanz (Mein Team → Schlagdistanz)
Schlüssel: `ID|JJJJ-MM`.

| Feld | Bedeutung |
|---|---|
| `legId` | Bein-Wurzel nach **Einschreibung**. Live geprüft: entspricht zu 100 % der Enroller-Kette. |
| `monthRank` | Rangqualifikation im laufenden Monat (z. B. Consultant) |
| `pctToRank`, `targetRank` | doTERRAs eigene Berechnung „% zum Rang" für den im Bericht gewählten Rang (Standard: Elite) |
| `legsByRank` | Anzahl Beine je Rang laut doTERRA |

### `orders` – Bestellhistorie (Bestellungs- und Sendeverfolgung je Mitglied)
Schlüssel: **Rechnungsnummer**. Abruf rückwärts in 3-Monats-Schritten bis `fromMonth` (Standard: 12 Monate). Die Versandadresse wird **nicht** übernommen.

| Feld | Bedeutung |
|---|---|
| `typeCode` / `type` | I = Beraterbestellung, D = Kundenbestellung, R = Ersatzbestellung |
| `sourceCode` / `source` | SO Standard, IO Internet, IN Einschreibung, VO Sprachbestellung, **AS = Treuebestellung (LRP)** |
| `date`, `shipDate` | Bestell- und Versanddatum |
| `status` | `offen` = noch nicht versandt; Artikel erscheinen bei doTERRA erst nach Versand. `ausgeführt` = versandt bzw. Positionen vorhanden. |
| `pvMonth` | PV-Periode **laut doTERRA**, wird nie aus dem Datum abgeleitet (z. B. Bestellung 31.10. kann PV-Monat 11 sein) |
| `volume` | PV der Bestellung |
| `amount`, `currency` | Betrag in Landeswährung; Währung aus dem Land des Mitglieds (DEU/ITA/AUT… = EUR, CHE = CHF …). Unbekanntes Land → `null`. |
| `items[]` | Artikelnummer und Menge. doTERRA liefert keine Produktnamen; Namen werden in `products` gepflegt. |
| `history` | Änderungen (z. B. offen → versandt) |

Eigene Bestellungen der Kontoinhaberin liegen bei doTERRA unter shop.doterra.com und werden **noch nicht** abgeglichen. Ihr PV kommt aus dem Downline-Bericht.

### `commissions` – Provisionsübersicht
Schlüssel: `Periode|primary|secondary`.

- **Primärbonus:** Periode = Monat (MM/JJJJ).
- **Sekundärbonus:** Periode = **Kalenderwoche** (WW/JJJJ, bis Woche 44 am 10.11.2026). Wird als `JJJJ-Www` gespeichert und **nie** mit Monaten vermischt.
- Felder: `earned` (Verdienst), `fees` (Gebühren), `withheld` (zurückgehalten), `payout` (auszuzahlen), `currency` (EUR laut Office).
- Das sind die **einzigen belastbaren Geldbeträge** im System.

## CRM-Daten (manuell)

| Sammlung | Inhalt |
|---|---|
| `profiles[contactKey]` | Kontaktquelle, Interessen und Präferenzen (nur ausdrücklich genannte), Instagram, nächster Schritt, Wiedervorlage, Einwilligungen (WhatsApp, E-Mail, sensible Notizen) |
| `prospects["p:<uuid>"]` | Interessentinnen ohne doTERRA-ID |
| `notes` | Gesprächsnotizen; `sensitive=true` nur nach ausdrücklicher Bestätigung |
| `tasks` | Aufgaben mit Fälligkeit, Dauer, Herkunft (Vorschlagsregel) |
| `events` | Veranstaltungen und Testwochen mit Teilnehmenden; Ergebnis = Einschreibungen und Bestellungen innerhalb von 30 Tagen |
| `goals` | Monatsziele mit Messgröße |
| `products[sku]` | Produktname je Artikelnummer |
| `drafts` | Nachrichtenentwürfe; werden nie automatisch versendet |

`contactKey` ist die doTERRA-ID oder `p:<uuid>` für Interessentinnen.

## Betrieb

| Sammlung | Inhalt |
|---|---|
| `syncRuns` | Lauf mit Bereichen, Status je Bereich, Prüfungen (Quelle vs. erhalten), Fehlern, Änderungsanzahl |
| `areaStatus` | je Bereich: letzter **vollständiger** Abgleich, letzter Versuch, letzter Status |
| `changes` | erkannte Änderungen je Lauf (neues Mitglied, geänderte Felder, neue oder geänderte Bestellung, nicht mehr in Downline) |
| `suppressed` | lokal gelöschte Personen, die nicht reimportiert werden |
| `audit` | Aktionen ohne Personeninhalte (Abgleich, Wiederherstellung, KI-Tokenverbrauch) |

## Kennzahlen (Definitionen)

| Kennzahl | Definition |
|---|---|
| Neue Mitglieder (30 Tage) | Registrierungsdatum in den letzten 30 Tagen |
| Bestellaktive Personen | PV > 0 im laufenden PV-Monat |
| LRP verarbeitet | LRP-PV > 0 im laufenden Monat |
| LRP hinterlegt | „Nächster LRP-Termin" vorhanden |
| LRP-Termin überschritten | nächster LRP-Termin < heute |
| Wiederbestellquote | Anteil der im vorletzten abgeschlossenen Monat Aktiven, die auch im letzten aktiv waren |
| Segment | Neu ≤ 60 Tage; Treue LRP = LRP-PV in ≥ 5 von 6 Monaten; Regelmäßig ≥ 3 von 6; Gelegentlich 1–2; Inaktiv 0 |
| Wertstufe | Ø PV der letzten 6 abgeschlossenen Monate: A ≥ 100, B ≥ 50, C > 0, D = 0 |
| Nachkauf möglich | gleicher Artikel ≥ 2× gekauft (Median-Abstand ≥ 20 Tage) und Abstand seit letztem Kauf ≥ Median |

Jede Kennzahl auf der Startseite ist anklickbar und führt zur Liste der zugrunde liegenden Personen.
