// Erzeugt eine getrennte BEISPIEL-Instanz in ./data-demo (erfundene Personen).
// Echte Daten liegen ausschließlich in ./data und werden hiervon nie berührt.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../lib/store.mjs';
import * as sync from '../lib/sync.mjs';
import { hashPin, atomicWriteJSON, uid, localDate, addDays } from '../lib/util.mjs';
import { makeOrg, downlinePayload, legsPayload, ORDER_HEADERS, orderRow, commissionsPayload } from '../tests/fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(ROOT, 'data-demo');
fs.rmSync(dir, { recursive: true, force: true });
const store = new Store(dir);
const org = makeOrg(120, 11);
const SKUS = [['60204656', 'Lavendel 15 ml'], ['60220837', 'On Guard 15 ml'], ['60217397', 'Pfefferminze 15 ml'], ['10100612', 'Zitrone 15 ml'], ['60224021', 'Deep Blue Rub'], ['60231421', 'Lifelong Vitality Pack'], ['60201653', 'Frankincense 15 ml']];
store.transact((db) => {
  db.meta.dataKind = 'beispiel';
  const r = sync.startRun(db, { kinds: ['downline', 'legs', 'orders', 'commissions'], trigger: 'beispiel' });
  sync.ingestDownline(db, r.id, downlinePayload(org));
  sync.ingestLegs(db, r.id, legsPayload(org));
  const members = [];
  let inv = 300000;
  for (const p of org.slice(1, 70)) {
    const rows = [];
    if (!p.lastOrder) { members.push({ memberId: p.id, fromMonth: '2025-11', complete: true, rows }); continue; }
    const n = p.lrpActive ? 8 : 2;
    for (let k = 0; k < n; k++) {
      const d = addDays('2026-11-05', -30 * k - (Number(p.id) % 9));
      const items = [SKUS[(Number(p.id) + k) % SKUS.length], SKUS[(Number(p.id) * 3) % SKUS.length]].map((s) => [s[0], 1]);
      rows.push(orderRow({ invoice: String(inv++), source: p.lrpActive ? 'AS' : 'IO', items: k === 0 && Number(p.id) % 5 === 0 ? [] : items, date: d, ship: k === 0 && Number(p.id) % 5 === 0 ? null : addDays(d, 1), pvMonth: `${Number(d.slice(5, 7))}/${d.slice(0, 4)}`, volume: 100 + (Number(p.id) % 60), amount: 120 + (Number(p.id) % 70) }));
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
  db.notes[uid()] = { id: uid(), contactKey: someone, text: 'War beim Yoga-Abend, hat eine Testwoche mitgenommen.', kind: 'Gespräch', createdAt: new Date().toISOString() };
  const tid = uid(); db.tasks[tid] = { id: tid, title: 'Rückmeldung zur Testwoche einholen', contactKey: other, due: t, status: 'offen', estimateMin: 15, createdAt: new Date().toISOString() };
  const pk = 'p:' + uid(); db.prospects[pk] = { name: 'Interessentin, Beispiel', city: 'Musterstadt', createdAt: new Date().toISOString() }; db.profiles[pk] = { source: 'Instagram', followUpDate: addDays(t, 2), nextStep: 'Fragen zur Anwendung beantworten' };
  const ev = uid(); db.events[ev] = { id: ev, title: 'Workshop „Gut durch den Winter" (Beispiel)', type: 'Workshop', date: addDays(t, -20), participants: [someone, other, pk], createdAt: new Date().toISOString() };
  const g = uid(); db.goals[g] = { id: g, month: t.slice(0, 7), title: '5 neue Kundinnen', metric: 'neue_mitglieder', target: 5 };
  const g2 = uid(); db.goals[g2] = { id: g2, month: t.slice(0, 7), title: '40 Personen mit LRP', metric: 'lrp_personen', target: 40 };
});
atomicWriteJSON(path.join(dir, 'config.json'), { syncToken: 'demo-token-nur-fuer-beispieldaten', pinHash: hashPin('123456') });
console.log('Beispiel-Instanz erzeugt:', dir, '– PIN 123456');
