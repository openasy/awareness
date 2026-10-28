// Writes openapi.json (ADR 0014, 0024). Run `node scripts/openapi.ts` after changing the API; a test fails when the
// file is out of date. Sign-in routes come from @openasy/auth and are merged in when the description is served.
import { writeFileSync } from "node:fs";

type S = Record<string, unknown>;
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const str = { type: "string" };
const int = { type: "integer" };
const num = { type: "number" };
const bool = { type: "boolean" };
const dt = { type: "string", format: "date-time" };
const nul = (s: S) => ({ anyOf: [s, { type: "null" }] });
const arr = (s: S) => ({ type: "array", items: s });
const obj = (properties: Record<string, S>, required = Object.keys(properties)) => ({ type: "object", required, properties });

const problem = { $ref: "#/components/responses/Problem" };
const ok = (schema: S, description = "OK") => ({ description, content: { "application/json": { schema } } });
const VIEWER = [{ session: [] }, { apiToken: [] }, { adminToken: [] }];
const id = (what: string) => [{ name: "id", in: "path", required: true, description: `The ${what}'s id.`, schema: str }];

/** An operation that needs a role (ADR 0003), with the refusals every such operation can answer. */
function op(role: "viewer" | "editor" | "admin", o: S & { responses: Record<string, unknown> }) {
  return {
    ...o,
    security: VIEWER,
    "x-openasy-role": role,
    description: [`Needs the ${role} role.`, o.description].filter(Boolean).join(" "),
    responses: { ...o.responses, "401": problem, "403": problem, "503": problem },
  };
}

const CampaignStats = obj({ recipients: int, sent: int, failed: int, opened: int, clicked: int, submitted: int, reported: int });

