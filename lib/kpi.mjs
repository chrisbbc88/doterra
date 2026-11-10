// Geschäftsregeln und Kennzahlen. Reine Funktionen über der Datenbank, deterministisch
// und testbar. Das Sprachmodell erhält nur Ergebnisse dieser Funktionen, rechnet nie selbst.
import { localDate, localMonth, addMonths, addDays, daysBetween } from './util.mjs';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const RULES = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../rules/ranks.json', import.meta.url)), 'utf8'));

export const KPI_DEFS = {
  neu30: { label: 'Neue Mitglieder (30 Tage)', def: 'Anzahl Personen in der Downline mit Registrierungsdatum in den letzten 30 Kalendertagen (Europe/Berlin). Quelle: Downline-Bericht.' },
  kaeuferMonat: { label: 'Bestellaktive Personen (lfd. Monat)', def: 'Personen mit PV > 0 im laufenden PV-Monat laut Downline-Bericht. Leere Zelle zählt als "keine Volumenangabe".' },
  lrpMonat: { label: 'LRP verarbeitet (lfd. Monat)', def: 'Personen mit LRP-PV > 0 im laufenden PV-Monat.' },
  lrpAktiv: { label: 'LRP hinterlegt', def: 'Personen mit eingetragenem "Nächster LRP-Termin" im Downline-Bericht.' },
  lrpUeberfaellig: { label: 'LRP-Termin überschritten', def: 'Personen, deren "Nächster LRP-Termin" vor heute liegt. Hinweis auf nicht verarbeitete Treuebestellung (Zahlung, Pause, Fehler) – im Office prüfen.' },
  wiederbestellquote: { label: 'Wiederbestellquote', def: 'Anteil der Personen mit PV > 0 im vorletzten abgeschlossenen Monat, die auch im letzten abgeschlossenen Monat PV > 0 hatten.' },
  eigenesPv: { label: 'Eigenes PV (lfd. Monat)', def: 'PV der Kontoinhaberin im laufenden Monat laut Downline-Bericht (Zeile Level 0).' },
  eigenesOv: { label: 'OV (lfd. Monat)', def: 'Organisationsvolumen der Kontoinhaberin im laufenden Monat. OV ist Volumen, kein Geldbetrag.' },
  provision: { label: 'Auszahlung letzter Monat', def: 'Primärbonus "Auszuzahlender Betrag" des letzten Monats in der Provisionsübersicht, in EUR. Einziger echter Geldbetrag im System.' },
};

const BUYER_TYPES = new Set(['Vorteilskundin', 'Einzelhandelskundin', 'Beraterin']);

export function context(db, ref = new Date()) {
  const today = localDate(ref);
  const month = localMonth(ref);
  const closed = [1, 2, 3, 4, 5, 6].map((n) => addMonths(month, -n)); // letzte 6 abgeschlossene Monate
  const covered = new Set(db.syncRuns ? Object.values(db.syncRuns).flatMap((r) => r.parts?.downline?.monthsCovered || []) : []);
  return { today, month, closed, covered, ownerId: db.settings.ownerId };
}

function monthVal(db, id, month, field) {
  const r = db.memberMonths[`${id}|${month}`];
  return r ? r[field] : undefined; // undefined = kein Datensatz
}

