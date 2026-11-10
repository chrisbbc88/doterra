const $ = (id) => document.getElementById(id);
const st = $('status');

async function load() {
  const s = await chrome.storage.local.get(['serverUrl', 'syncToken', 'monthsBack']);
  $('url').value = s.serverUrl || 'http://127.0.0.1:8787';
  $('token').value = s.syncToken || '';
  $('months').value = s.monthsBack || 12;
  if (!s.syncToken) { st.innerHTML = '<span class="warn">Bitte unter „Einrichtung" den Abgleich-Schlüssel eintragen.</span>'; document.querySelector('details').open = true; }
  const { progress } = await chrome.storage.session.get('progress');
  if (progress && !progress.done) { st.textContent = progress.step; $('go').disabled = true; }
  else if (progress?.summary?.message) st.textContent = `Letzter Lauf: ${progress.summary.message}`;
}

$('save').onclick = async () => {
  await chrome.storage.local.set({ serverUrl: $('url').value.trim() || 'http://127.0.0.1:8787', syncToken: $('token').value.trim(), monthsBack: Math.min(36, Math.max(3, Number($('months').value) || 12)) });
  await chrome.runtime.sendMessage({ type: 'refreshAlarm' });
  st.textContent = 'Gespeichert.';
};

$('go').onclick = async () => {
  $('go').disabled = true;
  st.textContent = 'Starte …';
  const res = await chrome.runtime.sendMessage({ type: 'sync', options: { fullOrders: $('full').checked } });
  $('go').disabled = false;
  const lines = [res?.message || 'Unbekanntes Ergebnis'];
  for (const [k, v] of Object.entries(res?.parts || {})) lines.push(`• ${k}: ${v.ok ? 'übertragen' + (v.complete === false ? ' (unvollständig)' : '') : 'Fehler – ' + v.error}`);
  st.innerHTML = '';
  st.textContent = lines.join('\n');
  if (!res?.ok) st.classList.add('warn'); else st.classList.remove('warn');
};

$('file').onclick = async () => {
  $('file').disabled = true; $('go').disabled = true; st.textContent = 'Starte …';
  const res = await chrome.runtime.sendMessage({ type: 'syncToFile', options: { monthsBack: Number($('months').value) || 12 } });
  $('file').disabled = false; $('go').disabled = false;
  st.textContent = res?.message || 'Unbekanntes Ergebnis';
  st.classList.toggle('warn', !res?.ok);
};
chrome.storage.local.get(['autoSyncActive', 'autoSyncNext']).then((a) => {
  $('next').textContent = a.autoSyncActive ? `Automatischer Abgleich aktiv · nächster Lauf ${a.autoSyncNext ? new Date(a.autoSyncNext).toLocaleString('de-DE', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : 'geplant'}` : 'Automatischer Abgleich: aus';
});
chrome.runtime.onMessage.addListener((m) => { if (m.type === 'progress' && !m.done) st.textContent = m.step; });
load();
