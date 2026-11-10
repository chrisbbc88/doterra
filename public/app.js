// Oberfläche ohne Framework. Alle Daten kommen vom lokalen Server; Berechnungen passieren dort.
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = (n, d = 0) => (n === null || n === undefined || Number.isNaN(n) ? '–' : Number(n).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmtDate = (s) => (s ? new Date(s.length === 10 ? s + 'T12:00:00' : s).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '–');
const fmtDT = (s) => (s ? new Date(s).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–');
const fmtMonth = (m) => { if (!m) return '–'; const [y, mo] = m.split('-'); return new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString('de-DE', { month: 'short', year: '2-digit' }); };
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
const plusDays = (n) => { const d = new Date(today() + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

async function api(path, opts = {}) {
  const r = await fetch(path, { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', 'x-requested-with': 'crm' }, body: opts.body ? JSON.stringify(opts.body) : undefined, credentials: 'same-origin' });
  if (r.status === 401) { showAuth(); throw new Error('Bitte anmelden'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Fehler ${r.status}`);
  return j;
}
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2800); }
function modal(html, onMount) { $('#modalBody').innerHTML = html; const d = $('#modal'); if (!d.open) d.showModal(); onMount?.($('#modalBody')); }
function closeModal() { $('#modal').close(); }
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

const NAV = [
  ['heute', 'Heute', '☀'], ['kontakte', 'Kontakte', '◎'], ['team', 'Team', '⟁'], ['produkte', 'Produkte', '◈'],
  ['aufgaben', 'Aufgaben', '✓'], ['veranstaltungen', 'Veranstaltungen', '✦'], ['ziele', 'Ziele & Rang', '◷'],
  ['assistent', 'Assistent', '✎'], ['daten', 'Daten', '⛁'],
];
function renderNav(active) {
  $('#nav').innerHTML = NAV.map(([k, l, i]) => `<a href="#/${k}" class="${active === k ? 'active' : ''}"><span aria-hidden="true">${i}</span>${l}<span class="count" data-count="${k}" hidden></span></a>`).join('');
  $('#bottomNav').innerHTML = NAV.filter(([k]) => ['heute', 'kontakte', 'aufgaben', 'assistent', 'daten'].includes(k)).map(([k, l, i]) => `<a href="#/${k}" class="${active === k ? 'active' : ''}"><span aria-hidden="true">${i}</span>${l}</a>`).join('');
}

// ---------------- Anmeldung ----------------
let setupMode = false;
function showAuth() { $('#app').hidden = true; $('#auth').hidden = false; $('#pin').focus(); }
async function boot() {
  const s = await fetch('/api/status').then((r) => r.json());
  setupMode = s.setupRequired;
  if (s.authenticated && !setupMode) { $('#auth').hidden = true; $('#app').hidden = false; route(); refreshStatus(); return; }
  $('#authHint').textContent = setupMode ? 'Willkommen! Lege eine PIN (6–12 Ziffern) fest. Sie schützt die Daten auf diesem Rechner.' : 'Bitte PIN eingeben.';
  $('#pin2').hidden = !setupMode; $('#authBtn').textContent = setupMode ? 'PIN festlegen' : 'Anmelden';
  showAuth();
}
$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault(); $('#authErr').textContent = '';
  const pin = $('#pin').value;
  try {
    if (setupMode) {
      if (pin !== $('#pin2').value) throw new Error('PINs stimmen nicht überein');
      await fetch('/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin }) }).then(async (r) => { if (!r.ok) throw new Error((await r.json()).error); });
    }
    const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin }) });
    if (!r.ok) throw new Error((await r.json()).error);
    $('#pin').value = ''; $('#pin2').value = '';
    boot();
  } catch (err) { $('#authErr').textContent = err.message; }
});
$('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); boot(); });

// ---------------- Datenstatus (Kopfzeile + Hinweisbalken) ----------------
async function refreshStatus() {
  try {
    const s = await api('/api/data/status');
    const bad = s.areas.filter((a) => /fehl|abgelaufen|struktur|unvollst|teilweise/.test(a.lastStatus));
    const stale = s.areas.filter((a) => a.veraltet);
    const pill = $('#dataPill');
    pill.className = 'pill' + (bad.length ? ' bad' : stale.length ? ' stale' : '');
    pill.textContent = bad.length ? 'Abgleich-Problem' : stale.length ? (s.areas.every((a) => !a.lastSuccessAt) ? 'Noch kein Abgleich' : 'Daten veraltet') : `Stand ${fmtDT(s.areas[0].lastSuccessAt)}`;
    let html = '';
    if (s.demo) html += `<div class="banner demo"><span><strong>Beispieldaten.</strong> Diese Instanz enthält erfundene Testdaten und ist vom echten Datenbestand getrennt.</span></div>`;
    const lastRun = s.runs[0];
    if (lastRun && lastRun.status === 'sitzung_abgelaufen') html += `<div class="banner warn"><span><strong>doTERRA-Anmeldung abgelaufen.</strong> Der letzte Abgleich (${fmtDT(lastRun.startedAt)}) konnte nicht lesen. Bitte im doTERRA Office anmelden und den Abgleich in der Erweiterung neu starten.</span><a href="#/daten">Details</a></div>`;
    else if (lastRun && lastRun.status === 'struktur_geändert') html += `<div class="banner warn"><span><strong>doTERRA hat eine Seite verändert.</strong> Betroffene Daten wurden nicht überschrieben. Der Abgleich muss angepasst werden.</span><a href="#/daten">Details</a></div>`;
    else if (bad.length) html += `<div class="banner warn"><span><strong>Abgleich nicht vollständig:</strong> ${bad.map((a) => esc(a.label)).join(', ')}. Es werden die letzten vollständigen Daten angezeigt.</span><a href="#/daten">Details</a></div>`;
    else if (stale.length && !s.areas.every((a) => !a.lastSuccessAt)) html += `<div class="banner stale"><span><strong>Daten veraltet:</strong> ${stale.map((a) => `${esc(a.label)} (${a.lastSuccessAt ? 'Stand ' + fmtDT(a.lastSuccessAt) : 'nie'})`).join(' · ')}</span><a href="#/daten">Abgleich</a></div>`;
    $('#banner').innerHTML = html;
  } catch {}
}

// ---------------- Router ----------------
const VIEWS = {};
async function route() {
  const [, name = 'heute', ...rest] = location.hash.replace(/^#/, '').split('/');
  const key = VIEWS[name] ? name : 'heute';
  renderNav(name === 'kontakt' ? 'kontakte' : key);
  const v = $('#view');
  v.innerHTML = '<div class="empty">Lädt …</div>';
  try { await (VIEWS[name] || VIEWS.heute)(v, ...rest.map(decodeURIComponent)); }
  catch (e) { v.innerHTML = `<div class="card empty"><strong>Das hat nicht geklappt</strong>${esc(e.message)}</div>`; }
  v.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
const go = (h) => { location.hash = h; };
const contactLink = (key, name) => `<a href="#/kontakt/${encodeURIComponent(key)}">${esc(name || key)}</a>`;

// Gemeinsame Aktionen
async function createTask(t) { await api('/api/tasks', { body: t }); toast('Aufgabe erstellt'); }
async function draftFor(contactKey, anlass) {
  modal('<h2>Gesprächsentwurf</h2><p class="muted">Wird erstellt …</p>');
  try {
    const r = await api('/api/drafts', { body: { contactKey, anlass } });
    if (!r.ok) return modal(`<h2>Gesprächsentwurf</h2><p class="hint">${esc(r.grund)}</p><div class="actions"><button id="closeDraft">Schließen</button></div>`, (el) => { $('#closeDraft', el).onclick = closeModal; });
    modal(`<h2>Gesprächsentwurf</h2><p class="tiny muted">${esc(r.status)}. Bitte prüfen und selbst versenden.</p><textarea id="draftText" style="min-height:140px">${esc(r.entwurf)}</textarea>${r.warnungen.length ? `<p class="error">${r.warnungen.map(esc).join('<br>')}</p>` : ''}<div class="actions"><button class="primary" id="copyDraft">Kopieren</button><button id="closeDraft">Schließen</button></div>`, (el) => {
      $('#copyDraft', el).onclick = async () => { await navigator.clipboard.writeText($('#draftText', el).value); toast('Kopiert – Nachricht wurde nicht versendet'); };
      $('#closeDraft', el).onclick = closeModal;
    });
  } catch (e) { modal(`<h2>Gesprächsentwurf</h2><p class="error">${esc(e.message)}</p>`); }
}
function oppActions(o) {
  return `<div class="actions"><a class="btn small" href="#/kontakt/${encodeURIComponent(o.memberId)}">Kontakt öffnen</a><button class="small" data-task='${esc(JSON.stringify({ title: o.titel, contactKey: o.memberId, origin: o.id, due: today(), estimateMin: 15 }))}'>Aufgabe erstellen</button><button class="small" data-draft="${esc(o.memberId)}" data-anlass="${esc(o.aktion)}">Entwurf vorbereiten</button></div>`;
}
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-task]');
  if (t) { e.preventDefault(); try { await createTask(JSON.parse(t.dataset.task)); t.disabled = true; t.textContent = 'Aufgabe angelegt'; } catch (err) { toast(err.message); } }
  const d = e.target.closest('[data-draft]');
  if (d) { e.preventDefault(); draftFor(d.dataset.draft, d.dataset.anlass); }
  const k = e.target.closest('[data-kpi]');
  if (k) { e.preventDefault(); sessionStorage.setItem('kpiIds', k.dataset.ids || ''); sessionStorage.setItem('kpiLabel', k.dataset.label || ''); go('#/kontakte/kpi'); }
});

// ---------------- Heute ----------------
VIEWS.heute = async (v) => {
  const o = await api('/api/overview');
  const hello = new Date().getHours() < 11 ? 'Guten Morgen' : new Date().getHours() < 18 ? 'Hallo' : 'Guten Abend';
  const first = o.owner?.name?.split(',')[1]?.trim() || 'Kathrin';
  const noData = !o.lastRun && Object.keys(o.kpis).every((k) => !o.kpis[k].wert);
  const k = o.kpis;
  const kpiTile = (key, extra = '') => { const x = k[key]; const val = x.einheit === '%' ? (x.wert == null ? '–' : fmtNum(x.wert * 100) + ' %') : x.einheit === 'EUR' ? (x.wert == null ? '–' : fmtNum(x.wert, 2) + ' €') : fmtNum(x.wert, x.einheit === 'PV' || x.einheit === 'OV' ? 1 : 0); return `<button class="kpi" ${x.ids && x.einheit === 'Personen' ? `data-kpi data-ids="${esc(x.ids.join(','))}" data-label="${esc(x.label)}"` : ''} title="${esc(x.def)}"><span class="l">${esc(x.label)}</span><span class="v">${val}</span><span class="d">${extra || (x.vormonat != null ? 'Vormonat ' + fmtNum(x.vormonat, 1) : x.monat ? 'Monat ' + fmtMonth(x.monat) : x.basis ? esc(x.basis) : '&nbsp;')}</span></button>`; };
  const maxB = Math.max(1, ...o.trend.map((t) => t.kaeufer));
  const changesBy = {};
  for (const c of o.changes) (changesBy[c.type] ||= []).push(c);
  const CH = { neues_mitglied: 'Neue Mitglieder', neue_bestellung: 'Neue Bestellungen', bestellung_geändert: 'Geänderte Bestellungen', mitglied_geändert: 'Geänderte Mitgliedsdaten', nicht_mehr_in_downline: 'Nicht mehr in der Downline' };
  v.innerHTML = `
  <div class="page-head"><div><h1>${hello}, ${esc(first)}</h1><p>${new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' })} · ca. ${o.minutesPerDay} Min. Arbeitszeit für heute eingeplant</p></div></div>
  ${noData ? `<div class="card empty"><strong>Noch keine doTERRA-Daten</strong>Starte den ersten Abgleich mit der Chrome-Erweiterung. Anleitung unter <a href="#/daten">Daten</a>.</div>` : ''}
  <div class="split">
    <section class="card"><div class="card-head"><h2>Die nächsten drei Schritte</h2><span class="tiny muted">begrenzt auf deine Zeit</span></div>
      ${o.steps.length ? o.steps.map((s, i) => `<div class="step"><span class="n">${i + 1}</span><div><strong>${esc(s.titel)}</strong><div class="small muted">${esc(s.grund || '')} · ca. ${s.minuten} Min.</div>
        <div class="actions">${s.contactKey ? `<a class="btn small" href="#/kontakt/${encodeURIComponent(s.contactKey)}">Kontakt öffnen</a>` : ''}${s.art === 'vorschlag' ? `<button class="small" data-task='${esc(JSON.stringify({ title: s.titel, contactKey: s.contactKey, origin: s.opportunityId, due: today(), estimateMin: s.minuten }))}'>Als Aufgabe übernehmen</button>` : ''}${s.taskId ? `<button class="small" data-done="${s.taskId}">Erledigt</button>` : ''}${s.contactKey ? `<button class="small" data-draft="${esc(s.contactKey)}" data-anlass="${esc(s.grund || s.titel)}">Entwurf</button>` : ''}</div></div></div>`).join('') : '<div class="empty"><strong>Nichts Dringendes</strong>Keine fälligen Aufgaben oder Vorschläge.</div>'}
    </section>
    <section class="card"><h2>Seit dem letzten Abgleich</h2>
      ${o.lastRun ? `<p class="tiny muted">Abgleich ${fmtDT(o.lastRun.startedAt)} · ${esc(o.lastRun.status)}</p>` : ''}
      ${o.changes.length ? `<ul class="list">${Object.entries(changesBy).map(([t, arr]) => `<li><details style="width:100%"><summary>${esc(CH[t] || t)} <span class="badge">${arr.length}</span></summary><ul class="list small">${arr.slice(0, 25).map((c) => `<li>${c.memberId ? contactLink(c.memberId, c.name) : ''}<span class="muted tiny">${esc(describeChange(c))}</span></li>`).join('')}</ul></details></li>`).join('')}</ul>` : '<div class="empty small">Keine Änderungen erkannt.</div>'}
    </section>
  </div>
  <div class="grid g4 section">${kpiTile('neu30')}${kpiTile('kaeuferMonat')}${kpiTile('lrpMonat')}${kpiTile('lrpUeberfaellig')}${kpiTile('eigenesPv')}${kpiTile('eigenesOv')}${kpiTile('wiederbestellquote')}${kpiTile('provision')}</div>
  <div class="grid g2 section">
    <section class="card"><div class="card-head"><h2>Entwicklung</h2><span class="tiny muted">bestellaktive Personen je Monat</span></div>
      <div class="bar">${o.trend.map((t) => `<div title="${esc(fmtMonth(t.monat))}: ${t.kaeufer} bestellaktiv, ${t.lrp} mit LRP, ${t.neu} neu"><span>${t.kaeufer}</span><span class="b ${t.laufend ? 'cur' : ''}" style="height:${(t.kaeufer / maxB) * 100}%"></span>${fmtMonth(t.monat)}</div>`).join('')}</div>
      <div class="table-wrap section"><table><thead><tr><th>Monat</th><th class="num">Eig. PV</th><th class="num">OV</th><th class="num">LRP</th><th class="num">Neu</th><th class="num">Auszahlung</th></tr></thead><tbody>${o.trend.slice().reverse().map((t) => `<tr><td>${fmtMonth(t.monat)}${t.laufend ? ' <span class="badge gold">läuft</span>' : ''}</td><td class="num">${fmtNum(t.eigenesPv, 1)}</td><td class="num">${fmtNum(t.ov, 0)}</td><td class="num">${t.lrp}</td><td class="num">${t.neu}</td><td class="num">${t.provisionEUR != null ? fmtNum(t.provisionEUR, 2) + ' €' : '–'}</td></tr>`).join('')}</tbody></table></div>
      <p class="tiny muted">PV/OV sind Volumenpunkte, keine Euro. Auszahlung = Primärbonus laut Provisionsübersicht.</p>
    </section>
    <section class="card"><div class="card-head"><h2>Fällig &amp; Wiedervorlagen</h2><a href="#/aufgaben" class="small">Alle Aufgaben</a></div>
      ${o.due.length + o.followUps.length ? `<ul class="list">${o.due.map((t) => `<li><span>${esc(t.title)}${t.contactKey ? ' · ' + contactLink(t.contactKey, t.contactName) : ''}<br><span class="tiny ${t.due < today() ? 'error' : 'muted'}">fällig ${fmtDate(t.due)}</span></span><button class="small" data-done="${t.id}">Erledigt</button></li>`).join('')}${o.followUps.map((f) => `<li><span>Wiedervorlage ${contactLink(f.contactKey, f.name)}<br><span class="tiny muted">${esc(f.nextStep || '')} · ${fmtDate(f.followUpDate)}</span></span></li>`).join('')}</ul>` : '<div class="empty small">Nichts fällig.</div>'}
      <h3 class="section">Ziele diesen Monat</h3>
      ${o.goals.length ? o.goals.map((g) => `<div class="section small"><div class="row" style="justify-content:space-between"><span>${esc(g.title)}</span><span>${fmtNum(g.ist)} / ${fmtNum(g.target)}</span></div><div class="progress ${g.ist >= g.target ? 'ok' : ''}"><span style="width:${Math.min(100, g.target ? (g.ist / g.target) * 100 : 0)}%"></span></div>${g.aufmerksamkeit ? '<span class="tiny error">liegt hinter dem anteiligen Monatsziel</span>' : ''}</div>`).join('') : '<p class="small muted">Noch keine Ziele. <a href="#/ziele">Ziel anlegen</a></p>'}
    </section>
  </div>
  <section class="card section"><div class="card-head"><h2>Weitere Vorschläge</h2><span class="tiny muted">regelbasiert, mit Begründung</span></div>
    ${o.opps.length ? diversify(o.opps, 3).slice(0, 10).map((p) => `<div class="step" style="grid-template-columns:1fr"><div><strong>${esc(p.titel)}</strong> <span class="badge">${esc(p.regel)}</span><div class="small">${esc(p.beobachtung)}</div><div class="small muted">${esc(p.begruendung)} <em>Nächster Schritt:</em> ${esc(p.aktion)}${p.unsicherheit ? ` <span class="badge gold">Unsicher: ${esc(p.unsicherheit)}</span>` : ''}</div>${oppActions(p)}</div></div>`).join('') : '<div class="empty small">Keine Vorschläge – entweder fehlen Daten oder alles ist im grünen Bereich.</div>'}
  </section>`;
  v.querySelectorAll('[data-done]').forEach((b) => (b.onclick = async () => { await api('/api/tasks/' + b.dataset.done, { method: 'PUT', body: { status: 'erledigt' } }); toast('Erledigt'); route(); }));
};
function diversify(list, perRule) { const n = {}; return list.filter((o) => (n[o.regel] = (n[o.regel] || 0) + 1) <= perRule); }
function describeChange(c) {
  const d = c.detail || {};
  if (c.type === 'neues_mitglied') return `${d.art || ''}, registriert ${fmtDate(d.eingeschrieben)}`;
  if (c.type === 'neue_bestellung' || c.type === 'bestellung_geändert') return `Rechnung ${d.rechnung}${d.volumen != null ? ', ' + fmtNum(d.volumen, 1) + ' PV' : ''}${d.lrp ? ' (LRP)' : ''}${c.type === 'bestellung_geändert' ? ': ' + Object.keys(d).filter((x) => x !== 'rechnung').join(', ') : ''}`;
  if (c.type === 'mitglied_geändert') return Object.entries(d).map(([f, x]) => `${FIELD[f] || f}: ${x.vorher ?? '–'} → ${x.nachher ?? '–'}`).join('; ');
  return '';
}
const FIELD = { name: 'Name', memberType: 'Art', currentRank: 'Rang', highestRank: 'Höchster Rang', nextLrpDate: 'Nächster LRP', nextLrpPv: 'LRP-PV', lastOrderDate: 'Letzte Bestellung', sponsorId: 'Sponsor', enrollerId: 'Enroller', level: 'Level', inDownline: 'In Downline' };

// ---------------- Kontakte ----------------
const SEGMENTS = [['', 'Alle'], ['kundinnen', 'Kundinnen'], ['beraterinnen', 'Beraterinnen'], ['interessentinnen', 'Interessentinnen'], ['neu', 'Neu (60 T.)'], ['treu', 'Treue LRP'], ['a', 'Wertstufe A'], ['gefaehrdet', 'Aufmerksamkeit'], ['ohnelrp', 'Ohne LRP'], ['inaktiv', 'Inaktiv'], ['wiedervorlage', 'Wiedervorlage fällig']];
VIEWS.kontakte = async (v, mode) => {
  let seg = sessionStorage.getItem('seg') || '';
  let q = '';
  const kpiIds = mode === 'kpi' ? sessionStorage.getItem('kpiIds') : null;
  v.innerHTML = `<div class="page-head"><div><h1>Kontakte</h1><p id="cCount" class="small"></p></div><button class="primary" id="newProspect">+ Interessentin</button></div>
    ${kpiIds !== null ? `<div class="hint">Gefiltert nach Kennzahl: <strong>${esc(sessionStorage.getItem('kpiLabel'))}</strong> · <a href="#/kontakte">Filter aufheben</a></div>` : `<div class="chips">${SEGMENTS.map(([k, l]) => `<button class="chip ${seg === k ? 'on' : ''}" data-seg="${k}">${l}</button>`).join('')}</div>`}
    <input id="cq" type="search" placeholder="In Kontakten suchen …" style="margin:10px 0 14px">
    <div class="card" style="padding:0"><div class="table-wrap"><table><thead><tr><th>Name</th><th>Art</th><th class="hide-m">Segment</th><th class="hide-m">Wert</th><th class="hide-m">Letzte Bestellung</th><th>LRP</th><th class="hide-m">Bein</th></tr></thead><tbody id="cRows"></tbody></table></div></div>
    <p class="tiny muted">Segment: Neu = Registrierung ≤ 60 Tage; Treue LRP = LRP-PV in ≥ 5 der letzten 6 Monate; Regelmäßig = PV in ≥ 3 von 6. Wertstufe nach Ø PV der letzten 6 abgeschlossenen Monate: A ≥ 100, B ≥ 50, C > 0, D = 0.</p>`;
  const load = async () => {
    const p = new URLSearchParams({ q, segment: seg }); if (kpiIds !== null) p.set('ids', kpiIds);
    const r = await api('/api/contacts?' + p);
    $('#cCount').textContent = `${r.total} Personen`;
    $('#cRows').innerHTML = r.list.length ? r.list.slice(0, 600).map((c) => `<tr class="click" data-key="${esc(c.key)}"><td><strong>${esc(c.name)}</strong>${c.owner ? ' <span class="badge forest">Du</span>' : ''}${(c.risk || []).length ? ` <span class="badge warn" title="${esc(c.risk.join(', '))}">!</span>` : ''}<div class="tiny muted">${esc(c.id || 'ohne doTERRA-ID')}${c.city ? ' · ' + esc(c.city) : ''}</div></td><td><span class="badge">${esc(c.art || '–')}</span></td><td class="hide-m">${esc(c.segment || '–')}</td><td class="hide-m">${esc(c.tier || '–')}</td><td class="hide-m">${fmtDate(c.lastOrderDate)}</td><td>${c.hasLrp ? `<span class="badge forest">${fmtDate(c.nextLrpDate)}</span>` : '<span class="muted">–</span>'}</td><td class="hide-m small">${esc(c.bein || '–')}</td></tr>`).join('') : `<tr><td colspan="7"><div class="empty"><strong>Keine Treffer</strong>${seg || q ? 'Filter oder Suchbegriff anpassen.' : 'Noch keine Kontakte – erster Abgleich steht aus.'}</div></td></tr>`;
    $('#cRows').querySelectorAll('tr[data-key]').forEach((tr) => (tr.onclick = () => go('#/kontakt/' + encodeURIComponent(tr.dataset.key))));
  };
  v.querySelectorAll('[data-seg]').forEach((b) => (b.onclick = () => { seg = b.dataset.seg; sessionStorage.setItem('seg', seg); v.querySelectorAll('[data-seg]').forEach((x) => x.classList.toggle('on', x === b)); load(); }));
  let t; $('#cq').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { q = e.target.value; load(); }, 200); };
  $('#newProspect').onclick = () => prospectForm();
  await load();
};
function prospectForm(prefill = {}) {
  modal(`<h2>Neue Interessentin</h2><form id="pf"><label>Name</label><input name="name" required value="${esc(prefill.name || '')}"><div class="row"><div><label>Telefon</label><input name="phone"></div><div><label>E-Mail</label><input name="email" type="email"></div></div><div class="row"><div><label>Ort</label><input name="city"></div><div><label>Kontaktquelle</label><select name="source">${SOURCES.map((s) => `<option ${prefill.source === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div></div><label>Interessen (nur ausdrücklich genannte)</label><input name="interests"><div class="actions"><button class="primary">Anlegen</button><button type="button" id="pfc">Abbrechen</button></div></form>`, (el) => {
    $('#pfc', el).onclick = closeModal;
    $('#pf', el).onsubmit = async (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); const r = await api('/api/prospects', { body: f }); closeModal(); prefill.onCreated ? prefill.onCreated(r.key) : go('#/kontakt/' + encodeURIComponent(r.key)); };
  });
}
const SOURCES = ['', 'Instagram', 'Empfehlung', 'Yoga', 'Veranstaltung', 'Testwoche', 'Kooperation', 'Online-Shop', 'Sonstiges'];

// ---------------- Kontaktansicht ----------------
VIEWS.kontakt = async (v, key) => {
  const c = await api('/api/contacts/' + encodeURIComponent(key));
  const m = c.source, pr = c.prospect, p = c.profile || {}, s = c.stats;
  const name = m?.name || pr?.name;
  const cons = p.consents || {};
  v.innerHTML = `
  <div class="page-head"><div><a href="#/kontakte" class="small">← Kontakte</a><h1>${esc(name)}</h1>
    <p>${m ? `<span class="badge">${esc(m.memberType)}</span> doTERRA-ID ${esc(m.id)} · Rang ${esc(m.currentRank || '–')} (höchster: ${esc(m.highestRank || '–')})` : '<span class="badge info">Interessentin · ohne doTERRA-ID</span>'}
    ${s ? ` · <span class="badge forest">${esc(s.segment)}</span> <span class="badge">Wertstufe ${esc(s.tier)}</span>` : ''}${(s?.risk || []).map((r) => ` <span class="badge warn">${esc(r)}</span>`).join('')}</p></div>
    <div class="actions"><button id="addNote" class="primary">+ Notiz</button><button id="addTask">+ Aufgabe</button><button data-draft="${esc(key)}" data-anlass="Persönliches Nachfassen">Entwurf</button></div></div>
  <div class="split">
    <div class="grid">
      ${c.opps.length ? `<section class="card"><h2>Vorschläge</h2>${c.opps.map((o) => `<div class="step" style="grid-template-columns:1fr"><div><strong>${esc(o.titel)}</strong><div class="small">${esc(o.beobachtung)}</div><div class="small muted">${esc(o.begruendung)} Nächster Schritt: ${esc(o.aktion)}</div>${oppActions(o)}</div></div>`).join('')}</section>` : ''}
      <section class="card"><div class="card-head"><h2>Gespräche &amp; Notizen</h2><span class="tag-src">CRM · manuell</span></div>
        ${c.notes.length ? `<ul class="list">${c.notes.map((n) => `<li style="align-items:flex-start"><div><div class="tiny muted">${fmtDT(n.createdAt)} · ${esc(n.kind)}${n.sensitive ? ' · <span class="badge warn">sensibel</span>' : ''}</div><div style="white-space:pre-wrap">${esc(n.text)}</div></div><button class="small ghost" data-delnote="${n.id}" aria-label="Notiz löschen">✕</button></li>`).join('')}</ul>` : '<div class="empty small">Noch keine Notizen.</div>'}
      </section>
      <section class="card"><div class="card-head"><h2>Aufgaben</h2><span class="tag-src">CRM · manuell</span></div>
        ${c.tasks.length ? `<ul class="list">${c.tasks.map((t) => `<li><span>${t.status === 'erledigt' ? '<s>' : ''}${esc(t.title)}${t.status === 'erledigt' ? '</s>' : ''}<br><span class="tiny muted">${t.due ? 'fällig ' + fmtDate(t.due) : 'ohne Datum'}</span></span>${t.status !== 'erledigt' ? `<button class="small" data-done="${t.id}">Erledigt</button>` : ''}</li>`).join('')}</ul>` : '<div class="empty small">Keine Aufgaben.</div>'}
      </section>
      ${m ? `<section class="card"><div class="card-head"><h2>Bestellungen</h2><span class="tag-src">doTERRA · ${c.orderCoverage ? 'ab ' + fmtMonth(c.orderCoverage.fromMonth) + ', Stand ' + fmtDT(c.orderCoverage.fetchedAt) : 'noch nicht abgeglichen'}</span></div>
        ${c.orders.length ? `<div class="table-wrap"><table><thead><tr><th>Datum</th><th>Art</th><th class="num">PV</th><th class="num">Betrag</th><th>PV-Monat</th><th>Artikel</th></tr></thead><tbody>${c.orders.map((o) => `<tr><td>${fmtDate(o.date)}<div class="tiny muted">${esc(o.invoice)}</div></td><td>${o.isLrp ? '<span class="badge forest">LRP</span>' : esc(o.source || '')}${o.status === 'offen' ? ' <span class="badge gold">noch nicht versandt</span>' : ''}</td><td class="num">${fmtNum(o.volume, 1)}</td><td class="num">${o.amount != null ? fmtNum(o.amount, 2) + ' ' + esc(o.currency || '?') : '–'}</td><td>${fmtMonth(o.pvMonth)}</td><td class="small">${o.items.length ? o.items.map((i) => `${esc(i.name || i.sku)}${i.qty > 1 ? ' ×' + i.qty : ''}`).join(', ') : '<span class="muted">Positionen nach Versand</span>'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty small">Keine Bestellungen im abgeglichenen Zeitraum.</div>'}
      </section>
      <section class="card"><div class="card-head"><h2>Volumenverlauf</h2><span class="tag-src">doTERRA · Downline-Bericht</span></div>
        <div class="table-wrap"><table><thead><tr><th>Monat</th><th class="num">PV</th><th class="num">LRP-PV</th><th class="num">OV</th><th class="num">PGV</th><th class="num">TGV</th></tr></thead><tbody>${c.months.map((x) => `<tr><td>${fmtMonth(x.month)}</td><td class="num">${fmtNum(x.pv, 1)}</td><td class="num">${fmtNum(x.lrpPv, 1)}</td><td class="num">${fmtNum(x.ov, 1)}</td><td class="num">${fmtNum(x.pgv, 1)}</td><td class="num">${fmtNum(x.tgv, 1)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Keine Volumenangaben (leer = in der Quelle kein Wert, nicht 0).</td></tr>'}</tbody></table></div>
      </section>
      <section class="card"><h2>Produkte</h2><p class="tiny muted">Nur Kaufhistorie. Es werden keine Rückschlüsse auf Gesundheit gezogen.</p>${c.products.length ? `<ul class="list">${c.products.map((x) => `<li><span>${esc(x.name || 'Artikel ' + x.sku)}</span><span class="small muted">${x.kaeufe}× · zuletzt ${fmtDate(x.zuletzt)}</span></li>`).join('')}</ul>` : '<div class="empty small">Keine Artikeldaten.</div>'}</section>` : ''}
    </div>
    <div class="grid" style="align-content:start">
      <section class="card"><div class="card-head"><h2>Kontakt</h2><span class="tag-src">${m ? 'doTERRA' : 'CRM'}</span></div>
        <dl class="kv">${m ? `<dt>Mobil</dt><dd>${esc(m.contact?.phoneMobile || m.contact?.phoneHome || '–')}</dd><dt>E-Mail</dt><dd>${m.contact?.email ? `<a href="mailto:${esc(m.contact.email)}">${esc(m.contact.email)}</a>` : '–'}</dd><dt>Ort</dt><dd>${esc([m.contact?.zip, m.contact?.city].filter(Boolean).join(' ') || '–')} ${esc(m.contact?.country || '')}</dd><dt>Registriert</dt><dd>${fmtDate(m.entryDate)}</dd><dt>Letzte Bestellung</dt><dd>${fmtDate(m.lastOrderDate)}</dd><dt>Nächster LRP</dt><dd>${m.nextLrpDate ? fmtDate(m.nextLrpDate) + (m.nextLrpPv != null ? ` · ${fmtNum(m.nextLrpPv, 1)} PV` : '') : 'kein LRP hinterlegt'}</dd>` : `<dt>Telefon</dt><dd>${esc(pr.phone || '–')}</dd><dt>E-Mail</dt><dd>${esc(pr.email || '–')}</dd><dt>Ort</dt><dd>${esc(pr.city || '–')}</dd>`}</dl>
        ${m ? `<p class="tiny muted">Stand ${fmtDT(c.stand)}. Änderungen bitte im doTERRA Office vornehmen.</p>` : ''}
      </section>
      ${m ? `<section class="card"><h2>Team</h2><dl class="kv">
        <dt>Sponsor (Platzierung)</dt><dd>${c.sponsor ? contactLink(c.sponsor.id, c.sponsor.name) : '–'}</dd>
        <dt>Enroller (Einschreibung)</dt><dd>${c.enroller ? contactLink(c.enroller.id, c.enroller.name) : '–'}</dd>
        <dt>Platzierungslinie</dt><dd>${c.team?.platzierungslinie ? contactLink(c.team.platzierungslinie, c.team.linieName) : '<span class="muted">ungeklärt</span>'}</dd>
        <dt>Einschreibungsbein</dt><dd>${c.team?.bein ? contactLink(c.team.bein, c.team.beinName) + ` <span class="tiny muted">(${esc(c.team.beinQuelle)})</span>` : '<span class="muted">ungeklärt</span>'}</dd>
        <dt>Darunter platziert</dt><dd>${c.placed.length}</dd><dt>Selbst eingeschrieben</dt><dd>${c.enrolled.length}</dd></dl>
        ${c.enrolled.length ? `<details class="section"><summary class="small">Eingeschriebene anzeigen</summary><ul class="list small">${c.enrolled.map((x) => `<li>${contactLink(x.id, x.name)}<span class="badge">${esc(x.art)}</span></li>`).join('')}</ul></details>` : ''}
      </section>` : ''}
      <section class="card"><div class="card-head"><h2>CRM-Profil</h2><span class="tag-src">manuell · wird nie überschrieben</span></div>
        <form id="prof">
          <label>Kontaktquelle</label><select name="source">${SOURCES.map((x) => `<option ${p.source === x ? 'selected' : ''}>${x}</option>`).join('')}</select>
          <label>Interessen (ausdrücklich genannt)</label><input name="interests" value="${esc(p.interests || '')}">
          <label>Präferenzen (z. B. Kontaktweg, Zeiten)</label><input name="preferences" value="${esc(p.preferences || '')}">
          <label>Instagram</label><input name="instagram" value="${esc(p.instagram || '')}" placeholder="@name">
          <label>Nächster Schritt</label><input name="nextStep" value="${esc(p.nextStep || '')}">
          <label>Wiedervorlage</label><input name="followUpDate" type="date" value="${esc(p.followUpDate || '')}">
          <label>Einwilligungen</label>
          <div class="small"><label style="display:flex;gap:8px;align-items:center;margin:4px 0"><input type="checkbox" name="c_whatsapp" style="width:auto" ${cons.whatsapp ? 'checked' : ''}>Kontakt per WhatsApp erlaubt</label>
          <label style="display:flex;gap:8px;align-items:center;margin:4px 0"><input type="checkbox" name="c_email" style="width:auto" ${cons.email ? 'checked' : ''}>Kontakt per E-Mail erlaubt</label>
          <label style="display:flex;gap:8px;align-items:center;margin:4px 0"><input type="checkbox" name="c_sensitive" style="width:auto" ${cons.sensitive ? 'checked' : ''}>Einwilligung für sensible Notizen liegt vor</label></div>
          <div class="actions"><button class="primary">Speichern</button></div>
        </form>
        ${p.updatedAt ? `<p class="tiny muted">Zuletzt geändert ${fmtDT(p.updatedAt)}</p>` : ''}
      </section>
      ${c.events.length ? `<section class="card"><h2>Veranstaltungen</h2><ul class="list">${c.events.map((e) => `<li>${esc(e.title)}<span class="small muted">${fmtDate(e.date)}</span></li>`).join('')}</ul></section>` : ''}
      <section class="card"><h2>Daten dieser Person</h2><p class="small muted">Export oder Löschung der CRM-Daten. Löschungen im doTERRA-Konto selbst sind hier nicht möglich.</p>
        <div class="actions"><button class="small" id="exportOne">Als JSON exportieren</button><button class="small danger" id="delCrm">CRM-Daten löschen</button>${m ? '<button class="small danger" id="delAll">Lokal komplett löschen</button>' : ''}</div></section>
    </div>
  </div>`;
  $('#prof').onsubmit = async (e) => {
    e.preventDefault(); const f = Object.fromEntries(new FormData(e.target));
    const body = { source: f.source || null, interests: f.interests || null, preferences: f.preferences || null, instagram: f.instagram || null, nextStep: f.nextStep || null, followUpDate: f.followUpDate || null, consents: { whatsapp: !!f.c_whatsapp, email: !!f.c_email, sensitive: !!f.c_sensitive, updatedAt: new Date().toISOString() } };
    await api(`/api/contacts/${encodeURIComponent(key)}/profile`, { method: 'PUT', body }); toast('Profil gespeichert');
  };
  $('#addNote').onclick = () => noteDialog({ contactKey: key, name });
  $('#addTask').onclick = () => taskForm({ contactKey: key });
  v.querySelectorAll('[data-done]').forEach((b) => (b.onclick = async () => { await api('/api/tasks/' + b.dataset.done, { method: 'PUT', body: { status: 'erledigt' } }); route(); }));
  v.querySelectorAll('[data-delnote]').forEach((b) => (b.onclick = async () => { if (confirm('Notiz löschen?')) { await api('/api/notes/' + b.dataset.delnote, { method: 'DELETE' }); route(); } }));
  $('#exportOne').onclick = () => { const blob = new Blob([JSON.stringify(c, null, 1)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `kontakt-${key.replace(/[^\w-]/g, '')}.json`; a.click(); };
  $('#delCrm').onclick = async () => { if (confirm('Alle CRM-Daten (Notizen, Aufgaben, Profil) dieser Person löschen? Vorher wird automatisch eine Sicherung angelegt.')) { await api('/api/contacts/' + encodeURIComponent(key), { method: 'DELETE' }); toast('CRM-Daten gelöscht'); go(m ? '#/kontakt/' + encodeURIComponent(key) : '#/kontakte'); route(); } };
  const da = $('#delAll'); if (da) da.onclick = async () => { if (confirm('Person lokal vollständig löschen und vom künftigen Abgleich ausschließen? Im doTERRA-Konto ändert sich nichts.')) { await api('/api/contacts/' + encodeURIComponent(key) + '?source=1', { method: 'DELETE' }); toast('Lokal gelöscht'); go('#/kontakte'); } };
};

// ---------------- Schnellnotiz ----------------
function noteDialog(pre = {}) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  modal(`<h2>Schnelle Notiz</h2><p class="small muted">In eigenen Worten, z. B. „Silke war beim Yoga dabei, hat eine Testwoche gemacht und möchte nächsten Dienstag noch einmal sprechen."</p>
    <textarea id="nt" placeholder="Was ist passiert?">${pre.name ? esc(pre.name.split(',').reverse().join(' ').trim()) + ' ' : ''}</textarea>
    <div class="actions">${SR ? '<button class="small" id="dict">🎙 Diktieren</button>' : ''}<label class="small" style="margin:0;display:inline-flex;gap:6px;align-items:center"><input type="file" accept="audio/*" id="audio" style="width:auto"> Sprachmemo</label></div>
    <p class="tiny muted" id="audioHint">${SR ? 'Diktieren nutzt die Spracherkennung von Chrome (Audio wird dabei von Google verarbeitet).' : ''}</p>
    <div class="actions"><button class="primary" id="propose">Vorschlag erstellen</button><button id="ncancel">Abbrechen</button></div><div id="proposal"></div>`, (el) => {
    $('#ncancel', el).onclick = closeModal;
    const ta = $('#nt', el); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    $('#audio', el).onchange = () => { $('#audioHint', el).innerHTML = '<span class="error">Transkription von Sprachmemos ist vorbereitet, aber noch nicht eingerichtet (geplant: lokale Transkription). Bitte vorerst diktieren oder tippen.</span>'; };
    if (SR) $('#dict', el).onclick = () => { const r = new SR(); r.lang = 'de-DE'; r.interimResults = false; r.onresult = (e) => { ta.value += (ta.value ? ' ' : '') + e.results[0][0].transcript; }; r.onerror = () => toast('Diktieren nicht möglich'); r.start(); toast('Ich höre zu …'); };
    $('#propose', el).onclick = async () => {
      const text = ta.value.trim(); if (!text) return;
      const p = await api('/api/notes/propose', { body: { text } });
      let chosen = pre.contactKey || p.kontaktEindeutig;
      const datQ = p.fragen.find((f) => f.typ === 'datum');
      $('#proposal', el).innerHTML = `<div class="section card" style="box-shadow:none">
        <h3>Vorschlag – bitte prüfen</h3>
        ${p.fragen.length ? `<div class="hint section">${p.fragen.map((f) => esc(f.text)).join('<br>')}</div>` : ''}
        <label>Kontakt</label>
        ${pre.contactKey ? `<p><strong>${esc(pre.name)}</strong></p>` : p.kandidaten.length ? p.kandidaten.map((k) => `<label style="display:flex;gap:8px;align-items:center;margin:4px 0"><input type="radio" name="who" value="${esc(k.key)}" style="width:auto" ${chosen === k.key ? 'checked' : ''}> ${esc(k.name)} <span class="badge">${esc(k.art)}</span> <span class="tiny muted">${esc(k.key.startsWith('p:') ? 'CRM' : 'ID ' + k.key)}${k.entryDate ? ' · seit ' + fmtDate(k.entryDate) : ''}${k.city ? ' · ' + esc(k.city) : ''}</span></label>`).join('') + '<label style="display:flex;gap:8px;align-items:center;margin:4px 0"><input type="radio" name="who" value="__new" style="width:auto"> Neue Interessentin anlegen</label>' : '<label style="display:flex;gap:8px;align-items:center"><input type="radio" name="who" value="__new" style="width:auto" checked> Neue Interessentin anlegen</label>'}
        <label>Notiz</label><textarea id="pnote">${esc(p.notiz.text)}</textarea>
        ${p.notiz.quellenHinweis.length ? `<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="psrc" style="width:auto"> Kontaktquelle setzen: ${esc(p.notiz.quellenHinweis[0])} (nur wenn noch leer)</label>` : ''}
        ${p.notiz.sensibel ? '<label style="display:flex;gap:8px;align-items:center" class="error"><input type="checkbox" id="psens" style="width:auto"> Ich bestätige: Die Gesundheitsangabe ist für die Betreuung nötig und es liegt eine Einwilligung vor.</label>' : ''}
        ${p.aufgabe ? `<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="ptask" style="width:auto" checked> Aufgabe anlegen</label><div class="row"><div><label>Aufgabe</label><input id="ptitle" value="${esc(p.aufgabe.title)}"></div><div><label>Fällig${datQ ? ' – bitte wählen' : ''}</label>${datQ ? `<select id="pdue">${datQ.options.map((d) => `<option value="${d}">${fmtDate(d)}</option>`).join('')}</select>` : `<input id="pdue" type="date" value="${esc(p.aufgabe.due || '')}">`}</div></div>` : ''}
        <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="pfollow" style="width:auto" ${p.aufgabe?.due ? 'checked' : ''}> Als Wiedervorlage im Profil setzen</label>
        <div class="actions"><button class="primary" id="psave">Bestätigen &amp; speichern</button></div></div>`;
      $('#psave', el).onclick = async () => {
        let key = pre.contactKey || el.querySelector('input[name=who]:checked')?.value;
        if (!key) return toast('Bitte Kontakt wählen');
        if (p.notiz.sensibel && !$('#psens', el)?.checked) return toast('Sensible Angabe: bitte bestätigen oder Text kürzen');
        if (key === '__new') { const nm = prompt('Name der neuen Interessentin?', ''); if (!nm) return; key = (await api('/api/prospects', { body: { name: nm, source: $('#psrc', el)?.checked ? p.notiz.quellenHinweis[0] : null } })).key; }
        await api('/api/notes', { body: { contactKey: key, text: $('#pnote', el).value, sensitive: !!p.notiz.sensibel, kind: p.testwoche ? 'Testwoche' : 'Gespräch', source: $('#psrc', el)?.checked ? p.notiz.quellenHinweis[0] : null } });
        const due = $('#pdue', el)?.value || null;
        if ($('#ptask', el)?.checked) await api('/api/tasks', { body: { title: $('#ptitle', el).value, contactKey: key, due, estimateMin: 15 } });
        if ($('#pfollow', el)?.checked && due) await api(`/api/contacts/${encodeURIComponent(key)}/profile`, { method: 'PUT', body: { followUpDate: due, nextStep: $('#ptitle', el)?.value || null } });
        closeModal(); toast('Gespeichert'); go('#/kontakt/' + encodeURIComponent(key)); route();
      };
    };
  });
}
$('#quickNote').onclick = () => noteDialog();

// ---------------- Globale Suche ----------------
let st;
$('#globalSearch').addEventListener('input', (e) => {
  clearTimeout(st); const q = e.target.value.trim(); const box = $('#searchResults');
  if (q.length < 2) { box.hidden = true; return; }
  st = setTimeout(async () => { const r = await api('/api/contacts?q=' + encodeURIComponent(q)); box.innerHTML = r.list.slice(0, 12).map((c) => `<a href="#/kontakt/${encodeURIComponent(c.key)}"><span>${esc(c.name)}</span><span class="small muted">${esc(c.art || '')} ${esc(c.id || '')}</span></a>`).join('') || '<div class="empty small">Keine Treffer</div>'; box.hidden = false; }, 180);
});
document.addEventListener('click', (e) => { if (!e.target.closest('.search')) $('#searchResults').hidden = true; });
$('#searchResults').addEventListener('click', () => { $('#searchResults').hidden = true; $('#globalSearch').value = ''; });

// ---------------- Team ----------------
VIEWS.team = async (v) => {
  const t = await api('/api/team');
  const legRow = (l) => `<tr class="click" data-key="${esc(l.rootId)}"><td><strong>${esc(l.name)}</strong><div class="tiny muted">${esc(l.art)} · ${esc(l.rang || '')}</div></td><td>${esc(l.monatsrang || '–')}${l.prozentZumRang != null ? `<div class="tiny muted">${fmtNum(l.prozentZumRang, 0)} % zu ${esc(l.schlagdistanzZiel || '')}</div>` : ''}</td><td class="num">${fmtNum(l.ovSchlagdistanz ?? l.ov, 0)}</td><td class="num">${l.mitglieder}</td><td class="num">${l.beraterinnen}</td><td class="num">${l.kaeufer}</td><td class="num">${l.neu90}</td><td class="num">${l.lrpTeil == null ? '–' : fmtNum(l.lrpTeil * 100) + ' %'}</td><td>${l.hinweise.map((h) => `<span class="badge warn">${esc(h)}</span>`).join(' ')}</td></tr>`;
  const head = '<thead><tr><th>Wurzel</th><th>Monatsrang</th><th class="num">OV</th><th class="num">Mitgl.</th><th class="num">Berat.</th><th class="num">aktiv</th><th class="num">neu 90 T.</th><th class="num">LRP</th><th>Auffällig</th></tr></thead>';
  const active = t.legs.filter((l) => l.mitglieder > 1 || (l.ovSchlagdistanz ?? 0) > 0);
  v.innerHTML = `<div class="page-head"><div><h1>Team</h1><p>Platzierung und Einschreibung werden getrennt geführt. Stand Teamlinien: ${fmtDT(t.stand)}</p></div></div>
    <section class="card"><div class="card-head"><h2>Einschreibungsbeine</h2><span class="tiny muted">rangrelevant · Leg ID laut Schlagdistanz</span></div>
      <div class="table-wrap"><table>${head}<tbody>${active.slice(0, 12).map(legRow).join('') || '<tr><td colspan="9" class="empty">Noch keine Daten</td></tr>'}</tbody></table></div>
      ${active.length > 12 ? `<details class="section"><summary class="small">Weitere ${active.length - 12} Beine anzeigen</summary><div class="table-wrap"><table>${head}<tbody>${active.slice(12).map(legRow).join('')}</tbody></table></div></details>` : ''}
      <p class="tiny muted">${t.legs.length} persönlich Eingeschriebene = ${t.legs.length} Beine; angezeigt ${active.length} mit eigener Organisation oder Volumen. „% zu Rang" stammt direkt aus doTERRAs Schlagdistanz.</p></section>
    <section class="card section"><div class="card-head"><h2>Platzierungslinien (Frontline)</h2><span class="tiny muted">nach Sponsor</span></div>
      <div class="table-wrap"><table>${head}<tbody>${t.placementLines.map(legRow).join('') || '<tr><td colspan="9" class="empty">Noch keine Daten</td></tr>'}</tbody></table></div></section>
    <div class="grid g2 section">
      <section class="card"><h2>Wer schreibt ein?</h2><table><thead><tr><th>Enroller*in</th><th class="num">neu 90 T.</th><th class="num">gesamt</th><th class="num">aktiv</th></tr></thead><tbody>${t.enrollers.slice(0, 15).map((e) => `<tr class="click" data-key="${esc(e.id)}"><td>${esc(e.name)}</td><td class="num">${e.neu90}</td><td class="num">${e.gesamt}</td><td class="num">${e.aktiveEnrollees}</td></tr>`).join('')}</tbody></table><p class="tiny muted">„aktiv" = Eingeschriebene mit PV in mind. 1 der letzten 6 Monate.</p></section>
      <section class="card"><h2>Datenqualität Teamstruktur</h2><p class="small">${t.ungeklaert.length} Personen mit nicht eindeutig ableitbarer Linie, ${t.konflikte.length} Abweichungen zwischen Leg ID und Enroller-Kette.</p>${t.konflikte.length ? `<ul class="list small">${t.konflikte.slice(0, 20).map((x) => `<li>${contactLink(x.id, x.name)}</li>`).join('')}</ul>` : ''}<p class="tiny muted">Unklare Beziehungen werden nicht geraten, sondern als ungeklärt geführt.</p></section>
    </div>`;
  v.querySelectorAll('tr[data-key]').forEach((tr) => (tr.onclick = () => go('#/kontakt/' + encodeURIComponent(tr.dataset.key))));
};

// ---------------- Produkte ----------------
VIEWS.produkte = async (v) => {
  const p = await api('/api/products');
  v.innerHTML = `<div class="page-head"><div><h1>Produkte</h1><p>Aus abgeglichenen, versandten Bestellungen. Stand ${fmtDT(p.stand)}</p></div></div>
    <div class="grid g2">
      <section class="card"><h2>Meistgekauft (12 Monate)</h2>${p.list.length ? `<div class="table-wrap"><table><thead><tr><th>Artikel</th><th class="num">Best.</th><th class="num">Käufer</th><th class="num">90 T.</th></tr></thead><tbody>${p.list.slice(0, 60).map((x) => `<tr><td><input class="pname" data-sku="${esc(x.sku)}" value="${esc(x.name || '')}" placeholder="Name für ${esc(x.sku)}" style="padding:4px 8px"><div class="tiny muted">${esc(x.sku)}</div></td><td class="num">${x.bestellungen365}</td><td class="num">${x.kaeufer}</td><td class="num">${x.bestellungen90}</td></tr>`).join('')}</tbody></table></div><p class="tiny muted">doTERRA liefert nur Artikelnummern. Namen einmal eintragen – sie gelten überall im CRM.</p>` : '<div class="empty"><strong>Noch keine Artikeldaten</strong>Erst nach dem Abgleich der Bestellungen verfügbar.</div>'}</section>
      <section class="card"><h2>Nachkauf möglich</h2><p class="small muted">Gleicher Artikel mind. 2× gekauft und der übliche Abstand ist überschritten. Reiner Kaufrhythmus.</p>${p.nachkauf.length ? `<ul class="list">${p.nachkauf.slice(0, 40).map((n) => `<li><span>${contactLink(n.memberId, n.memberName)}<br><span class="tiny muted">${esc(n.name || 'Artikel ' + n.sku)} · ${n.kaeufe}× · üblich alle ${n.medianTage} T., zuletzt vor ${n.seitLetztemKauf} T.</span></span><button class="small" data-task='${esc(JSON.stringify({ title: 'Nachkauf ansprechen: ' + (n.name || n.sku), contactKey: n.memberId, due: today(), estimateMin: 10, origin: 'nachkauf:' + n.memberId + ':' + n.sku }))}'>Aufgabe</button></li>`).join('')}</ul>` : '<div class="empty small">Keine Hinweise.</div>'}</section>
    </div>`;
  v.querySelectorAll('.pname').forEach((i) => (i.onchange = async () => { await api('/api/products/' + i.dataset.sku, { method: 'PUT', body: { name: i.value } }); toast('Produktname gespeichert'); }));
};

// ---------------- Aufgaben ----------------
function taskForm(pre = {}) {
  modal(`<h2>${pre.id ? 'Aufgabe bearbeiten' : 'Neue Aufgabe'}</h2><form id="tf"><label>Was ist zu tun?</label><input name="title" required value="${esc(pre.title || '')}"><div class="row"><div><label>Fällig</label><input type="date" name="due" value="${esc(pre.due || plusDays(1))}"></div><div><label>Dauer (Min.)</label><input type="number" name="estimateMin" min="5" step="5" value="${esc(pre.estimateMin || 15)}"></div></div><div class="actions"><button class="primary">Speichern</button><button type="button" id="tfc">Abbrechen</button></div></form>`, (el) => {
    $('#tfc', el).onclick = closeModal;
    $('#tf', el).onsubmit = async (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); f.estimateMin = Number(f.estimateMin) || 15; if (pre.contactKey) f.contactKey = pre.contactKey; await api(pre.id ? '/api/tasks/' + pre.id : '/api/tasks', { method: pre.id ? 'PUT' : 'POST', body: f }); closeModal(); toast('Gespeichert'); route(); };
  });
}
VIEWS.aufgaben = async (v) => {
  const tasks = await api('/api/tasks');
  const t0 = today();
  const groups = [['Überfällig', (t) => t.status !== 'erledigt' && t.due && t.due < t0], ['Heute', (t) => t.status !== 'erledigt' && t.due === t0], ['Demnächst', (t) => t.status !== 'erledigt' && t.due && t.due > t0], ['Ohne Datum', (t) => t.status !== 'erledigt' && !t.due], ['Erledigt', (t) => t.status === 'erledigt']];
  v.innerHTML = `<div class="page-head"><div><h1>Aufgaben</h1><p>${tasks.filter((t) => t.status !== 'erledigt').length} offen</p></div><button class="primary" id="nt">+ Aufgabe</button></div>
    ${groups.map(([l, f]) => { const arr = tasks.filter(f).sort((a, b) => (a.due || '').localeCompare(b.due || '')); return arr.length ? `<section class="card section"><h2>${l} <span class="badge">${arr.length}</span></h2><ul class="list">${arr.slice(0, l === 'Erledigt' ? 20 : 200).map((t) => `<li><span>${t.status === 'erledigt' ? '<s>' : ''}${esc(t.title)}${t.status === 'erledigt' ? '</s>' : ''}${t.contactKey ? ' · ' + contactLink(t.contactKey, t.contactName) : ''}<br><span class="tiny muted">${t.due ? fmtDate(t.due) : 'ohne Datum'} · ${t.estimateMin || 15} Min.</span></span><span class="actions" style="margin:0">${t.status !== 'erledigt' ? `<button class="small" data-done="${t.id}">Erledigt</button>` : ''}<button class="small ghost" data-edit="${t.id}">Bearbeiten</button><button class="small ghost" data-del="${t.id}" aria-label="Löschen">✕</button></span></li>`).join('')}</ul></section>` : ''; }).join('') || '<div class="card empty"><strong>Keine Aufgaben</strong>Lege eine an oder übernimm einen Vorschlag von der Startseite.</div>'}`;
  $('#nt').onclick = () => taskForm();
  v.querySelectorAll('[data-done]').forEach((b) => (b.onclick = async () => { await api('/api/tasks/' + b.dataset.done, { method: 'PUT', body: { status: 'erledigt' } }); route(); }));
  v.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => { if (confirm('Aufgabe löschen?')) { await api('/api/tasks/' + b.dataset.del, { method: 'DELETE' }); route(); } }));
  v.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => taskForm(tasks.find((t) => t.id === b.dataset.edit))));
};

// ---------------- Veranstaltungen ----------------
VIEWS.veranstaltungen = async (v) => {
  const evs = await api('/api/events');
  v.innerHTML = `<div class="page-head"><div><h1>Veranstaltungen</h1><p>Workshops, Yoga, Testwochen, Kooperationen</p></div><button class="primary" id="ne">+ Veranstaltung</button></div>
    ${evs.length ? evs.map((e) => `<section class="card section"><div class="card-head"><div><h2>${esc(e.title)}</h2><span class="small muted">${fmtDate(e.date)} · ${esc(e.type || '')}${e.location ? ' · ' + esc(e.location) : ''}${e.partner ? ' · mit ' + esc(e.partner) : ''}</span></div><button class="small" data-edit="${e.id}">Bearbeiten</button></div>
      <div class="grid g3"><div><span class="tiny muted">Teilnehmende</span><div class="kpi" style="cursor:default"><span class="v">${e.ergebnis.teilnehmende}</span></div></div><div><span class="tiny muted">eingeschrieben ≤ 30 T.</span><div class="kpi" style="cursor:default"><span class="v">${e.ergebnis.eingeschrieben30.length}</span></div></div><div><span class="tiny muted">bestellt ≤ 30 T.</span><div class="kpi" style="cursor:default"><span class="v">${e.ergebnis.bestellt30.length}</span></div></div></div>
      ${e.participantNames.length ? `<p class="small section">${e.participantNames.map((p) => contactLink(p.key, p.name)).join(' · ')}</p>` : ''}${e.outcomeNote ? `<p class="small">${esc(e.outcomeNote)}</p>` : ''}<p class="tiny muted">${esc(e.ergebnis.hinweis)}</p></section>`).join('') : '<div class="card empty"><strong>Noch keine Veranstaltungen</strong>Lege die nächste an – Teilnehmende verknüpfen, Ergebnis wird automatisch ausgewertet.</div>'}`;
  $('#ne').onclick = () => eventForm();
  v.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => eventForm(evs.find((x) => x.id === b.dataset.edit))));
};
function eventForm(e = {}) {
  let parts = (e.participantNames || []).map((p) => ({ ...p }));
  const render = (el) => { $('#parts', el).innerHTML = parts.map((p, i) => `<span class="badge forest" style="margin:2px">${esc(p.name)} <button type="button" class="small ghost" data-rm="${i}" style="min-height:0;padding:0 4px" aria-label="entfernen">✕</button></span>`).join(''); el.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => { parts.splice(Number(b.dataset.rm), 1); render(el); })); };
  modal(`<h2>${e.id ? 'Veranstaltung bearbeiten' : 'Neue Veranstaltung'}</h2><form id="ef"><label>Titel</label><input name="title" required value="${esc(e.title || '')}"><div class="row"><div><label>Art</label><select name="type">${['Workshop', 'Yoga', 'Testwoche', 'Kooperation', 'Online', 'Sonstiges'].map((t) => `<option ${e.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div><div><label>Datum</label><input type="date" name="date" required value="${esc(e.date || today())}"></div></div><div class="row"><div><label>Ort</label><input name="location" value="${esc(e.location || '')}"></div><div><label>Kooperationspartner</label><input name="partner" value="${esc(e.partner || '')}"></div></div>
    <label>Teilnehmende</label><div id="parts"></div><input id="psearch" placeholder="Name suchen und hinzufügen …"><div id="pres" class="list small"></div>
    <label>Notiz zum Ergebnis</label><textarea name="outcomeNote">${esc(e.outcomeNote || '')}</textarea>
    <div class="actions"><button class="primary">Speichern</button><button type="button" id="efc">Abbrechen</button>${e.id ? '<button type="button" class="danger" id="efd">Löschen</button>' : ''}</div></form>`, (el) => {
    render(el);
    $('#efc', el).onclick = closeModal;
    let t; $('#psearch', el).oninput = (ev) => { clearTimeout(t); t = setTimeout(async () => { const q = ev.target.value.trim(); if (q.length < 2) { $('#pres', el).innerHTML = ''; return; } const r = await api('/api/contacts?q=' + encodeURIComponent(q)); $('#pres', el).innerHTML = r.list.slice(0, 6).map((c) => `<li><span>${esc(c.name)} <span class="badge">${esc(c.art)}</span></span><button type="button" class="small" data-add="${esc(c.key)}" data-name="${esc(c.name)}">Hinzufügen</button></li>`).join('') + `<li><span class="muted">Nicht dabei?</span><button type="button" class="small" id="newP">Interessentin anlegen</button></li>`; el.querySelectorAll('[data-add]').forEach((b) => (b.onclick = () => { if (!parts.some((p) => p.key === b.dataset.add)) parts.push({ key: b.dataset.add, name: b.dataset.name }); render(el); })); const np = $('#newP', el); if (np) np.onclick = () => { const nm = $('#psearch', el).value; api('/api/prospects', { body: { name: nm, source: 'Veranstaltung' } }).then((r) => { parts.push({ key: r.key, name: nm }); render(el); }); }; }, 200); };
    if (e.id) $('#efd', el).onclick = async () => { if (confirm('Veranstaltung löschen?')) { await api('/api/events/' + e.id, { method: 'DELETE' }); closeModal(); route(); } };
    $('#ef', el).onsubmit = async (ev) => { ev.preventDefault(); const f = Object.fromEntries(new FormData(ev.target)); f.participants = parts.map((p) => p.key); await api(e.id ? '/api/events/' + e.id : '/api/events', { method: e.id ? 'PUT' : 'POST', body: f }); closeModal(); toast('Gespeichert'); route(); };
  });
}

// ---------------- Ziele & Rang ----------------
VIEWS.ziele = async (v) => {
  const [o, goals, s] = await Promise.all([api('/api/overview'), api('/api/goals'), api('/api/data/status')]);
  const target = s.settings.targetRank || 'Gold';
  const rp = await api('/api/rank?target=' + encodeURIComponent(target));
  const METRICS = { neue_mitglieder: 'Neue Mitglieder im Monat', lrp_personen: 'Personen mit LRP im Monat', aktive_kaeufer: 'Bestellaktive Personen', ov: 'OV (Volumen)', veranstaltungen: 'Veranstaltungen', manuell: 'Manuell gezählt' };
  v.innerHTML = `<div class="page-head"><div><h1>Ziele &amp; Rang</h1><p>Monat ${fmtMonth(o.ctx.month)}</p></div></div>
  <div class="grid g2">
    <section class="card"><div class="card-head"><h2>Monatsziele</h2><button class="small" id="ng">+ Ziel</button></div>
      ${o.goals.length ? o.goals.map((g) => `<div class="section"><div class="row" style="justify-content:space-between"><strong>${esc(g.title)}</strong><span>${fmtNum(g.ist)} / ${fmtNum(g.target)}</span></div><div class="progress ${g.ist >= g.target ? 'ok' : ''}"><span style="width:${Math.min(100, g.target ? (g.ist / g.target) * 100 : 0)}%"></span></div><div class="tiny muted">${esc(METRICS[g.metric] || g.metric)} · anteilig erwartet ${fmtNum(g.sollAnteilig, 1)}${g.aufmerksamkeit ? ' · <span class="error">braucht Aufmerksamkeit</span>' : ''}</div><div class="actions">${g.metric === 'manuell' ? `<button class="small" data-man="${g.id}">Wert eintragen</button>` : ''}<button class="small ghost" data-delg="${g.id}">Löschen</button></div></div>`).join('') : '<div class="empty small">Noch keine Ziele für diesen Monat.</div>'}
      <h3 class="section">Verfügbare Zeit</h3><div class="row"><input type="number" id="hours" min="0" max="80" value="${esc(s.settings.weeklyHours)}" style="max-width:120px"><span class="small muted">Stunden pro Woche – begrenzt die Tagesprioritäten</span></div>
    </section>
    <section class="card"><div class="card-head"><h2>Rangplanung</h2><select id="tr" style="width:auto">${['Premier', 'Silver', 'Gold', 'Platinum', 'Diamond'].map((r) => `<option ${r === target ? 'selected' : ''}>${r}</option>`).join('')}</select></div>
      ${rp.bedingungen ? `<table><thead><tr><th>Bedingung</th><th class="num">Ist</th><th class="num">Soll</th><th></th></tr></thead><tbody>${rp.bedingungen.map((b) => `<tr><td>${esc(b.bedingung)}${b.details?.length ? `<div class="tiny muted">${b.details.map(esc).join(', ')}</div>` : ''}</td><td class="num">${fmtNum(b.ist, b.art === 'berechnet' ? 0 : 1)}</td><td class="num">${fmtNum(b.soll)}</td><td>${b.erfuellt === null ? '<span class="badge">offen</span>' : b.erfuellt ? '<span class="badge forest">erfüllt</span>' : '<span class="badge warn">fehlt</span>'}</td></tr>`).join('')}</tbody></table>
        <h3 class="section">Nächste Beine</h3><ul class="list small">${(rp.naechsteBeine || []).map((l) => `<li>${contactLink(l.rootId, l.name)}<span class="muted">${esc(l.monatsrang || '–')} · ${fmtNum(l.prozentZumRang)} % zu ${esc(l.bezugsrang || '–')} · OV ${fmtNum(l.ov)}</span></li>`).join('')}</ul>` : `<p class="hint">${esc(rp.hinweis)}</p>`}
      <p class="tiny muted section">Regelquelle: ${esc(rp.quelle)} · Version ${esc(rp.regelVersion)} · geprüft ${fmtDate(rp.geprueftAm)}. ${esc(rp.hinweis || '')} Prognosen sind keine Zusagen.</p>
    </section>
  </div>`;
  $('#tr').onchange = async (e) => { await api('/api/settings', { method: 'PUT', body: { targetRank: e.target.value } }); route(); };
  $('#hours').onchange = async (e) => { await api('/api/settings', { method: 'PUT', body: { weeklyHours: Number(e.target.value) } }); toast('Gespeichert'); };
  $('#ng').onclick = () => modal(`<h2>Neues Monatsziel</h2><form id="gf"><label>Titel</label><input name="title" required placeholder="z. B. 5 neue Kundinnen"><label>Messgröße</label><select name="metric">${Object.entries(METRICS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select><label>Zielwert</label><input name="target" type="number" min="0" required><div class="actions"><button class="primary">Anlegen</button></div></form>`, (el) => { $('#gf', el).onsubmit = async (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); await api('/api/goals', { body: { ...f, target: Number(f.target), month: o.ctx.month } }); closeModal(); route(); }; });
  v.querySelectorAll('[data-delg]').forEach((b) => (b.onclick = async () => { await api('/api/goals/' + b.dataset.delg, { method: 'DELETE' }); route(); }));
  v.querySelectorAll('[data-man]').forEach((b) => (b.onclick = async () => { const val = prompt('Aktueller Wert?'); if (val !== null) { await api('/api/goals/' + b.dataset.man, { method: 'PUT', body: { manualValue: Number(val) } }); route(); } }));
};

// ---------------- Assistent ----------------
const QUESTIONS = ['Welche Kundinnen sollte ich diese Woche kontaktieren und weshalb?', 'Welche Teamlinie braucht gerade Unterstützung?', 'Wie haben sich die letzten drei Monate entwickelt?', 'Was hat die letzte Veranstaltung gebracht?', 'Welche Aufgaben passen in meine verfügbare Zeit?', 'Welche Voraussetzungen fehlen bis zu meinem Rangziel?'];
VIEWS.assistent = async (v) => {
  v.innerHTML = `<div class="page-head"><div><h1>Strategieassistent</h1><p>Antwortet nur aus den CRM-Daten. Zahlen werden vorher im Programm berechnet.</p></div></div>
    <section class="card"><div class="chips">${QUESTIONS.map((q) => `<button class="chip" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>
      <textarea id="aq" placeholder="Eigene Frage …" style="min-height:70px"></textarea><div class="actions"><button class="primary" id="ask">Fragen</button><button id="facts">Datengrundlage anzeigen</button></div>
      <p class="tiny muted">An Claude übertragen werden nur Namen, doTERRA-IDs und berechnete Kennzahlen – keine Telefonnummern, E-Mails oder Adressen. Notiztexte werden nicht übertragen.</p></section>
    <div id="answer" class="section"></div>`;
  v.querySelectorAll('[data-q]').forEach((b) => (b.onclick = () => { $('#aq').value = b.dataset.q; $('#ask').click(); }));
  $('#facts').onclick = async () => { const f = await api('/api/assistant/facts'); $('#answer').innerHTML = `<section class="card"><h2>Datengrundlage (${f.length} Fakten)</h2>${f.map((x) => `<div class="fact ${x.art}"><strong>${x.id}</strong> <span class="badge">${esc(x.art)}</span> ${esc(x.text)} <span class="tiny muted">Quelle: ${esc(x.quelle)}</span></div>`).join('')}</section>`; };
  $('#ask').onclick = async () => {
    const q = $('#aq').value.trim(); if (!q) return;
    $('#ask').disabled = true; $('#answer').innerHTML = '<div class="card empty">Denke nach …</div>';
    try {
      const r = await api('/api/assistant', { body: { question: q } });
      const factMap = Object.fromEntries((r.facts || []).map((f) => [f.id, f]));
      if (!r.ok) { $('#answer').innerHTML = `<section class="card"><p class="hint">${esc(r.grund)}</p>${r.roh ? `<pre class="small">${esc(r.roh)}</pre>` : ''}</section>`; return; }
      const a = r.antwort;
      $('#answer').innerHTML = `<section class="card"><h2>Antwort</h2><p>${esc(a.kurzantwort)}</p>
        ${(a.empfehlungen || []).map((e, i) => `<div class="rec"><h3>${i + 1}. ${esc(e.titel)}</h3><dl><dt>Beobachtung</dt><dd>${esc(e.beobachtung)}</dd><dt>Quelle &amp; Datenstand</dt><dd>${esc(e.quelle_datenstand)}</dd><dt>Begründung</dt><dd>${esc(e.begruendung)}</dd><dt>Nächster Schritt</dt><dd><strong>${esc(e.naechster_schritt)}</strong></dd><dt>Unsicherheiten</dt><dd>${esc(e.unsicherheiten || '–')}</dd></dl>
          ${e.ungepruefteZahlen?.length ? `<p class="error tiny">Zahl(en) ohne Beleg in den Fakten: ${e.ungepruefteZahlen.map(esc).join(', ')} – bitte prüfen.</p>` : ''}
          <details class="section"><summary class="small">Datengrundlage: ${e.fakten.join(', ')}</summary>${e.fakten.map((id) => factMap[id] ? `<div class="fact ${factMap[id].art}"><strong>${id}</strong> <span class="badge">${esc(factMap[id].art)}</span> ${esc(factMap[id].text)}</div>` : '').join('')}</details></div>`).join('')}
        ${a.annahmen?.length ? `<h3 class="section">Annahmen</h3><ul>${a.annahmen.map((x) => `<li class="small">${esc(x)}</li>`).join('')}</ul>` : ''}
        ${a.fehlende_daten?.length ? `<h3 class="section">Fehlende Daten</h3><ul>${a.fehlende_daten.map((x) => `<li class="small">${esc(x)}</li>`).join('')}</ul>` : ''}
        ${a.pruefhinweise?.length ? `<p class="error tiny">${a.pruefhinweise.map(esc).join('<br>')}</p>` : ''}
        <p class="tiny muted">Fakten = beobachtet aus doTERRA/CRM · Berechnet = Programmlogik · Annahme = Einstellung/Schätzung · Empfehlung = Vorschlag des Assistenten.</p></section>`;
    } catch (e) { $('#answer').innerHTML = `<div class="card"><p class="error">${esc(e.message)}</p></div>`; }
    finally { $('#ask').disabled = false; }
  };
};

// ---------------- Daten ----------------
VIEWS.daten = async (v) => {
  const s = await api('/api/data/status');
  const statusBadge = (st) => `<span class="badge ${/erfolg|vollständig/.test(st) ? 'forest' : /läuft/.test(st) ? 'info' : /teil|unvollst|veraltet|nie|fehlt/.test(st) ? 'gold' : 'warn'}">${esc(st)}</span>`;
  v.innerHTML = `<div class="page-head"><div><h1>Daten &amp; Abgleich</h1><p>Alles liegt lokal auf diesem Rechner. ${s.counts.mitglieder} Mitglieder · ${s.counts.bestellungen} Bestellungen · ${s.counts.notizen} Notizen</p></div></div>
  <section class="card"><h2>Stand je Datenbereich</h2><div class="table-wrap"><table><thead><tr><th>Bereich</th><th>Letzter vollständiger Abgleich</th><th>Letzter Versuch</th><th>Status</th></tr></thead><tbody>${s.areas.map((a) => `<tr><td>${esc(a.label)}</td><td>${a.lastSuccessAt ? fmtDT(a.lastSuccessAt) : '<span class="muted">nie</span>'}${a.veraltet && a.lastSuccessAt ? ' <span class="badge gold">veraltet</span>' : ''}</td><td>${fmtDT(a.lastAttemptAt)}</td><td>${statusBadge(a.lastStatus)}</td></tr>`).join('')}</tbody></table></div>
    <p class="tiny muted">Ein Bereich gilt nach ${esc(s.settings.staleAfterHours)} Std. als veraltet. Unvollständige oder fehlgeschlagene Abrufe ändern den „letzten vollständigen Abgleich" nicht und löschen keine Daten.</p></section>
  <div class="grid g2 section">
    <section class="card"><h2>Abgleich einrichten</h2><ol class="small" style="padding-left:18px">
      <li>Chrome-Erweiterung aus dem Ordner <code>extension</code> laden (siehe Anleitung).</li>
      <li>Im Popup der Erweiterung unter „Einrichtung" diesen Abgleich-Schlüssel eintragen:</li></ol>
      <div class="row"><input id="tok" type="password" readonly value="${esc(s.syncToken)}"><button class="small" id="showTok">Anzeigen</button><button class="small" id="copyTok">Kopieren</button></div>
      <ol class="small" start="3" style="padding-left:18px"><li>Im doTERRA Office anmelden, dann in der Erweiterung „Jetzt abgleichen".</li></ol>
      <h3 class="section">Automatischer Abgleich</h3>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="auto" style="width:auto" ${s.settings.autoSync?.enabled ? 'checked' : ''}> aktivieren</label>
      <div class="row"><select id="autoMode"><option value="daily" ${s.settings.autoSync?.mode !== 'interval' ? 'selected' : ''}>täglich um</option><option value="interval" ${s.settings.autoSync?.mode === 'interval' ? 'selected' : ''}>alle … Stunden</option></select><input type="time" id="autoT" value="${esc(s.settings.autoSync?.time || '05:00')}"><input type="number" id="autoH" min="2" max="48" value="${esc(s.settings.autoSync?.everyHours || 12)}" title="Stunden (nur Intervall)"></div>
      <p class="tiny muted">Läuft über die Chrome-Erweiterung, solange der Rechner wach, Chrome geöffnet und Kathrin im doTERRA Office angemeldet ist. Hat der Rechner um diese Zeit geschlafen, wird der Lauf beim nächsten Chrome-Start nachgeholt. Ist die Anmeldung abgelaufen, erscheint ein deutlicher Hinweis. Erst aktivieren, wenn manuelle Abgleiche zuverlässig funktionieren.</p>
      <h3 class="section">Abgleich-Datei importieren</h3>
      <p class="tiny muted">Datei aus der Erweiterung („Als Datei speichern"). Die Daten bleiben in diesem Browser bzw. auf diesem Rechner.</p>
      ${s.demo ? '<label style="display:flex;gap:8px;align-items:center" class="small"><input type="checkbox" id="impReplace" style="width:auto" checked> Beispieldaten vollständig durch die echten Daten ersetzen</label>' : '<label style="display:flex;gap:8px;align-items:center" class="small"><input type="checkbox" id="impReplace" style="width:auto"> vorhandene Daten vorher leeren (sonst wird ergänzt und abgeglichen)</label>'}
      <input type="file" accept="application/json,.json" id="impBundle">
      <p id="impOut" class="small"></p>
    </section>
    <section class="card"><h2>Sicherungen</h2><p class="small muted">Automatisch: täglich und vor jedem Abgleich, jeder Wiederherstellung und jeder Löschung. Die letzten 60 werden behalten.</p>
      <div class="actions"><button class="primary" id="bk">Jetzt sichern</button><a class="btn small" href="/api/export">Gesamtexport (JSON)</a><a class="btn small" href="/api/export/contacts.csv">Kontakte (CSV)</a><label class="small" style="margin:0;display:inline-flex;gap:6px;align-items:center"><input type="file" accept="application/json" id="imp" style="width:auto"> Sicherung einspielen</label></div>
      <ul class="list small section">${s.backups.slice(0, 10).map((b) => `<li><span>${esc(b.name.replace(/^db-|\.json$/g, ''))}<br><span class="tiny muted">${fmtDT(b.at)} · ${fmtNum(b.size / 1024)} KB</span></span><button class="small" data-restore="${esc(b.name)}">Wiederherstellen</button></li>`).join('') || '<li class="muted">Noch keine Sicherung</li>'}</ul>
    </section>
  </div>
  <section class="card section"><h2>Abgleich-Protokoll</h2><div class="table-wrap"><table><thead><tr><th>Start</th><th>Auslöser</th><th>Status</th><th>Bereiche</th><th>Prüfungen</th><th class="num">Änderungen</th></tr></thead><tbody>${s.runs.map((r) => `<tr><td>${fmtDT(r.startedAt)}</td><td>${esc(r.trigger)}</td><td>${statusBadge(r.status)}${r.errors?.length ? `<div class="tiny error">${r.errors.map(esc).join('<br>')}</div>` : ''}</td><td class="small">${Object.entries(r.parts || {}).map(([k, p]) => `${esc(k)}: ${esc(p.status)}${p.received != null ? ` (${p.received})` : ''}`).join('<br>')}</td><td class="small">${(r.checks || []).map((c) => `${c.ok ? '✓' : '✗'} ${esc(c.check)}: ${c.erhalten}${c.quelle != null ? ' / Quelle ' + c.quelle : ''}${c.hinweis ? ' – ' + esc(c.hinweis) : ''}`).join('<br>')}</td><td class="num">${r.changeCount ?? '–'}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">Noch kein Abgleich</td></tr>'}</tbody></table></div></section>
  <div class="grid g2 section">
    <section class="card"><h2>Einstellungen</h2><label>Daten gelten als veraltet nach (Stunden)</label><input type="number" id="staleH" min="1" value="${esc(s.settings.staleAfterHours)}"><label>Modell für den Assistenten</label><input id="model" value="${esc(s.settings.assistantModel)}"><p class="tiny muted">Claude-API-Schlüssel: ${s.settings.apiKeyConfigured ? '<span class="badge forest">hinterlegt</span>' : '<span class="badge gold">fehlt</span> – in der Datei <code>.env</code> eintragen (nicht hier)'}.</p><div class="actions"><button id="saveSet">Speichern</button></div></section>
    <section class="card"><h2>Betriebskosten KI</h2><p class="small">Dieser Monat: ${s.kiNutzung.anfragenMonat} Anfragen · ${fmtNum(s.kiNutzung.inputTokensMonat)} Eingabe- und ${fmtNum(s.kiNutzung.outputTokensMonat)} Ausgabe-Tokens.</p><p class="tiny muted">Kosten laut aktueller Preisliste von Anthropic für das gewählte Modell. Der lokale Betrieb selbst verursacht keine Kosten.</p></section>
  </div>`;
  $('#showTok').onclick = () => { const t = $('#tok'); t.type = t.type === 'password' ? 'text' : 'password'; };
  $('#copyTok').onclick = async () => { await navigator.clipboard.writeText(s.syncToken); toast('Schlüssel kopiert'); };
  $('#bk').onclick = async () => { const r = await api('/api/backup', { method: 'POST' }); toast('Gesichert: ' + r.name); route(); };
  v.querySelectorAll('[data-restore]').forEach((b) => (b.onclick = async () => { if (confirm(`Stand „${b.dataset.restore}" wiederherstellen? Der aktuelle Stand wird vorher gesichert.`)) { await api('/api/restore', { body: { name: b.dataset.restore } }); toast('Wiederhergestellt'); route(); refreshStatus(); } }));
  $('#imp').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; if (!confirm('Diese Sicherung einspielen? Der aktuelle Stand wird vorher gesichert.')) return; try { const data = JSON.parse(await f.text()); await api('/api/restore', { body: { data } }); toast('Eingespielt'); route(); } catch (err) { toast('Fehler: ' + err.message); } };
  const saveAuto = async () => { await api('/api/settings', { method: 'PUT', body: { autoSync: { enabled: $('#auto').checked, mode: $('#autoMode').value, time: $('#autoT').value, everyHours: Number($('#autoH').value) } } }); toast('Gespeichert – die Erweiterung übernimmt es beim nächsten Öffnen ihres Fensters'); };
  ['#auto', '#autoMode', '#autoT', '#autoH'].forEach((id) => ($(id).onchange = saveAuto));
  $('#impBundle').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const out = $('#impOut'); out.textContent = 'Lese Datei …';
    try {
      const bundle = JSON.parse(await f.text());
      const replace = $('#impReplace')?.checked || false;
      if (replace && !confirm('Vorhandene Daten werden vorher gesichert und dann ersetzt. Fortfahren?')) { out.textContent = ''; return; }
      out.textContent = 'Importiere …';
      const r = await api('/api/sync/import-bundle', { body: { bundle, replace } });
      const parts = Object.entries(r.run.parts || {}).map(([k, p]) => `${k}: ${p.status}${p.received != null ? ' (' + p.received + ')' : ''}`).join(' · ');
      out.innerHTML = `<strong>${esc(r.run.status)}</strong> – ${esc(parts)}${r.run.errors?.length ? `<br><span class="error">${r.run.errors.map(esc).join('<br>')}</span>` : ''}`;
      refreshStatus(); setTimeout(route, 1500);
    } catch (err) { out.innerHTML = `<span class="error">${esc(err.message)}</span>`; }
  };
  $('#saveSet').onclick = async () => { await api('/api/settings', { method: 'PUT', body: { staleAfterHours: Number($('#staleH').value), assistantModel: $('#model').value } }); toast('Gespeichert'); };
};

window.crmRefreshStatus = refreshStatus;
boot();
setInterval(() => { if (!$('#app').hidden) refreshStatus(); }, 5 * 60 * 1000);
