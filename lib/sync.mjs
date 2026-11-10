// Abgleich: nimmt Rohdaten der Chrome-Erweiterung entgegen, prüft Struktur und
// Vollständigkeit, normalisiert Felder und schreibt idempotent in die Datenbank.
// Grundsätze:
//  * Upsert über stabile IDs (Mitglied-ID, Rechnungsnummer) -> keine Duplikate
//  * Nichts wird gelöscht. Fehlende Mitglieder werden nur bei vollständigem Lauf markiert.
//  * Ein unvollständiger/fehlgeschlagener Teil aktualisiert NICHT den "letzten erfolgreichen Abgleich".
//  * Leere Zellen bleiben null (fehlend), 0.00 bleibt 0 (echter Nullwert).
import { uid, parseNum, parseUSDate, parsePeriod, parseMonthLabel, localMonth, diffFields } from './util.mjs';

export class StructureError extends Error {
  constructor(msg) { super(msg); this.code = 'structure_changed'; }
}

const norm = (h) => String(h || '').replace(/[\u00ad\u200b-\u200d\ufeff]/g, '').toLowerCase().replace(/[*:]/g, '').replace(/\s+/g, ' ').trim();

// Spaltenüberschrift (de/en) -> internes Feld
const DOWNLINE_FIELDS = {
  'mitglied-id': 'id', 'member id': 'id', 'mitglieds-id': 'id',
  'name': 'name',
  'mitgliedsart': 'memberType', 'member type': 'memberType',
  'levels': 'level', 'level': 'level',
  'derzeitiger rang': 'currentRank', 'current rank': 'currentRank',
  'höchster rang': 'highestRank', 'highest rank': 'highestRank',
  'pv der nächsten treuebestellung': 'nextLrpPv',
  'nächster lrp-termin': 'nextLrpDate', 'next lrp date': 'nextLrpDate',
  'letztes bestelldatum': 'lastOrderDate', 'last order date': 'lastOrderDate',
  'registrierungsdatum': 'entryDate', 'entry date': 'entryDate',
  'id sponsorin': 'sponsorId', 'sponsor id': 'sponsorId',
  'name sponsorin': 'sponsorName',
  'id enrollerin': 'enrollerId', 'enroller id': 'enrollerId',
  'name enrollerin': 'enrollerName',
  'festnetztelefon': 'phoneHome', 'mobiltelefon': 'phoneMobile', 'arbeitshandy': 'phoneWork',
  'adresse': 'address1', 'adresse 2': 'address2', 'e-mail': 'email', 'stadt': 'city',
  'bundesland': 'state', 'postleitzahl': 'zip', 'land': 'country',
};
const REQUIRED_DOWNLINE = ['id', 'name', 'memberType', 'sponsorId', 'enrollerId'];
const MONTH_SUB = { 'ov': 'ov', 'pv': 'pv', 'qual pv': 'qualPv', 'lrp pv': 'lrpPv', 'pgv': 'pgv', 'tgv': 'tgv' };
const TRACKED = ['name', 'memberType', 'currentRank', 'highestRank', 'nextLrpDate', 'nextLrpPv', 'lastOrderDate', 'sponsorId', 'enrollerId', 'level', 'inDownline'];

const MEMBER_TYPE = { 'wellness advocate': 'Beraterin', 'vorteilskunde': 'Vorteilskundin', 'retail customer': 'Einzelhandelskundin', 'wholesale customer': 'Vorteilskundin', 's': 'Sonstige (S)' };

const INVIS = /[\u00ad\u200b-\u200d\ufeff]/g;
function cleanId(v) { const s = String(v ?? '').replace(INVIS, '').trim(); return /^\d{4,}$/.test(s) ? s : null; }
function clean(v) { const s = String(v ?? '').replace(INVIS, '').replace(/\s+/g, ' ').trim(); return s === '' || s === '--' ? null : s; }

