// Abnahmetests. Ausführen: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { emptyDb, Store } from '../lib/store.mjs';
import * as sync from '../lib/sync.mjs';
import { computeAll, memberStats, context, rankPlan } from '../lib/kpi.mjs';
import { proposeFromNote, resolveDates } from '../lib/notes.mjs';
import { buildFacts, validateAnswer } from '../lib/assistant.mjs';
import { localDate, parseNum } from '../lib/util.mjs';
import { createApp } from '../server.mjs';
import { makeOrg, downlinePayload, legsPayload, ORDER_HEADERS, orderRow, commissionsPayload, OWNER } from './fixture.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'crm-test-'));
function runSync(db, kinds, fn) { const r = sync.startRun(db, { kinds }); fn(r.id); return sync.finishRun(db, r.id); }

test('1 Derselbe Import erzeugt keine Duplikate', () => {
  const db = emptyDb(); const org = makeOrg(60);
  runSync(db, ['downline'], (id) => sync.ingestDownline(db, id, downlinePayload(org)));
  const n1 = Object.keys(db.members).length, m1 = Object.keys(db.memberMonths).length;
  const r2 = runSync(db, ['downline'], (id) => sync.ingestDownline(db, id, downlinePayload(org)));
  assert.equal(Object.keys(db.members).length, n1);
  assert.equal(n1, 61);
  assert.equal(Object.keys(db.memberMonths).length, m1);
  assert.equal(r2.status, 'erfolgreich');
  assert.equal(r2.changeCount, 0, 'unveränderter Import erzeugt keine Änderungsmeldungen');
});

test('2 Geänderte Bestellungen werden korrekt übernommen (offen -> versandt)', () => {
  const db = emptyDb(); const org = makeOrg(10);
  runSync(db, ['downline'], (id) => sync.ingestDownline(db, id, downlinePayload(org)));
  const mid = org[3].id;
  const first = { kind: 'orders', headers: ORDER_HEADERS, plannedMembers: 1, complete: true, members: [{ memberId: mid, fromMonth: '2025-11', complete: true, rows: [orderRow({ invoice: '185001', items: [], date: '2026-11-09', pvMonth: '11/2026', volume: 148.5, amount: 162.33 })] }] };
  runSync(db, ['orders'], (id) => sync.ingestOrders(db, id, first));
  assert.equal(db.orders['185001'].status, 'offen');
  const second = structuredClone(first);
  second.members[0].rows = [orderRow({ invoice: '185001', items: [['60204656', 1], ['60220837', 2]], date: '2026-11-09', ship: '2026-11-10', pvMonth: '11/2026', volume: 150, amount: 170.1 })];
  const r = runSync(db, ['orders'], (id) => sync.ingestOrders(db, id, second));
  const o = db.orders['185001'];
  assert.equal(Object.keys(db.orders).length, 1, 'keine doppelte Rechnung');
  assert.equal(o.status, 'ausgeführt'); assert.equal(o.items.length, 2); assert.equal(o.items[1].qty, 2);
  assert.equal(o.volume, 150); assert.equal(o.amount, 170.1); assert.equal(o.currency, 'EUR');
  assert.ok(o.history?.length === 1, 'Änderungshistorie vorhanden');
  assert.ok(Object.values(db.changes).some((c) => c.runId === r.id && c.type === 'bestellung_geändert'));
});

test('3 Unvollständiger Abruf zerstört keinen gültigen Datenstand', () => {
  const db = emptyDb(); const org = makeOrg(40);
  runSync(db, ['downline'], (id) => sync.ingestDownline(db, id, downlinePayload(org)));
  const okAt = db.areaStatus.downline.lastSuccessAt;
  const before = Object.keys(db.members).length;
  // Seite 2 fehlt: 15 Zeilen weniger als von der Quelle angegeben
  const r = runSync(db, ['downline'], (id) => sync.ingestDownline(db, id, downlinePayload(org, { dropRows: 15, expectedTotal: 41 })));
  assert.equal(r.status, 'teilweise');
  assert.equal(Object.keys(db.members).length, before, 'nichts gelöscht');
  assert.ok(Object.values(db.members).every((m) => m.inDownline !== false), 'niemand fälschlich als ausgeschieden markiert');
  assert.equal(db.areaStatus.downline.lastSuccessAt, okAt, 'letzter erfolgreicher Abgleich bleibt unverändert');
  assert.equal(db.areaStatus.downline.lastStatus, 'unvollständig');
});