/** Kennzahlen je Mitglied */
export function memberStats(db, ctx) {
  const out = {};
  const ordersBy = {};
  for (const o of Object.values(db.orders)) (ordersBy[o.memberId] ||= []).push(o);
  for (const m of Object.values(db.members)) {
    if (m.inDownline === false) continue;
    const pvs = ctx.closed.map((mo) => monthVal(db, m.id, mo, 'pv'));
    const lrps = ctx.closed.map((mo) => monthVal(db, m.id, mo, 'lrpPv'));
    // Monate ohne Datensatz, die im Bericht abgedeckt waren, gelten als "ohne Volumenangabe".
    const knownMonths = ctx.closed.filter((mo, i) => pvs[i] !== undefined || ctx.covered.has(mo)).length;
    const activeMonths6 = pvs.filter((v) => (v ?? 0) > 0).length;
    const lrpMonths6 = lrps.filter((v) => (v ?? 0) > 0).length;
    const pvSum6 = pvs.reduce((a, v) => a + (v ?? 0), 0);
    const curPv = monthVal(db, m.id, ctx.month, 'pv');
    const curLrp = monthVal(db, m.id, ctx.month, 'lrpPv');
    const lastClosedPv = pvs[0];
    const daysSinceOrder = m.lastOrderDate ? daysBetween(m.lastOrderDate, ctx.today) : null;
    const ageDays = m.entryDate ? daysBetween(m.entryDate, ctx.today) : null;
    const orders = (ordersBy[m.id] || []).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const lrpOrders = orders.filter((o) => o.isLrp && o.status === 'ausgeführt');
    const lastLrpOrder = lrpOrders.at(-1) || null;
    let lastLrpMonth = null;
    for (const mo of [ctx.month, ...ctx.closed]) { if ((monthVal(db, m.id, mo, 'lrpPv') ?? 0) > 0) { lastLrpMonth = mo; break; } }
    const lrpOverdue = !!(m.nextLrpDate && m.nextLrpDate < ctx.today);

    let segment;
    if (ageDays !== null && ageDays <= 60) segment = 'Neu';
    else if (lrpMonths6 >= 5) segment = 'Treue LRP';
    else if (activeMonths6 >= 3) segment = 'Regelmäßig';
    else if (activeMonths6 >= 1) segment = 'Gelegentlich';
    else segment = 'Inaktiv';

    const risk = [];
    if (lrpMonths6 >= 2 && (pvs[0] ?? 0) === 0 && (curPv ?? 0) === 0) risk.push('LRP-Rhythmus unterbrochen');
    if (lrpMonths6 >= 2 && !m.nextLrpDate) risk.push('Kein LRP mehr hinterlegt');
    if (daysSinceOrder !== null && daysSinceOrder >= 75 && daysSinceOrder <= 150 && activeMonths6 >= 2) risk.push(`Letzte Bestellung vor ${daysSinceOrder} Tagen`);
    if (lrpOverdue) risk.push('LRP-Termin überschritten');

    const avgPv6 = knownMonths ? pvSum6 / 6 : null;
    const tier = avgPv6 === null ? '–' : avgPv6 >= 100 ? 'A' : avgPv6 >= 50 ? 'B' : avgPv6 > 0 ? 'C' : 'D';

    out[m.id] = {
      id: m.id, activeMonths6, lrpMonths6, avgPv6, tier, segment, risk, curPv: curPv ?? null, curLrp: curLrp ?? null,
      lastClosedPv: lastClosedPv ?? null, daysSinceOrder, ageDays, lastLrpMonth, lrpOverdue, hasLrp: !!m.nextLrpDate,
      orderCount: orders.length, lastLrpOrder: lastLrpOrder ? { invoice: lastLrpOrder.invoice, date: lastLrpOrder.date } : null,
      isBuyer: BUYER_TYPES.has(m.memberType),
    };
  }
  return out;
}

/** Teamstruktur in zwei getrennten Sichten:
 *  - Platzierungslinien: Frontline nach Sponsor (Platzierung), Kette über sponsorId.
 *  - Einschreibungsbeine: persönlich Eingeschriebene als Bein-Wurzel, Kette über enrollerId.
 *    Diese Sicht entspricht der "Leg ID" im Schlagdistanz-Bericht (am 10.11.2026 330/330 übereinstimmend geprüft)
 *    und ist die Grundlage der Rangqualifikation (Beine). */