/** Rohzeilen des Downline-Berichts in Mitglieder + Monatswerte übersetzen. */
export function parseDownline(payload) {
  const headers = payload.headers || [];
  const map = {};
  const monthCols = [];
  for (const h of headers) {
    const [top, sub] = String(h).split('|');
    if (sub !== undefined) {
      const month = parseMonthLabel(top);
      const field = MONTH_SUB[norm(sub)];
      if (month && field) monthCols.push({ h, month, field });
      continue;
    }
    const f = DOWNLINE_FIELDS[norm(h)];
    if (f) map[h] = f;
  }
  const present = new Set(Object.values(map));
  const missing = REQUIRED_DOWNLINE.filter((f) => !present.has(f));
  if (missing.length) throw new StructureError(`Downline: Pflichtspalten fehlen (${missing.join(', ')}). Seitenstruktur hat sich vermutlich geändert.`);
  if (monthCols.length === 0) throw new StructureError('Downline: keine Monatsspalten gefunden.');

  const members = [], months = [], problems = [];
  for (const row of payload.rows || []) {
    const rec = {};
    for (const [h, f] of Object.entries(map)) rec[f] = row.cells?.[h];
    const id = cleanId(rec.id) || cleanId(String(row.rowId || '').replace(/\D/g, ''));
    if (!id) { problems.push('Zeile ohne gültige Mitglied-ID übersprungen'); continue; }
    const rowIdNum = String(row.rowId || '').replace(/\D/g, '');
    if (rowIdNum && rowIdNum !== id) problems.push(`ID-Abweichung Zeile/Zelle bei ${id}`);
    const typeRaw = clean(rec.memberType);
    members.push({
      id,
      name: clean(rec.name),
      memberTypeRaw: typeRaw,
      memberType: MEMBER_TYPE[norm(typeRaw)] || typeRaw,
      level: parseNum(rec.level),
      currentRank: clean(rec.currentRank),
      highestRank: clean(rec.highestRank),
      nextLrpPv: parseNum(rec.nextLrpPv),
      nextLrpDate: parseUSDate(rec.nextLrpDate),
      lastOrderDate: parseUSDate(rec.lastOrderDate),
      entryDate: parseUSDate(rec.entryDate),
      sponsorId: cleanId(rec.sponsorId),
      sponsorName: clean(rec.sponsorName),
      enrollerId: cleanId(rec.enrollerId),
      enrollerName: clean(rec.enrollerName),
      contact: {
        phoneMobile: clean(rec.phoneMobile), phoneHome: clean(rec.phoneHome), phoneWork: clean(rec.phoneWork),
        email: clean(rec.email), address1: clean(rec.address1), address2: clean(rec.address2),
        zip: clean(rec.zip), city: clean(rec.city), state: clean(rec.state), country: clean(rec.country),
      },
    });
    const byMonth = {};
    for (const c of monthCols) {
      const v = parseNum(row.cells?.[c.h]);
      (byMonth[c.month] ||= {})[c.field] = v;
    }
    for (const [month, vals] of Object.entries(byMonth)) {
      const hasAny = Object.values(vals).some((v) => v !== null);
      if (!hasAny) continue; // komplett leer = keine Daten, kein Nullmonat
      months.push({ id, month, ...vals });
    }
  }
  return { members, months, problems, monthsCovered: [...new Set(monthCols.map((c) => c.month))].sort() };
}

const ORDER_FIELDS = {
  'rechnung': 'invoice', 'invoice': 'invoice', 'art': 'type', 'type': 'type', 'quelle': 'source', 'source': 'source',
  'artikelnummer': 'skus', 'item number': 'skus', 'qty': 'qtys', 'datum': 'date', 'date': 'date',
  'versand': 'shipDate', 'ship date': 'shipDate', 'pvdatum': 'pvMonth', 'pv date': 'pvMonth',
  'volumen': 'volume', 'volume': 'volume', 'betrag': 'amount', 'amount': 'amount',
};
const ORDER_TYPE = { I: 'Beraterbestellung', D: 'Kundenbestellung', R: 'Ersatzbestellung' };
const ORDER_SOURCE = { SO: 'Standardbestellung', IO: 'Internetbestellung', IN: 'Einschreibung', VO: 'Sprachbestellung', AS: 'Treuebestellung (LRP)' };