test('3b Seitenstruktur geändert: nichts wird geschrieben', () => {
  const db = emptyDb(); const org = makeOrg(5);
  const p = downlinePayload(org);
  p.headers = p.headers.map((h) => (h === 'ID Enroller*in' ? 'Irgendwas' : h));
  const r = sync.startRun(db, { kinds: ['downline'] });
  assert.throws(() => sync.ingestDownline(db, r.id, p), (e) => e.code === 'structure_changed');
  assert.equal(Object.keys(db.members).length, 0);
});

test('4 Abgelaufene Sitzung erzeugt einen sichtbaren Status', () => {
  const db = emptyDb();
  const r = sync.startRun(db, { kinds: ['downline', 'orders'] });
  const fin = sync.finishRun(db, r.id, { clientStatus: 'session_expired', error: 'nicht angemeldet' });
  assert.equal(fin.status, 'sitzung_abgelaufen');
  assert.equal(db.areaStatus.downline.lastStatus, 'sitzung_abgelaufen');
  assert.equal(db.areaStatus.downline.lastSuccessAt, undefined, 'kein Erfolg vorgetäuscht');
});

test('5 Kennzahlen stimmen mit Stichproben der Quelle überein; leer ≠ 0', () => {
  const db = emptyDb(); const org = makeOrg(60);
  runSync(db, ['downline', 'legs'], (id) => { sync.ingestDownline(db, id, downlinePayload(org)); sync.ingestLegs(db, id, legsPayload(org)); });
  const ref = new Date('2026-11-10T12:00:00Z');
  const c = computeAll(db, ref);
  // Stichprobe Kontoinhaberin: Oktober PV 291.5 laut Quelle
  assert.equal(db.memberMonths[`${OWNER}|2026-10`].pv, 291.5);
  assert.equal(c.trend.find((t) => t.monat === '2026-10').eigenesPv, 291.5);
  // OV Oktober = Summe PV (Regel des Testdatensatzes)
  const sumOkt = org.reduce((s, p) => s + (p.months['Oktober 2026']?.PV || 0), 0);
  assert.equal(c.trend.find((t) => t.monat === '2026-10').ov, sumOkt);
  // bestellaktive Personen im Oktober = Anzahl mit PV > 0 (ohne Kathrin)
  const buyers = org.filter((p) => p.id !== OWNER && (p.months['Oktober 2026']?.PV || 0) > 0).length;
  assert.equal(c.trend.find((t) => t.monat === '2026-10').kaeufer, buyers);
  // leere Zelle -> kein Monatsdatensatz (fehlend), nicht 0
  const inactive = org.find((p) => p.id !== OWNER && !p.months['Oktober 2026']);
  assert.equal(db.memberMonths[`${inactive.id}|2026-10`], undefined);
  assert.equal(parseNum(''), null); assert.equal(parseNum('0.00'), 0); assert.equal(parseNum('26,683.50'), 26683.5);
});