export function teamStructure(db, ctx, stats) {
  const owner = ctx.ownerId;
  const members = db.members;
  const chainRoot = (field) => {
    const cache = {};
    return (id) => {
      if (cache[id] !== undefined) return cache[id];
      let cur = members[id], guard = 0; const path = [];
      while (cur && guard++ < 60) {
        path.push(cur.id);
        if (cur[field] === owner) { for (const p of path) cache[p] = cur.id; return cur.id; }
        cur = members[cur[field]];
      }
      for (const p of path) cache[p] = null; // Kette bricht ab -> ungeklärt
      return null;
    };
  };
  const placeOf = chainRoot('sponsorId');
  const legOf = chainRoot('enrollerId');
  const legSource = {};
  for (const m of Object.values(members)) {
    if (m.id === owner || m.inDownline === false) continue;
    const reportLeg = db.legs[`${m.id}|${ctx.month}`]?.legId || null;
    const derived = legOf(m.id);
    legSource[m.id] = {
      platzierungslinie: placeOf(m.id),
      bein: reportLeg && reportLeg !== '0' ? reportLeg : derived,
      beinQuelle: reportLeg && reportLeg !== '0' ? 'Schlagdistanz (Leg ID)' : derived ? 'Enroller-Kette (abgeleitet)' : 'ungeklärt',
      konflikt: !!(reportLeg && reportLeg !== '0' && derived && reportLeg !== derived),
    };
  }
  const summarize = (root, key) => {
    const ids = Object.entries(legSource).filter(([, v]) => v[key] === root.id).map(([k]) => k);
    const ms = ids.map((i) => members[i]);
    const st = ids.map((i) => stats[i]).filter(Boolean);
    const strike = db.legs[`${root.id}|${ctx.month}`];
    const ovRow = monthVal(db, root.id, ctx.month, 'ov');
    const ovPrev = monthVal(db, root.id, ctx.closed[0], 'ov');
    const ovPrev2 = monthVal(db, root.id, ctx.closed[1], 'ov');
    const neu90 = ms.filter((m) => m.entryDate && daysBetween(m.entryDate, ctx.today) <= 90).length;
    const beraterinnen = ms.filter((m) => m.memberType === 'Beraterin').length + (root.memberType === 'Beraterin' ? 1 : 0);
    const kaeufer = st.filter((s) => (s.curPv ?? 0) > 0).length + ((stats[root.id]?.curPv ?? 0) > 0 ? 1 : 0);
    const all = [...st, stats[root.id]].filter(Boolean);
    const lrpTeil = all.length ? all.filter((s) => s.hasLrp).length / all.length : null;
    const hinweise = [];
    if (ovPrev && ovPrev2 && ovPrev < ovPrev2 * 0.75) hinweise.push(`OV im letzten Monat um ${Math.round((1 - ovPrev / ovPrev2) * 100)} % gesunken`);
    if (ms.length >= 4 && neu90 === 0) hinweise.push('Keine Neuregistrierung in 90 Tagen');
    if (lrpTeil !== null && all.length >= 5 && lrpTeil < 0.3) hinweise.push(`Nur ${Math.round(lrpTeil * 100)} % mit LRP`);
    if (all.length >= 5 && beraterinnen === 0) hinweise.push('Keine Beraterin in der Linie');
    return {
      rootId: root.id, name: root.name, art: root.memberType, rang: root.currentRank, hoechsterRang: root.highestRank,
      monatsrang: strike?.monthRank || null, prozentZumRang: strike?.pctToRank ?? null, schlagdistanzZiel: strike?.targetRank || null,
      ovSchlagdistanz: strike?.ov ?? null, ov: ovRow ?? null, ovVormonat: ovPrev ?? null, ovVorvormonat: ovPrev2 ?? null,
      mitglieder: ms.length + 1, beraterinnen, kaeufer, neu90, lrpTeil, hinweise,
    };
  };
  const frontline = Object.values(members).filter((m) => m.sponsorId === owner && m.inDownline !== false);
  const enrollees = Object.values(members).filter((m) => m.enrollerId === owner && m.inDownline !== false);
  const byOv = (a, b) => ((b.ovSchlagdistanz ?? b.ov ?? -1) - (a.ovSchlagdistanz ?? a.ov ?? -1));
  const placementLines = frontline.map((f) => summarize(f, 'platzierungslinie')).sort(byOv);
  const legs = enrollees.map((f) => summarize(f, 'bein')).sort(byOv);

  const enrollers = {};
  for (const m of Object.values(members)) {
    if (!m.enrollerId || m.inDownline === false) continue;
    const e = (enrollers[m.enrollerId] ||= { id: m.enrollerId, name: members[m.enrollerId]?.name || m.enrollerName, gesamt: 0, neu90: 0, aktiveEnrollees: 0 });
    e.gesamt++;
    if (m.entryDate && daysBetween(m.entryDate, ctx.today) <= 90) e.neu90++;
    if ((stats[m.id]?.activeMonths6 ?? 0) >= 1) e.aktiveEnrollees++;
  }
  return {
    frontline: frontline.map((f) => f.id), personalEnrollees: enrollees.map((m) => m.id),
    placementLines, legs, legSource,
    ungeklaert: Object.entries(legSource).filter(([, v]) => !v.bein || !v.platzierungslinie).map(([k]) => k),
    konflikte: Object.entries(legSource).filter(([, v]) => v.konflikt).map(([k]) => k),
    enrollers: Object.values(enrollers).sort((a, b) => b.neu90 - a.neu90 || b.gesamt - a.gesamt),
  };
}

