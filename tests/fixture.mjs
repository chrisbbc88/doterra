// BEISPIELDATEN – erfundene Personen, aber exakt die am 10.11.2026 live geprüfte Spaltenstruktur
// des doTERRA-Downline-Berichts, der Schlagdistanz, der Bestellhistorie und der Provisionsübersicht.
export const OWNER = '90000001';
const MONTH_LABELS = ['November 2026', 'Oktober 2026', 'September 2026', 'August 2026', 'Juli 2026', 'Juni 2026', 'Mai 2026'];
const SUBS = ['OV', 'PV', 'Qual PV', 'LRP PV', 'PGV', 'TGV'];
export const DOWNLINE_HEADERS = [
  'BEOBACHTUNGSLISTE', 'Mitglied-ID', 'Name', 'Mitgliedsart', 'Levels', 'Derzeitiger Rang', 'Höchster Rang',
  'PV der nächsten Treuebestellung', 'Nächster LRP-Termin', 'Letztes Bestelldatum', 'Registrierungsdatum',
  'ID Sponsor*in', 'Name Sponsor*in', 'ID Enroller*in', 'Name Enroller*in', 'Festnetztelefon', 'Mobiltelefon',
  'Arbeitshandy', 'Adresse', 'Adresse 2', 'E-Mail', 'Stadt', 'Bundesland', 'Postleitzahl', 'Land',
  ...MONTH_LABELS.flatMap((m) => SUBS.map((s) => `${m}|${s}`)),
];
export const ORDER_HEADERS = ['Rechnung', 'Art', 'Quelle', 'Versandadresse', 'Paketverfolgung', 'Artikelnummer', 'Qty', 'Payment Link', 'Datum', 'Versand', 'PVDatum', 'Volumen', 'Betrag'];
export const LEG_HEADERS = ['#', 'Mitglieds-ID', 'Name', 'Leg ID', 'Level', 'Rang', '% to Rank', 'PV', 'OV', 'Executive Beine', 'Elite Beine', 'Premier Beine', 'Silber Beine', 'Gold Beine', 'Platin Beine'];

const FIRST = ['Anna', 'Silke', 'Marie', 'Lena', 'Julia', 'Sophie', 'Laura', 'Nina', 'Sarah', 'Lisa', 'Jana', 'Eva', 'Tanja', 'Mia', 'Clara', 'Ida', 'Paula', 'Greta', 'Hanna', 'Emma'];
const LAST = ['Muster', 'Beispiel', 'Probe', 'Testfrau', 'Sonnenschein', 'Lindner', 'Waldmann', 'Fichte', 'Rosenthal', 'Ahorn', 'Birke', 'Eiche', 'Linde', 'Kiefer', 'Weide'];

function rng(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }
const fmtNum = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usDate = (ymd) => { const [y, m, d] = ymd.split('-'); return `${m}/${d}/${y}`; };

/** Erzeugt eine Organisation: Kathrin (Level 0) + n Mitglieder. */
export function makeOrg(n = 60, seed = 7) {
  const r = rng(seed);
  const people = [{ id: OWNER, name: 'Beispiel, Kathrin', type: 'Wellness Advocate', level: 0, sponsor: '90000000', enroller: '90000000', entry: '2023-10-17' }];
  for (let i = 1; i <= n; i++) {
    const id = String(90000001 + i);
    // Platzierung: erste 5 direkt unter Kathrin; Rest zufällig unter Vorhandene
    const sponsor = i <= 5 ? OWNER : people[Math.floor(r() * people.length)].id;
    // Einschreibung: oft Kathrin, sonst die Sponsorin – erzeugt bewusst Unterschiede
    const enroller = r() < 0.55 ? OWNER : sponsor;
    const lvl = (people.find((p) => p.id === sponsor)?.level ?? 0) + 1;
    const type = r() < 0.25 ? 'Wellness Advocate' : r() < 0.97 ? 'Vorteilskunde' : 'Retail Customer';
    const y = 2024 + Math.floor(r() * 3);
    const mo = 1 + Math.floor(r() * (y === 2026 ? 10 : 12));
    people.push({ id, name: `${LAST[i % LAST.length]}, ${FIRST[i % FIRST.length]}`, type, level: lvl, sponsor, enroller, entry: `${y}-${String(mo).padStart(2, '0')}-${String(1 + Math.floor(r() * 27)).padStart(2, '0')}` });
  }
  // Volumen: je Person Aktivitätsmuster
  for (const p of people) {
    const pattern = r();
    p.months = {};
    MONTH_LABELS.forEach((m, idx) => {
      let pv = 0, lrp = 0;
      if (p.id === OWNER) { pv = [0, 291.5, 205, 180, 160, 150, 140][idx]; lrp = pv; }
      else if (pattern < 0.35) { pv = 100 + Math.round(r() * 80); lrp = pv; }           // treue LRP
      else if (pattern < 0.6) { if (r() < 0.5) { pv = 40 + Math.round(r() * 60); lrp = r() < 0.5 ? pv : 0; } } // gelegentlich
      p.months[m] = pv > 0 ? { OV: pv, PV: pv, 'Qual PV': pv, 'LRP PV': lrp, PGV: 0, TGV: 0 } : null; // leer = keine Angabe
    });
    p.lrpActive = pattern < 0.45;
    p.nextLrp = p.lrpActive ? '2026-12-0' + (1 + Math.floor(r() * 8)) : null;
    p.lastOrder = pattern < 0.6 ? '2026-1' + (0 + Math.floor(r() * 2)) + '-0' + (1 + Math.floor(r() * 8)) : pattern < 0.8 ? '2025-0' + (3 + Math.floor(r() * 6)) + '-15' : null;
  }
  // OV der Kathrin = Summe PV aller (vereinfachte Stichprobenregel für den Test)
  for (const m of MONTH_LABELS) {
    const sum = people.reduce((s, p) => s + (p.months[m]?.PV || 0), 0);
    const own = people[0];
    if (own.months[m]) own.months[m].OV = sum; else own.months[m] = { OV: sum, PV: 0, 'Qual PV': 0, 'LRP PV': 0, PGV: 0, TGV: 0 };
  }
  return people;
}

