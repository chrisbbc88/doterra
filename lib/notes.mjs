// Schnellnotizen in natürlicher Sprache -> Vorschlag (Kontakt, Notiz, Aufgabe).
// Deterministisch und offline. Unsicheres wird als Rückfrage markiert, nie still gespeichert.
import { addDays, normName } from './util.mjs';

const WEEKDAYS = { montag: 1, dienstag: 2, mittwoch: 3, donnerstag: 4, freitag: 5, samstag: 6, sonntag: 0 };
const WD_NAMES = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

function weekday(ymd) { return new Date(ymd + 'T12:00:00Z').getUTCDay(); }
export function fmtDate(ymd) { const [y, m, d] = ymd.split('-'); return `${WD_NAMES[weekday(ymd)]}, ${d}.${m}.${y}`; }

/** Erkennt Datumsangaben relativ zu "heute" (YYYY-MM-DD, Europe/Berlin). */
export function resolveDates(text, today) {
  const t = text.toLowerCase();
  const found = [];
  const add = (phrase, date, options) => found.push({ phrase, date, ambiguous: !!options, options: options || null });
  if (/\bübermorgen\b/.test(t)) add('übermorgen', addDays(today, 2));
  else if (/\bmorgen\b/.test(t)) add('morgen', addDays(today, 1));
  if (/\bheute\b/.test(t)) add('heute', today);
  let m;
  const reIn = /\bin (\d+|einer|einem|zwei|drei|vier) (tag|tagen|woche|wochen)\b/g;
  const words = { einer: 1, einem: 1, zwei: 2, drei: 3, vier: 4 };
  while ((m = reIn.exec(t))) { const n = words[m[1]] ?? Number(m[1]); add(m[0], addDays(today, m[2].startsWith('woche') ? n * 7 : n)); }
  const reWd = /\b(nächste[nm]?|kommende[nm]?|am|diese[nm]?)?\s*(montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)\b/g;
  while ((m = reWd.exec(t))) {
    const target = WEEKDAYS[m[2]];
    const cur = weekday(today);
    let diff = (target - cur + 7) % 7;
    if (diff === 0) diff = 7;
    const first = addDays(today, diff);
    const mod = m[1] || '';
    // "nächsten Dienstag": liegt der Tag noch in dieser Woche (Mo–So), ist unklar, ob diese oder nächste Woche gemeint ist.
    const daysToSunday = (7 - cur) % 7;
    if (/nächst/.test(mod) && diff <= daysToSunday) add(m[0].trim(), null, [first, addDays(first, 7)]);
    else add(m[0].trim(), first);
  }
  const reDate = /\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})?/g;
  while ((m = reDate.exec(text))) {
    const d = m[1].padStart(2, '0'), mo = m[2].padStart(2, '0');
    let y = m[3] ? (m[3].length === 2 ? '20' + m[3] : m[3]) : today.slice(0, 4);
    let date = `${y}-${mo}-${d}`;
    if (!m[3] && date < today) date = `${Number(y) + 1}-${mo}-${d}`;
    if (!isNaN(new Date(date + 'T12:00:00Z'))) add(m[0], date);
  }
  return found;
}

/** Kontaktvorschläge über Namensbestandteile. Kein automatisches Zusammenführen. */
export function matchContacts(text, db) {
  const tokens = [...text.matchAll(/\b[A-ZÄÖÜ][a-zäöüß]+(?:-[A-ZÄÖÜ][a-zäöüß]+)?\b/g)].map((m) => normName(m[0]));
  const stop = new Set(['der', 'die', 'das', 'sie', 'er', 'wir', 'ich', 'yoga', 'instagram', 'testwoche', 'montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag', 'sonntag', 'nächsten', 'heute', 'morgen', 'workshop', 'beim', 'am', 'mit']);
  const want = tokens.filter((t) => !stop.has(t));
  const people = [
    ...Object.values(db.members).filter((m) => m.inDownline !== false).map((m) => ({ key: m.id, name: m.name, art: m.memberType, quelle: 'doTERRA', entryDate: m.entryDate || null, city: m.contact?.city || null })),
    ...Object.entries(db.prospects).map(([key, p]) => ({ key, name: p.name, art: 'Interessentin', quelle: 'CRM' })),
  ];
  const hits = [];
  for (const p of people) {
    const parts = normName(p.name).replace(',', ' ').split(/\s+/).filter(Boolean);
    const score = want.reduce((s, w) => s + (parts.includes(w) ? 1 : 0), 0);
    if (score > 0) hits.push({ ...p, score });
  }
  hits.sort((a, b) => b.score - a.score);
  const best = hits[0]?.score || 0;
  return { candidates: hits.filter((h) => h.score === best).slice(0, 8), tokens: want };
}

const SOURCES = [
  [/\byoga\b/i, 'Yoga'], [/instagram|\binsta\b|\bdm\b/i, 'Instagram'], [/empfehlung|empfohlen/i, 'Empfehlung'],
  [/veranstaltung|workshop|event|abend/i, 'Veranstaltung'], [/kooperation/i, 'Kooperation'],
];
// Gesundheitsbezogene Begriffe: werden nicht automatisch gespeichert, sondern zur Prüfung markiert.
const HEALTH = /krank|schmerz|diagnose|migräne|schlafprobl|depress|angst(?:zust|stör)|schwanger|allergi|entzünd|therapie|medikament|blutdruck|krebs|diabet/i;

export function proposeFromNote(text, db, today) {
  const dates = resolveDates(text, today);
  const { candidates } = matchContacts(text, db);
  const sources = SOURCES.filter(([re]) => re.test(text)).map(([, s]) => s);
  const fragen = [];
  if (candidates.length === 0) fragen.push({ typ: 'kontakt', text: 'Keine passende Person gefunden. Neue Interessentin anlegen oder Person auswählen?' });
  else if (candidates.length > 1) fragen.push({ typ: 'kontakt', text: `Mehrere Personen passen (${candidates.map((c) => c.name).join(' · ')}). Welche ist gemeint?` });
  const terminDates = dates.filter((d) => d.date || d.options);
  const amb = terminDates.find((d) => d.ambiguous);
  if (amb) fragen.push({ typ: 'datum', text: `"${amb.phrase}": ${fmtDate(amb.options[0])} oder ${fmtDate(amb.options[1])}?`, options: amb.options });
  if (terminDates.filter((d) => !d.ambiguous).length > 1) fragen.push({ typ: 'datum', text: 'Mehrere Daten erkannt – welches ist der Termin?', options: terminDates.filter((d) => d.date).map((d) => d.date) });
  const sensibel = HEALTH.test(text);
  if (sensibel) fragen.push({ typ: 'sensibel', text: 'Die Notiz enthält möglicherweise Gesundheitsangaben. Bitte nur speichern, was für die Betreuung nötig ist und wofür eine Einwilligung vorliegt.' });
  const gespraech = /sprechen|telefon|anrufen|melden|treffen|termin|gespräch|nachfass/i.test(text);
  const date = terminDates.find((d) => d.date && !d.ambiguous)?.date || null;
  return {
    original: text,
    kandidaten: candidates,
    kontaktEindeutig: candidates.length === 1 ? candidates[0].key : null,
    notiz: { text, quellenHinweis: sources, sensibel },
    aufgabe: gespraech || date ? { title: gespraech ? 'Gespräch führen' : 'Nachfassen', due: date, dueUnsicher: !!amb } : null,
    testwoche: /testwoche|probewoche/i.test(text),
    fragen,
    hinweis: 'Vorschlag – wird erst nach Bestätigung gespeichert.',
  };
}