/** Produktsicht aus ausgeführten Bestellungen */
export function productStats(db, ctx) {
  const by = {};
  const cutoff90 = addDays(ctx.today, -90), cutoff365 = addDays(ctx.today, -365);
  const perMember = {};
  for (const o of Object.values(db.orders)) {
    if (o.status !== 'ausgeführt') continue;
    for (const it of o.items || []) {
      const p = (by[it.sku] ||= { sku: it.sku, name: db.products[it.sku]?.name || null, bestellungen365: 0, bestellungen90: 0, menge365: 0, kaeufer: new Set() });
      if (o.date >= cutoff365) { p.bestellungen365++; p.menge365 += it.qty || 0; p.kaeufer.add(o.memberId); }
      if (o.date >= cutoff90) p.bestellungen90++;
      ((perMember[o.memberId] ||= {})[it.sku] ||= []).push(o.date);
    }
  }
  const list = Object.values(by).map((p) => ({ ...p, kaeufer: p.kaeufer.size })).sort((a, b) => b.bestellungen365 - a.bestellungen365);
  // Nachkauf-Zyklus: gleicher Artikel mind. 2x gekauft -> Median-Abstand; fällig, wenn überschritten.
  const nachkauf = [];
  for (const [mid, skus] of Object.entries(perMember)) {
    for (const [sku, dates] of Object.entries(skus)) {
      const ds = [...new Set(dates)].sort();
      if (ds.length < 2) continue;
      const gaps = ds.slice(1).map((d, i) => daysBetween(ds[i], d)).sort((a, b) => a - b);
      const median = gaps[Math.floor(gaps.length / 2)];
      const since = daysBetween(ds.at(-1), ctx.today);
      if (median >= 20 && since >= median) nachkauf.push({ memberId: mid, sku, name: db.products[sku]?.name || null, kaeufe: ds.length, medianTage: median, seitLetztemKauf: since });
    }
  }
  nachkauf.sort((a, b) => b.seitLetztemKauf / b.medianTage - a.seitLetztemKauf / a.medianTage);
  return { list, perMember, nachkauf };
}

