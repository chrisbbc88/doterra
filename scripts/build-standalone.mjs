// Baut eine einzelne Test-HTML-Datei (dist/kathrins-crm-test.html), die den echten Server-Code,
// Abgleich, Kennzahlen, Assistent und Oberfläche enthält und komplett im Browser läuft.
// Daten: Beispieldaten oder eine importierte Abgleich-Datei; gespeichert in IndexedDB dieses Browsers (nie im Netz).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const MODULES = [
  ['util', 'lib/util.mjs'], ['store', 'lib/store.mjs'], ['sync', 'lib/sync.mjs'], ['kpi', 'lib/kpi.mjs'],
  ['notes', 'lib/notes.mjs'], ['assistant', 'lib/assistant.mjs'], ['fixture', 'tests/fixture.mjs'], ['server', 'server.mjs'],
];
const NODE_MAP = { 'node:crypto': 'NODE.crypto', 'node:fs': 'NODE.fs', 'node:path': 'NODE.path', 'node:url': 'NODE.url', 'node:http': 'NODE.http' };

function transform(name, src) {
  src = src.replace(/^#!.*\n/, '');
  // Feste Basis statt Seiten-URL: sonst ändert ein #/anker den Speicherpfad
  src = src.replace(/import\.meta\.url/g, "'file:///crm/app.mjs'");
  src = src.replace(/^import\s+(.+?)\s+from\s+['"](.+?)['"];?[ \t]*$/gm, (_, clause, spec) => {
    const target = NODE_MAP[spec] || ('M_' + path.basename(spec).replace(/\.m?js$/, ''));
    clause = clause.trim();
    if (clause.startsWith('* as ')) return `const ${clause.slice(5).trim()} = ${target};`;
    if (clause.startsWith('{')) return `const ${clause.replace(/\s+as\s+/g, ': ')} = ${target};`;
    return `const ${clause} = ${target};`;
  });
  const names = [];
  src = src.replace(/^export\s+(async\s+function|function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm, (_, kind, n) => { names.push(n); return `${kind} ${n}`; });
  if (/^export\s/m.test(src)) throw new Error(`${name}: nicht unterstützter export`);
  return `const M_${name} = (() => {\n${src}\nreturn { ${names.join(', ')} };\n})();\n`;
}

const RULES = read('rules/ranks.json');
const css = read('public/styles.css');
const appJs = read('public/app.js');
const icon = 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'public/icon.png')).toString('base64');
const bodyHtml = read('public/index.html').match(/<body>([\s\S]*)<\/body>/)[1].replace(/<script[^>]*><\/script>/g, '');

// Module in Abhängigkeitsreihenfolge; Store/Util werden nach der Auswertung für den Browser gepatcht.
let modulesCode = '';
for (const [name, file] of MODULES) {
  let src = read(file);
  if (name === 'assistant') src = src.replace("Kein Claude-API-Schlüssel hinterlegt (Datei .env).", "Kein Claude-API-Schlüssel hinterlegt – in der Testversion unten links über 🧪 Testlabor eintragen.");
  if (name === 'kpi') src = src.replace("new URL('../rules/ranks.json', import.meta.url)", "'rules/ranks.json'");
  modulesCode += transform(name, src);
  if (name === 'util') modulesCode += 'patchUtil(M_util);\n';
  if (name === 'store') modulesCode += 'M_store.Store = makeBrowserStore(M_store, M_util);\n';
}