const schemas: Record<string, S> = {
  Problem: obj(
    {
      type: { type: "string", format: "uri" },
      title: str,
      status: int,
      code: {
        type: "string",
        enum: [
          "invalid-json",
          "invalid-body",
          "conflict",
          "not-found",
          "internal-error",
          "unauthenticated",
          "invalid-credentials",
          "mfa-required",
          "mfa-setup-required",
          "forbidden",
          "cross-site",
          "rate-limited",
        ],
        description: "Stable; match on this.",
      },
      detail: str,
    },
    ["type", "title", "status", "code"],
  ),
  Status: obj({ status: str }),
  Version: obj({ product: { const: "awareness" }, version: str }),
  ProductLink: obj({
    id: { type: "string", description: "The product, as OpenAsy names it.", examples: ["identity"] },
    url: { type: "string", format: "uri", description: "The address people open it at.", examples: ["https://identity.example.com"] },
  }),
  ProductList: obj({ products: arr(ref("ProductLink")) }),
  Domain: obj({
    id: str,
    name: { type: "string", examples: ["example.com"] },
    state: {
      type: "string",
      enum: ["pending", "verified", "lost"],
      description:
        "A recipient is only ever mailed when its address is in a verified domain. lost: it was verified, and its record was gone at the last check.",
    },
    proof: {
      ...obj({ name: { type: "string", examples: ["_openasy-awareness.example.com"] }, type: { const: "TXT" }, value: str }),
      description: "The TXT record the domain's owner publishes to prove it.",
    },
    createdAt: dt,
    createdBy: str,
    verifiedAt: nul(dt),
    checkedAt: nul(dt),
    error: nul({ type: "string", description: "Why the last check did not find the record." }),
    people: { type: "integer", description: "People whose email is in this domain." },
  }),
  DomainList: obj({ domains: arr(ref("Domain")) }),
  NewDomain: obj({ name: { type: "string", examples: ["example.com"] } }),
  Person: obj({
    id: str,
    email: str,
    name: str,
    department: nul(str),
    source: { type: "string", enum: ["identity", "csv"], description: "Where the person came from: the Identity directory or a CSV import." },
    active: bool,
    createdAt: dt,
    updatedAt: dt,
  }),
  PersonList: obj({ people: arr(ref("Person")) }),
  ImportResult: obj({
    added: int,
    updated: int,
    rejected: { type: "integer", description: "Addresses left out because they are not in a verified domain." },
    rejectedEmails: arr(str),
  }),
  Template: obj({
    id: str,
    name: str,
    category: { type: "string", enum: ["document", "it", "delivery", "hr"] },
    displayFrom: { type: "string", description: "The fictional sender shown in the mail, always under example-corp.test. Never a real brand (ADR 0071)." },
    subject: str,
    tell: { type: "string", description: "The tell a real version of this lure would show, taught on the landing page." },
    lines: arr(str),
    action: str,
  }),
  TemplateList: obj({ templates: arr(ref("Template")) }),
  Question: obj({ prompt: str, options: arr(str) }),
  Module: obj({ id: str, title: str, minutes: int, required: bool, body: arr(str), questions: arr(ref("Question")) }),
  ModuleList: obj({ modules: arr(ref("Module")) }),
  CampaignStats,
  Campaign: obj({
    id: str,
    name: str,
    templateId: str,
    fromName: str,
    fromEmail: str,
    subject: str,
    reportAddress: { type: "string", description: "Where a recipient reports the mail. A reported mail counts for the campaign (ADR 0071)." },
    department: nul(str),
    state: { type: "string", enum: ["draft", "sending", "sent", "failed"] },
    createdAt: dt,
    createdBy: { type: "string", description: "The admin or editor who created it; every campaign names one (ADR 0071)." },
    sentAt: nul(dt),
    error: nul(str),
    stats: ref("CampaignStats"),
  }),
  CampaignList: obj({ campaigns: arr(ref("Campaign")) }),
  NewCampaign: obj(
    {
      name: str,
      templateId: { type: "string", description: "A built-in template id, from GET /api/v1/templates." },
      fromEmail: { type: "string", description: "The from address. Must be in a verified domain." },
      reportAddress: str,
      fromName: str,
      subject: str,
      department: { type: "string", description: "Only people in this department; omit for everyone." },
    },
    ["name", "templateId", "fromEmail", "reportAddress"],
  ),
  Assignment: obj({
    id: str,
    moduleId: str,
    moduleTitle: str,
    personId: str,
    personName: str,
    reason: str,
    assignedAt: dt,
    dueAt: nul(dt),
    startedAt: nul(dt),
    completedAt: nul(dt),
    score: nul(int),
    passed: nul(bool),
  }),
  AssignmentList: obj({ assignments: arr(ref("Assignment")) }),
  NewAssignment: obj({ moduleId: str, personId: str, reason: str }, ["moduleId", "personId"]),
  RiskPerson: obj({
    id: str,
    name: str,
    department: nul(str),
    campaigns: int,
    clicked: int,
    submitted: int,
    reported: int,
    trainingDue: int,
    trainingDone: int,
    risk: { type: "integer", description: "0 to 100: submissions weigh most, clicks next, reporting lowers it, unfinished training keeps it up." },
  }),
  RiskGroup: obj({ department: str, people: int, risk: int, clicked: int, reported: int }),
  RiskPoint: obj({ id: str, name: str, at: dt, clickRate: num, reportRate: num }),
  Risk: obj({ groups: arr(ref("RiskGroup")), people: arr(ref("RiskPerson")), timeline: arr(ref("RiskPoint")) }),
  TrainingSummary: obj({ assigned: int, completed: int, overdue: int, completionPct: int }),
  SmtpStatus: obj({ host: str, port: int, security: str, username: nul(str), hasPassword: bool }),
  IdentityStatus: obj({ url: str, connected: bool }),
  Summary: obj({
    domains: obj({ verified: int, pending: int, lost: int }),
    people: int,
    campaigns: int,
    lastCampaign: nul(ref("Campaign")),
    training: ref("TrainingSummary"),
    smtp: { type: "boolean", description: "Whether an SMTP relay is set." },
    identity: nul(ref("IdentityStatus")),
  }),
  Settings: obj({ smtp: nul(ref("SmtpStatus")), identity: nul(ref("IdentityStatus")) }),
  SmtpSettings: obj(
    {
      host: str,
      port: int,
      security: { type: "string", enum: ["none", "starttls", "tls"] },
      username: str,
      password: { type: "string", description: "Sealed with the install's key (ADR 0021); never sent back." },
      insecureTls: { type: "boolean", description: "For a test relay with a self-signed certificate only." },
    },
    ["host", "port"],
  ),
  IdentitySettings: obj(
    {
      url: { type: "string", description: "The Identity base URL." },
      token: { type: "string", description: "A viewer token; sealed with the install's key." },
    },
    ["url", "token"],
  ),
  AuditEntry: obj({ id: int, at: dt, actor: str, action: str, target: str, detail: str }),
  AuditList: obj({ entries: arr(ref("AuditEntry")) }),
};

