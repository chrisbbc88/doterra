// Hintergrundprozess: steuert einen Abgleichlauf.
// Ablauf: Server prüfen -> Office-Tab finden/öffnen -> Sitzung prüfen -> Lauf starten ->
// Bereiche einzeln sammeln und übertragen -> Lauf abschließen. Fehler eines Bereichs stoppen die anderen nicht.
import { checkSession, collectDownline, collectLegs, collectOrders, collectCommissions } from './collectors.js';

const DEFAULTS = { serverUrl: 'http://127.0.0.1:8787', syncToken: '', monthsBack: 12 };
let running = false;

async function settings() { return { ...DEFAULTS, ...(await chrome.storage.local.get(['serverUrl', 'syncToken', 'monthsBack'])) }; }
async function progress(p) { await chrome.storage.session.set({ progress: { ...p, at: new Date().toISOString() } }); chrome.runtime.sendMessage({ type: 'progress', ...p }).catch(() => {}); }

async function api(s, path, body, method = body ? 'POST' : 'GET') {
  const r = await fetch(s.serverUrl + path, { method, headers: { 'content-type': 'application/json', 'x-sync-token': s.syncToken }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `Server ${r.status}`), { status: r.status });
  return j;
}

async function officeTab() {
  const tabs = await chrome.tabs.query({ url: 'https://office.doterra.com/*' });
  if (tabs.length) return tabs[0].id;
  const t = await chrome.tabs.create({ url: 'https://office.doterra.com/', active: false });
  await new Promise((resolve) => {
    const l = (id, info) => { if (id === t.id && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(l); resolve(); } };
    chrome.tabs.onUpdated.addListener(l);
    setTimeout(resolve, 20000);
  });
  return t.id;
}

async function run(tabId, func, args = []) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  if (res?.error) throw res.error;
  const out = res?.result;
  if (out === undefined || out === null) throw new Error('Keine Antwort aus dem doTERRA-Tab');
  if (out.__error) throw Object.assign(new Error(out.__error), { structure: out.structure, session: out.session });
  return out;
}

async function notify(title, message) {
  try { await chrome.notifications.create({ type: 'basic', iconUrl: 'icon.png', title, message }); } catch {}
}

export async function syncNow({ kinds = ['downline', 'legs', 'orders', 'commissions'], trigger = 'manuell', fullOrders = false } = {}) {
  if (running) return { ok: false, message: 'Ein Abgleich läuft bereits.' };
  running = true;
  const s = await settings();
  const summary = { ok: false, parts: {} };
  let runId = null;
  try {
    if (!s.syncToken) throw new Error('Abgleich-Schlüssel fehlt. Bitte im CRM unter "Daten" kopieren und hier eintragen.');
    await progress({ step: 'Verbinde mit dem CRM …' });
    await api(s, '/api/sync/ping');
    const tabId = await officeTab();
    await progress({ step: 'Prüfe doTERRA-Anmeldung …' });
    const sess = await run(tabId, checkSession);
    const start = await api(s, '/api/sync/start', { kinds, trigger });
    runId = start.runId;
    if (!sess?.ok) {
      await api(s, `/api/sync/${runId}/finish`, { status: 'session_expired', error: 'doTERRA-Sitzung abgelaufen oder nicht angemeldet' });
      await chrome.tabs.update(tabId, { active: true });
      await notify('doTERRA-Anmeldung nötig', 'Bitte im geöffneten Tab im doTERRA Office anmelden und den Abgleich erneut starten.');
      summary.message = 'Nicht im doTERRA Office angemeldet. Bitte anmelden und erneut starten.';
      summary.sessionExpired = true;
      return summary;
    }
    let structure = false, sessionLost = false;
    const steps = {
      downline: async () => run(tabId, collectDownline),
      legs: async () => run(tabId, collectLegs),
      commissions: async () => run(tabId, collectCommissions),
      orders: async () => {
        const plan = await api(s, `/api/sync/plan?monthsBack=${s.monthsBack}${fullOrders ? '&full=1' : ''}`);
        await progress({ step: `Bestellungen: ${plan.members.length} Mitglieder werden abgefragt …` });
        return run(tabId, collectOrders, [plan, { concurrency: 3 }]);
      },
    };
    for (const k of kinds) {
      try {
        await progress({ step: `Lese ${({ downline: 'Mitglieder & Volumen', legs: 'Teamlinien', orders: 'Bestellungen', commissions: 'Provisionen' })[k]} …` });
        const data = await steps[k]();
        const res = await api(s, `/api/sync/${runId}/part`, { ...data, kind: k });
        summary.parts[k] = { ok: true, ...res };
      } catch (e) {
        const msg = e?.message || String(e);
        if (e?.structure || /struktur|spalte/i.test(msg)) structure = true;
        if (e?.session) sessionLost = true;
        summary.parts[k] = { ok: false, error: msg };
      }
    }
    const fin = await api(s, `/api/sync/${runId}/finish`, sessionLost ? { status: 'session_expired' } : structure ? { status: 'structure_changed' } : {});
    summary.ok = fin.status === 'erfolgreich';
    summary.status = fin.status;
    summary.changes = fin.changeCount;
    summary.message = `Abgleich ${fin.status}. ${fin.changeCount || 0} Änderungen erkannt.`;
    if (!summary.ok) await notify('CRM-Abgleich nicht vollständig', summary.message);
    return summary;
  } catch (e) {
    summary.message = e.message;
    if (runId) { try { await api(s, `/api/sync/${runId}/finish`, { error: e.message }); } catch {} }
    return summary;
  } finally {
    running = false;
    await progress({ step: 'Fertig', done: true, summary });
  }
}