const shim = String.raw`
// ===================== Browser-Laufzeit (ersetzt Node.js) =====================
// Speicher: IndexedDB (groß genug für echte Daten), synchron nutzbar über einen vorab geladenen Zwischenspeicher.
const KV = await (async () => {
  const open = () => new Promise((res, rej) => { const r = indexedDB.open('kathrins-crm-test', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  let idb = null; const map = new Map();
  try {
    idb = await open();
    await new Promise((res, rej) => { const rq = idb.transaction('kv').objectStore('kv').openCursor(); rq.onsuccess = () => { const c = rq.result; if (c) { map.set(c.key, c.value); c.continue(); } else res(); }; rq.onerror = () => rej(rq.error); });
  } catch (e) { console.warn('IndexedDB nicht verfügbar – Daten bleiben nur bis zum Schließen erhalten', e); }
  try { for (const k of Object.keys(localStorage)) if (k.startsWith('crmtest:') && !map.has(k)) map.set(k, localStorage.getItem(k)); } catch {}
  let chain = Promise.resolve();
  const persist = (fn) => { if (!idb) return; chain = chain.then(() => new Promise((res) => { const tx = idb.transaction('kv', 'readwrite'); fn(tx.objectStore('kv')); tx.oncomplete = res; tx.onerror = () => { console.error('Speichern fehlgeschlagen', tx.error); res(); }; })); };
  for (const [k, v] of map) persist((st) => st.put(v, k));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { v = String(v); map.set(k, v); persist((st) => st.put(v, k)); },
    removeItem: (k) => { map.delete(k); persist((st) => st.delete(k)); },
    clear: async () => { map.clear(); persist((st) => st.clear()); try { for (const k of Object.keys(localStorage)) if (k.startsWith('crmtest:')) localStorage.removeItem(k); } catch {} await chain; },
    flush: () => chain,
  };
})();
const LS = 'crmtest:';
const RULES_JSON = ${JSON.stringify(RULES)};
globalThis.process = { env: {}, argv: [], pid: 1 };
globalThis.Buffer = { concat: (arr) => ({ toString: () => arr.map((c) => c.s).join('') }), isBuffer: () => false };
function demoHash(s) { let h1 = 0xdeadbeef, h2 = 0x41c6ce57; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); } h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909); h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909); return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0'); }
const b64url = (a) => btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const NODE = {
  crypto: {
    randomUUID: () => crypto.randomUUID(),
    randomBytes: (n) => { const a = crypto.getRandomValues(new Uint8Array(n)); return { toString: (enc) => enc === 'hex' ? [...a].map((b) => b.toString(16).padStart(2, '0')).join('') : b64url(a) }; },
    scryptSync: () => { throw new Error('nicht im Browser'); }, timingSafeEqual: (a, b) => a === b,
  },
  fs: {
    existsSync: (p) => String(p).endsWith('ranks.json') || KV.getItem(LS + p) !== null,
    readFileSync: (p) => { if (String(p).endsWith('ranks.json')) return RULES_JSON; const v = KV.getItem(LS + p); if (v === null) throw new Error('Datei fehlt: ' + p); return v; },
    mkdirSync: () => {}, readdirSync: () => [], statSync: () => ({ size: 0, mtime: new Date(), isDirectory: () => false }), unlinkSync: () => {},
    createReadStream: () => { throw new Error('nicht im Browser'); },
  },
  path: {
    join: (...a) => a.filter(Boolean).join('/').replace(/\/+/g, '/'), resolve: (...a) => a.filter(Boolean).join('/').replace(/\/+/g, '/'),
    dirname: (p) => String(p).split('/').slice(0, -1).join('/') || '.', normalize: (p) => p, extname: (p) => (String(p).match(/\.[^./]+$/) || [''])[0],
  },
  url: { fileURLToPath: (u) => String(u) },
  http: { createServer: () => { throw new Error('nicht im Browser'); } },
};
function patchUtil(U) {
  U.atomicWriteJSON = (file, data) => KV.setItem(LS + file, JSON.stringify(data));
  U.hashPin = (pin) => { const salt = U.token(8); return salt + ':' + demoHash(salt + String(pin)); };
  U.verifyPin = (pin, stored) => { if (!stored) return false; const [salt, h] = stored.split(':'); return demoHash(salt + String(pin)) === h; };
}
function makeBrowserStore(S, U) {
  const KEEP = 10;
  return class BrowserStore {
    constructor(dir) { this.dir = dir; this.key = LS + dir + '/db.json'; this.bkey = LS + dir + '/backups'; this.db = this.load(); }
    load() {
      const raw = KV.getItem(this.key);
      if (!raw) { const db = S.emptyDb(); KV.setItem(this.key, JSON.stringify(db)); return db; }
      const db = S.migrate(JSON.parse(raw)); const e = S.validateDb(db); if (e.length) throw new Error('Datenbank ungültig: ' + e.join('; ')); return db;
    }
    save() { try { KV.setItem(this.key, JSON.stringify(this.db)); } catch (e) { this._free(); KV.setItem(this.key, JSON.stringify(this.db)); } }
    transact(fn) { const work = U.clone(this.db); const r = fn(work); const e = S.validateDb(work); if (e.length) throw new Error('Transaktion verworfen: ' + e.join('; ')); this.db = work; this.save(); return r; }
    log(action, info = {}) { this.db.audit.push({ at: new Date().toISOString(), action, ...info }); if (this.db.audit.length > 2000) this.db.audit = this.db.audit.slice(-2000); }
    _list() { try { return JSON.parse(KV.getItem(this.bkey) || '[]'); } catch { return []; } }
    _put(list) { while (true) { try { KV.setItem(this.bkey, JSON.stringify(list)); return; } catch (e) { if (!list.length) throw e; list.pop(); } } }
    _free() { const l = this._list(); l.splice(1); this._put(l); }
    backup(reason = 'manuell') {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const name = 'db-' + stamp + '-' + reason.replace(/[^a-z0-9-]/gi, '') + '.json';
      const data = JSON.stringify(this.db);
      const list = this._list(); list.unshift({ name, at: new Date().toISOString(), size: data.length, data });
      this._put(list.slice(0, KEEP)); return name;
    }
    listBackups() { return this._list().map(({ name, at, size }) => ({ name, at, size })); }
    pruneBackups() {}
    restore(nameOrData) {
      let data = nameOrData;
      if (typeof nameOrData === 'string') { const b = this._list().find((x) => x.name === nameOrData); if (!b) throw new Error('Sicherung nicht gefunden'); data = JSON.parse(b.data); }
      if (!data || typeof data !== 'object' || typeof data.schemaVersion !== 'number' || typeof data.members !== 'object' || !data.meta) throw new Error('Sicherung ungültig: keine CRM-Sicherung');
      const db = S.migrate(U.clone(data)); const e = S.validateDb(db); if (e.length) throw new Error('Sicherung ungültig: ' + e.join('; '));
      const before = this.backup('vor-wiederherstellung'); this.db = db; this.log('restore', { source: typeof nameOrData === 'string' ? nameOrData : 'upload', safety: before }); this.save(); return before;
    }
  };
}
`;

