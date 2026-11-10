// Sammelfunktionen, die per chrome.scripting.executeScript im eingeloggten Tab
// von office.doterra.com laufen. Jede Funktion ist in sich geschlossen (keine Closures),
// liest nur (GET bzw. Berichts-POST ohne Speichern von Voreinstellungen) und gibt Rohdaten zurück.
// Es werden keine Formulare abgeschickt, die Konto-, Bestell- oder Platzierungsdaten ändern.

export async function checkSession() {
  try {
    const r = await fetch('/index.cfm?tabsel=MainMenu', { credentials: 'same-origin', redirect: 'follow' });
    const h = await r.text();
    const u = new URL(r.url);
    const loggedOut = u.hostname !== 'office.doterra.com' || /login|signin|auth/i.test(u.pathname + u.search) || /type=["']password["']|gigya\.com\/oidc|\/oidc\/op\/|\/authorize\?scope=/i.test(h) || !/Fuseaction|evo_Modules|My Dashboard|Startseite/i.test(h);
    return { ok: !loggedOut, status: r.status };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function collectDownline() {
  try {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function req(url, init, tries = 3) {
    for (let i = 0; i < tries; i++) {
      try {
        const r = await fetch(url, { credentials: 'same-origin', ...init });
        if (r.status >= 500) throw new Error('HTTP ' + r.status);
        const t = await r.text();
        if (/type=["']password["']|gigya\.com\/oidc|\/oidc\/op\/|\/authorize\?scope=/i.test(t) && !/DetailGen/i.test(t)) throw Object.assign(new Error('Sitzung abgelaufen'), { session: true });
        return t;
      } catch (e) {
        if (e.session || i === tries - 1) throw e;
        await sleep(1000 * 2 ** i);
      }
    }
  }
  const txt = (el) => { const c = el.cloneNode(true); c.querySelectorAll('br').forEach((b) => b.replaceWith('\n')); return c.textContent.replace(/[\u00ad\u200b-\u200d\ufeff]/g, '').replace(/[ \t\u00a0]+/g, ' ').split('\n').map((s) => s.trim()).filter(Boolean).join('\n'); };
  const parse = (html) => new DOMParser().parseFromString(html, 'text/html');
  const bigTable = (d) => [...d.querySelectorAll('table')].sort((a, b) => b.rows.length - a.rows.length)[0];

  // 1) Formular der Seite laden und mit festen, vollständigen Einstellungen abschicken (saveDefault=0)
  // Die Seite lädt Formular und Tabelle per AJAX nach ("FirstLoad"); genau diesen Aufruf nutzen wir.
  let form = null;
  for (let attempt = 0; attempt < 4 && !form; attempt++) {
    if (attempt) await sleep(2000 * attempt);
    await req('/index.cfm?Fuseaction=evo_Modules.DetailedGenealogy&Reset=1');
    const page = parse(await req('/index.cfm?Fuseaction=evo_Modules.DetailedGenealogy&Reset=1&FuseSubAction=AjaxMain&FirstLoad=1', { method: 'POST' }));
    form = page.querySelector('form#DetailedGenForm, form[name=DetailedGenForm]');
  }
  if (!form) throw Object.assign(new Error('Downline-Formular nicht gefunden'), { structure: true });
  const fd = new URLSearchParams();
  for (const el of form.elements) {
    if (!el.name || el.type === 'submit' || el.type === 'button') continue;
    if (el.type === 'checkbox') {
      // alle Spalten-Checkboxen einschalten; Filter-Checkboxen wie vorgegeben übernehmen
      const isFilter = /^DETAIL_|^active$|^loyalty-rewards$/.test(el.name);
      if (isFilter ? el.hasAttribute('checked') : true) fd.append(el.name, el.value || 'on');
      continue;
    }
    fd.append(el.name, el.value);
  }
  const set = (k, v) => fd.set(k, v);
  set('saveDefault', '0'); set('FuseSubAction', 'AjaxMain'); set('UpdateDetailFilter', '1');
  set('DETAIL_START_LEVEL', '0');
  const maxLevel = form.elements.DETAIL_END_LEVEL?.getAttribute('max');
  set('DETAIL_END_LEVEL', maxLevel || '10');
  set('DETAIL_TYPE', 'SponsorDownlineExtended');
  set('DETAIL_MEMBERS', 'D,C,P,R,S,W');
  set('DETAIL_RANKS', '1,2,3,4,5,6,7,8,9,10,11,12');
  set('DETAIL_ACTIVE', 'ALL'); set('DETAIL_AUTOSHIP', 'ALL');
  for (const k of ['DETAIL_NEXT_LRP_DATE_FROM', 'DETAIL_NEXT_LRP_DATE_TO', 'DETAIL_LAST_ORDER_DATE_FROM', 'DETAIL_LAST_ORDER_DATE_TO', 'DETAIL_NEXT_LRP_PV', 'DETAIL_NEXT_LRP_PV_RANGE', 'DETAIL_NEXT_LRP_PV_GOAL', 'DETAIL_SEARCH']) set(k, '');
  const focusId = form.elements.DETAIL_FOCUSID?.value || null;

  const pageResult = (html) => {
    const d = parse(html);
    const t = bigTable(d);
    if (!t || !t.tHead) return null;
    const h0 = [...t.tHead.rows[0].cells];
    const h1 = t.tHead.rows[1] ? [...t.tHead.rows[1].cells] : [];
    const headers = [];
    let si = 0;
    for (const c of h0) {
      const label = txt(c);
      if (c.colSpan > 1) { for (let k = 0; k < c.colSpan; k++) headers.push(label + '|' + txt(h1[si++] || c)); }
      else headers.push(label);
    }
    const rows = [...t.tBodies[0].rows].filter((r) => r.cells.length === headers.length).map((r) => {
      const cells = {};
      [...r.cells].forEach((c, i) => { cells[headers[i]] = txt(c); });
      return { rowId: r.id || null, cells };
    });
    const info = (d.body.textContent.match(/Showing Record\s*(\d+)\s*-\s*(\d+)\s*(?:von|of)\s*(\d+)/i) || []);
    return { headers, rows, total: info[3] ? Number(info[3]) : null };
  };

  let first = pageResult(await req('/index.cfm', { method: 'POST', body: fd }));
  if (!first) throw Object.assign(new Error('Downline-Tabelle nicht gefunden'), { structure: true });
  const all = [...first.rows];
  const total = first.total ?? first.rows.length;
  let start = first.rows.length + 1, guard = 0;
  while (all.length < total && guard++ < 50) {
    await sleep(400);
    const body = new URLSearchParams({ FuseAction: 'evo_Modules.DetailedGenealogy', FuseSubAction: 'AjaxMain', PAGING: '1', DoNotCache: '1', sortdirection: '', sortfield: '', StartNum: String(start) });
    const p = pageResult(await req('/index.cfm', { method: 'POST', body }));
    if (!p || !p.rows.length) break;
    if (p.headers.join('§') !== first.headers.join('§')) throw Object.assign(new Error('Spalten zwischen Seiten verschieden'), { structure: true });
    all.push(...p.rows);
    start += p.rows.length;
  }
  // Duplikate über Seiten hinweg entfernen (stabile Zeilen-ID)
  const seen = new Set();
  const rows = all.filter((r) => { const k = r.rowId || JSON.stringify(r.cells); if (seen.has(k)) return false; seen.add(k); return true; });
  return { kind: 'downline', headers: first.headers, rows, expectedTotal: total, complete: rows.length >= total, focusId, fetchedAt: new Date().toISOString() };
  } catch (e) {
    return { __error: String((e && e.message) || e), structure: !!(e && e.structure), session: !!(e && e.session) };
  }
}

export async function collectLegs() {
  try {
  const r = await fetch('/index.cfm?Fuseaction=evo_Modules.QueryReport&QryID=EliteStriking&QueryType=StrikingDistance&SORTFIELD=amt5&SORTTYPE=A&SORTDIRECTION=D', { credentials: 'same-origin' });
  if (r.status >= 400) throw new Error('HTTP ' + r.status);
  const __h = await r.text(); if (/type=["']password["']|gigya\.com\/oidc|\/oidc\/op\/|\/authorize\?scope=/i.test(__h)) throw Object.assign(new Error('Sitzung abgelaufen'), { session: true });
    const d = new DOMParser().parseFromString(__h, 'text/html');
  const t = [...d.querySelectorAll('table')].sort((a, b) => b.rows.length - a.rows.length)[0];
  if (!t) throw Object.assign(new Error('Schlagdistanz-Tabelle fehlt'), { structure: true });
  const headers = [...t.rows[0].cells].map((c) => c.textContent.replace(/[\u00ad\u200b-\u200d\ufeff]/g, '').trim().replace(/\s+/g, ' '));
  const rows = [...t.rows].slice(1).map((r) => [...r.cells].map((c) => c.textContent.replace(/[\u00ad\u200b-\u200d\ufeff]/g, '').trim().replace(/\s+/g, ' '))).filter((c) => c.length === headers.length && /^\d{4,}$/.test(c[1] || ''));
  const info = d.body.textContent.match(/(?:Angezeigt|Showing):?\s*\d+\s*-\s*\d+\s*(?:von|of)\s*(\d+)/i);
  const sels = [...d.querySelectorAll('select')];
  const rankSel = sels.find((s) => [...s.options].some((o) => /Premier/.test(o.text)));
  const periodSel = sels.find((s) => [...s.options].some((o) => /^\d{1,2}\/\d{4}$/.test(o.text.trim())));
  const per = periodSel ? periodSel.options[periodSel.selectedIndex].text.trim().match(/^(\d{1,2})\/(\d{4})$/) : null;
  return {
    kind: 'legs', headers, rows, expectedTotal: info ? Number(info[1]) : null, complete: true,
    targetRank: rankSel ? rankSel.options[rankSel.selectedIndex].text.trim() : null,
    month: per ? `${per[2]}-${per[1].padStart(2, '0')}` : null, fetchedAt: new Date().toISOString(),
  };
  } catch (e) {
    return { __error: String((e && e.message) || e), structure: !!(e && e.structure), session: !!(e && e.session) };
  }
}

export async function collectOrders(plan, opts) {
  try {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const concurrency = (opts && opts.concurrency) || 3;
  const txt = (el) => { const c = el.cloneNode(true); c.querySelectorAll('br').forEach((b) => b.replaceWith('\n')); return c.textContent.replace(/[\u00ad\u200b-\u200d\ufeff]/g, '').replace(/[ \t\u00a0]+/g, ' ').split('\n').map((s) => s.trim()).filter(Boolean).join('\n'); };
  async function get(url) {
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
        if (r.status >= 500) throw new Error('HTTP ' + r.status);
        const __h = await r.text();
        if (/type=["']password["']|gigya\.com\/oidc|\/oidc\/op\/|\/authorize\?scope=/i.test(__h)) throw Object.assign(new Error('Sitzung abgelaufen'), { session: true });
        return __h;
      } catch (e) { if (e.session || i === 2) throw e; await sleep(1000 * 2 ** i); }
    }
  }
  let headers = null;
  async function one(entry) {
    const id = entry.memberId;
    const res = { memberId: id, fromMonth: entry.fromMonth, rows: [], complete: false };
    try {
      const html = await get(`/index.cfm?Fuseaction=evo_Modules.OrderHistoryFull&SRC=gen&DISTID2=${encodeURIComponent(id)}`);
      const d = new DOMParser().parseFromString(html, 'text/html');
      const t = d.querySelector('#OrderHistoryTable');
      if (!t) { res.error = 'Keine Bestelltabelle'; return res; }
      const hrow = [...t.querySelectorAll('tr')].find((r) => r.querySelector('th'));
      const h = hrow ? [...hrow.cells].map((c) => txt(c)) : null;
      if (h && !headers) headers = h;
      const take = (rows) => rows.filter((r) => r.cells.length >= 13 && !r.querySelector('th')).forEach((r) => res.rows.push([...r.cells].map((c, i) => (i === 3 ? '' : txt(c))))); // Spalte 3 = Versandadresse: nicht übernehmen
      take([...t.querySelectorAll('tr')]);
      let sd = [...d.querySelectorAll('.startdate')].pop()?.value;
      const from = entry.fromMonth.replace('-', '');
      let guard = 0;
      while (sd && sd >= from && guard++ < 16) {
        await sleep(250);
        const more = await get(`/index.cfm?Fuseaction=evo_Modules.OrderHistoryFull&SupressDTSPopup=1&PopupDiv=orderhistoryrows&DISTID2=${encodeURIComponent(id)}&noheader=1&nofooter=1&api=1&no_meta=1&axn=ViewMoreCount&startdate=${sd}&_=${Date.now()}`);
        const md = new DOMParser().parseFromString(more, 'text/html');
        take([...md.querySelectorAll('#ajaxrowstable tr')]);
        const next = [...md.querySelectorAll('.startdate')].pop()?.value;
        if (!next || next === sd) break;
        sd = next;
      }
      res.complete = true;
    } catch (e) { if (e.session) throw e; res.error = String(e.message || e); }
    return res;
  }
  const out = [];
  const queue = [...plan.members];
  async function worker() { while (queue.length) { const e = queue.shift(); out.push(await one(e)); await sleep(300); } }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { kind: 'orders', headers, members: out, plannedMembers: plan.members.length, complete: out.every((m) => m.complete), fetchedAt: new Date().toISOString() };
  } catch (e) {
    return { __error: String((e && e.message) || e), structure: !!(e && e.structure), session: !!(e && e.session) };
  }
}

export async function collectCommissions() {
  try {
  const r = await fetch('/index.cfm?FuseAction=evo_Modules.CommissionSummary', { credentials: 'same-origin' });
  if (r.status >= 400) throw new Error('HTTP ' + r.status);
  const __h = await r.text(); if (/type=["']password["']|gigya\.com\/oidc|\/oidc\/op\/|\/authorize\?scope=/i.test(__h)) throw Object.assign(new Error('Sitzung abgelaufen'), { session: true });
    const d = new DOMParser().parseFromString(__h, 'text/html');
  const tables = [...d.querySelectorAll('table')].filter((t) => /Zeitraum/.test(t.rows[0]?.textContent || '') && /Auszuzahlender/.test(t.rows[0]?.textContent || ''));
  if (!tables.length) throw Object.assign(new Error('Provisionstabellen fehlen'), { structure: true });
  const cur = (d.body.textContent.match(/\b(EUR|USD|GBP|CHF)\b/) || [])[1] || 'EUR';
  return {
    kind: 'commissions', currency: cur, complete: true, fetchedAt: new Date().toISOString(),
    tables: tables.map((t, i) => ({ kind: i === 0 ? 'primary' : 'secondary', headers: [...t.rows[0].cells].map((c) => c.textContent.replace(/[\u00ad\u200b-\u200d\ufeff]/g, '').trim()), rows: [...t.rows].slice(1).map((r) => [...r.cells].map((c) => c.textContent.replace(/[\u00ad\u200b-\u200d\ufeff]/g, '').trim())) })),
  };
  } catch (e) {
    return { __error: String((e && e.message) || e), structure: !!(e && e.structure), session: !!(e && e.session) };
  }
}