/** Handlungsvorschläge. Jede Regel liefert Beobachtung, Begründung, Aktion, Datengrundlage. */
export function opportunities(db, ctx, stats, products) {
  const out = [];
  const name = (id) => db.members[id]?.name || id;
  const push = (o) => out.push({ id: `${o.regel}:${o.memberId}${o.extra ? ':' + o.extra : ''}`, ...o });
  for (const s of Object.values(stats)) {
    const m = db.members[s.id];
    if (s.id === ctx.ownerId) continue;
    if (s.lrpOverdue) push({ regel: 'lrp_ueberfaellig', memberId: s.id, gewicht: 5,
      titel: `LRP von ${name(s.id)} wurde nicht verarbeitet`,
      beobachtung: `Nächster LRP-Termin laut Office: ${m.nextLrpDate}; heute: ${ctx.today}.`,
      begruendung: 'Ein Termin in der Vergangenheit deutet auf eine nicht verarbeitete Treuebestellung hin (z. B. Zahlungsproblem oder Pause).',
      aktion: 'Freundlich nachfragen, ob alles passt, und bei Bedarf Unterstützung anbieten.', unsicherheit: 'Ursache ist aus den Daten nicht erkennbar.' });
    if (s.isBuyer && !s.hasLrp && s.daysSinceOrder !== null && s.daysSinceOrder <= 90) push({ regel: 'lrp_vorstellen', memberId: s.id, gewicht: 3,
      titel: `${name(s.id)}: bestellt, aber kein LRP`,
      beobachtung: `Letzte Bestellung vor ${s.daysSinceOrder} Tagen, kein nächster LRP-Termin hinterlegt.`,
      begruendung: 'Kundin kauft aktiv; das Treueprogramm bringt ihr Punkte für eigene Produktwünsche.',
      aktion: 'Im nächsten Gespräch das Treueprogramm erklären – ohne Druck, nur wenn es zu ihrem Bedarf passt.', unsicherheit: 'Ob ein LRP gewünscht ist, kann nur das Gespräch klären.' });
    if (s.segment !== 'Neu' && s.activeMonths6 >= 3 && (s.lastClosedPv ?? 0) === 0 && (stats[s.id].curPv ?? 0) === 0) push({ regel: 'reaktivieren', memberId: s.id, gewicht: 4,
      titel: `${name(s.id)} war regelmäßig aktiv, zuletzt nicht`,
      beobachtung: `Aktiv in ${s.activeMonths6} der letzten 6 Monate, im letzten Monat und bisher in diesem Monat ohne PV.`,
      begruendung: 'Regelmäßige Kundinnen früh anzusprechen erhält die Beziehung.',
      aktion: 'Persönlich nachfragen, wie es mit den Produkten läuft.', unsicherheit: 'Die Kundin kann auch über andere Wege bestellt haben (nicht sichtbar).' });
    if (s.ageDays !== null && s.ageDays <= 45 && s.orderCount <= 1) push({ regel: 'onboarding', memberId: s.id, gewicht: 4,
      titel: `Willkommensbegleitung für ${name(s.id)}`,
      beobachtung: `Registriert vor ${s.ageDays} Tagen, ${s.orderCount} erfasste Bestellung(en).`,
      begruendung: 'Die ersten Wochen entscheiden, ob die Produkte in den Alltag finden.',
      aktion: 'Kurzes Willkommensgespräch: Anwendung, Fragen, ggf. Einladung zu einem Workshop.', unsicherheit: s.orderCount === 0 ? 'Bestellhistorie evtl. noch nicht abgeglichen.' : null });
    if (m.memberType !== 'Beraterin') {
      const geworben = Object.values(db.members).filter((x) => x.enrollerId === s.id && x.inDownline !== false).length;
      if (geworben >= 2) push({ regel: 'business_interesse', memberId: s.id, gewicht: 2,
        titel: `${name(s.id)} hat bereits ${geworben} Person(en) eingeschrieben`,
        beobachtung: `Als Enroller*in eingetragen bei ${geworben} Mitglied(ern), selbst Mitgliedsart "${m.memberType}".`,
        begruendung: 'Wer andere begeistert, interessiert sich womöglich für die Beraterinnen-Rolle.',
        aktion: 'Offen fragen, ob sie mehr über die Möglichkeiten als Beraterin wissen möchte.', unsicherheit: 'Interesse ist nicht ableitbar, nur ein Gesprächsanlass.' });
    }
    if (m.memberType === 'Beraterin' && s.activeMonths6 >= 2 && (s.lastClosedPv ?? 0) === 0) {
      const kunden = Object.values(db.members).filter((x) => x.sponsorId === s.id && x.inDownline !== false).length;
      if (kunden >= 2) push({ regel: 'beraterin_unterstuetzen', memberId: s.id, gewicht: 3,
        titel: `Beraterin ${name(s.id)} braucht evtl. Unterstützung`,
        beobachtung: `${kunden} direkt platzierte Mitglieder, eigenes PV im letzten Monat 0.`,
        begruendung: 'Aktive Beraterinnen halten ihre Linie stabil.',
        aktion: 'Kurzer Check-in: Ziele, Hindernisse, gemeinsamer nächster Schritt.', unsicherheit: null });
    }
  }
  for (const n of products.nachkauf.slice(0, 40)) push({ regel: 'nachkauf', memberId: n.memberId, extra: n.sku, gewicht: 2,
    titel: `${name(n.memberId)}: Nachkauf ${n.name || 'Artikel ' + n.sku} möglich`,
    beobachtung: `Artikel ${n.kaeufe}× gekauft, typischer Abstand ${n.medianTage} Tage, letzter Kauf vor ${n.seitLetztemKauf} Tagen.`,
    begruendung: 'Der übliche Nachkauf-Rhythmus ist überschritten.',
    aktion: 'Beiläufig nachfragen, ob der Artikel noch vorrätig ist.', unsicherheit: 'Kein Rückschluss auf Gesundheit oder Verwendung – nur Kaufrhythmus.' });
  // Wertigkeit der Kundin fließt in die Priorität ein
  const tierW = { A: 3, B: 2, C: 1, D: 0.5, '–': 0.5 };
  for (const o of out) o.prioritaet = o.gewicht * (tierW[stats[o.memberId]?.tier] || 1);
  return out.sort((a, b) => b.prioritaet - a.prioritaet);
}