// Währung der Bestellung nach Land des Mitglieds (Betrag steht in Landeswährung). Unbekannt -> null.
const CURRENCY = { DEU: 'EUR', AUT: 'EUR', ITA: 'EUR', FRA: 'EUR', ESP: 'EUR', NLD: 'EUR', BEL: 'EUR', LUX: 'EUR', IRL: 'EUR', PRT: 'EUR', FIN: 'EUR', GRC: 'EUR', SVK: 'EUR', SVN: 'EUR', EST: 'EUR', LVA: 'EUR', LTU: 'EUR', HRV: 'EUR', BGR: 'BGN', CHE: 'CHF', GBR: 'GBP', POL: 'PLN', CZE: 'CZK', HUN: 'HUF', ROU: 'RON', DNK: 'DKK', SWE: 'SEK', NOR: 'NOK', TUR: 'TRY', USA: 'USD' };
export const currencyFor = (country) => CURRENCY[String(country || '').toUpperCase()] || null;

export function parseOrderRows(headers, rows, memberId, country) {
  const map = {};
  headers.forEach((h, i) => { const f = ORDER_FIELDS[norm(h)]; if (f) map[f] = i; });
  for (const req of ['invoice', 'date', 'pvMonth', 'volume']) {
    if (map[req] === undefined) throw new StructureError(`Bestellhistorie: Spalte "${req}" fehlt.`);
  }
  const out = [];
  for (const cells of rows) {
    const get = (f) => (map[f] !== undefined ? cells[map[f]] : null);
    const invoice = cleanId(get('invoice'));
    if (!invoice) continue;
    const skus = String(get('skus') || '').split(/[\n;]+/).map((s) => s.trim()).filter(Boolean);
    const qtys = String(get('qtys') || '').split(/[\n;]+/).map((s) => s.trim()).filter(Boolean);
    const items = skus.map((sku, i) => ({ sku, qty: parseNum(qtys[i]) ?? null }));
    const typeCode = clean(get('type'));
    const sourceCode = clean(get('source'));
    const shipDate = parseUSDate(get('shipDate'));
    out.push({
      invoice, memberId,
      typeCode, type: ORDER_TYPE[typeCode] || typeCode,
      sourceCode, source: ORDER_SOURCE[sourceCode] || sourceCode,
      isLrp: sourceCode === 'AS',
      date: parseUSDate(get('date')),
      shipDate,
      pvMonth: parsePeriod(get('pvMonth')),
      volume: parseNum(get('volume')),
      amount: parseNum(get('amount')),
      currency: currencyFor(country),
      items,
      status: shipDate || items.length ? 'ausgeführt' : 'offen',
    });
  }
  return out;
}

// ---------------- Lauf-Verwaltung ----------------

export function startRun(db, { kinds, trigger = 'manuell', client = 'extension' }) {
  const id = uid();
  db.syncRuns[id] = {
    id, kinds, trigger, client, startedAt: new Date().toISOString(), finishedAt: null,
    status: 'läuft', parts: {}, errors: [], checks: [],
  };
  for (const k of kinds) {
    db.areaStatus[k] = { ...(db.areaStatus[k] || {}), lastAttemptAt: db.syncRuns[id].startedAt, lastRunId: id, lastStatus: 'läuft' };
  }
  return db.syncRuns[id];
}

function addChange(db, runId, type, memberId, detail) {
  const id = uid();
  db.changes[id] = { id, runId, at: new Date().toISOString(), type, memberId: memberId || null, detail };
}

function markPart(db, run, kind, status, info) {
  run.parts[kind] = { status, at: new Date().toISOString(), ...info };
  const a = db.areaStatus[kind] || {};
  a.lastAttemptAt = run.parts[kind].at;
  a.lastStatus = status;
  a.lastRunId = run.id;
  if (status === 'vollständig') a.lastSuccessAt = run.parts[kind].at;
  db.areaStatus[kind] = a;
}