const boot = String.raw`
// ===================== Start: Beispieldaten, App, HTTP-Brücke =====================
const DATA_DIR = 'data-demo';
(function ensureConfig() {
  // gleiche Pfadlogik wie server.mjs: ROOT/data-demo/config.json
  const ROOTP = NODE.path.dirname('file:///crm/app.mjs');
  const file = NODE.path.join(NODE.path.resolve(ROOTP, DATA_DIR), 'config.json');
  globalThis.CFG_FILE = file;
  if (KV.getItem(LS + file) === null) M_util.atomicWriteJSON(file, { syncToken: M_util.token(24), pinHash: M_util.hashPin('123456') });
})();
const APP = M_server.createApp({ dataDir: DATA_DIR, getApiKey: () => KV.getItem(LS + 'apikey') || null });

function seedDemo() {
  const { sync } = { sync: M_sync };
  const { makeOrg, downlinePayload, legsPayload, ORDER_HEADERS, orderRow, commissionsPayload } = M_fixture;
  const { uid, localDate, addDays } = M_util;
  const org = makeOrg(120, 11);
  const SKUS = [['60204656', 'Lavendel 15 ml'], ['60220837', 'On Guard 15 ml'], ['60217397', 'Pfefferminze 15 ml'], ['10100612', 'Zitrone 15 ml'], ['60224021', 'Deep Blue Rub'], ['60231421', 'Lifelong Vitality Pack'], ['60201653', 'Frankincense 15 ml']];
  APP.store.transact((db) => {
    db.meta.dataKind = 'beispiel';
    const r = sync.startRun(db, { kinds: ['downline', 'legs', 'orders', 'commissions'], trigger: 'beispiel' });
    sync.ingestDownline(db, r.id, downlinePayload(org));
    sync.ingestLegs(db, r.id, legsPayload(org));
    const members = []; let inv = 300000;
    for (const p of org.slice(1, 70)) {
      const rows = [];
      if (p.lastOrder) {
        const n = p.lrpActive ? 8 : 2;
        for (let k = 0; k < n; k++) {
          const d = addDays('2026-11-05', -30 * k - (Number(p.id) % 9));
          const open = k === 0 && Number(p.id) % 5 === 0;
          const items = [SKUS[(Number(p.id) + k) % SKUS.length], SKUS[(Number(p.id) * 3) % SKUS.length]].map((s) => [s[0], 1]);
          rows.push(orderRow({ invoice: String(inv++), source: p.lrpActive ? 'AS' : 'IO', items: open ? [] : items, date: d, ship: open ? null : addDays(d, 1), pvMonth: Number(d.slice(5, 7)) + '/' + d.slice(0, 4), volume: 100 + (Number(p.id) % 60), amount: 120 + (Number(p.id) % 70) }));
        }
      }
      members.push({ memberId: p.id, fromMonth: '2025-11', complete: true, rows });
    }
    sync.ingestOrders(db, r.id, { headers: ORDER_HEADERS, members, plannedMembers: members.length, complete: true });
    sync.ingestCommissions(db, r.id, commissionsPayload());
    sync.finishRun(db, r.id);
    for (const [sku, name] of SKUS) db.products[sku] = { name };
    const t = localDate();
    const someone = org[4].id, other = org[9].id;
    db.profiles[someone] = { source: 'Yoga', nextStep: 'Testwoche nachbesprechen', followUpDate: t };
    const n1 = uid(); db.notes[n1] = { id: n1, contactKey: someone, text: 'War beim Yoga-Abend, hat eine Testwoche mitgenommen.', kind: 'Gespräch', createdAt: new Date().toISOString() };
    const tid = uid(); db.tasks[tid] = { id: tid, title: 'Rückmeldung zur Testwoche einholen', contactKey: other, due: t, status: 'offen', estimateMin: 15, createdAt: new Date().toISOString() };
    const pk = 'p:' + uid(); db.prospects[pk] = { name: 'Interessentin, Beispiel', city: 'Musterstadt', createdAt: new Date().toISOString() }; db.profiles[pk] = { source: 'Instagram', followUpDate: addDays(t, 2), nextStep: 'Fragen zur Anwendung beantworten' };
    const ev = uid(); db.events[ev] = { id: ev, title: 'Workshop „Gut durch den Winter" (Beispiel)', type: 'Workshop', date: addDays(t, -20), participants: [someone, other, pk], createdAt: new Date().toISOString() };
    const g = uid(); db.goals[g] = { id: g, month: t.slice(0, 7), title: '5 neue Kundinnen', metric: 'neue_mitglieder', target: 5 };
    const g2 = uid(); db.goals[g2] = { id: g2, month: t.slice(0, 7), title: '40 Personen mit LRP', metric: 'lrp_personen', target: 40 };
  });
  KV.setItem(LS + 'simstep', '0');
}
if (!APP.store.db.meta.initialSyncDone) seedDemo();

// --- HTTP-Brücke: fetch('/api/...') geht an den echten Server-Code statt ins Netz ---
const jar = {};
const realFetch = window.fetch.bind(window);
async function bridge(url, init = {}) {
  const headers = {};
  const h = init.headers || {};
  for (const [k, v] of (h instanceof Headers ? h.entries() : Object.entries(h))) headers[k.toLowerCase()] = v;
  headers.host = '127.0.0.1:8787';
  const ck = Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');
  if (ck) headers.cookie = ck;
  const body = init.body == null ? '' : String(init.body);
  const listeners = {};
  const req = { method: (init.method || 'GET').toUpperCase(), url, headers, on(ev, cb) { (listeners[ev] ||= []).push(cb); return req; }, destroy() {} };
  setTimeout(() => { if (body) (listeners.data || []).forEach((cb) => cb({ s: body, length: body.length })); (listeners.end || []).forEach((cb) => cb()); }, 0);
  return new Promise((resolve) => {
    let status = 200; const rh = {};
    const res = {
      headersSent: false,
      setHeader(k, v) { rh[k.toLowerCase()] = v; },
      writeHead(c, hh = {}) { status = c; for (const [k, v] of Object.entries(hh)) rh[k.toLowerCase()] = v; this.headersSent = true; },
      end(b) {
        const sc = rh['set-cookie'];
        if (sc) { const [kv] = String(sc).split(';'); const [k, v] = kv.split('='); if (/Max-Age=0/.test(sc) || !v) delete jar[k]; else jar[k] = v; }
        delete rh['set-cookie'];
        resolve(new Response(status === 204 ? null : (b ?? ''), { status, headers: rh }));
      },
    };
    Promise.resolve(APP.handler(req, res)).catch((e) => resolve(new Response(JSON.stringify({ error: e.message }), { status: 500 })));
  });
}
window.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('/api/')) return bridge(url, init);
  if (/api\.anthropic\.com/.test(url)) init = { ...init, headers: { ...(init?.headers || {}), 'anthropic-dangerous-direct-browser-access': 'true' } };
  return realFetch(input, init);
};
// Downloads (Export-Links) über die Brücke
document.addEventListener('click', async (e) => {
  const a = e.target.closest('a[href^="/api/"]');
  if (!a) return;
  e.preventDefault(); e.stopPropagation();
  const r = await fetch(a.getAttribute('href'));
  const blob = await r.blob();
  const name = ((r.headers.get('content-disposition') || '').match(/filename="([^"]+)"/) || [])[1] || 'export';
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = name; link.click();
}, true);

// --- Testlabor: simuliert die Chrome-Erweiterung ---
async function syncCall(p, body) {
  const r = await fetch(p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sync-token': APP.cfg.syncToken }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body: j };
}
function simulatedOrg(step) {
  const org = M_fixture.makeOrg(120, 11);
  if (step >= 1) {
    org.push({ ...org[30], id: '91000001', name: 'Neu, Testkundin', type: 'Vorteilskunde', sponsor: org[2].id, enroller: org[0].id, entry: M_util.localDate(), months: { 'November 2026': { OV: 90, PV: 90, 'Qual PV': 90, 'LRP PV': 0, PGV: 0, TGV: 0 } }, lrpActive: false, nextLrp: null, lastOrder: M_util.localDate() });
    org[6].name = 'Umbenannt, ' + org[6].name.split(', ')[1];
    org[8].nextLrp = M_util.addDays(M_util.localDate(), -3); org[8].lrpActive = true;
  }
  if (step >= 2) { org[12].type = 'Wellness Advocate'; org[0].months['November 2026'] = { ...org[0].months['November 2026'], PV: 120, 'LRP PV': 120 }; }
  return org;
}
async function simulate(kind) {
  const step = Number(KV.getItem(LS + 'simstep') || '0') + (kind === 'ok' ? 1 : 0);
  const org = simulatedOrg(step);
  const start = await syncCall('/api/sync/start', { kinds: kind === 'session' ? ['downline'] : ['downline', 'legs', 'orders'], trigger: 'testlabor' });
  const id = start.body.runId;
  if (kind === 'session') { await syncCall('/api/sync/' + id + '/finish', { status: 'session_expired', error: 'Simuliert: doTERRA-Anmeldung abgelaufen' }); return 'Abgelaufene Sitzung simuliert. Achte auf den roten Hinweis.'; }
  if (kind === 'structure') {
    const p = M_fixture.downlinePayload(org); p.headers = p.headers.filter((h) => h !== 'Mitgliedsart');
    const r = await syncCall('/api/sync/' + id + '/part', p);
    await syncCall('/api/sync/' + id + '/finish', { status: 'structure_changed' });
    return 'Strukturänderung simuliert (Antwort ' + r.status + '). Es wurden keine Daten überschrieben.';
  }
  const dl = kind === 'partial' ? M_fixture.downlinePayload(org, { dropRows: 40, expectedTotal: org.length }) : M_fixture.downlinePayload(org);
  await syncCall('/api/sync/' + id + '/part', dl);
  await syncCall('/api/sync/' + id + '/part', M_fixture.legsPayload(org));
  if (kind === 'ok') {
    // eine bisher offene Bestellung wird versandt, eine neue kommt hinzu
    const open = Object.values(APP.store.db.orders).find((o) => o.status === 'offen');
    const members = [];
    if (open) members.push({ memberId: open.memberId, fromMonth: '2025-11', complete: true, rows: [M_fixture.orderRow({ invoice: open.invoice, source: open.sourceCode, items: [['60204656', 1], ['60220837', 1]], date: open.date, ship: M_util.localDate(), pvMonth: Number(open.pvMonth.slice(5)) + '/' + open.pvMonth.slice(0, 4), volume: open.volume, amount: open.amount })] });
    const buyer = org[20];
    members.push({ memberId: buyer.id, fromMonth: '2025-11', complete: true, rows: [M_fixture.orderRow({ invoice: String(390000 + step), source: 'IO', items: [['60231421', 1]], date: M_util.localDate(), ship: null, pvMonth: Number(M_util.localDate().slice(5, 7)) + '/' + M_util.localDate().slice(0, 4), volume: 95, amount: 104.5 })] });
    await syncCall('/api/sync/' + id + '/part', { kind: 'orders', headers: M_fixture.ORDER_HEADERS, members, plannedMembers: members.length, complete: true });
    KV.setItem(LS + 'simstep', String(step));
  }
  const fin = await syncCall('/api/sync/' + id + '/finish', {});
  return kind === 'partial' ? 'Unvollständiger Abruf simuliert (40 Zeilen fehlen). Status: ' + fin.body.status + '. Nichts wurde gelöscht.' : 'Abgleich simuliert. Status: ' + fin.body.status + ', ' + (fin.body.changeCount || 0) + ' Änderungen.';
}
function openLab() {
  const d = document.getElementById('modal');
  document.getElementById('modalBody').innerHTML = '<h2>🧪 Testlabor</h2><p class="small muted">Ersetzt in dieser Testdatei die Chrome-Erweiterung. Alles läuft lokal in diesem Browser mit Beispieldaten.</p>' +
    '<h3 class="section">Abgleich simulieren</h3><div class="actions"><button class="primary" data-sim="ok">Normaler Abgleich mit Änderungen</button><button data-sim="partial">Unvollständiger Abruf</button><button data-sim="session">Sitzung abgelaufen</button><button data-sim="structure">doTERRA-Seite geändert</button></div><p id="labOut" class="hint section">Bereit.</p>' +
    '<h3 class="section">Strategieassistent</h3><p class="small muted">Für echte Antworten einen Claude-API-Schlüssel eintragen. Er wird nur in diesem Browser gespeichert. Für den Testbetrieb gedacht, im echten System liegt er in der Datei .env.</p><div class="row"><input id="labKey" type="password" placeholder="sk-ant-…" value="' + (KV.getItem(LS + 'apikey') ? '••••••••' : '') + '"><button id="labKeySave">Speichern</button><button id="labKeyDel" class="ghost">Entfernen</button></div>' +
    '<h3 class="section">PIN ändern</h3><p class="small muted">Vor dem Import echter Daten eine eigene PIN setzen.</p><div class="row"><input id="labPin" type="password" inputmode="numeric" placeholder="neue PIN (6–12 Ziffern)"><button id="labPinSave">PIN speichern</button></div>' +
    '<h3 class="section">Zurücksetzen</h3><div class="actions"><button class="danger" id="labReset">Alle Testdaten löschen und neu erzeugen</button></div><div class="actions section"><button id="labClose">Schließen</button></div>';
  if (!d.open) d.showModal();
  d.querySelectorAll('[data-sim]').forEach((b) => (b.onclick = async () => { b.disabled = true; const out = document.getElementById('labOut'); out.textContent = 'Läuft …'; try { out.textContent = await simulate(b.dataset.sim); } catch (e) { out.textContent = 'Fehler: ' + e.message; } b.disabled = false; window.crmRefreshStatus?.(); window.dispatchEvent(new HashChangeEvent('hashchange')); }));
  document.getElementById('labKeySave').onclick = () => { const v = document.getElementById('labKey').value.trim(); if (v && !v.startsWith('•')) { KV.setItem(LS + 'apikey', v); document.getElementById('labOut').textContent = 'Schlüssel gespeichert.'; } };
  document.getElementById('labKeyDel').onclick = () => { KV.removeItem(LS + 'apikey'); document.getElementById('labKey').value = ''; document.getElementById('labOut').textContent = 'Schlüssel entfernt.'; };
  document.getElementById('labReset').onclick = async () => { if (confirm('Alle Daten dieser Testversion in diesem Browser löschen und Beispieldaten neu erzeugen?')) { await KV.clear(); location.hash = ''; location.reload(); } };
  document.getElementById('labPinSave').onclick = () => { const v = document.getElementById('labPin').value; if (!/^\d{6,12}$/.test(v)) { document.getElementById('labOut').textContent = 'PIN muss 6–12 Ziffern haben.'; return; } APP.cfg.pinHash = M_util.hashPin(v); M_util.atomicWriteJSON(CFG_FILE, APP.cfg); KV.setItem(LS + 'pinchanged', '1'); document.getElementById('labOut').textContent = 'Neue PIN gespeichert.'; };
  document.getElementById('labClose').onclick = () => d.close();
}
document.getElementById('labBtn').onclick = openLab;
if (KV.getItem(LS + 'pinchanged')) document.getElementById('testHint').textContent = 'Testversion · eigene PIN';
`;

