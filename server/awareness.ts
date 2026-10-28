// The core of Awareness (ADR 0071): the organisation's own people, the domains it has proven, the phishing
// simulations it sends through its own relay, the clicks and reports those record without ever keeping what a person
// typed, the training assigned to whoever clicked, and the risk that falls as people learn. Everything a request
// changes goes through here, and every change that matters is audited.
import { randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { hasProof, proofName, proofValue, type Dns } from "./dns.ts";
import { log } from "./log.ts";
import type { Sealer } from "./seal.ts";
import { createMailer, type Mailer, type SmtpConfig } from "./smtp.ts";
import { MODULES, grade, module as findModule, type Module } from "./training.ts";
import { render, template as findTemplate, TEMPLATES, type Template } from "./templates.ts";

export type ProblemCode = "invalid-json" | "invalid-body" | "not-found" | "conflict" | "internal-error";

export class AwarenessError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  constructor(status: number, code: ProblemCode, message?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const bad = (message: string) => new AwarenessError(400, "invalid-body", message);
const notFound = (what: string) => new AwarenessError(404, "not-found", `No such ${what}.`);
const conflict = (message: string) => new AwarenessError(409, "conflict", message);

export interface AwarenessOptions {
  dns: Dns;
  sealer: Sealer;
  /** The address people and recipients reach this Awareness at, for the links in the mail (ADR 0026). */
  publicUrl: string;
  /** Builds a mailer from a relay config; overridden in tests to point at a catcher. */
  makeMailer?: (config: SmtpConfig) => Mailer;
  /** The outbound fetch, overridden in tests so no request leaves the machine. */
  fetch?: typeof fetch;
  clock?: () => number;
}

// ---- Shapes the API returns. They follow openapi.json. ----

export interface Domain {
  id: string;
  name: string;
  state: "pending" | "verified" | "lost";
  proof: { name: string; type: "TXT"; value: string };
  createdAt: string;
  createdBy: string;
  verifiedAt: string | null;
  checkedAt: string | null;
  error: string | null;
  people: number;
}

export interface Person {
  id: string;
  email: string;
  name: string;
  department: string | null;
  source: "identity" | "csv";
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Campaign {
  id: string;
  name: string;
  templateId: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  reportAddress: string;
  department: string | null;
  state: "draft" | "sending" | "sent" | "failed";
  createdAt: string;
  createdBy: string;
  sentAt: string | null;
  error: string | null;
  stats: CampaignStats;
}

export interface CampaignStats {
  recipients: number;
  sent: number;
  failed: number;
  opened: number;
  clicked: number;
  submitted: number;
  reported: number;
}

export interface Assignment {
  id: string;
  moduleId: string;
  moduleTitle: string;
  personId: string;
  personName: string;
  reason: string;
  assignedAt: string;
  dueAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  score: number | null;
  passed: boolean | null;
}

type Row = Record<string, unknown>;

export function createAwareness(db: DatabaseSync, opts: AwarenessOptions) {
  const now = opts.clock ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  const base = opts.publicUrl.replace(/\/$/, "");
  const makeMailer = opts.makeMailer ?? createMailer;
  const http = opts.fetch ?? fetch;
  // Campaign sends run in the background; idle() awaits those in flight, for the schedule, tests and shutdown.
  const inFlight = new Set<Promise<void>>();
  const idle = () => Promise.all(inFlight).then(() => undefined);

  function audit(actor: string, action: string, target: string, detail = "") {
    db.prepare("INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)").run(iso(), actor, action, target, detail);
  }

  // ---- Domains ----

  const DOMAIN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
  const cleanDomain = (raw: unknown): string => {
    if (typeof raw !== "string") throw bad("A domain name is required.");
    const name = raw.trim().toLowerCase().replace(/\.$/, "");
    if (!DOMAIN.test(name) || name.length > 253 || /^\d+$/.test(name.split(".").at(-1)!)) throw bad("That is not a domain name.");
    return name;
  };

  const domainRow = (r: Row): Domain => ({
    id: r.id as string,
    name: r.name as string,
    state: r.state as Domain["state"],
    proof: { name: proofName(r.name as string), type: "TXT", value: proofValue(r.token as string) },
    createdAt: r.created_at as string,
    createdBy: r.created_by as string,
    verifiedAt: (r.verified_at as string) ?? null,
    checkedAt: (r.checked_at as string) ?? null,
    error: (r.error as string) ?? null,
    people: Number(r.people ?? 0),
  });

  const DOMAIN_SELECT =
    "SELECT d.*, (SELECT COUNT(*) FROM people p WHERE lower(substr(p.email, instr(p.email, '@') + 1)) = d.name OR lower(substr(p.email, instr(p.email, '@') + 1)) LIKE '%.' || d.name) AS people FROM domains d";

  function domains(): Domain[] {
    return (db.prepare(`${DOMAIN_SELECT} ORDER BY d.created_at DESC`).all() as Row[]).map(domainRow);
  }
  function domain(id: string): Domain {
    const r = db.prepare(`${DOMAIN_SELECT} WHERE d.id = ?`).get(id) as Row | undefined;
    if (!r) throw notFound("domain");
    return domainRow(r);
  }
  function createDomain(body: Row, actor: string): Domain {
    const name = cleanDomain(body.name);
    if (db.prepare("SELECT 1 FROM domains WHERE name = ?").get(name)) throw conflict("That domain is already added.");
    const id = randomUUID();
    const token = randomBytes(16).toString("hex");
    db.prepare("INSERT INTO domains (id, name, token, state, created_at, created_by) VALUES (?, ?, ?, 'pending', ?, ?)").run(id, name, token, iso(), actor);
    audit(actor, "domain-added", name);
    return domain(id);
  }
  async function verifyDomain(id: string, actor: string): Promise<Domain> {
    const r = db.prepare("SELECT * FROM domains WHERE id = ?").get(id) as Row | undefined;
    if (!r) throw notFound("domain");
    const found = await hasProof(opts.dns, r.name as string, r.token as string);
    const was = r.state as string;
    const state = found ? "verified" : was === "verified" ? "lost" : "pending";
    const error = found ? null : "The TXT record with this domain's token was not found.";
    db.prepare("UPDATE domains SET state = ?, checked_at = ?, verified_at = COALESCE(verified_at, ?), error = ? WHERE id = ?").run(
      state,
      iso(),
      found ? iso() : null,
      error,
      id,
    );
    if (found && was !== "verified") audit(actor, "domain-verified", r.name as string);
    if (!found && was === "verified") audit(actor, "domain-lost", r.name as string);
    return domain(id);
  }
  function deleteDomain(id: string, actor: string): void {
    const r = db.prepare("SELECT name FROM domains WHERE id = ?").get(id) as Row | undefined;
    if (!r) throw notFound("domain");
    db.prepare("DELETE FROM domains WHERE id = ?").run(id);
    audit(actor, "domain-deleted", r.name as string);
  }
  /** Re-reads every verified or lost domain's TXT record; the schedule calls it. */
  async function recheckDomains(): Promise<void> {
    const rows = db.prepare("SELECT id FROM domains WHERE state IN ('verified', 'lost')").all() as Row[];
    for (const r of rows) await verifyDomain(r.id as string, "schedule");
  }

  const verifiedNames = (): string[] => (db.prepare("SELECT name FROM domains WHERE state = 'verified'").all() as Row[]).map((r) => r.name as string);
  const emailDomain = (email: string) => email.slice(email.indexOf("@") + 1).toLowerCase();
  /** Whether an address is in a verified domain, so a recipient there may be mailed. The gate of the whole product. */
  function inVerifiedDomain(email: string, verified = verifiedNames()): boolean {
    const d = emailDomain(email);
    return verified.some((v) => d === v || d.endsWith(`.${v}`));
  }

  // ---- People ----

  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const personRow = (r: Row): Person => ({
    id: r.id as string,
    email: r.email as string,
    name: r.name as string,
    department: (r.department as string) ?? null,
    source: r.source as Person["source"],
    active: Boolean(r.active),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  });

  function people(filter: { department?: string | null } = {}): Person[] {
    const rows = filter.department
      ? db.prepare("SELECT * FROM people WHERE department = ? ORDER BY name COLLATE NOCASE").all(filter.department)
      : db.prepare("SELECT * FROM people ORDER BY name COLLATE NOCASE").all();
    return (rows as Row[]).map(personRow);
  }
  function person(id: string): Person {
    const r = db.prepare("SELECT * FROM people WHERE id = ?").get(id) as Row | undefined;
    if (!r) throw notFound("person");
    return personRow(r);
  }

  /** Adds or updates one person, refusing an address outside the verified domains. Returns what happened. */
  function upsertPerson(
    p: { email: string; name: string; department: string | null; source: "identity" | "csv"; externalId: string | null; active: boolean },
    verified: string[],
  ): "added" | "updated" | "rejected" {
    const email = p.email.trim().toLowerCase();
    if (!EMAIL.test(email) || !inVerifiedDomain(email, verified)) return "rejected";
    const existing = db.prepare("SELECT id FROM people WHERE email = ?").get(email) as Row | undefined;
    if (existing) {
      db.prepare("UPDATE people SET name = ?, department = ?, source = ?, external_id = ?, active = ?, updated_at = ? WHERE id = ?").run(
        p.name,
        p.department,
        p.source,
        p.externalId,
        p.active ? 1 : 0,
        iso(),
        existing.id as string,
      );
      return "updated";
    }
    db.prepare("INSERT INTO people (id, email, name, department, source, external_id, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      randomUUID(),
      email,
      p.name || email,
      p.department,
      p.source,
      p.externalId,
      p.active ? 1 : 0,
      iso(),
      iso(),
    );
    return "added";
  }

  interface ImportResult {
    added: number;
    updated: number;
    rejected: number;
    /** The addresses left out because they are not in a verified domain, so an admin can see why. */
    rejectedEmails: string[];
  }

  function importCsv(text: string, actor: string): ImportResult {
    const verified = verifiedNames();
    const rows = parseCsv(text);
    if (!rows.length) throw bad("The CSV has no rows.");
    const header = rows[0]!.map((h) => h.trim().toLowerCase());
    const emailAt = header.indexOf("email");
    if (emailAt < 0) throw bad("The CSV needs an 'email' column.");
    const nameAt = header.indexOf("name");
    const deptAt = header.findIndex((h) => h === "department" || h === "team");
    const result: ImportResult = { added: 0, updated: 0, rejected: 0, rejectedEmails: [] };
    for (const row of rows.slice(1)) {
      const email = (row[emailAt] ?? "").trim();
      if (!email) continue;
      const outcome = upsertPerson(
        {
          email,
          name: (nameAt >= 0 ? row[nameAt] : "")?.trim() ?? "",
          department: deptAt >= 0 ? row[deptAt]?.trim() || null : null,
          source: "csv",
          externalId: null,
          active: true,
        },
        verified,
      );
      if (outcome === "rejected") result.rejectedEmails.push(email.toLowerCase());
      result[outcome]++;
    }
    audit(actor, "people-imported", "csv", `${result.added} added, ${result.updated} updated, ${result.rejected} rejected`);
    return result;
  }

  /** Reads the Identity directory with the sealed viewer token (ADR 0071) and upserts everyone in a verified domain. */
  async function syncIdentity(actor: string): Promise<ImportResult> {
    const conn = identityConn();
    if (!conn) throw bad("Connect the Identity directory first, under Settings.");
    const res = await http(`${conn.url}/api/v1/people`, { headers: { authorization: `Bearer ${conn.token}` } });
    if (!res.ok) throw new AwarenessError(502, "internal-error", `Identity answered ${res.status}.`);
    const data = (await res.json()) as { people?: Array<{ id?: string; email?: string; name?: string; groups?: string[]; status?: string }> };
    const verified = verifiedNames();
    const result: ImportResult = { added: 0, updated: 0, rejected: 0, rejectedEmails: [] };
    for (const p of data.people ?? []) {
      if (!p.email) continue;
      const outcome = upsertPerson(
        {
          email: p.email,
          name: p.name ?? p.email,
          department: p.groups?.[0] ?? null,
          source: "identity",
          externalId: p.id ?? null,
          active: p.status !== "suspended" && p.status !== "disabled",
        },
        verified,
      );
      if (outcome === "rejected") result.rejectedEmails.push(p.email.toLowerCase());
      result[outcome]++;
    }
    audit(actor, "identity-synced", conn.url, `${result.added} added, ${result.updated} updated, ${result.rejected} rejected`);
    return result;
  }

  // ---- Templates ----

  const templates = (): Template[] => TEMPLATES;

  // ---- Campaigns ----

  const statsOf = (campaignId: string): CampaignStats => {
    const r = db
      .prepare(
        `SELECT COUNT(*) AS recipients,
           COUNT(sent_at) AS sent, COUNT(error) AS failed,
           COUNT(opened_at) AS opened, COUNT(clicked_at) AS clicked,
           COUNT(submitted_at) AS submitted, COUNT(reported_at) AS reported
         FROM recipients WHERE campaign_id = ?`,
      )
      .get(campaignId) as Row;
    return {
      recipients: Number(r.recipients),
      sent: Number(r.sent),
      failed: Number(r.failed),
      opened: Number(r.opened),
      clicked: Number(r.clicked),
      submitted: Number(r.submitted),
      reported: Number(r.reported),
    };
  };

  const campaignRow = (r: Row): Campaign => ({
    id: r.id as string,
    name: r.name as string,
    templateId: r.template_id as string,
    fromName: r.from_name as string,
    fromEmail: r.from_email as string,
    subject: r.subject as string,
    reportAddress: r.report_address as string,
    department: (r.department as string) ?? null,
    state: r.state as Campaign["state"],
    createdAt: r.created_at as string,
    createdBy: r.created_by as string,
    sentAt: (r.sent_at as string) ?? null,
    error: (r.error as string) ?? null,
    stats: statsOf(r.id as string),
  });

  function campaigns(): Campaign[] {
    return (db.prepare("SELECT * FROM campaigns ORDER BY created_at DESC").all() as Row[]).map(campaignRow);
  }
  function campaign(id: string): Campaign {
    const r = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id) as Row | undefined;
    if (!r) throw notFound("campaign");
    return campaignRow(r);
  }

  const str = (v: unknown, what: string, max = 200): string => {
    if (typeof v !== "string" || !v.trim()) throw bad(`${what} is required.`);
    if (v.length > max) throw bad(`${what} is at most ${max} characters.`);
    return v.trim();
  };

  interface Created {
    campaign: Campaign;
    done: Promise<void>;
  }

  /** Creates a campaign, builds a recipient for every eligible person, and sends through the relay in the background.
   * Returns at once with the draft and a promise that settles when the sending finishes (for tests and the schedule). */
  function createCampaign(body: Row, actor: string): Created {
    const t = findTemplate(str(body.templateId, "A template"));
    if (!t) throw bad("No such template.");
    const name = str(body.name, "A name");
    const fromName = str(body.fromName ?? t.displayFrom.replace(/\s*<.*/, ""), "A from name", 120);
    const fromEmail = str(body.fromEmail, "A from address").toLowerCase();
    if (!EMAIL.test(fromEmail)) throw bad("The from address is not an email address.");
    if (!inVerifiedDomain(fromEmail)) throw bad("The from address must be in a verified domain.");
    const reportAddress = str(body.reportAddress, "A report address").toLowerCase();
    if (!EMAIL.test(reportAddress)) throw bad("The report address is not an email address.");
    const department = body.department == null ? null : str(body.department, "A department", 120);
    const subject = typeof body.subject === "string" && body.subject.trim() ? body.subject.trim().slice(0, 300) : t.subject;

    const audience = people({ department }).filter((p) => p.active && inVerifiedDomain(p.email));
    if (!audience.length) throw bad("No eligible people: add people in a verified domain, or widen the department.");

    const id = randomUUID();
    db.prepare(
      "INSERT INTO campaigns (id, name, template_id, from_name, from_email, subject, report_address, department, state, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sending', ?, ?)",
    ).run(id, name, t.id, fromName, fromEmail, subject, reportAddress, department, iso(), actor);
    const insert = db.prepare("INSERT INTO recipients (id, campaign_id, person_id, email, name, token) VALUES (?, ?, ?, ?, ?, ?)");
    for (const p of audience) insert.run(randomUUID(), id, p.id, p.email, p.name, randomBytes(18).toString("hex"));
    audit(actor, "campaign-created", name, `template ${t.id}, ${audience.length} recipients`);

    const done = send(id, t, { name, fromName, fromEmail, subject, reportAddress })
      .catch((err) => {
        log("error", "campaign send failed", { campaign: id, error: String(err) });
      })
      .finally(() => inFlight.delete(done));
    inFlight.add(done);
    return { campaign: campaign(id), done };
  }

  async function send(campaignId: string, t: Template, c: { name: string; fromName: string; fromEmail: string; subject: string; reportAddress: string }) {
    let mailer: Mailer;
    try {
      mailer = mailerFromSettings();
    } catch (err) {
      db.prepare("UPDATE campaigns SET state = 'failed', error = ? WHERE id = ?").run(String((err as Error).message), campaignId);
      throw err;
    }
    const recipients = db.prepare("SELECT * FROM recipients WHERE campaign_id = ?").all(campaignId) as Row[];
    for (const r of recipients) {
      const token = r.token as string;
      const mail = render(t, {
        recipientName: (r.name as string) || null,
        landingUrl: `${base}/l/${token}`,
        pixelUrl: `${base}/l/${token}/i.gif`,
        reportAddress: c.reportAddress,
      });
      try {
        await mailer.send({ from: `${c.fromName} <${c.fromEmail}>`, to: r.email as string, subject: c.subject, text: mail.text, html: mail.html });
        db.prepare("UPDATE recipients SET sent_at = ?, error = NULL WHERE id = ?").run(iso(), r.id as string);
      } catch (err) {
        db.prepare("UPDATE recipients SET error = ? WHERE id = ?").run(String((err as Error).message).slice(0, 300), r.id as string);
      }
    }
    const s = statsOf(campaignId);
    const state = s.sent === 0 ? "failed" : "sent";
    const error = s.failed ? `${s.failed} of ${s.recipients} could not be sent` : null;
    db.prepare("UPDATE campaigns SET state = ?, sent_at = ?, error = ? WHERE id = ?").run(state, iso(), error, campaignId);
  }

  // ---- The landing page's record of behaviour. It never reads a request body (ADR 0071). ----

  interface Landing {
    campaignId: string;
    campaignName: string;
    reportAddress: string;
    template: Template;
  }
  function landingFor(token: string): Landing | null {
    const r = db
      .prepare(
        "SELECT c.id AS cid, c.name AS cname, c.report_address AS report, c.template_id AS tid FROM recipients r JOIN campaigns c ON c.id = r.campaign_id WHERE r.token = ?",
      )
      .get(token) as Row | undefined;
    if (!r) return null;
    const t = findTemplate(r.tid as string);
    if (!t) return null;
    return { campaignId: r.cid as string, campaignName: r.cname as string, reportAddress: r.report as string, template: t };
  }
  const mark = (token: string, column: "opened_at" | "clicked_at" | "submitted_at" | "reported_at"): Landing | null => {
    const landing = landingFor(token);
    if (!landing) return null;
    // Record the first time only; a click also counts as an open.
    if (column === "clicked_at" || column === "submitted_at")
      db.prepare("UPDATE recipients SET opened_at = COALESCE(opened_at, ?) WHERE token = ?").run(iso(), token);
    if (column === "submitted_at") db.prepare("UPDATE recipients SET clicked_at = COALESCE(clicked_at, ?) WHERE token = ?").run(iso(), token);
    db.prepare(`UPDATE recipients SET ${column} = COALESCE(${column}, ?) WHERE token = ?`).run(iso(), token);
    return landing;
  };
  const recordOpen = (token: string) => mark(token, "opened_at");
  const recordClick = (token: string) => {
    const landing = mark(token, "clicked_at");
    if (landing) autoAssignForToken(token);
    return landing;
  };
  /** Records that the simulated form was posted. The caller passes nothing from the body, and this stores nothing
   * from it: only that a submission happened (ADR 0071). */
  const recordSubmit = (token: string) => {
    const landing = mark(token, "submitted_at");
    if (landing) autoAssignForToken(token);
    return landing;
  };
  const recordReport = (token: string) => mark(token, "reported_at");

  function autoAssignForToken(token: string) {
    const r = db.prepare("SELECT person_id FROM recipients WHERE token = ?").get(token) as Row | undefined;
    if (r) assign("spotting-phishing", r.person_id as string, "Clicked a simulation", "auto");
  }

  // ---- Training ----

  const modulesPublic = () =>
    MODULES.map((m) => ({
      id: m.id,
      title: m.title,
      minutes: m.minutes,
      required: m.required,
      body: m.body,
      // The answer index is never sent out; the quiz is graded on the server.
      questions: m.questions.map((q) => ({ prompt: q.prompt, options: q.options })),
    }));

  const assignmentRow = (r: Row): Assignment => ({
    id: r.id as string,
    moduleId: r.module_id as string,
    moduleTitle: (findModule(r.module_id as string)?.title ?? r.module_id) as string,
    personId: r.person_id as string,
    personName: (r.person_name as string) ?? "",
    reason: r.reason as string,
    assignedAt: r.assigned_at as string,
    dueAt: (r.due_at as string) ?? null,
    startedAt: (r.started_at as string) ?? null,
    completedAt: (r.completed_at as string) ?? null,
    score: r.score == null ? null : Number(r.score),
    passed: r.passed == null ? null : Boolean(r.passed),
  });

  const ASSIGN_SELECT = "SELECT a.*, p.name AS person_name FROM assignments a JOIN people p ON p.id = a.person_id";
  function assignments(filter: { personId?: string; moduleId?: string } = {}): Assignment[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.personId) (where.push("a.person_id = ?"), args.push(filter.personId));
    if (filter.moduleId) (where.push("a.module_id = ?"), args.push(filter.moduleId));
    const sql = `${ASSIGN_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY a.assigned_at DESC`;
    return (db.prepare(sql).all(...args) as Row[]).map(assignmentRow);
  }

  /** Assigns a module to a person once; a repeat is ignored. The due date is 14 days out for a required module. */
  function assign(moduleId: string, personId: string, reason: string, actor: string): Assignment | null {
    const m = findModule(moduleId);
    if (!m) throw bad("No such module.");
    if (!db.prepare("SELECT 1 FROM people WHERE id = ?").get(personId)) throw notFound("person");
    const existing = db.prepare("SELECT id FROM assignments WHERE module_id = ? AND person_id = ?").get(moduleId, personId) as Row | undefined;
    if (existing) return assignmentOne(existing.id as string);
    const id = randomUUID();
    const due = m.required ? new Date(now() + 14 * 86_400_000).toISOString() : null;
    db.prepare("INSERT INTO assignments (id, module_id, person_id, token, reason, assigned_at, due_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      id,
      moduleId,
      personId,
      randomBytes(18).toString("hex"),
      reason,
      iso(),
      due,
    );
    if (actor !== "auto") audit(actor, "training-assigned", `${moduleId} to ${personId}`, reason);
    return assignmentOne(id);
  }
  const assignmentOne = (id: string): Assignment => {
    const r = db.prepare(`${ASSIGN_SELECT} WHERE a.id = ?`).get(id) as Row | undefined;
    if (!r) throw notFound("assignment");
    return assignmentRow(r);
  };

  interface TrainingPage {
    assignmentId: string;
    module: Module;
    personName: string;
    completedAt: string | null;
    score: number | null;
  }
  function trainingByToken(token: string): TrainingPage | null {
    const r = db.prepare(`${ASSIGN_SELECT} WHERE a.token = ?`).get(token) as Row | undefined;
    if (!r) return null;
    const m = findModule(r.module_id as string);
    if (!m) return null;
    db.prepare("UPDATE assignments SET started_at = COALESCE(started_at, ?) WHERE id = ?").run(iso(), r.id as string);
    return {
      assignmentId: r.id as string,
      module: m,
      personName: r.person_name as string,
      completedAt: (r.completed_at as string) ?? null,
      score: r.score == null ? null : Number(r.score),
    };
  }
  /** Grades the quiz from the chosen option indexes and records completion. No free text is read. */
  function completeTraining(token: string, answers: number[]): { score: number; passed: boolean } | null {
    const r = db.prepare("SELECT id, module_id FROM assignments WHERE token = ?").get(token) as Row | undefined;
    if (!r) return null;
    const m = findModule(r.module_id as string);
    if (!m) return null;
    const result = grade(m, Array.isArray(answers) ? answers.map((a) => Number(a)) : []);
    db.prepare("UPDATE assignments SET completed_at = ?, score = ?, passed = ?, started_at = COALESCE(started_at, ?) WHERE id = ?").run(
      iso(),
      result.score,
      result.passed ? 1 : 0,
      iso(),
      r.id as string,
    );
    return result;
  }

  // ---- Risk ----

  interface PersonRisk {
    id: string;
    name: string;
    department: string | null;
    campaigns: number;
    clicked: number;
    submitted: number;
    reported: number;
    trainingDue: number;
    trainingDone: number;
    risk: number;
  }
  function personRisk(p: Person): PersonRisk {
    const r = db
      .prepare(
        "SELECT COUNT(*) AS campaigns, COUNT(clicked_at) AS clicked, COUNT(submitted_at) AS submitted, COUNT(reported_at) AS reported FROM recipients WHERE person_id = ?",
      )
      .get(p.id) as Row;
    const tr = db.prepare("SELECT COUNT(*) AS due, COUNT(completed_at) AS done FROM assignments WHERE person_id = ?").get(p.id) as Row;
    const clicked = Number(r.clicked);
    const submitted = Number(r.submitted);
    const reported = Number(r.reported);
    const campaignsSeen = Number(r.campaigns);
    const due = Number(tr.due);
    const done = Number(tr.done);
    // A simple, legible score: credential-style submissions weigh most, clicks next, reporting pulls it down, and
    // training not finished keeps it up. Clamped to 0..100 (ADR 0071).
    let risk = submitted * 30 + (clicked - submitted) * 15 - reported * 10 + (due - done) * 10;
    if (campaignsSeen === 0 && due === 0) risk = 0;
    return {
      id: p.id,
      name: p.name,
      department: p.department,
      campaigns: campaignsSeen,
      clicked,
      submitted,
      reported,
      trainingDue: due,
      trainingDone: done,
      risk: Math.max(0, Math.min(100, risk)),
    };
  }
  function risk() {
    const everyone = people().map(personRisk);
    const byDept = new Map<string, PersonRisk[]>();
    for (const p of everyone) {
      const key = p.department ?? "No team";
      (byDept.get(key) ?? byDept.set(key, []).get(key)!).push(p);
    }
    const groups = [...byDept.entries()]
      .map(([department, members]) => ({
        department,
        people: members.length,
        risk: Math.round(members.reduce((s, m) => s + m.risk, 0) / members.length),
        clicked: members.reduce((s, m) => s + m.clicked, 0),
        reported: members.reduce((s, m) => s + m.reported, 0),
      }))
      .sort((a, b) => b.risk - a.risk);
    // Over time: the click and report rate of each campaign, oldest first.
    const timeline = (db.prepare("SELECT id, name, created_at FROM campaigns ORDER BY created_at ASC").all() as Row[]).map((c) => {
      const s = statsOf(c.id as string);
      const pct = (n: number) => (s.recipients ? Math.round((n / s.recipients) * 1000) / 10 : 0);
      return { id: c.id as string, name: c.name as string, at: c.created_at as string, clickRate: pct(s.clicked), reportRate: pct(s.reported) };
    });
    return { groups, people: everyone.sort((a, b) => b.risk - a.risk), timeline };
  }

  // ---- Settings: the SMTP relay and the Identity connection, both sealed (ADR 0021) ----

  const getSetting = (key: string): Row | null => {
    const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as Row | undefined;
    return r ? (JSON.parse(r.value as string) as Row) : null;
  };
  const putSetting = (key: string, value: Row, actor: string) => {
    db.prepare(
      "INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
    ).run(key, JSON.stringify(value), iso(), actor);
  };

  function setSmtp(body: Row, actor: string): void {
    const host = str(body.host, "The SMTP host");
    const port = Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw bad("The SMTP port must be 1 to 65535.");
    const security = body.security ?? "starttls";
    if (security !== "none" && security !== "starttls" && security !== "tls") throw bad("security must be none, starttls or tls.");
    const username = body.username == null || body.username === "" ? null : str(body.username, "The username");
    const password = body.password == null || body.password === "" ? null : String(body.password);
    putSetting(
      "smtp",
      { host, port, security, username, password: password === null ? null : opts.sealer.seal(password), insecureTls: Boolean(body.insecureTls) },
      actor,
    );
    audit(actor, "smtp-set", host, `port ${port}, ${security}`);
  }
  function smtpStatus() {
    const s = getSetting("smtp");
    if (!s) return null;
    return {
      host: s.host as string,
      port: Number(s.port),
      security: s.security as string,
      username: (s.username as string) ?? null,
      hasPassword: Boolean(s.password),
    };
  }
  function mailerFromSettings(): Mailer {
    const s = getSetting("smtp");
    if (!s) throw new AwarenessError(400, "invalid-body", "No SMTP relay is set. Set one under Settings before a campaign.");
    return makeMailer({
      host: s.host as string,
      port: Number(s.port),
      security: s.security as SmtpConfig["security"],
      username: (s.username as string) ?? undefined,
      password: s.password ? opts.sealer.open(s.password as string) : undefined,
      insecureTls: Boolean(s.insecureTls),
    });
  }

  function setIdentity(body: Row, actor: string): void {
    const url = str(body.url, "The Identity URL").replace(/\/$/, "");
    if (!/^https?:\/\//.test(url)) throw bad("The Identity URL must be http(s).");
    const token = str(body.token, "A viewer token");
    putSetting("identity", { url, token: opts.sealer.seal(token) }, actor);
    audit(actor, "identity-set", url);
  }
  function identityStatus() {
    const s = getSetting("identity");
    return s ? { url: s.url as string, connected: true } : null;
  }
  function identityConn(): { url: string; token: string } | null {
    const s = getSetting("identity");
    return s ? { url: s.url as string, token: opts.sealer.open(s.token as string) } : null;
  }

  // ---- Summary and metrics ----

  function summary() {
    const d = db.prepare("SELECT state, COUNT(*) AS n FROM domains GROUP BY state").all() as Row[];
    const domainCounts = { verified: 0, pending: 0, lost: 0 };
    for (const r of d) domainCounts[r.state as keyof typeof domainCounts] = Number(r.n);
    const peopleCount = Number((db.prepare("SELECT COUNT(*) AS n FROM people WHERE active = 1").get() as Row).n);
    const last = db.prepare("SELECT * FROM campaigns ORDER BY created_at DESC LIMIT 1").get() as Row | undefined;
    const training = trainingSummary();
    return {
      domains: domainCounts,
      people: peopleCount,
      campaigns: Number((db.prepare("SELECT COUNT(*) AS n FROM campaigns").get() as Row).n),
      lastCampaign: last ? campaignRow(last) : null,
      training,
      smtp: smtpStatus() !== null,
      identity: identityStatus(),
    };
  }
  function trainingSummary() {
    const r = db
      .prepare(
        "SELECT COUNT(*) AS assigned, COUNT(completed_at) AS completed, COUNT(CASE WHEN completed_at IS NULL AND due_at < ? THEN 1 END) AS overdue FROM assignments",
      )
      .get(iso()) as Row;
    const assigned = Number(r.assigned);
    const completed = Number(r.completed);
    return { assigned, completed, overdue: Number(r.overdue), completionPct: assigned ? Math.round((completed / assigned) * 100) : 100 };
  }

  function auditEntries(): Array<{ id: number; at: string; actor: string; action: string; target: string; detail: string }> {
    return (db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 1000").all() as Row[]).map((r) => ({
      id: Number(r.id),
      at: r.at as string,
      actor: r.actor as string,
      action: r.action as string,
      target: r.target as string,
      detail: r.detail as string,
    }));
  }

  return {
    domains,
    domain,
    createDomain,
    verifyDomain,
    deleteDomain,
    recheckDomains,
    people,
    person,
    importCsv,
    syncIdentity,
    templates,
    campaigns,
    campaign,
    createCampaign,
    idle,
    recordOpen,
    recordClick,
    recordSubmit,
    recordReport,
    landingFor,
    modulesPublic,
    assignments,
    assign,
    trainingByToken,
    completeTraining,
    trainingSummary,
    risk,
    setSmtp,
    smtpStatus,
    setIdentity,
    identityStatus,
    summary,
    audit: auditEntries,
  };
}

export type Awareness = ReturnType<typeof createAwareness>;

/** A small CSV reader: commas, double-quoted fields with "" for a quote, and CRLF or LF rows. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const t = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (quoted) {
      if (ch === '"') {
        if (t[i + 1] === '"') ((field += '"'), i++);
        else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") (row.push(field), (field = ""));
    else if (ch === "\n") (row.push(field), rows.push(row), (row = []), (field = ""));
    else field += ch;
  }
  if (field !== "" || row.length) (row.push(field), rows.push(row));
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}