test('6 Monatsgrenzen, Zeitzone und Währungen', () => {
  // 30.11. 23:30 UTC ist in Berlin bereits der 1.12.
  assert.equal(localDate(new Date('2026-11-30T23:30:00Z')), '2026-12-01');
  assert.equal(localDate(new Date('2026-03-29T00:30:00Z')), '2026-03-29'); // Sommerzeitwechsel
  const db = emptyDb(); const org = makeOrg(10);
  runSync(db, ['downline'], (id) => sync.ingestDownline(db, id, downlinePayload(org)));
  const itaMember = org.find((p) => p.id.endsWith('7'));
  // Bestellung am 31.10., aber PV-Monat 11/2026 -> zählt laut Quelle für November
  runSync(db, ['orders'], (id) => sync.ingestOrders(db, id, { headers: ORDER_HEADERS, plannedMembers: 1, complete: true, members: [{ memberId: itaMember.id, fromMonth: '2025-11', complete: true, rows: [orderRow({ invoice: '200001', date: '2026-10-31', ship: '2026-11-02', pvMonth: '11/2026', volume: 100, amount: 120 })] }] }));
  assert.equal(db.orders['200001'].pvMonth, '2026-11');
  assert.equal(db.orders['200001'].currency, 'EUR', 'Italien -> EUR');
  // Provisionen: Sekundärbonus ist wöchentlich und darf nicht als Monat gelesen werden
  runSync(db, ['commissions'], (id) => sync.ingestCommissions(db, id, commissionsPayload()));
  assert.equal(db.commissions['2026-09|primary'].payout, 1752.46);
  assert.equal(db.commissions['2026-W09|secondary'].periodType, 'woche');
  assert.equal(db.commissions['2026-09|secondary'], undefined);
  assert.equal(sync.currencyFor('CHE'), 'CHF'); assert.equal(sync.currencyFor('XYZ'), null);
});

test('7 Manuelle Notizen und Profile bleiben beim Abgleich erhalten', () => {
  const db = emptyDb(); const org = makeOrg(20);
  runSync(db, ['downline'], (id) => sync.ingestDownline(db, id, downlinePayload(org)));
  const mid = org[4].id;
  db.profiles[mid] = { source: 'Yoga', nextStep: 'Testwoche besprechen', followUpDate: '2026-11-17' };
  db.notes.n1 = { id: 'n1', contactKey: mid, text: 'War beim Yoga.', createdAt: new Date().toISOString() };
  org[4].name = 'Neuname, Silke'; org[4].lrpActive = false; org[4].nextLrp = null;
  runSync(db, ['downline'], (id) => sync.ingestDownline(db, id, downlinePayload(org)));
  assert.equal(db.profiles[mid].source, 'Yoga'); assert.equal(db.profiles[mid].nextStep, 'Testwoche besprechen');
  assert.equal(db.notes.n1.text, 'War beim Yoga.');
  assert.equal(db.members[mid].name, 'Neuname, Silke');
});

test('8 Teamstruktur: Platzierung und Einschreibung getrennt, Leg ID geprüft', () => {
  const db = emptyDb(); const org = makeOrg(60);
  runSync(db, ['downline', 'legs'], (id) => { sync.ingestDownline(db, id, downlinePayload(org)); sync.ingestLegs(db, id, legsPayload(org)); });
  const c = computeAll(db, new Date('2026-11-10T12:00:00Z'));
  assert.equal(c.team.placementLines.length, org.filter((p) => p.sponsor === OWNER && p.id !== OWNER).length);
  assert.equal(c.team.legs.length, org.filter((p) => p.enroller === OWNER && p.id !== OWNER).length);
  assert.equal(c.team.konflikte.length, 0, 'Leg ID = Enroller-Kette');
  const someone = Object.entries(c.team.legSource).find(([, v]) => v.bein !== v.platzierungslinie);
  assert.ok(someone, 'es gibt Personen mit unterschiedlicher Platzierungs- und Einschreibungslinie');
  // gebrochene Kette -> ungeklärt statt geraten
  db.members[org[10].id].enrollerId = '99999999'; delete db.legs[`${org[10].id}|2026-11`];
  const c2 = computeAll(db, new Date('2026-11-10T12:00:00Z'));
  assert.equal(c2.team.legSource[org[10].id].bein, null);
});