const html = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>Kathrins CRM – Testversion</title>
<link rel="icon" href="${icon}">
<style>
${css}
.lab-btn { position: fixed; left: 16px; bottom: 16px; z-index: 30; border-radius: 999px; background: var(--gold-soft); color: var(--ink); border-color: var(--gold); box-shadow: var(--shadow); }
.test-hint { margin-top: 14px; font-size: 13px; color: var(--muted); }
@media (max-width: 760px) { .lab-btn { bottom: 78px; left: 10px; } }
</style>
</head>
<body>
${bodyHtml.replace('<p class="error" id="authErr" role="alert"></p>', '<p class="error" id="authErr" role="alert"></p>\n        <p class="test-hint" id="testHint">Testversion · Start-PIN <strong>123456</strong> · im 🧪 Testlabor änderbar</p>')}
<button id="labBtn" class="lab-btn" type="button">🧪 Testlabor</button>
<script type="module">
// Kathrins CRM – Testversion (eine Datei). Erzeugt am ${new Date().toISOString().slice(0, 10)} aus dem Quellcode.
// Enthält den unveränderten Server-, Abgleich-, Kennzahlen- und Assistenten-Code sowie die Oberfläche.
${shim}
${modulesCode}
${boot}
// ===================== Oberfläche =====================
(() => {
${appJs}
})();
</script>
</body>
</html>`;

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const out = path.join(ROOT, 'dist', 'kathrins-crm-test.html');
fs.writeFileSync(out, html);
console.log('geschrieben:', out, Math.round(html.length / 1024) + ' KB');