// ---------- Abgleich in eine Datei (ohne CRM-Server, z. B. für die Testversion) ----------
// Die Datei bleibt auf diesem Rechner (Download-Ordner). Sie enthält personenbezogene Daten:
// nicht in Git, Cloud-Ordner oder Chats hochladen.
export async function syncToFile({ monthsBack = 12 } = {}) {
  if (running) return { ok: false, message: 'Ein Abgleich läuft bereits.' };
  running = true;
  const bundle = { format: 'kathrins-crm-sync-bundle', version: 1, createdAt: new Date().toISOString(), parts: {}, errors: {} };
  try {
    const tabId = await officeTab();
    await progress({ step: 'Prüfe doTERRA-Anmeldung …' });
    const sess = await run(tabId, checkSession);
    if (!sess?.ok) { await chrome.tabs.update(tabId, { active: true }); return { ok: false, sessionExpired: true, message: 'Nicht im doTERRA Office angemeldet. Bitte anmelden und erneut starten.' }; }
    for (const [k, fn] of [['downline', collectDownline], ['legs', collectLegs], ['commissions', collectCommissions]]) {
      await progress({ step: `Lese ${k} …` });
      try { bundle.parts[k] = await run(tabId, fn); } catch (e) { bundle.errors[k] = e.message; }
    }
    if (bundle.parts.downline) {
      const d = bundle.parts.downline;
      const now = new Date(); const t = now.getFullYear() * 12 + now.getMonth() - monthsBack;
      const from = `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
      const members = d.rows.filter((r) => r.cells['Letztes Bestelldatum'] && r.cells['Mitglied-ID'] !== d.focusId).map((r) => {
        const e = (r.cells['Registrierungsdatum'] || '').match(/^(\d{1,2})\/\d{1,2}\/(\d{4})$/);
        const entry = e ? `${e[2]}-${e[1].padStart(2, '0')}` : null;
        return { memberId: r.cells['Mitglied-ID'], fromMonth: entry && entry > from ? entry : from };
      });
      await progress({ step: `Bestellungen: ${members.length} Mitglieder …` });
      try { bundle.parts.orders = await run(tabId, collectOrders, [{ members }, { concurrency: 3 }]); } catch (e) { bundle.errors.orders = e.message; }
    }
    const json = JSON.stringify(bundle);
    const name = `doterra-abgleich-${new Date().toISOString().slice(0, 10)}.json`;
    // Speichern über den Office-Tab (Blob), damit auch mehrere MB zuverlässig funktionieren
    await chrome.scripting.executeScript({ target: { tabId }, args: [json, name], func: (data, fname) => {
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' })); a.download = fname;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 10000);
    } });
    const n = bundle.parts.downline?.rows?.length || 0;
    return { ok: !Object.keys(bundle.errors).length, message: `Datei erstellt: ${n} Mitglieder${Object.keys(bundle.errors).length ? ' – Fehler: ' + Object.keys(bundle.errors).join(', ') : ''}. Im CRM unter „Daten" importieren.` };
  } catch (e) {
    return { ok: false, message: e.message };
  } finally {
    running = false;
    await progress({ step: 'Fertig', done: true });
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'sync') { syncNow(msg.options || {}).then(reply); return true; }
  if (msg?.type === 'syncToFile') { syncToFile(msg.options || {}).then(reply); return true; }
  if (msg?.type === 'refreshAlarm') { configureAlarm().then(() => reply({ ok: true })); return true; }
  return false;
});

// ---------- Automatischer Abgleich ----------
// Nur wenn im CRM ausdrücklich aktiviert. Modus "täglich" (Standard 05:00) oder "Intervall".
// Voraussetzungen: Rechner wach, Chrome geöffnet, Kathrin im doTERRA Office angemeldet.
// Verpasste Läufe (Rechner schlief) werden beim nächsten Chrome-Start bzw. Aufwachen nachgeholt.
function nextAt(hhmm) {
  const [h, m] = String(hhmm || '05:00').split(':').map(Number);
  const d = new Date(); d.setSeconds(0, 0); d.setHours(h || 0, m || 0);
  if (d.getTime() <= Date.now() + 60000) d.setDate(d.getDate() + 1);
  return d.getTime();
}
async function configureAlarm() {
  const s = await settings();
  if (!s.syncToken) return null;
  try {
    const info = await api(s, '/api/sync/ping');
    const a = info.autoSync || {};
    await chrome.alarms.clear('autosync');
    if (a.enabled) {
      if (a.mode === 'interval') chrome.alarms.create('autosync', { periodInMinutes: Math.max(120, (a.everyHours || 12) * 60) });
      else chrome.alarms.create('autosync', { when: nextAt(a.time), periodInMinutes: 1440 });
    }
    const alarm = await chrome.alarms.get('autosync');
    await chrome.storage.local.set({ autoSyncActive: !!a.enabled, autoSyncNext: alarm ? new Date(alarm.scheduledTime).toISOString() : null });
    return info;
  } catch { return null; } // CRM nicht erreichbar: nichts planen
}
async function catchUp() {
  const info = await configureAlarm();
  if (!info?.autoSync?.enabled) return;
  const last = info.lastSuccessAt ? new Date(info.lastSuccessAt).getTime() : 0;
  if (Date.now() - last > 24 * 3600 * 1000) syncNow({ trigger: 'nachgeholt' });
}
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'autosync') syncNow({ trigger: 'automatisch' }); });
chrome.runtime.onStartup.addListener(catchUp);
chrome.runtime.onInstalled.addListener(configureAlarm);
