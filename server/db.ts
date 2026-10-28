import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Forward-only migrations (ADR 0010): append new entries, never edit or remove old ones.
const MIGRATIONS = [
  `-- A domain the organisation says is its own. A recipient is only ever mailed when its address is in a domain whose
   -- state is verified: the TXT record with its token was found at the last check (ADR 0071).
   CREATE TABLE domains (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     token TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('pending', 'verified', 'lost')),
     created_at TEXT NOT NULL,
     created_by TEXT NOT NULL,
     verified_at TEXT,
     checked_at TEXT,
     error TEXT
   );
   -- The organisation's own people, from the Identity directory or a CSV import. Only people whose email is in a
   -- verified domain can be added to a campaign; the column is kept so the rule can be re-checked as domains change.
   CREATE TABLE people (
     id TEXT PRIMARY KEY,
     email TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     department TEXT,
     source TEXT NOT NULL CHECK (source IN ('identity', 'csv')),
     external_id TEXT,
     active INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX people_department ON people (department);
   -- A phishing simulation. It names the admin who created it (ADR 0071), the built-in or custom template, the from
   -- address (which must be in a verified domain) and the report address a reported mail counts for.
   CREATE TABLE campaigns (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     template_id TEXT NOT NULL,
     from_name TEXT NOT NULL,
     from_email TEXT NOT NULL,
     subject TEXT NOT NULL,
     report_address TEXT NOT NULL,
     department TEXT,
     state TEXT NOT NULL CHECK (state IN ('draft', 'sending', 'sent', 'failed')),
     created_at TEXT NOT NULL,
     created_by TEXT NOT NULL,
     sent_at TEXT,
     error TEXT
   );
   CREATE INDEX campaigns_created ON campaigns (created_at);
   -- One person in one campaign. The token is the opaque id in that person's links; it is all the landing page knows.
   -- opened_at, clicked_at, submitted_at and reported_at hold the first time each happened. No field a person typed is
   -- ever stored: submitted_at records only that the form was posted (ADR 0071).
   CREATE TABLE recipients (
     id TEXT PRIMARY KEY,
     campaign_id TEXT NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
     person_id TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
     email TEXT NOT NULL,
     name TEXT NOT NULL,
     token TEXT NOT NULL UNIQUE,
     sent_at TEXT,
     error TEXT,
     opened_at TEXT,
     clicked_at TEXT,
     submitted_at TEXT,
     reported_at TEXT,
     UNIQUE (campaign_id, person_id)
   );
   CREATE INDEX recipients_campaign ON recipients (campaign_id);
   CREATE INDEX recipients_person ON recipients (person_id);
   -- A training module assigned to a person (ADR 0071). Modules are built in (training.ts); this records who owes what
   -- and who finished, with the quiz score. The token is the opaque id in the person's training link.
   CREATE TABLE assignments (
     id TEXT PRIMARY KEY,
     module_id TEXT NOT NULL,
     person_id TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
     token TEXT NOT NULL UNIQUE,
     reason TEXT NOT NULL,
     assigned_at TEXT NOT NULL,
     due_at TEXT,
     started_at TEXT,
     completed_at TEXT,
     score INTEGER,
     passed INTEGER,
     UNIQUE (module_id, person_id)
   );
   CREATE INDEX assignments_person ON assignments (person_id);
   -- Settings that hold a secret, sealed with the install's key (ADR 0021): the SMTP relay and the Identity
   -- connection. One row per key; the value is JSON.
   CREATE TABLE settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     updated_by TEXT NOT NULL
   );
   -- Every campaign, every domain change, every directory sync and every setting change (ADR 0013). Append-only.
   CREATE TABLE audit (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at TEXT NOT NULL,
     actor TEXT NOT NULL,
     action TEXT NOT NULL,
     target TEXT NOT NULL,
     detail TEXT NOT NULL DEFAULT ''
   );
   CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;
   CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END`,
];

/** Opens the product's single SQLite file in WAL mode (ADR 0011) and migrates it forward. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