export function downlinePayload(people, { dropRows = 0, expectedTotal } = {}) {
  const rows = people.slice(0, people.length - dropRows).map((p) => {
    const cells = Object.fromEntries(DOWNLINE_HEADERS.map((h) => [h, '']));
    Object.assign(cells, {
      'Mitglied-ID': p.id, Name: p.name, Mitgliedsart: p.type, Levels: p.level === 0 ? '' : String(p.level),
      'Derzeitiger Rang': p.type === 'Wellness Advocate' ? 'Wellness-Botschafter:in' : 'Vorteilskunde', 'Höchster Rang': p.id === OWNER ? 'Silver' : p.type === 'Wellness Advocate' ? 'Manager' : 'Vorteilskunde',
      'PV der nächsten Treuebestellung': p.lrpActive ? '120.00' : '', 'Nächster LRP-Termin': p.nextLrp ? usDate(p.nextLrp) : '',
      'Letztes Bestelldatum': p.lastOrder ? usDate(p.lastOrder) : '', Registrierungsdatum: usDate(p.entry),
      'ID Sponsor*in': p.sponsor, 'ID Enroller*in': p.enroller, 'E-Mail': `beispiel+${p.id}@example.invalid`, 'Mobiltelefon': '+49 000 000000', Stadt: 'Musterstadt', Land: p.id.endsWith('7') ? 'ITA' : 'DEU',
    });
    for (const [m, v] of Object.entries(p.months)) if (v) for (const [sub, val] of Object.entries(v)) cells[`${m}|${sub}`] = fmtNum(val);
    return { rowId: 'DetailGen' + p.id, cells };
  });
  return { kind: 'downline', headers: DOWNLINE_HEADERS, rows, expectedTotal: expectedTotal ?? people.length, complete: rows.length >= (expectedTotal ?? people.length), focusId: OWNER };
}

/** Schlagdistanz: Leg ID = Wurzel der Enroller-Kette (wie live geprüft) */
export function legsPayload(people) {
  const byId = Object.fromEntries(people.map((p) => [p.id, p]));
  const legOf = (id) => { let cur = byId[id], g = 0; while (cur && g++ < 50) { if (cur.enroller === OWNER) return cur.id; cur = byId[cur.enroller]; } return '0'; };
  const rows = people.map((p, i) => [String(i + 1), '­' + p.id, p.name, '­' + (p.id === OWNER ? '0' : legOf(p.id)), String(p.level), p.type === 'Wellness Advocate' ? 'Manager' : 'Consultant', '50.00%', fmtNum(p.months['November 2026']?.PV || 0), fmtNum(p.months['November 2026']?.OV || 0), '0', '0', '0', '0', '0', '0']);
  return { kind: 'legs', headers: LEG_HEADERS, rows, expectedTotal: people.length, complete: true, month: '2026-11', targetRank: 'Elite' };
}

export function orderRow({ invoice, type = 'I', source = 'AS', items = [['60204656', 1]], date, ship, pvMonth, volume, amount }) {
  return [invoice, type, source, '', ship ? 'TRACK' : '', items.map((i) => i[0]).join('\n'), items.map((i) => String(i[1])).join('\n'), '', usDate(date), ship ? usDate(ship) : '', pvMonth, fmtNum(volume), fmtNum(amount)];
}

export function commissionsPayload() {
  return {
    kind: 'commissions', currency: 'EUR', complete: true,
    tables: [
      { kind: 'primary', headers: ['Zeitraum', 'Verdienst', 'Gebühren', 'Zurückgehaltener Betrag', 'Auszuzahlender Betrag'], rows: [['08/2026', '1,072.00', '0.00', '0.00', '1,072.00'], ['09/2026', '2,099.18', '0.00', '346.72', '1,752.46']] },
      { kind: 'secondary', headers: ['Zeitraum', 'Verdienst', 'Gebühren', 'Zurückgehaltener Betrag', 'Auszuzahlender Betrag'], rows: [['09/2026', '287.15', '0.00', '0.00', '287.15'], ['44/2026', '50.00', '0.00', '0.00', '50.00']] },
    ],
  };
}