/** Downline-Teil einspielen */
export function ingestDownline(db, runId, part) {
  const run = db.syncRuns[runId];
  if (!run) throw new Error('Unbekannter Abgleichlauf');
  const parsed = parseDownline(part);
  const now = new Date().toISOString();
  const seen = new Set();
  let created = 0, updated = 0;
  for (const m of parsed.members) {
    if (db.suppressed[m.id]) continue;
    seen.add(m.id);
    const prev = db.members[m.id];
    const next = { ...(prev || {}), ...m, inDownline: true, missingSince: null, lastSeenAt: now, lastRunId: runId };
    if (!prev) {
      next.firstSeenAt = now;
      created++;
      // Erste Befüllung erzeugt keine "neu"-Meldungen, sonst wären alle 334 neu.
      if (db.meta.initialSyncDone) addChange(db, runId, 'neues_mitglied', m.id, { name: m.name, art: m.memberType, eingeschrieben: m.entryDate });
    } else {
      const d = diffFields(prev, next, TRACKED);
      if (Object.keys(d).length) {
        updated++;
        next.history = [...(prev.history || []), { at: now, runId, changes: d }].slice(-50);
        addChange(db, runId, 'mitglied_geändert', m.id, d);
      }
    }
    db.members[m.id] = next;
  }
  if (part.focusId && cleanId(part.focusId)) db.settings.ownerId = part.focusId;

  for (const mm of parsed.months) {
    if (db.suppressed[mm.id]) continue;
    const key = `${mm.id}|${mm.month}`;
    const prev = db.memberMonths[key];
    const vals = { ov: mm.ov ?? null, pv: mm.pv ?? null, qualPv: mm.qualPv ?? null, lrpPv: mm.lrpPv ?? null, pgv: mm.pgv ?? null, tgv: mm.tgv ?? null };
    if (!prev) db.memberMonths[key] = { id: mm.id, month: mm.month, ...vals, firstObservedAt: now, observedAt: now };
    else {
      const changed = Object.keys(vals).some((k) => prev[k] !== vals[k]);
      db.memberMonths[key] = { ...prev, ...vals, observedAt: now, ...(changed ? { previous: Object.fromEntries(Object.keys(vals).map((k) => [k, prev[k]])), changedAt: now } : {}) };
    }
  }

  // Vollständigkeit prüfen: erwartete Gesamtzahl laut Quelle vs. erhaltene Zeilen
  const expected = Number(part.expectedTotal);
  const received = parsed.members.length;
  // Vollständig nur, wenn die Quelle eine Gesamtzahl nennt und mindestens so viele Zeilen ankamen.
  // (doTERRA zählt z. B. Mitgliedsart "S" nicht mit -> eine Zeile mehr ist kein Fehler, wird aber vermerkt.)
  const complete = part.complete === true && Number.isFinite(expected) && received >= expected;
  run.checks.push({ kind: 'downline', check: 'Anzahl Mitglieder', quelle: Number.isFinite(expected) ? expected : null, erhalten: received, ok: complete, hinweis: complete && received > expected ? `${received - expected} Zeile(n) mehr als von doTERRA gezählt` : null });

  if (complete) {
    for (const [id, m] of Object.entries(db.members)) {
      if (!seen.has(id) && m.inDownline !== false) {
        m.inDownline = false;
        m.missingSince = now;
        addChange(db, runId, 'nicht_mehr_in_downline', id, { name: m.name });
      }
    }
    db.meta.initialSyncDone = true;
  }
  markPart(db, run, 'downline', complete ? 'vollständig' : 'unvollständig', {
    received, expected: Number.isFinite(expected) ? expected : null, created, updated,
    monthsCovered: parsed.monthsCovered, problems: parsed.problems.slice(0, 20),
  });
  return { received, expected, complete, created, updated, problems: parsed.problems.length };
}

