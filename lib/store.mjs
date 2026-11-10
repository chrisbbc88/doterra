// Lokale JSON-Datenbank mit Migrationen, atomarem Speichern und Sicherungen.
// Struktur bewusst tabellenartig (Sammlungen mit stabilen Schlüsseln),
// damit ein späterer Umzug nach Supabase/Postgres 1:1 möglich ist.
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJSON, clone } from './util.mjs';

export const SCHEMA_VERSION = 2;

export function emptyDb() {
  return {
    schemaVersion: SCHEMA_VERSION,
    meta: { createdAt: new Date().toISOString(), dataKind: 'echt' },
    // --- aus doTERRA synchronisiert (nur lesend erzeugt, nie manuell überschrieben)
    members: {},        // doTERRA-ID -> Stammdaten aus Downline-Bericht
    memberMonths: {},   // "ID|YYYY-MM" -> Volumenwerte je Monat
    legs: {},           // "ID|YYYY-MM" -> Schlagdistanz (Leg-ID, Monatsrang, % zum Rang)
    orders: {},         // Rechnungsnummer -> Bestellung
    orderCoverage: {},  // doTERRA-ID -> {fromMonth, fetchedAt, lastOrderDateSeen}
    commissions: {},    // "YYYY-MM|primary|secondary" -> Provisionsbeträge
    // --- manuell im CRM gepflegt (wird von keinem Import verändert)
    profiles: {},       // contactKey -> CRM-Profil (Quelle, Interessen, nächster Schritt …)
    prospects: {},      // "p:<uuid>" -> Interessent*in ohne doTERRA-ID
    notes: {},
    tasks: {},
    events: {},
    goals: {},
    products: {},       // SKU -> {name, kategorie}
    drafts: {},
    settings: {
      weeklyHours: 10,
      staleAfterHours: 26,
      ownerId: null,       // Kathrins doTERRA-ID, wird beim ersten Abgleich gesetzt
      market: 'DE',
      currency: 'EUR',
      assistantModel: 'claude-sonnet-5-5',
      autoSync: { enabled: false, mode: 'daily', time: '05:00', everyHours: 12 },
    },
    // --- Betrieb
    syncRuns: {},
    areaStatus: {},      // kind -> {lastSuccessAt, lastAttemptAt, lastStatus, lastRunId}
    changes: {},         // erkannte Änderungen je Abgleich
    suppressed: {},      // doTERRA-IDs, die lokal gelöscht wurden und nicht reimportiert werden
    audit: [],           // knappe Protokolle ohne Personeninhalte
  };
}

const MIGRATIONS = {
  // v1 -> v2: Sammlungen ergänzt
  1: (db) => {
    const base = emptyDb();
    for (const k of Object.keys(base)) if (db[k] === undefined) db[k] = base[k];
    db.settings = { ...base.settings, ...db.settings };
    db.schemaVersion = 2;
    return db;
  },
};

export function migrate(db) {
  let v = db.schemaVersion || 1;
  while (v < SCHEMA_VERSION) {
    const fn = MIGRATIONS[v];
    if (!fn) throw new Error(`Keine Migration für Schema v${v}`);
    db = fn(db);
    v = db.schemaVersion;
  }
  // fehlende Sammlungen immer ergänzen
  const base = emptyDb();
  for (const k of Object.keys(base)) if (db[k] === undefined) db[k] = base[k];
  db.settings = { ...base.settings, ...db.settings };
  return db;
}

export function validateDb(db) {
  const errors = [];
  if (!db || typeof db !== 'object') return ['Keine Datenbankstruktur'];
  for (const k of ['members', 'memberMonths', 'orders', 'profiles', 'notes', 'tasks', 'settings']) {
    if (typeof db[k] !== 'object' || db[k] === null) errors.push(`Sammlung fehlt: ${k}`);
  }
  for (const [id, m] of Object.entries(db.members || {})) {
    if (m.id !== id) { errors.push(`Mitglied ${id}: ID-Konflikt`); break; }
  }
  return errors;
}

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'db.json');
    this.backupDir = path.join(dir, 'backups');
    fs.mkdirSync(this.backupDir, { recursive: true });
    this.db = this.load();
  }

  load() {
    if (!fs.existsSync(this.file)) {
      const db = emptyDb();
      atomicWriteJSON(this.file, db);
      return db;
    }
    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    const db = migrate(raw);
    const errs = validateDb(db);
    if (errs.length) throw new Error('Datenbank ungültig: ' + errs.join('; '));
    return db;
  }

  save() { atomicWriteJSON(this.file, this.db); }

  /** Änderung atomar anwenden: auf Kopie arbeiten, erst bei Erfolg übernehmen. */
  transact(fn) {
    const work = clone(this.db);
    const result = fn(work);
    const errs = validateDb(work);
    if (errs.length) throw new Error('Transaktion verworfen: ' + errs.join('; '));
    this.db = work;
    this.save();
    return result;
  }

  log(action, info = {}) {
    // Protokoll ohne personenbezogene Inhalte: nur Aktion, Zähler, IDs von Läufen
    this.db.audit.push({ at: new Date().toISOString(), action, ...info });
    if (this.db.audit.length > 2000) this.db.audit = this.db.audit.slice(-2000);
  }

  backup(reason = 'manuell') {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `db-${stamp}-${reason.replace(/[^a-z0-9-]/gi, '')}.json`;
    atomicWriteJSON(path.join(this.backupDir, name), this.db);
    this.pruneBackups();
    return name;
  }

  listBackups() {
    return fs.readdirSync(this.backupDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => { const st = fs.statSync(path.join(this.backupDir, f)); return { name: f, size: st.size, at: st.mtime.toISOString() }; })
      .sort((a, b) => b.name.localeCompare(a.name));
  }

  pruneBackups(keep = 60) {
    const list = this.listBackups();
    for (const b of list.slice(keep)) fs.unlinkSync(path.join(this.backupDir, b.name));
  }

  /** Wiederherstellung: prüft die Sicherung, sichert den aktuellen Stand vorher. */
  restore(nameOrData) {
    let data = nameOrData;
    if (typeof nameOrData === 'string') {
      if (!/^[\w.-]+\.json$/.test(nameOrData)) throw new Error('Ungültiger Dateiname');
      data = JSON.parse(fs.readFileSync(path.join(this.backupDir, nameOrData), 'utf8'));
    }
    if (!data || typeof data !== 'object' || typeof data.schemaVersion !== 'number' || typeof data.members !== 'object' || !data.meta) throw new Error('Sicherung ungültig: keine CRM-Sicherung');
    const db = migrate(clone(data));
    const errs = validateDb(db);
    if (errs.length) throw new Error('Sicherung ungültig: ' + errs.join('; '));
    const before = this.backup('vor-wiederherstellung');
    this.db = db;
    this.log('restore', { source: typeof nameOrData === 'string' ? nameOrData : 'upload', safety: before });
    this.save();
    return before;
  }
}