test('9 Strategieempfehlungen lassen sich auf ihre Datengrundlage zurückführen', () => {
  const db = emptyDb(); const org = makeOrg(30);
  runSync(db, ['downline'], (id) => sync.ingestDownline(db, id, downlinePayload(org)));
  const { facts } = buildFacts(db, new Date('2026-11-10T12:00:00Z'));
  assert.ok(facts.length > 10);
  const all = JSON.stringify(facts);
  assert.ok(!all.includes('@example.invalid') && !all.includes('+49 000'), 'keine E-Mails oder Telefonnummern an die KI');
  const ans = validateAnswer({ kurzantwort: 'x', empfehlungen: [
    { titel: 'belegt', beobachtung: 'siehe F1', begruendung: 'b', naechster_schritt: 'n', fakten: ['F1'] },
    { titel: 'erfunden', beobachtung: 'ohne Beleg', fakten: ['F999'] },
    { titel: 'falsche Zahl', beobachtung: 'Es sind 4711 Kundinnen', begruendung: '', naechster_schritt: '', fakten: ['F2'] },
  ] }, facts);
  assert.equal(ans.empfehlungen.length, 2);
  assert.equal(ans.pruefhinweise.length, 1);
  assert.deepEqual(ans.empfehlungen[1].ungepruefteZahlen, ['4711']);
});

test('10 Schnellnotiz: Kontaktvorschlag, Datum, Rückfragen, Gesundheitsangaben', () => {
  const db = emptyDb();
  db.members['1'] = { id: '1', name: 'Schuchardt, Silke', memberType: 'Vorteilskundin' };
  db.members['2'] = { id: '2', name: 'Meier, Anna', memberType: 'Beraterin' };
  const text = 'Silke war beim Yoga dabei, hat eine Testwoche gemacht und möchte nächsten Dienstag noch einmal sprechen.';
  const p = proposeFromNote(text, db, '2026-11-10'); // Dienstag
  assert.equal(p.kontaktEindeutig, '1');
  assert.equal(p.aufgabe.due, '2026-11-17');
  assert.ok(p.notiz.quellenHinweis.includes('Yoga')); assert.ok(p.testwoche);
  // zweite Silke -> Rückfrage statt stiller Zuordnung
  db.members['3'] = { id: '3', name: 'Siegel, Silke', memberType: 'Vorteilskundin' };
  const p2 = proposeFromNote(text, db, '2026-11-10');
  assert.equal(p2.kontaktEindeutig, null); assert.ok(p2.fragen.some((f) => f.typ === 'kontakt'));
  // Montag: "nächsten Mittwoch" ist mehrdeutig
  const d = resolveDates('nächsten Mittwoch treffen', '2026-11-09');
  assert.ok(d[0].ambiguous); assert.deepEqual(d[0].options, ['2026-11-11', '2026-11-18']);
  const p3 = proposeFromNote('Anna hat Migräne erwähnt', db, '2026-11-10');
  assert.ok(p3.notiz.sensibel && p3.fragen.some((f) => f.typ === 'sensibel'));
});

test('11 Sicherung lässt sich wiederherstellen; ungültige wird abgelehnt', () => {
  const dir = tmp(); const store = new Store(dir); const org = makeOrg(15);
  store.transact((db) => runSync(db, ['downline'], (id) => sync.ingestDownline(db, id, downlinePayload(org))));
  store.transact((db) => { db.notes.a = { id: 'a', contactKey: org[2].id, text: 'wichtig', createdAt: 'x' }; });
  const name = store.backup('test');
  store.transact((db) => { delete db.notes.a; db.members = {}; });
  assert.equal(Object.keys(store.db.members).length, 0);
  store.restore(name);
  assert.equal(store.db.notes.a.text, 'wichtig'); assert.equal(Object.keys(store.db.members).length, 16);
  const reloaded = new Store(dir); // von Platte
  assert.equal(reloaded.db.notes.a.text, 'wichtig');
  assert.throws(() => store.restore({ foo: 1 }), /ungültig/);
  assert.ok(store.listBackups().some((b) => b.name.includes('vor-wiederherstellung')));
});