/** Schlagdistanz: Teamlinien-Zuordnung (Leg-ID) und Monatsrang */
export function ingestLegs(db, runId, part) {
  const run = db.syncRuns[runId];
  const H = (part.headers || []).map(norm);
  const idx = (name) => H.indexOf(name);
  const iId = idx('mitglieds-id'), iLeg = idx('leg id'), iLevel = idx('level'), iRank = idx('rang'), iPct = idx('% to rank'), iPv = idx('pv'), iOv = idx('ov');
  if ([iId, iLeg, iRank].some((i) => i < 0)) throw new StructureError('Schlagdistanz: Spalten Mitglieds-ID / Leg ID / Rang fehlen.');
  const month = part.month || localMonth();
  const legCols = H.map((h, i) => [h, i]).filter(([h]) => / beine$/.test(h));
  const now = new Date().toISOString();
  let n = 0;
  for (const cells of part.rows || []) {
    const id = cleanId(cells[iId]);
    if (!id || db.suppressed[id]) continue;
    const legsByRank = {};
    for (const [h, i] of legCols) legsByRank[h.replace(' beine', '')] = parseNum(cells[i]);
    db.legs[`${id}|${month}`] = {
      id, month, legId: cleanId(cells[iLeg]) || (String(cells[iLeg]).trim() === '0' ? '0' : null),
      level: parseNum(cells[iLevel]), monthRank: clean(cells[iRank]),
      pctToRank: parseNum(String(cells[iPct] || '').replace('%', '')),
      targetRank: part.targetRank || null, pv: parseNum(cells[iPv]), ov: parseNum(cells[iOv]),
      legsByRank, observedAt: now,
    };
    n++;
  }
  const expected = Number(part.expectedTotal);
  const complete = part.complete === true && (!Number.isFinite(expected) || n >= expected);
  run.checks.push({ kind: 'legs', check: 'Zeilen Schlagdistanz', quelle: Number.isFinite(expected) ? expected : null, erhalten: n, ok: complete });
  markPart(db, run, 'legs', complete ? 'vollständig' : 'unvollständig', { received: n, month });
  return { received: n, complete };
}

/** Bestellhistorie je Mitglied */
export function ingestOrders(db, runId, part) {
  const run = db.syncRuns[runId];
  const now = new Date().toISOString();
  let created = 0, changed = 0, membersComplete = 0, membersIncomplete = 0;
  for (const mem of part.members || []) {
    const memberId = cleanId(mem.memberId);
    if (!memberId || db.suppressed[memberId]) continue;
    const orders = parseOrderRows(part.headers || mem.headers || [], mem.rows || [], memberId, db.members[memberId]?.contact?.country);
    const hadCoverage = !!db.orderCoverage[memberId];
    for (const o of orders) {
      const prev = db.orders[o.invoice];
      if (!prev) {
        db.orders[o.invoice] = { ...o, firstSeenAt: now, lastSeenAt: now };
        created++;
        if (hadCoverage) addChange(db, runId, 'neue_bestellung', memberId, { rechnung: o.invoice, pvMonat: o.pvMonth, volumen: o.volume, lrp: o.isLrp });
      } else {
        const d = diffFields(prev, o, ['status', 'shipDate', 'items', 'volume', 'amount', 'pvMonth', 'typeCode', 'sourceCode', 'date']);
        db.orders[o.invoice] = { ...prev, ...o, lastSeenAt: now, ...(Object.keys(d).length ? { changedAt: now, history: [...(prev.history || []), { at: now, changes: d }].slice(-20) } : {}) };
        if (Object.keys(d).length) { changed++; addChange(db, runId, 'bestellung_geändert', memberId, { rechnung: o.invoice, ...d }); }
      }
    }
    if (mem.complete) {
      membersComplete++;
      const prevCov = db.orderCoverage[memberId];
      db.orderCoverage[memberId] = {
        fromMonth: prevCov?.fromMonth && prevCov.fromMonth < mem.fromMonth ? prevCov.fromMonth : mem.fromMonth,
        fetchedAt: now, lastOrderDateSeen: db.members[memberId]?.lastOrderDate || null,
      };
    } else membersIncomplete++;
  }
  const planned = Number(part.plannedMembers);
  const complete = part.complete === true && membersIncomplete === 0 && (!Number.isFinite(planned) || planned === membersComplete);
  run.checks.push({ kind: 'orders', check: 'Mitglieder mit vollständiger Bestellhistorie', quelle: Number.isFinite(planned) ? planned : null, erhalten: membersComplete, ok: complete });
  markPart(db, run, 'orders', complete ? 'vollständig' : 'unvollständig', { created, changed, membersComplete, membersIncomplete });
  return { created, changed, membersComplete, membersIncomplete, complete };
}

