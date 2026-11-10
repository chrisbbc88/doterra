#!/usr/bin/env node
// doTERRA CRM – lokaler Server (ohne externe Abhängigkeiten).
// Läuft nur auf 127.0.0.1. Oberfläche, API, Abgleich-Empfang, Sicherungen, Claude-Proxy.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, emptyDb } from './lib/store.mjs';
import { uid, token, hashPin, verifyPin, localDate, atomicWriteJSON, daysBetween } from './lib/util.mjs';
import * as sync from './lib/sync.mjs';
import { computeAll, today as todayView, goalsProgress, rankPlan, eventOutcome, KPI_DEFS } from './lib/kpi.mjs';
import { proposeFromNote } from './lib/notes.mjs';
import { ask, draftMessage, buildFacts } from './lib/assistant.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

export function loadEnv(file) {
  const env = {};
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

export function createApp(opts = {}) {
  const env = { ...loadEnv(path.join(ROOT, '.env')), ...process.env, ...(opts.env || {}) };
  const dataDir = path.resolve(ROOT, opts.dataDir || env.DATA_DIR || 'data');
  const store = new Store(dataDir);
  const isDemo = () => store.db.meta.dataKind === 'beispiel';
  const cfgFile = path.join(dataDir, 'config.json');
  const cfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};
  if (!cfg.syncToken) { cfg.syncToken = token(24); atomicWriteJSON(cfgFile, cfg); }
  const saveCfg = () => atomicWriteJSON(cfgFile, cfg);
  const apiKey = () => (opts.getApiKey && opts.getApiKey()) || env.ANTHROPIC_API_KEY || null;
  const sessions = new Map(); // sid -> {role, exp}
  const SESSION_MS = 12 * 3600 * 1000;
  const loginAttempts = { count: 0, until: 0 };

  // ---------- Hilfen ----------
  const send = (res, code, body, headers = {}) => {
    const isStr = typeof body === 'string' || Buffer.isBuffer(body);
    res.writeHead(code, { 'content-type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
    res.end(isStr ? body : JSON.stringify(body));
  };
  const readBody = (req, limit = 30e6) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Anfrage zu groß'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { const s = Buffer.concat(chunks).toString('utf8'); if (!s) return resolve({}); try { resolve(JSON.parse(s)); } catch { reject(Object.assign(new Error('Ungültiges JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
  const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((a) => a[0]));
  function auth(req) {
    const t = req.headers['x-sync-token'];
    if (t && t === cfg.syncToken) return { role: 'sync' };
    const sid = cookies(req).sid;
    const s = sid && sessions.get(sid);
    if (s && s.exp > Date.now()) { s.exp = Date.now() + SESSION_MS; return { role: s.role, sid }; }
    return null;
  }
  const can = (who, need) => {
    if (!who) return false;
    if (need === 'sync') return who.role === 'sync' || who.role === 'owner';
    if (need === 'read') return who.role === 'owner' || who.role === 'viewer';
    if (need === 'write') return who.role === 'owner';
    return false;
  };
  const err = (status, msg) => Object.assign(new Error(msg), { status });

  // ---------- Routen ----------
  const routes = [];
  const route = (method, pattern, need, fn) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, need, fn });
  };
  const db = () => store.db;
  const nameOf = (k) => db().members[k]?.name || db().prospects[k]?.name || k;

  route('GET', '/api/status', null, (req) => ({ setupRequired: !cfg.pinHash, authenticated: !!auth(req) && auth(req).role !== 'sync', demo: isDemo(), dataKind: db().meta.dataKind }));
  route('POST', '/api/setup', null, async (req) => {
    if (cfg.pinHash) throw err(409, 'PIN ist bereits eingerichtet');
    const { pin } = await readBody(req);
    if (!/^\d{6,12}$/.test(String(pin || ''))) throw err(400, 'PIN muss 6–12 Ziffern haben');
    cfg.pinHash = hashPin(pin); saveCfg();
    store.log('pin_eingerichtet'); store.save();
    return { ok: true };
  });
  route('POST', '/api/login', null, async (req, res) => {
    if (Date.now() < loginAttempts.until) throw err(429, 'Zu viele Versuche. Bitte kurz warten.');
    const { pin } = await readBody(req);
    if (!verifyPin(pin, cfg.pinHash)) {
      loginAttempts.count++;
      if (loginAttempts.count >= 5) { loginAttempts.until = Date.now() + 60000; loginAttempts.count = 0; }
      throw err(401, 'PIN falsch');
    }
    loginAttempts.count = 0;
    const sid = token(32);
    sessions.set(sid, { role: 'owner', exp: Date.now() + SESSION_MS });
    res.setHeader('set-cookie', `sid=${sid}; HttpOnly; SameSite=Strict; Path=/`);
    return { ok: true };
  });
  route('POST', '/api/logout', 'read', (req, res, p, who) => { sessions.delete(who.sid); res.setHeader('set-cookie', 'sid=; Max-Age=0; Path=/'); return { ok: true }; });

  route('GET', '/api/overview', 'read', () => {
    const d = db();
    const c = computeAll(d);
    const t = todayView(d, c.ctx, c.opps);
    const lastOk = Object.values(d.syncRuns).filter((r) => r.status === 'erfolgreich' || r.status === 'teilweise').sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    const changes = Object.values(d.changes).filter((ch) => lastOk && ch.runId === lastOk.id).map((ch) => ({ ...ch, name: nameOf(ch.memberId) }));
    return {
      ctx: c.ctx, owner: d.members[c.ctx.ownerId] ? { id: c.ctx.ownerId, name: d.members[c.ctx.ownerId].name } : null,
      kpis: Object.fromEntries(Object.entries(c.kpis).map(([k, v]) => [k, { ...v, ids: v.ids?.slice(0, 500) }])),
      trend: c.trend, steps: t.steps.map((s) => ({ ...s, name: s.contactKey ? nameOf(s.contactKey) : null })), minutesPerDay: t.minutesPerDay,
      due: t.due.map((x) => ({ ...x, contactName: x.contactKey ? nameOf(x.contactKey) : null })), followUps: t.followUps.map((f) => ({ ...f, name: nameOf(f.contactKey) })),
      changes: changes.slice(0, 100), lastRun: lastOk || null,
      goals: goalsProgress(d, c.ctx, c.stats), areas: areaStatus(), opps: c.opps.slice(0, 30).map((o) => ({ ...o, name: nameOf(o.memberId) })),
      placementLines: c.team.placementLines, legs: c.team.legs.slice(0, 12), settings: publicSettings(),
    };
  });

  function areaStatus() {
    const d = db();
    const stale = d.settings.staleAfterHours || 26;
    const labels = { downline: 'Mitglieder & Volumen', legs: 'Teamlinien (Schlagdistanz)', orders: 'Bestellungen', commissions: 'Provisionen' };
    return Object.entries(labels).map(([k, label]) => {
      const a = d.areaStatus[k] || {};
      const ageH = a.lastSuccessAt ? (Date.now() - new Date(a.lastSuccessAt)) / 3600000 : null;
      return { kind: k, label, lastSuccessAt: a.lastSuccessAt || null, lastAttemptAt: a.lastAttemptAt || null, lastStatus: a.lastStatus || 'nie abgeglichen', veraltet: ageH === null || ageH > stale, alterStunden: ageH === null ? null : Math.round(ageH) };
    });
  }
  const publicSettings = () => { const { ...s } = db().settings; return { ...s, apiKeyConfigured: !!apiKey() }; };

  route('GET', '/api/contacts', 'read', (req) => {
    const u = new URL(req.url, 'http://x');
    const q = (u.searchParams.get('q') || '').toLowerCase().trim();
    const seg = u.searchParams.get('segment') || '';
    const ids = u.searchParams.get('ids');
    const d = db();
    const c = computeAll(d);
    const team = c.team.legSource;
    let list = Object.values(d.members).filter((m) => m.inDownline !== false).map((m) => {
      const s = c.stats[m.id] || {};
      const p = d.profiles[m.id] || {};
      return { key: m.id, id: m.id, name: m.name, art: m.memberType, rang: m.currentRank, level: m.level, segment: s.segment, tier: s.tier, risk: s.risk, curPv: s.curPv, hasLrp: s.hasLrp, nextLrpDate: m.nextLrpDate, lastOrderDate: m.lastOrderDate, entryDate: m.entryDate, activeMonths6: s.activeMonths6, lrpMonths6: s.lrpMonths6, bein: team[m.id]?.bein ? nameOf(team[m.id].bein) : null, linie: team[m.id]?.platzierungslinie ? nameOf(team[m.id].platzierungslinie) : null, followUpDate: p.followUpDate || null, source: p.source || null, owner: m.id === c.ctx.ownerId, city: m.contact?.city || null };
    });
    list = list.concat(Object.entries(d.prospects).map(([key, p]) => ({ key, id: null, name: p.name, art: 'Interessentin', segment: 'Interessentin', tier: '–', risk: [], followUpDate: d.profiles[key]?.followUpDate || null, source: d.profiles[key]?.source || null, city: p.city || null })));
    if (ids) { const set = new Set(ids.split(',')); list = list.filter((x) => set.has(x.key)); }
    if (q) list = list.filter((x) => (x.name || '').toLowerCase().includes(q) || (x.id || '').includes(q) || (x.city || '').toLowerCase().includes(q));
    const SEG = {
      kundinnen: (x) => x.art === 'Vorteilskundin' || x.art === 'Einzelhandelskundin', beraterinnen: (x) => x.art === 'Beraterin', interessentinnen: (x) => x.art === 'Interessentin',
      neu: (x) => x.segment === 'Neu', treu: (x) => x.segment === 'Treue LRP', gefaehrdet: (x) => (x.risk || []).length > 0, inaktiv: (x) => x.segment === 'Inaktiv',
      ohnelrp: (x) => x.id && !x.hasLrp && x.art !== 'Interessentin', wiedervorlage: (x) => x.followUpDate && x.followUpDate <= c.ctx.today,
      a: (x) => x.tier === 'A',
    };
    if (SEG[seg]) list = list.filter(SEG[seg]);
    list.sort((a, b) => (a.owner ? -1 : b.owner ? 1 : 0) || (a.name || '').localeCompare(b.name || '', 'de'));
    return { list, total: list.length };
  });

  route('GET', '/api/contacts/:key', 'read', (req, res, p) => {
    const d = db(); const key = decodeURIComponent(p.key);
    const m = d.members[key], pr = d.prospects[key];
    if (!m && !pr) throw err(404, 'Kontakt nicht gefunden');
    const c = computeAll(d);
    const months = Object.values(d.memberMonths).filter((x) => x.id === key).sort((a, b) => b.month.localeCompare(a.month));
    const orders = Object.values(d.orders).filter((o) => o.memberId === key).sort((a, b) => (b.date || '').localeCompare(a.date || '')).map((o) => ({ ...o, items: o.items.map((i) => ({ ...i, name: d.products[i.sku]?.name || null })) }));
    const legs = Object.values(d.legs).filter((l) => l.id === key).sort((a, b) => b.month.localeCompare(a.month));
    const notes = Object.values(d.notes).filter((n) => n.contactKey === key).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const tasks = Object.values(d.tasks).filter((t) => t.contactKey === key).sort((a, b) => (a.due || '9').localeCompare(b.due || '9'));
    const events = Object.values(d.events).filter((e) => (e.participants || []).includes(key));
    const products = c.products.perMember[key] ? Object.entries(c.products.perMember[key]).map(([sku, dates]) => ({ sku, name: d.products[sku]?.name || null, kaeufe: dates.length, zuletzt: dates.sort().at(-1) })).sort((a, b) => b.zuletzt.localeCompare(a.zuletzt)) : [];
    const sponsor = m?.sponsorId ? { id: m.sponsorId, name: d.members[m.sponsorId]?.name || m.sponsorName } : null;
    const enroller = m?.enrollerId ? { id: m.enrollerId, name: d.members[m.enrollerId]?.name || m.enrollerName } : null;
    const placed = Object.values(d.members).filter((x) => x.sponsorId === key && x.inDownline !== false).map((x) => ({ id: x.id, name: x.name, art: x.memberType }));
    const enrolled = Object.values(d.members).filter((x) => x.enrollerId === key && x.inDownline !== false).map((x) => ({ id: x.id, name: x.name, art: x.memberType }));
    return {
      key, source: m ? { ...m, history: m.history || [] } : null, prospect: pr || null, profile: d.profiles[key] || {},
      stats: c.stats[key] || null, months, orders, orderCoverage: d.orderCoverage[key] || null, legs, notes, tasks,
      events: events.map((e) => ({ id: e.id, title: e.title, date: e.date, type: e.type })),
      products, sponsor, enroller, placed, enrolled, team: c.team.legSource[key] ? { ...c.team.legSource[key], beinName: nameOf(c.team.legSource[key].bein), linieName: nameOf(c.team.legSource[key].platzierungslinie) } : null,
      opps: c.opps.filter((o) => o.memberId === key), stand: d.areaStatus.downline?.lastSuccessAt || null,
    };
  });

  const PROFILE_FIELDS = ['source', 'interests', 'preferences', 'owner', 'nextStep', 'followUpDate', 'consents', 'tags', 'instagram', 'whatsapp', 'status', 'personalNote'];
  route('PUT', '/api/contacts/:key/profile', 'write', async (req, res, p) => {
    const key = decodeURIComponent(p.key); const body = await readBody(req);
    if (!db().members[key] && !db().prospects[key]) throw err(404, 'Kontakt nicht gefunden');
    return store.transact((d) => {
      const prev = d.profiles[key] || {};
      const next = { ...prev };
      for (const f of PROFILE_FIELDS) if (body[f] !== undefined) next[f] = body[f];
      if (next.followUpDate && !/^\d{4}-\d{2}-\d{2}$/.test(next.followUpDate)) throw err(400, 'Datum ungültig');
      next.updatedAt = new Date().toISOString();
      d.profiles[key] = next;
      return next;
    });
  });

  route('POST', '/api/prospects', 'write', async (req) => {
    const b = await readBody(req);
    if (!b.name || String(b.name).trim().length < 2) throw err(400, 'Name fehlt');
    return store.transact((d) => {
      const key = 'p:' + uid();
      d.prospects[key] = { name: String(b.name).trim(), phone: b.phone || null, email: b.email || null, city: b.city || null, createdAt: new Date().toISOString() };
      d.profiles[key] = { source: b.source || null, status: 'Interessentin', interests: b.interests || null, createdAt: new Date().toISOString() };
      return { key };
    });
  });
  route('PUT', '/api/prospects/:key', 'write', async (req, res, p) => {
    const key = decodeURIComponent(p.key); const b = await readBody(req);
    return store.transact((d) => {
      if (!d.prospects[key]) throw err(404, 'Nicht gefunden');
      for (const f of ['name', 'phone', 'email', 'city', 'linkedMemberId']) if (b[f] !== undefined) d.prospects[key][f] = b[f];
      return d.prospects[key];
    });
  });
  // Löschen: CRM-Daten der Person; bei doTERRA-Mitgliedern zusätzlich lokale Quelldaten + Reimport-Sperre.
  route('DELETE', '/api/contacts/:key', 'write', async (req, res, p) => {
    const key = decodeURIComponent(p.key);
    const u = new URL(req.url, 'http://x');
    const includeSource = u.searchParams.get('source') === '1';
    store.backup('vor-loeschung');
    return store.transact((d) => {
      let n = 0;
      for (const coll of ['notes', 'tasks', 'drafts']) for (const [id, x] of Object.entries(d[coll])) if (x.contactKey === key) { delete d[coll][id]; n++; }
      delete d.profiles[key]; delete d.prospects[key];
      for (const e of Object.values(d.events)) e.participants = (e.participants || []).filter((x) => x !== key);
      if (includeSource && d.members[key]) {
        delete d.members[key]; d.suppressed[key] = { at: new Date().toISOString() };
        for (const k of Object.keys(d.memberMonths)) if (k.startsWith(key + '|')) delete d.memberMonths[k];
        for (const k of Object.keys(d.legs)) if (k.startsWith(key + '|')) delete d.legs[k];
        for (const [inv, o] of Object.entries(d.orders)) if (o.memberId === key) delete d.orders[inv];
        delete d.orderCoverage[key];
      }
      store.log('kontakt_geloescht', { quelldaten: includeSource, eintraege: n });
      return { ok: true, entfernt: n };
    });
  });

  route('POST', '/api/notes/propose', 'write', async (req) => {
    const { text } = await readBody(req);
    if (!text || String(text).trim().length < 3) throw err(400, 'Notiz ist leer');
    return proposeFromNote(String(text).slice(0, 4000), db(), localDate());
  });
  route('POST', '/api/notes', 'write', async (req) => {
    const b = await readBody(req);
    if (!b.contactKey || (!db().members[b.contactKey] && !db().prospects[b.contactKey])) throw err(400, 'Kontakt fehlt oder unbekannt');
    if (!b.text) throw err(400, 'Text fehlt');
    return store.transact((d) => {
      const id = uid();
      d.notes[id] = { id, contactKey: b.contactKey, text: String(b.text).slice(0, 8000), kind: b.kind || 'Notiz', sensitive: !!b.sensitive, channel: b.channel || null, createdAt: new Date().toISOString(), confirmed: true };
      if (b.source && !(d.profiles[b.contactKey] || {}).source) d.profiles[b.contactKey] = { ...(d.profiles[b.contactKey] || {}), source: b.source };
      return d.notes[id];
    });
  });
  route('DELETE', '/api/notes/:id', 'write', (req, res, p) => store.transact((d) => { delete d.notes[p.id]; return { ok: true }; }));

  // Generische CRUD-Routen für Aufgaben, Veranstaltungen, Ziele
  const CRUD = {
    tasks: ['title', 'due', 'status', 'priority', 'estimateMin', 'contactKey', 'origin', 'notes'],
    events: ['title', 'type', 'date', 'location', 'notes', 'participants', 'outcomeNote', 'partner'],
    goals: ['month', 'title', 'metric', 'target', 'manualValue', 'note'],
  };
  for (const [coll, fields] of Object.entries(CRUD)) {
    route('GET', `/api/${coll}`, 'read', () => {
      const items = Object.values(db()[coll]).map((x) => ({ ...x, contactName: x.contactKey ? nameOf(x.contactKey) : undefined }));
      if (coll === 'events') return items.map((e) => ({ ...e, ergebnis: eventOutcome(db(), e), participantNames: (e.participants || []).map((k) => ({ key: k, name: nameOf(k) })) })).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      return items;
    });
    route('POST', `/api/${coll}`, 'write', async (req) => {
      const b = await readBody(req);
      if (!b.title && coll !== 'goals') throw err(400, 'Titel fehlt');
      return store.transact((d) => {
        const id = uid(); const x = { id, createdAt: new Date().toISOString() };
        for (const f of fields) if (b[f] !== undefined) x[f] = b[f];
        if (coll === 'tasks') x.status = x.status || 'offen';
        d[coll][id] = x; return x;
      });
    });
    route('PUT', `/api/${coll}/:id`, 'write', async (req, res, p) => {
      const b = await readBody(req);
      return store.transact((d) => {
        const x = d[coll][p.id]; if (!x) throw err(404, 'Nicht gefunden');
        for (const f of fields) if (b[f] !== undefined) x[f] = b[f];
        if (coll === 'tasks' && b.status === 'erledigt') x.doneAt = new Date().toISOString();
        x.updatedAt = new Date().toISOString(); return x;
      });
    });
    route('DELETE', `/api/${coll}/:id`, 'write', (req, res, p) => store.transact((d) => { delete d[coll][p.id]; return { ok: true }; }));
  }

  route('GET', '/api/team', 'read', () => {
    const d = db(); const c = computeAll(d);
    return { placementLines: c.team.placementLines, legs: c.team.legs, frontline: c.team.frontline.map((id) => ({ id, name: nameOf(id), art: d.members[id]?.memberType })), personalEnrollees: c.team.personalEnrollees.map((id) => ({ id, name: nameOf(id), art: d.members[id]?.memberType, entryDate: d.members[id]?.entryDate })), enrollers: c.team.enrollers.slice(0, 30), ungeklaert: c.team.ungeklaert.map((id) => ({ id, name: nameOf(id) })), konflikte: c.team.konflikte.map((id) => ({ id, name: nameOf(id) })), stand: d.areaStatus.legs?.lastSuccessAt || null };
  });
  route('GET', '/api/products', 'read', () => {
    const d = db(); const c = computeAll(d);
    return { list: c.products.list, nachkauf: c.products.nachkauf.slice(0, 60).map((n) => ({ ...n, memberName: nameOf(n.memberId) })), stand: d.areaStatus.orders?.lastSuccessAt || null };
  });
  route('PUT', '/api/products/:sku', 'write', async (req, res, p) => {
    const b = await readBody(req);
    if (!/^[\w-]{3,20}$/.test(p.sku)) throw err(400, 'Artikelnummer ungültig');
    return store.transact((d) => { d.products[p.sku] = { name: String(b.name || '').slice(0, 120) || null, kategorie: b.kategorie || null }; return d.products[p.sku]; });
  });
  route('GET', '/api/rank', 'read', (req) => {
    const u = new URL(req.url, 'http://x'); const d = db(); const c = computeAll(d);
    return rankPlan(d, c.ctx, c.team, u.searchParams.get('target') || d.settings.targetRank || 'Gold');
  });
  route('GET', '/api/kpi-defs', 'read', () => KPI_DEFS);

  route('POST', '/api/assistant', 'write', async (req) => {
    const { question } = await readBody(req);
    if (!question) throw err(400, 'Frage fehlt');
    const r = await ask(db(), apiKey(), question);
    if (r.usage) { store.log('ki_anfrage', { art: 'assistent', input: r.usage.input_tokens, output: r.usage.output_tokens }); store.save(); }
    return r;
  });
  route('GET', '/api/assistant/facts', 'read', () => buildFacts(db()).facts);
  route('POST', '/api/drafts', 'write', async (req) => {
    const b = await readBody(req);
    const r = await draftMessage(db(), apiKey(), b);
    if (r.ok) {
      store.transact((d) => { const id = uid(); d.drafts[id] = { id, contactKey: b.contactKey, anlass: b.anlass, text: r.entwurf, status: 'Entwurf', createdAt: new Date().toISOString() }; r.id = id; });
      if (r.usage) { store.log('ki_anfrage', { art: 'entwurf', input: r.usage.input_tokens, output: r.usage.output_tokens }); store.save(); }
    }
    return r;
  });

  // ---------- Datenstatus, Sicherung, Export ----------
  route('GET', '/api/data/status', 'read', () => {
    const d = db();
    const runs = Object.values(d.syncRuns).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 30);
    const usage = d.audit.filter((a) => a.action === 'ki_anfrage');
    const month = localDate().slice(0, 7);
    const thisMonth = usage.filter((a) => a.at.slice(0, 7) === month);
    return {
      areas: areaStatus(), runs, backups: store.listBackups().slice(0, 30), settings: publicSettings(), syncToken: cfg.syncToken, demo: isDemo(),
      counts: { mitglieder: Object.keys(d.members).length, monatswerte: Object.keys(d.memberMonths).length, bestellungen: Object.keys(d.orders).length, notizen: Object.keys(d.notes).length, aufgaben: Object.keys(d.tasks).length },
      kiNutzung: { anfragenMonat: thisMonth.length, inputTokensMonat: thisMonth.reduce((s, a) => s + (a.input || 0), 0), outputTokensMonat: thisMonth.reduce((s, a) => s + (a.output || 0), 0) },
      changes: Object.values(d.changes).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200).map((c) => ({ ...c, name: nameOf(c.memberId) })),
    };
  });
  route('PUT', '/api/settings', 'write', async (req) => {
    const b = await readBody(req);
    return store.transact((d) => {
      if (b.weeklyHours !== undefined) { const n = Number(b.weeklyHours); if (!(n >= 0 && n <= 80)) throw err(400, 'Stunden ungültig'); d.settings.weeklyHours = n; }
      if (b.staleAfterHours !== undefined) d.settings.staleAfterHours = Math.max(1, Number(b.staleAfterHours) || 26);
      if (b.targetRank !== undefined) d.settings.targetRank = String(b.targetRank);
      if (b.assistantModel !== undefined) d.settings.assistantModel = String(b.assistantModel).slice(0, 60);
      if (b.autoSync !== undefined) {
        const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(b.autoSync.time || '') ? b.autoSync.time : '05:00';
        d.settings.autoSync = { enabled: !!b.autoSync.enabled, mode: b.autoSync.mode === 'interval' ? 'interval' : 'daily', time, everyHours: Math.max(2, Number(b.autoSync.everyHours) || 12) };
      }
      return d.settings;
    });
  });
  route('POST', '/api/backup', 'write', () => ({ name: store.backup('manuell') }));
  route('POST', '/api/restore', 'write', async (req) => {
    const b = await readBody(req);
    if (b.name) return { ok: true, sicherheitskopie: store.restore(b.name) };
    if (b.data) return { ok: true, sicherheitskopie: store.restore(b.data) };
    throw err(400, 'Keine Sicherung angegeben');
  });
  route('GET', '/api/export', 'read', (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="crm-export-${localDate()}.json"`, 'cache-control': 'no-store' });
    res.end(JSON.stringify(db(), null, 1)); return undefined;
  });
  route('GET', '/api/export/contacts.csv', 'read', (req, res) => {
    const d = db(); const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['doTERRA-ID', 'Name', 'Art', 'Rang', 'E-Mail', 'Mobil', 'Ort', 'Registriert', 'Letzte Bestellung', 'Nächster LRP', 'Quelle (CRM)', 'Nächster Schritt (CRM)', 'Wiedervorlage (CRM)']];
    for (const m of Object.values(d.members)) { const p = d.profiles[m.id] || {}; rows.push([m.id, m.name, m.memberType, m.currentRank, m.contact?.email, m.contact?.phoneMobile, m.contact?.city, m.entryDate, m.lastOrderDate, m.nextLrpDate, p.source, p.nextStep, p.followUpDate]); }
    for (const [k, pr] of Object.entries(d.prospects)) { const p = d.profiles[k] || {}; rows.push(['', pr.name, 'Interessentin', '', pr.email, pr.phone, pr.city, '', '', '', p.source, p.nextStep, p.followUpDate]); }
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="kontakte-${localDate()}.csv"` });
    res.end('﻿' + rows.map((r) => r.map(esc).join(';')).join('\r\n')); return undefined;
  });

  // ---------- Abgleich (Chrome-Erweiterung) ----------
  route('GET', '/api/sync/ping', 'sync', () => ({ ok: true, ownerId: db().settings.ownerId, autoSync: db().settings.autoSync, lastSuccessAt: db().areaStatus.downline?.lastSuccessAt || null }));
  // Import einer Abgleich-Datei aus der Erweiterung ("Als Datei speichern"). Gleiche Prüfungen wie der Live-Abgleich.
  route('POST', '/api/sync/import-bundle', 'write', async (req) => {
    const { bundle, replace } = await readBody(req, 60e6);
    if (!bundle || bundle.format !== 'kathrins-crm-sync-bundle' || !bundle.parts?.downline) throw err(400, 'Keine gültige Abgleich-Datei (Format kathrins-crm-sync-bundle mit Downline erwartet)');
    const kinds = ['downline', 'legs', 'orders', 'commissions'].filter((k) => bundle.parts[k]);
    store.backup('vor-datei-import');
    if (replace) store.transact((d) => {
      const keep = { ...d.settings, ownerId: null };
      const fresh = emptyDb(); for (const k of Object.keys(fresh)) d[k] = fresh[k];
      d.settings = { ...fresh.settings, ...keep }; d.meta.dataKind = 'echt';
    });
    const fns = { downline: sync.ingestDownline, legs: sync.ingestLegs, orders: sync.ingestOrders, commissions: sync.ingestCommissions };
    const runId = store.transact((d) => sync.startRun(d, { kinds, trigger: 'datei-import' }).id);
    const results = {};
    for (const k of kinds) {
      try { results[k] = store.transact((d) => fns[k](d, runId, { ...bundle.parts[k], kind: k })); }
      catch (e) { results[k] = { error: e.message }; store.transact((d) => { const r = d.syncRuns[runId]; r.errors.push(`${k}: ${e.message}`); r.parts[k] = { status: e.code === 'structure_changed' ? 'struktur_geändert' : 'fehler', at: new Date().toISOString(), message: e.message }; }); }
    }
    const run = store.transact((d) => { if (replace) d.meta.dataKind = 'echt'; return sync.finishRun(d, runId, { error: Object.keys(bundle.errors || {}).length ? 'In der Datei fehlende Bereiche: ' + Object.keys(bundle.errors).join(', ') : undefined }); });
    store.log('datei_import', { runId, status: run.status }); store.save();
    return { run, results, dateiVom: bundle.createdAt };
  });
  route('GET', '/api/sync/plan', 'sync', (req) => {
    const u = new URL(req.url, 'http://x');
    return sync.orderPlan(db(), { monthsBack: Math.min(36, Number(u.searchParams.get('monthsBack')) || 12), full: u.searchParams.get('full') === '1' });
  });
  route('POST', '/api/sync/start', 'sync', async (req) => {
    const b = await readBody(req);
    const kinds = (b.kinds || ['downline']).filter((k) => ['downline', 'legs', 'orders', 'commissions'].includes(k));
    if (!kinds.length) throw err(400, 'Keine Datenbereiche');
    store.backup('vor-abgleich');
    return store.transact((d) => { const r = sync.startRun(d, { kinds, trigger: b.trigger || 'manuell' }); store.log('abgleich_start', { runId: r.id, kinds }); return { runId: r.id }; });
  });
  route('POST', '/api/sync/:runId/part', 'sync', async (req, res, p) => {
    const b = await readBody(req);
    const fn = { downline: sync.ingestDownline, legs: sync.ingestLegs, orders: sync.ingestOrders, commissions: sync.ingestCommissions }[b.kind];
    if (!fn) throw err(400, 'Unbekannter Datenbereich');
    try {
      return store.transact((d) => fn(d, p.runId, b));
    } catch (e) {
      // Strukturfehler: Daten verwerfen, Fehler am Lauf vermerken (in eigener Transaktion)
      store.transact((d) => {
        const run = d.syncRuns[p.runId];
        if (run) { run.errors.push(e.message); run.parts[b.kind] = { status: e.code === 'structure_changed' ? 'struktur_geändert' : 'fehler', at: new Date().toISOString(), message: e.message };
          d.areaStatus[b.kind] = { ...(d.areaStatus[b.kind] || {}), lastStatus: run.parts[b.kind].status, lastAttemptAt: run.parts[b.kind].at, lastRunId: p.runId }; }
      });
      throw err(422, e.message);
    }
  });
  route('POST', '/api/sync/:runId/finish', 'sync', async (req, res, p) => {
    const b = await readBody(req);
    return store.transact((d) => { const r = sync.finishRun(d, p.runId, { clientStatus: b.status, error: b.error }); store.log('abgleich_ende', { runId: r.id, status: r.status, aenderungen: r.changeCount }); return r; });
  });

  // ---------- HTTP ----------
  async function handler(req, res) {
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      // Fremde Webseiten dürfen die lokale API nicht ansprechen (CSRF-Schutz).
      const origin = req.headers.origin;
      const host = req.headers.host || '';
      const okOrigin = !origin || origin === `http://${host}` || origin.startsWith('chrome-extension://');
      if (req.method === 'OPTIONS') return send(res, 204, '', { 'access-control-allow-origin': okOrigin && origin ? origin : 'null', 'access-control-allow-headers': 'content-type,x-sync-token,x-requested-with', 'access-control-allow-methods': 'GET,POST,PUT,DELETE' });
      if (!okOrigin) return send(res, 403, { error: 'Herkunft nicht erlaubt' });
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return send(res, 403, { error: 'Nur lokaler Zugriff' });
      if (u.pathname.startsWith('/api/')) {
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = u.pathname.match(r.re);
          if (!m) continue;
          const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
          const who = auth(req);
          if (r.need) {
            if (!who) return send(res, 401, { error: 'Nicht angemeldet' });
            if (!can(who, r.need)) return send(res, 403, { error: 'Keine Berechtigung' });
            // UI-Schreibzugriffe zusätzlich mit eigenem Header (CSRF)
            if (who.role !== 'sync' && req.method !== 'GET' && req.headers['x-requested-with'] !== 'crm') return send(res, 403, { error: 'Anfrage ohne CRM-Kennung' });
          }
          const out = await r.fn(req, res, params, who);
          if (out !== undefined && !res.headersSent) send(res, 200, out);
          return;
        }
        return send(res, 404, { error: 'Unbekannter Endpunkt' });
      }
      // Statische Dateien
      let file = path.normalize(path.join(ROOT, 'public', u.pathname === '/' ? 'index.html' : u.pathname));
      if (!file.startsWith(path.join(ROOT, 'public'))) return send(res, 403, 'Verboten');
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(ROOT, 'public', 'index.html');
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' }[path.extname(file)] || 'application/octet-stream';
      res.writeHead(200, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'", 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error('[Fehler]', e.message);
      if (!res.headersSent) send(res, status, { error: e.message });
    }
  }

  // Tägliche Sicherung, solange der Server läuft
  let timer = null;
  const dailyBackup = () => {
    const last = store.listBackups().find((b) => /taeglich|manuell|vor-abgleich/.test(b.name));
    if (!last || daysBetween(last.at.slice(0, 10), localDate()) >= 1) store.backup('taeglich');
  };
  return {
    store, cfg, handler, sessions, // sessions nur für Tests/Rollenverwaltung
    listen(port = Number(env.PORT) || 8787, host = '127.0.0.1') {
      const server = http.createServer(handler);
      dailyBackup();
      timer = setInterval(dailyBackup, 3600 * 1000); timer.unref();
      return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataArg = process.argv.find((a) => a.startsWith('--data='));
  const app = createApp({ dataDir: dataArg ? dataArg.slice(7) : undefined });
  const port = Number(process.env.PORT) || 8787;
  app.listen(port).then(() => {
    const kind = app.store.db.meta.dataKind === 'beispiel' ? ' (BEISPIELDATEN)' : '';
    console.log(`doTERRA CRM${kind} läuft: http://127.0.0.1:${port}`);
    console.log(`Daten: ${app.store.dir}`);
    console.log(`Claude-API-Schlüssel: ${process.env.ANTHROPIC_API_KEY || loadEnv(path.join(ROOT, '.env')).ANTHROPIC_API_KEY ? 'vorhanden' : 'nicht gesetzt (Assistent eingeschränkt)'}`);
  });
}