export function kpis(db, ctx, stats) {
  const ids = Object.keys(stats);
  const sel = (f) => ids.filter((i) => f(stats[i], db.members[i]));
  const prev1 = ctx.closed[0], prev2 = ctx.closed[1];
  const activePrev2 = ids.filter((i) => (monthVal(db, i, prev2, 'pv') ?? 0) > 0);
  const stayed = activePrev2.filter((i) => (monthVal(db, i, prev1, 'pv') ?? 0) > 0);
  const owner = ctx.ownerId;
  const lastComm = Object.values(db.commissions).filter((c) => c.kind === 'primary').sort((a, b) => b.month.localeCompare(a.month))[0];
  const res = {
    neu30: { ids: sel((s, m) => m.entryDate && daysBetween(m.entryDate, ctx.today) <= 30 && m.id !== owner) },
    kaeuferMonat: { ids: sel((s, m) => (s.curPv ?? 0) > 0 && m.id !== owner) },
    lrpMonat: { ids: sel((s, m) => (s.curLrp ?? 0) > 0 && m.id !== owner) },
    lrpAktiv: { ids: sel((s, m) => s.hasLrp && m.id !== owner) },
    lrpUeberfaellig: { ids: sel((s) => s.lrpOverdue) },
    wiederbestellquote: { wert: activePrev2.length ? stayed.length / activePrev2.length : null, einheit: '%', basis: `${stayed.length} von ${activePrev2.length} (${prev2} → ${prev1})`, ids: stayed },
    eigenesPv: { wert: owner ? monthVal(db, owner, ctx.month, 'pv') ?? null : null, einheit: 'PV', vormonat: owner ? monthVal(db, owner, prev1, 'pv') ?? null : null },
    eigenesOv: { wert: owner ? monthVal(db, owner, ctx.month, 'ov') ?? null : null, einheit: 'OV', vormonat: owner ? monthVal(db, owner, prev1, 'ov') ?? null : null },
    provision: { wert: lastComm ? lastComm.payout : null, einheit: lastComm?.currency || 'EUR', monat: lastComm?.month || null },
  };
  for (const [k, v] of Object.entries(res)) {
    v.label = KPI_DEFS[k].label; v.def = KPI_DEFS[k].def;
    if (v.wert === undefined) { v.wert = v.ids.length; v.einheit = 'Personen'; }
  }
  return res;
}

/** Monatsverlauf (letzte 6 abgeschlossene + laufender Monat) für Kontoinhaberin und Team */
export function trend(db, ctx) {
  const months = [...ctx.closed].reverse().concat(ctx.month);
  const owner = ctx.ownerId;
  return months.map((mo) => {
    let buyers = 0, lrp = 0, neu = 0;
    for (const m of Object.values(db.members)) {
      if (m.id === owner) continue;
      if ((monthVal(db, m.id, mo, 'pv') ?? 0) > 0) buyers++;
      if ((monthVal(db, m.id, mo, 'lrpPv') ?? 0) > 0) lrp++;
      if (m.entryDate && m.entryDate.slice(0, 7) === mo) neu++;
    }
    const c = db.commissions[`${mo}|primary`];
    return { monat: mo, laufend: mo === ctx.month, eigenesPv: owner ? monthVal(db, owner, mo, 'pv') ?? null : null, ov: owner ? monthVal(db, owner, mo, 'ov') ?? null : null, kaeufer: buyers, lrp, neu, provisionEUR: c ? c.payout : null };
  });
}