/** Provisionsübersicht (einzige belastbare Geldbeträge) */
export function ingestCommissions(db, runId, part) {
  const run = db.syncRuns[runId];
  let n = 0;
  for (const table of part.tables || []) {
    const kind = table.kind === 'secondary' ? 'secondary' : 'primary';
    const H = (table.headers || []).map(norm);
    const iP = H.indexOf('zeitraum'), iE = H.indexOf('verdienst'), iF = H.indexOf('gebühren'), iW = H.indexOf('zurückgehaltener betrag'), iA = H.indexOf('auszuzahlender betrag');
    if (iP < 0 || iE < 0) throw new StructureError('Provisionsübersicht: Spalten fehlen.');
    // Primärbonus: Zeitraum = Monat (MM/YYYY). Sekundärbonus: Zeitraum = Kalenderwoche (WW/YYYY, bis 52/53).
    // Erkennung zusätzlich über Werte > 12, damit Wochen nie als Monate gelesen werden.
    const periods = (table.rows || []).map((c) => String(c[iP] || '').replace(INVIS, '').trim());
    const weekly = kind === 'secondary' || periods.some((p) => Number(p.split('/')[0]) > 12);
    for (const cells of table.rows || []) {
      const raw = String(cells[iP] || '').replace(INVIS, '').trim();
      const m = raw.match(/^(\d{1,2})\/(\d{4})$/);
      if (!m) continue;
      const period = weekly ? `${m[2]}-W${m[1].padStart(2, '0')}` : `${m[2]}-${m[1].padStart(2, '0')}`;
      db.commissions[`${period}|${kind}`] = {
        period, periodType: weekly ? 'woche' : 'monat', month: weekly ? null : period, kind,
        earned: parseNum(cells[iE]), fees: parseNum(cells[iF]), withheld: parseNum(cells[iW]),
        payout: parseNum(cells[iA]), currency: part.currency || 'EUR', observedAt: new Date().toISOString(),
      };
      n++;
    }
  }
  markPart(db, run, 'commissions', part.complete ? 'vollständig' : 'unvollständig', { received: n });
  return { received: n };
}

/** Lauf abschließen. Status wird aus den Teilen abgeleitet, nicht vom Client übernommen. */
export function finishRun(db, runId, { clientStatus, error } = {}) {
  const run = db.syncRuns[runId];
  if (!run) throw new Error('Unbekannter Abgleichlauf');
  run.finishedAt = new Date().toISOString();
  if (error) run.errors.push(String(error).slice(0, 500));
  const parts = run.kinds.map((k) => run.parts[k]?.status);
  let status;
  if (clientStatus === 'session_expired') status = 'sitzung_abgelaufen';
  else if (clientStatus === 'structure_changed') status = 'struktur_geändert';
  else if (parts.every((s) => s === 'vollständig')) status = 'erfolgreich';
  else if (parts.some((s) => s === 'vollständig' || s === 'unvollständig')) status = 'teilweise';
  else status = 'fehlgeschlagen';
  run.status = status;
  for (const k of run.kinds) {
    if (!run.parts[k]) {
      db.areaStatus[k] = { ...(db.areaStatus[k] || {}), lastStatus: status === 'erfolgreich' ? 'fehlt' : status, lastRunId: runId, lastAttemptAt: run.finishedAt };
    }
  }
  run.changeCount = Object.values(db.changes).filter((c) => c.runId === runId).length;
  return run;
}

/** Plan für Bestellabruf: wen muss die Erweiterung abfragen? */
export function orderPlan(db, { monthsBack = 12, full = false } = {}) {
  const cur = localMonth();
  const [y, m] = cur.split('-').map(Number);
  const t = y * 12 + (m - 1) - monthsBack;
  const fromMonth = `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
  const plan = [];
  for (const mem of Object.values(db.members)) {
    if (mem.inDownline === false || db.suppressed[mem.id]) continue;
    if (mem.id === db.settings.ownerId) continue; // eigene Bestellungen laufen über shop.doterra.com (offen)
    const cov = db.orderCoverage[mem.id];
    const openOrders = Object.values(db.orders).some((o) => o.memberId === mem.id && o.status === 'offen');
    const changedSince = !cov || cov.lastOrderDateSeen !== mem.lastOrderDate;
    if (!mem.lastOrderDate && cov) continue; // nie bestellt, schon geprüft
    if (full || !cov || changedSince || openOrders || cov.fromMonth > fromMonth) {
      const entry = mem.entryDate ? mem.entryDate.slice(0, 7) : null;
      plan.push({ memberId: mem.id, fromMonth: entry && entry > fromMonth ? entry : fromMonth });
    }
  }
  return { fromMonth, members: plan };
}