test('12 Rangplanung nutzt nur geprüfte Regeln und zeigt Quelle', () => {
  const db = emptyDb(); const org = makeOrg(30);
  runSync(db, ['downline', 'legs'], (id) => { sync.ingestDownline(db, id, downlinePayload(org)); sync.ingestLegs(db, id, legsPayload(org)); });
  const c = computeAll(db, new Date('2026-11-10T12:00:00Z'));
  const gold = rankPlan(db, c.ctx, c.team, 'Gold');
  assert.equal(gold.status, 'geprüft'); assert.ok(gold.quelle.includes('Rank Tracker'));
  assert.ok(gold.bedingungen.some((b) => /3 Beine mit Rang Premier/.test(b.bedingung)));
  const plat = rankPlan(db, c.ctx, c.team, 'Platinum');
  assert.ok(!plat.bedingungen && /keine geprüften Bedingungen/.test(plat.hinweis));
});

// ---------------- Server: Rollen, Herkunft, Ende-zu-Ende ----------------
async function startServer() {
  const dir = tmp();
  const app = createApp({ dataDir: dir, env: { ANTHROPIC_API_KEY: '' } });
  const server = await app.listen(0);
  const port = server.address().port;
  const call = (method, p, { body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'content-type': 'application/json', host: `127.0.0.1:${port}`, ...headers } }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { let j = d; try { j = JSON.parse(d); } catch {} resolve({ status: res.statusCode, body: j, headers: res.headers }); }); });
    req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
  return { app, server, call };
}