/** Rangplanung: aktueller Stand vs. versionierte Zielbedingungen */
export function rankPlan(db, ctx, team, targetRank = 'Gold') {
  const version = RULES.versions.find((v) => v.gueltigAb <= ctx.today && (!v.gueltigBis || v.gueltigBis >= ctx.today)) || RULES.versions[0];
  const rule = version.raenge[targetRank];
  const owner = ctx.ownerId;
  const me = db.members[owner];
  const strikeMe = db.legs[`${owner}|${ctx.month}`];
  const base = { zielRang: targetRank, regelVersion: version.version, quelle: version.quelle, geprueftAm: version.geprueftAm, status: rule?.status || 'unbekannt' };
  if (!rule || rule.status !== 'geprüft') return { ...base, hinweis: `Für ${targetRank} liegen keine geprüften Bedingungen vor. Angezeigt wird nur die von doTERRA berechnete Schlagdistanz.`, schlagdistanz: strikeMe || null };
  const pv = monthVal(db, owner, ctx.month, 'lrpPv');
  const tgv = monthVal(db, owner, ctx.month, 'tgv');
  const ov = monthVal(db, owner, ctx.month, 'ov');
  const order = version.rangfolge;
  const needIdx = rule.beine ? order.indexOf(rule.beine.rang) : -1;
  const legsMeeting = team.legs.filter((l) => {
    const r = l.monatsrang || l.rang;
    const i = order.indexOf(r);
    return i >= 0 && i >= needIdx;
  });
  const bedingungen = [
    { bedingung: `Persönliches LRP-PV ≥ ${rule.persoenlichesLrpPv}`, ist: pv ?? null, soll: rule.persoenlichesLrpPv, erfuellt: pv != null ? pv >= rule.persoenlichesLrpPv : null, art: 'beobachtet' },
    rule.tgv != null && { bedingung: `TGV ≥ ${rule.tgv}`, ist: tgv ?? null, soll: rule.tgv, erfuellt: tgv != null ? tgv >= rule.tgv : null, art: 'beobachtet' },
    rule.ov != null && { bedingung: `OV ≥ ${rule.ov}`, ist: ov ?? null, soll: rule.ov, erfuellt: ov != null ? ov >= rule.ov : null, art: 'beobachtet' },
    rule.beine && { bedingung: `${rule.beine.anzahl} Beine mit Rang ${rule.beine.rang} oder höher`, ist: legsMeeting.length, soll: rule.beine.anzahl, erfuellt: legsMeeting.length >= rule.beine.anzahl, art: 'berechnet', details: legsMeeting.map((l) => l.name) },
  ].filter(Boolean);
  const naechsteBeine = team.legs.filter((l) => !legsMeeting.includes(l)).sort((a, b) => (b.prozentZumRang ?? 0) - (a.prozentZumRang ?? 0)).slice(0, 4)
    .map((l) => ({ name: l.name, rootId: l.rootId, monatsrang: l.monatsrang, ov: l.ovSchlagdistanz ?? l.ov, prozentZumRang: l.prozentZumRang, bezugsrang: l.schlagdistanzZiel }));
  return { ...base, monat: ctx.month, aktuellerRang: { bezahlt: null, bezahltHinweis: 'Letzter bezahlter Rang wird noch nicht abgeglichen (nur im Rank Tracker sichtbar).', hoechster: me?.highestRank || null, derzeitig: me?.currentRank || null, monatsqualifikation: strikeMe?.monthRank || null }, bedingungen, naechsteBeine,
    hinweis: 'Monatswerte sind laufend und ändern sich bis Monatsende. Empfohlen wird Wachstum über echte Kundennachfrage, keine Vorratskäufe.' };
}

