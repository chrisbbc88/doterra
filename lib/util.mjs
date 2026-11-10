// Hilfsfunktionen ohne externe Abhängigkeiten.
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const TZ = 'Europe/Berlin';

export const uid = () => randomUUID();
export const token = (n = 24) => randomBytes(n).toString('base64url');

/** "26,683.50" -> 26683.5 ; "" / "--" / null -> null (fehlend, NICHT 0) */
export function parseNum(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[\u00ad\u200b-\u200d\ufeff]/g, '').trim().replace(/\s/g, '');
  if (s === '' || s === '--' || s === '-' || s === '—') return null;
  const neg = /^\(.*\)$/.test(s) || s.startsWith('-');
  const clean = s.replace(/[()\-+]/g, '').replace(/,/g, '').replace(/[^\d.]/g, '');
  if (clean === '' || isNaN(Number(clean))) return null;
  const n = Number(clean);
  return neg ? -n : n;
}

/** US-Datum "10/17/2023" -> "2023-10-17"; leer -> null */
export function parseUSDate(v) {
  if (!v) return null;
  const m = String(v).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mo, d, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/** PV-Periode "8/2026" oder "11/2026" -> "2026-08" */
export function parsePeriod(v) {
  if (!v) return null;
  const m = String(v).trim().match(/^(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[2]}-${m[1].padStart(2, '0')}`;
}

const MONTHS = {
  januar: 1, january: 1, februar: 2, february: 2, märz: 3, maerz: 3, march: 3, april: 4,
  mai: 5, may: 5, juni: 6, june: 6, juli: 7, july: 7, august: 8, september: 9,
  oktober: 10, october: 10, november: 11, dezember: 12, december: 12,
};
/** "November 2026" -> "2026-11" */
export function parseMonthLabel(v) {
  const m = String(v || '').trim().toLowerCase().match(/^([a-zäöü]+)\s+(\d{4})$/);
  if (!m || !MONTHS[m[1]]) return null;
  return `${m[2]}-${String(MONTHS[m[1]]).padStart(2, '0')}`;
}

/** Kalenderdatum in Europe/Berlin als YYYY-MM-DD */
export function localDate(d = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
export const localMonth = (d = new Date()) => localDate(d).slice(0, 7);

export function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}
export function addDays(ymd, n) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000);
}

export function atomicWriteJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(data, null, 1));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export function hashPin(pin) {
  const salt = randomBytes(16).toString('hex');
  const h = scryptSync(String(pin), salt, 32).toString('hex');
  return `${salt}:${h}`;
}
export function verifyPin(pin, stored) {
  if (!stored) return false;
  const [salt, h] = stored.split(':');
  const a = Buffer.from(h, 'hex');
  const b = scryptSync(String(pin), salt, 32);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const clone = (o) => JSON.parse(JSON.stringify(o));

/** Vergleicht zwei flache Objekte, liefert geänderte Felder */
export function diffFields(before, after, fields) {
  const out = {};
  for (const f of fields) {
    const a = before?.[f] ?? null, b = after?.[f] ?? null;
    if (JSON.stringify(a) !== JSON.stringify(b)) out[f] = { vorher: a, nachher: b };
  }
  return out;
}

export const normName = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').trim();