test('13 Rollenrechte verhindern unberechtigte Zugriffe', async () => {
  const { app, server, call } = await startServer();
  try {
    assert.equal((await call('GET', '/api/overview')).status, 401, 'ohne Anmeldung');
    assert.equal((await call('GET', '/api/contacts', { headers: { 'x-sync-token': app.cfg.syncToken } })).status, 403, 'Abgleich-Schlüssel darf keine Kontakte lesen');
    assert.equal((await call('GET', '/api/sync/ping', { headers: { 'x-sync-token': 'falsch' } })).status, 401);
    assert.equal((await call('GET', '/api/sync/ping', { headers: { 'x-sync-token': app.cfg.syncToken } })).status, 200);
    assert.equal((await call('POST', '/api/setup', { body: { pin: '12' } })).status, 400);
    assert.equal((await call('POST', '/api/setup', { body: { pin: '246813' } })).status, 200);
    assert.equal((await call('POST', '/api/setup', { body: { pin: '111111' } })).status, 409, 'PIN nicht überschreibbar');
    assert.equal((await call('POST', '/api/login', { body: { pin: '000000' } })).status, 401);
    const login = await call('POST', '/api/login', { body: { pin: '246813' } });
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    assert.match(login.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
    assert.equal((await call('GET', '/api/overview', { headers: { cookie } })).status, 200);
    assert.equal((await call('POST', '/api/tasks', { headers: { cookie }, body: { title: 'x' } })).status, 403, 'ohne CRM-Kennung (CSRF-Schutz)');
    assert.equal((await call('POST', '/api/tasks', { headers: { cookie, 'x-requested-with': 'crm', origin: 'https://evil.example' }, body: { title: 'x' } })).status, 403, 'fremde Herkunft');
    assert.equal((await call('POST', '/api/tasks', { headers: { cookie, 'x-requested-with': 'crm' }, body: { title: 'Rückruf' } })).status, 200);
    assert.equal((await call('GET', '/api/overview', { headers: { cookie, host: 'evil.example' } })).status, 403, 'nur lokaler Host');
    // Nur-Lesen-Rolle (vorbereitet): darf lesen, nicht schreiben
    app.sessions.set('viewer-test', { role: 'viewer', exp: Date.now() + 1e6 });
    const vc = { cookie: 'sid=viewer-test', 'x-requested-with': 'crm' };
    assert.equal((await call('GET', '/api/tasks', { headers: vc })).status, 200, 'Lesen erlaubt');
    assert.equal((await call('POST', '/api/tasks', { headers: vc, body: { title: 'x' } })).status, 403, 'Schreiben verboten');
    assert.equal((await call('POST', '/api/sync/start', { headers: vc, body: { kinds: ['downline'] } })).status, 403, 'Abgleich verboten');
  } finally { server.close(); }
});

test('14 Ende-zu-Ende über die API: Abgleich, Kontaktansicht, Notiz bleibt erhalten', async () => {
  const { app, server, call } = await startServer();
  try {
    const T = { 'x-sync-token': app.cfg.syncToken };
    const org = makeOrg(25);
    const start = await call('POST', '/api/sync/start', { headers: T, body: { kinds: ['downline', 'legs', 'commissions'] } });
    assert.equal(start.status, 200);
    const runId = start.body.runId;
    assert.equal((await call('POST', `/api/sync/${runId}/part`, { headers: T, body: downlinePayload(org) })).status, 200);
    assert.equal((await call('POST', `/api/sync/${runId}/part`, { headers: T, body: legsPayload(org) })).status, 200);
    assert.equal((await call('POST', `/api/sync/${runId}/part`, { headers: T, body: commissionsPayload() })).status, 200);
    const fin = await call('POST', `/api/sync/${runId}/finish`, { headers: T, body: {} });
    assert.equal(fin.body.status, 'erfolgreich');
    // Strukturfehler wird als 422 gemeldet und am Lauf vermerkt
    const s2 = await call('POST', '/api/sync/start', { headers: T, body: { kinds: ['downline'] } });
    const bad = downlinePayload(org); bad.headers = bad.headers.filter((h) => h !== 'Mitgliedsart');
    assert.equal((await call('POST', `/api/sync/${s2.body.runId}/part`, { headers: T, body: bad })).status, 422);
    assert.equal((await call('POST', `/api/sync/${s2.body.runId}/finish`, { headers: T, body: { status: 'structure_changed' } })).body.status, 'struktur_geändert');
    assert.equal(app.store.db.areaStatus.downline.lastStatus, 'struktur_geändert');
    assert.ok(app.store.db.areaStatus.downline.lastSuccessAt, 'früherer Erfolg bleibt sichtbar');
    // Anmeldung + Kontaktansicht
    await call('POST', '/api/setup', { body: { pin: '135790' } });
    const cookie = (await call('POST', '/api/login', { body: { pin: '135790' } })).headers['set-cookie'][0].split(';')[0];
    const H = { cookie, 'x-requested-with': 'crm' };
    const mid = org[3].id;
    const detail = await call('GET', `/api/contacts/${mid}`, { headers: H });
    assert.equal(detail.status, 200); assert.equal(detail.body.source.id, mid);
    assert.ok(detail.body.team.bein || detail.body.team.beinQuelle === 'ungeklärt');
    await call('POST', '/api/notes', { headers: H, body: { contactKey: mid, text: 'Möchte am Workshop teilnehmen.' } });
    await call('PUT', `/api/contacts/${mid}/profile`, { headers: H, body: { source: 'Instagram', followUpDate: '2026-11-20' } });
    // erneuter Abgleich mit geänderten Daten
    org[3].name = 'Geändert, Name';
    const s3 = await call('POST', '/api/sync/start', { headers: T, body: { kinds: ['downline'] } });
    await call('POST', `/api/sync/${s3.body.runId}/part`, { headers: T, body: downlinePayload(org) });
    await call('POST', `/api/sync/${s3.body.runId}/finish`, { headers: T, body: {} });
    const after = await call('GET', `/api/contacts/${mid}`, { headers: H });
    assert.equal(after.body.source.name, 'Geändert, Name');
    assert.equal(after.body.notes[0].text, 'Möchte am Workshop teilnehmen.');
    assert.equal(after.body.profile.source, 'Instagram');
    const ov = await call('GET', '/api/overview', { headers: H });
    assert.equal(ov.status, 200); assert.ok(ov.body.changes.some((c) => c.type === 'mitglied_geändert'));
    // Assistent ohne Schlüssel: ehrlicher Hinweis + Datengrundlage
    const as = await call('POST', '/api/assistant', { headers: H, body: { question: 'Wen soll ich anrufen?' } });
    assert.equal(as.body.ok, false); assert.ok(as.body.facts.length > 5);
    // Backups automatisch angelegt
    assert.ok(app.store.listBackups().some((b) => b.name.includes('vor-abgleich')));
    // Export und Löschung
    assert.equal((await call('GET', '/api/export/contacts.csv', { headers: H })).status, 200);
    const del = await call('DELETE', `/api/contacts/${mid}?source=1`, { headers: H });
    assert.equal(del.status, 200);
    assert.equal(app.store.db.members[mid], undefined); assert.ok(app.store.db.suppressed[mid]);
    const s4 = await call('POST', '/api/sync/start', { headers: T, body: { kinds: ['downline'] } });
    await call('POST', `/api/sync/${s4.body.runId}/part`, { headers: T, body: downlinePayload(org) });
    assert.equal(app.store.db.members[mid], undefined, 'gelöschte Person wird nicht reimportiert');
  } finally { server.close(); }
});

test('15 Abgleich-Datei importieren: ersetzt Beispieldaten, kennzeichnet echte Daten, gleiche Prüfungen', async () => {
  const { app, server, call } = await startServer();
  try {
    app.store.transact((d) => { d.meta.dataKind = 'beispiel'; d.members['1'] = { id: '1', name: 'Beispiel, Alt' }; });
    await call('POST', '/api/setup', { body: { pin: '864209' } });
    const cookie = (await call('POST', '/api/login', { body: { pin: '864209' } })).headers['set-cookie'][0].split(';')[0];
    const H = { cookie, 'x-requested-with': 'crm' };
    const org = makeOrg(40);
    const bundle = { format: 'kathrins-crm-sync-bundle', version: 1, createdAt: new Date().toISOString(), errors: {}, parts: {
      downline: downlinePayload(org), legs: legsPayload(org), commissions: commissionsPayload(),
      orders: { kind: 'orders', headers: ORDER_HEADERS, plannedMembers: 1, complete: true, members: [{ memberId: org[2].id, fromMonth: '2025-11', complete: true, rows: [orderRow({ invoice: '777001', date: '2026-11-02', ship: '2026-11-03', pvMonth: '11/2026', volume: 120, amount: 140 })] }] },
    } };
    assert.equal((await call('POST', '/api/sync/import-bundle', { headers: H, body: { bundle: { foo: 1 } } })).status, 400, 'falsches Format abgelehnt');
    assert.equal((await call('POST', '/api/sync/import-bundle', { headers: { 'x-sync-token': app.cfg.syncToken }, body: { bundle } })).status, 403, 'nur angemeldete Nutzerin');
    const r = await call('POST', '/api/sync/import-bundle', { headers: H, body: { bundle, replace: true } });
    assert.equal(r.status, 200); assert.equal(r.body.run.status, 'erfolgreich');
    assert.equal(app.store.db.members['1'], undefined, 'Beispieldaten entfernt');
    assert.equal(Object.keys(app.store.db.members).length, 41);
    assert.equal(app.store.db.meta.dataKind, 'echt');
    assert.equal((await call('GET', '/api/status')).body.demo, false, 'kein Beispieldaten-Hinweis mehr');
    assert.ok(app.store.listBackups().some((b) => b.name.includes('vor-datei-import')), 'vorher gesichert');
    // zweiter Import derselben Datei ohne Ersetzen: keine Duplikate
    const r2 = await call('POST', '/api/sync/import-bundle', { headers: H, body: { bundle } });
    assert.equal(r2.body.run.changeCount, 0); assert.equal(Object.keys(app.store.db.orders).length, 1);
    // Zeitplan-Einstellung
    const set = await call('PUT', '/api/settings', { headers: H, body: { autoSync: { enabled: true, mode: 'daily', time: '05:00' } } });
    assert.deepEqual([set.body.autoSync.mode, set.body.autoSync.time], ['daily', '05:00']);
    const ping = await call('GET', '/api/sync/ping', { headers: { 'x-sync-token': app.cfg.syncToken } });
    assert.equal(ping.body.autoSync.time, '05:00'); assert.ok(ping.body.lastSuccessAt);
  } finally { server.close(); }
});