/** Startseite: Was ist heute wichtig? Begrenzte Tagesprioritäten nach verfügbarer Zeit. */
export function today(db, ctx, opps) {
  const tasks = Object.values(db.tasks).filter((t) => t.status !== 'erledigt');
  const due = tasks.filter((t) => t.due && t.due <= ctx.today).sort((a, b) => a.due.localeCompare(b.due));
  const followUps = Object.entries(db.profiles).filter(([, p]) => p.followUpDate && p.followUpDate <= ctx.today).map(([key, p]) => ({ contactKey: key, followUpDate: p.followUpDate, nextStep: p.nextStep || null }));
  const minutesPerDay = Math.round((db.settings.weeklyHours || 10) * 60 / 5);
  const steps = [];
  let budget = minutesPerDay;
  const seen = new Set();
  const de = (ymd) => ymd ? ymd.split('-').reverse().join('.') : '';
  // Höchstens 3 Schritte, jede Person nur einmal, innerhalb des Tagesbudgets
  const add = (s) => { if (s.contactKey && seen.has(s.contactKey)) return; if (steps.length < 3 && budget - (s.minuten || 15) >= 0) { steps.push(s); budget -= s.minuten || 15; if (s.contactKey) seen.add(s.contactKey); } };
  for (const t of due) add({ art: 'aufgabe', titel: t.title, taskId: t.id, contactKey: t.contactKey || null, minuten: t.estimateMin || 15, grund: `Fällig am ${de(t.due)}` });
  for (const f of followUps) add({ art: 'wiedervorlage', titel: `Wiedervorlage: ${db.members[f.contactKey]?.name || db.prospects[f.contactKey]?.name || f.contactKey}`, contactKey: f.contactKey, minuten: 15, grund: f.nextStep || `Wiedervorlage ${de(f.followUpDate)}` });
  const done = new Set(Object.values(db.tasks).filter((t) => t.origin).map((t) => t.origin));
  for (const o of opps) if (!done.has(o.id)) add({ art: 'vorschlag', titel: o.titel, contactKey: o.memberId, opportunityId: o.id, minuten: 15, grund: o.beobachtung });
  return { due, followUps, steps, minutesPerDay };
}

export function goalsProgress(db, ctx, stats) {
  const out = [];
  for (const g of Object.values(db.goals)) {
    if (g.month !== ctx.month) continue;
    let ist = null;
    if (g.metric === 'neue_mitglieder') ist = Object.values(db.members).filter((m) => m.entryDate?.slice(0, 7) === ctx.month && m.id !== ctx.ownerId).length;
    else if (g.metric === 'lrp_personen') ist = Object.values(stats).filter((s) => (s.curLrp ?? 0) > 0 && s.id !== ctx.ownerId).length;
    else if (g.metric === 'aktive_kaeufer') ist = Object.values(stats).filter((s) => (s.curPv ?? 0) > 0 && s.id !== ctx.ownerId).length;
    else if (g.metric === 'ov') ist = monthVal(db, ctx.ownerId, ctx.month, 'ov') ?? null;
    else if (g.metric === 'veranstaltungen') ist = Object.values(db.events).filter((e) => e.date?.slice(0, 7) === ctx.month).length;
    else if (g.metric === 'manuell') ist = g.manualValue ?? null;
    const [y, mo] = ctx.month.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const dayOfMonth = Number(ctx.today.slice(8, 10));
    const sollAnteilig = g.target != null ? g.target * dayOfMonth / daysInMonth : null;
    out.push({ ...g, ist, sollAnteilig, aufmerksamkeit: ist != null && sollAnteilig != null && ist < sollAnteilig * 0.8 });
  }
  return out;
}

export function eventOutcome(db, ev) {
  const keys = ev.participants || [];
  const after = (d, n) => d && ev.date && d >= ev.date && daysBetween(ev.date, d) <= n;
  const eingeschrieben = keys.filter((k) => after(db.members[k]?.entryDate, 30));
  const bestellt = keys.filter((k) => Object.values(db.orders).some((o) => o.memberId === k && after(o.date, 30)));
  return { teilnehmende: keys.length, eingeschrieben30: eingeschrieben, bestellt30: bestellt, hinweis: 'Gezählt werden nur Teilnehmende, die im CRM mit einer doTERRA-ID verknüpft sind.' };
}

export function computeAll(db, ref = new Date()) {
  const ctx = context(db, ref);
  const stats = memberStats(db, ctx);
  const team = teamStructure(db, ctx, stats);
  const products = productStats(db, ctx);
  const opps = opportunities(db, ctx, stats, products);
  return { ctx, stats, team, products, opps, kpis: kpis(db, ctx, stats), trend: trend(db, ctx) };
}