const spec = {
  openapi: "3.1.1",
  info: {
    title: "OpenAsy Awareness API",
    version: "0.1.0",
    summary: "Run phishing simulations for your own people, train whoever clicks, and keep the training records ISO 27001 and SOC 2 ask for.",
    description:
      "Every screen of Awareness uses this API, and so can your scripts (ADR 0014). Within `/api/v1` changes are additive only; anything removed is deprecated first (ADR 0024). Errors use Problem Details (RFC 9457).\n\nEvery operation takes the session of a signed-in person or an API token, and names the role it needs (`x-openasy-role`: viewer, editor, admin; ADR 0003). A recipient is only ever mailed when its address is in a domain proven by a TXT record, and the simulated landing page captures nothing a person types (ADR 0071).\n\nThe pages a recipient sees (`/l/...`, `/r/...`, `/t/...`) are not part of this API; they take an opaque per-recipient token, not a sign-in.\n\nSign-in, members and API tokens are under `/api/v1/auth`, provided by [@openasy/auth](https://github.com/openasy/auth#routes).",
    license: { name: "AGPL-3.0-only", identifier: "AGPL-3.0-only" },
  },
  servers: [{ url: "/", description: "This Awareness" }],
  tags: [
    { name: "Directory", description: "The organisation's own people and the domains it has proven; the gate on who can be reached." },
    { name: "Campaigns", description: "Phishing simulations, their templates, and what each recipient did." },
    { name: "Training", description: "Modules assigned to people, their completion, and the risk view over time." },
    { name: "Product", description: "Version, overview, settings and audit log of this Awareness." },
  ],
  paths: {
    "/api/v1/domains": {
      get: op("viewer", { operationId: "listDomains", tags: ["Directory"], summary: "Domains", responses: { "200": ok(ref("DomainList")) } }),
      post: op("editor", {
        operationId: "createDomain",
        tags: ["Directory"],
        summary: "Add a domain",
        description: "It is pending until its TXT record is found; no address under it can be mailed before.",
        requestBody: { required: true, content: { "application/json": { schema: ref("NewDomain") } } },
        responses: { "201": ok(ref("Domain"), "Added, with the record to publish."), "400": problem, "409": problem },
      }),
    },
    "/api/v1/domains/{id}": {
      get: op("viewer", {
        operationId: "getDomain",
        tags: ["Directory"],
        summary: "A domain",
        parameters: id("domain"),
        responses: { "200": ok(ref("Domain")), "404": problem },
      }),
      delete: op("admin", {
        operationId: "deleteDomain",
        tags: ["Directory"],
        summary: "Delete a domain",
        parameters: id("domain"),
        responses: { "204": { description: "Deleted." }, "404": problem },
      }),
    },
    "/api/v1/domains/{id}/verify": {
      post: op("editor", {
        operationId: "verifyDomain",
        tags: ["Directory"],
        summary: "Look for the TXT record now",
        description: "The schedule looks again too, and marks a domain lost when its record has gone.",
        parameters: id("domain"),
        responses: { "200": ok(ref("Domain"), "The domain, verified or with why not."), "404": problem },
      }),
    },
    "/api/v1/people": {
      get: op("viewer", {
        operationId: "listPeople",
        tags: ["Directory"],
        summary: "People",
        parameters: [{ name: "department", in: "query", description: "Only people in this department.", schema: str }],
        responses: { "200": ok(ref("PersonList")) },
      }),
    },
    "/api/v1/people/{id}": {
      get: op("viewer", {
        operationId: "getPerson",
        tags: ["Directory"],
        summary: "A person",
        parameters: id("person"),
        responses: { "200": ok(ref("Person")), "404": problem },
      }),
    },
    "/api/v1/people/import": {
      post: op("editor", {
        operationId: "importPeople",
        tags: ["Directory"],
        summary: "Import people from CSV",
        description: "A CSV with an email column, and optional name and department columns. Addresses outside the verified domains are left out.",
        requestBody: { required: true, content: { "text/csv": { schema: str } } },
        responses: { "200": ok(ref("ImportResult")), "400": problem },
      }),
    },
    "/api/v1/people/sync": {
      post: op("admin", {
        operationId: "syncIdentity",
        tags: ["Directory"],
        summary: "Sync people from Identity",
        description: "Reads the Identity directory with the sealed viewer token set under Settings, and upserts everyone in a verified domain.",
        responses: { "200": ok(ref("ImportResult")), "400": problem, "502": problem },
      }),
    },
    "/api/v1/templates": {
      get: op("viewer", {
        operationId: "listTemplates",
        tags: ["Campaigns"],
        summary: "Built-in simulation templates",
        description: "Obvious training drills with a visible banner and a fictional sender; none impersonates a real brand (ADR 0071).",
        responses: { "200": ok(ref("TemplateList")) },
      }),
    },
    "/api/v1/campaigns": {
      get: op("viewer", { operationId: "listCampaigns", tags: ["Campaigns"], summary: "Campaigns", responses: { "200": ok(ref("CampaignList")) } }),
      post: op("editor", {
        operationId: "createCampaign",
        tags: ["Campaigns"],
        summary: "Create and send a campaign",
        description:
          "Builds a recipient for every eligible person and sends through the relay in the background. The from address must be in a verified domain.",
        requestBody: { required: true, content: { "application/json": { schema: ref("NewCampaign") } } },
        responses: { "202": ok(ref("Campaign"), "Created; the mail is sent in the background."), "400": problem },
      }),
    },
    "/api/v1/campaigns/{id}": {
      get: op("viewer", {
        operationId: "getCampaign",
        tags: ["Campaigns"],
        summary: "A campaign",
        parameters: id("campaign"),
        responses: { "200": ok(ref("Campaign")), "404": problem },
      }),
    },
    "/api/v1/modules": {
      get: op("viewer", {
        operationId: "listModules",
        tags: ["Training"],
        summary: "Built-in training modules",
        description: "The page and quiz questions, without the answers; the quiz is graded on the server.",
        responses: { "200": ok(ref("ModuleList")) },
      }),
    },
    "/api/v1/training": {
      get: op("viewer", {
        operationId: "listAssignments",
        tags: ["Training"],
        summary: "Training assignments",
        parameters: [
          { name: "person", in: "query", description: "Only this person's assignments.", schema: str },
          { name: "module", in: "query", description: "Only this module's assignments.", schema: str },
        ],
        responses: { "200": ok(ref("AssignmentList")) },
      }),
      post: op("editor", {
        operationId: "assignTraining",
        tags: ["Training"],
        summary: "Assign a module to a person",
        description: "A required module is due in 14 days. Assigning the same module to the same person again keeps the first.",
        requestBody: { required: true, content: { "application/json": { schema: ref("NewAssignment") } } },
        responses: { "201": ok(ref("Assignment")), "400": problem, "404": problem },
      }),
    },
    "/api/v1/risk": {
      get: op("viewer", {
        operationId: "getRisk",
        tags: ["Training"],
        summary: "Risk per person and per group, over time",
        responses: { "200": ok(ref("Risk")) },
      }),
    },
    "/api/v1/settings": {
      get: op("admin", {
        operationId: "getSettings",
        tags: ["Product"],
        summary: "The SMTP relay and Identity connection",
        description: "Without the secrets: whether a password is set, and the Identity URL.",
        responses: { "200": ok(ref("Settings")) },
      }),
    },
    "/api/v1/settings/smtp": {
      put: op("admin", {
        operationId: "setSmtp",
        tags: ["Product"],
        summary: "Set the SMTP relay",
        description: "The password is sealed with the install's key (ADR 0021). Awareness sends no mail any other way.",
        requestBody: { required: true, content: { "application/json": { schema: ref("SmtpSettings") } } },
        responses: { "204": { description: "Saved." }, "400": problem },
      }),
    },
    "/api/v1/settings/identity": {
      put: op("admin", {
        operationId: "setIdentity",
        tags: ["Product"],
        summary: "Connect the Identity directory",
        description: "The viewer token is sealed with the install's key (ADR 0021).",
        requestBody: { required: true, content: { "application/json": { schema: ref("IdentitySettings") } } },
        responses: { "204": { description: "Saved." }, "400": problem },
      }),
    },
    "/api/v1/audit": {
      get: op("admin", {
        operationId: "listAudit",
        tags: ["Product"],
        summary: "Audit log",
        description: "Campaigns, domain changes, directory syncs and setting changes, the newest 1000. Append-only.",
        responses: { "200": ok(ref("AuditList")) },
      }),
    },
    "/api/v1/summary": {
      get: op("viewer", {
        operationId: "getSummary",
        tags: ["Product"],
        summary: "Overview",
        description: "Counts for the first screen.",
        responses: { "200": ok(ref("Summary")) },
      }),
    },
    "/api/v1/products": {
      get: op("viewer", {
        operationId: "listProducts",
        tags: ["Product"],
        summary: "Other products of this install",
        responses: { "200": ok(ref("ProductList"), "From OPENASY_PRODUCTS, for the product switcher.") },
      }),
    },
    "/api/v1/version": {
      get: { operationId: "getVersion", tags: ["Product"], summary: "Version", security: [], responses: { "200": ok(ref("Version"), "The running version.") } },
    },
    "/healthz": {
      get: {
        operationId: "liveness",
        tags: ["Product"],
        summary: "Liveness",
        security: [],
        responses: { "200": ok(ref("Status"), "The process is running.") },
      },
    },
    "/readyz": {
      get: {
        operationId: "readiness",
        tags: ["Product"],
        summary: "Readiness",
        description: "Ready while its SQLite file answers.",
        security: [],
        responses: { "200": ok(ref("Status"), "Ready to serve."), "503": ok(ref("Status"), "The database is unavailable.") },
      },
    },
    "/metrics": {
      get: {
        operationId: "metrics",
        tags: ["Product"],
        summary: "Prometheus metrics",
        description: "Training completion and the last campaign's numbers, for Compliance (ADR 0058).",
        security: [],
        responses: { "200": { description: "Metrics in the Prometheus text format.", content: { "text/plain": { schema: str } } } },
      },
    },
  },
  components: {
    securitySchemes: {
      session: {
        type: "apiKey",
        in: "cookie",
        name: "__Host-openasy-session",
        description:
          "The browser session after signing in (`openasy-session` when Awareness runs on plain http://localhost). Requests that change something must come from the Awareness origin.",
      },
      apiToken: {
        type: "http",
        scheme: "bearer",
        description: "An API token created under Settings → API tokens (`oa_awareness_...`): one role, always an expiry (ADR 0003).",
      },
      adminToken: {
        type: "http",
        scheme: "bearer",
        description:
          "Only when Awareness is started by its tests or a local script: one shared token with the admin role. A production install does not have it.",
      },
    },
    responses: { Problem: { description: "An error, as RFC 9457 Problem Details.", content: { "application/problem+json": { schema: ref("Problem") } } } },
    schemas,
  },
};

export const OPENAPI = spec;
if (import.meta.url === `file://${process.argv[1]}`) writeFileSync(new URL("../openapi.json", import.meta.url), JSON.stringify(spec, null, 2) + "\n");
