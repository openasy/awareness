import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { AuthError, identityOrigin, mergeOpenApi, sendProblem, type Auth, type Role } from "@openasy/auth";
import { AwarenessError, type Awareness, type ProblemCode } from "./awareness.ts";
import { PIXEL, renderDebrief, renderLanding, renderNotFound, renderReported, renderTraining, renderTrainingResult } from "./landing.ts";
import { log } from "./log.ts";
import { countRequest, renderMetrics } from "./metrics.ts";
import type { ProductLink } from "./products.ts";

export interface AppOptions {
  db: DatabaseSync;
  awareness: Awareness;
  version: string;
  /** Sign-in, sessions, members and API tokens (ADR 0002, 0003). */
  auth: Auth;
  /** For tests and local scripts: one shared token with the admin role. main.ts never sets it. */
  adminToken?: string;
  /** Built web UI; omit to run headless (ADR 0018). */
  webDir?: string;
  /** Built API reference (Swagger UI), served at /api/docs. */
  docsDir?: string;
  /** The OpenAPI description, served at /api/openapi.json with this release's version. */
  openapi?: Record<string, unknown>;
  /** false when /metrics is served on its own port instead (ADR 0026). */
  serveMetrics?: boolean;
  /** The install's OpenAsy products and their addresses, from OPENASY_PRODUCTS, for the product switcher. */
  products?: ProductLink[];
}

function metricsText(awareness: Awareness, version: string) {
  return renderMetrics(version, awareness.summary());
}

/** Serves only /metrics, for a port that is not exposed with the rest (AWARENESS_METRICS_PORT). */
export function createMetricsHandler(awareness: Awareness, version: string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/metrics") return problem(res, 404, "not-found");
    send(res, 200, metricsText(awareness, version), "text/plain; version=0.0.4");
  };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Identity keeps people's theme and language when they sign in through it; the pages read them there (ADR 0033).
const IDENTITY = identityOrigin(process.env);

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": `default-src 'self'; connect-src 'self'${IDENTITY ? ` ${IDENTITY}` : ""}; img-src 'self' data:; style-src 'self' 'unsafe-inline'`,
};

function send(res: ServerResponse, status: number, body: string | Buffer, type = "application/json", headers: Record<string, string> = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers, "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const json = (res: ServerResponse, status: number, data: unknown, headers?: Record<string, string>) =>
  send(res, status, JSON.stringify(data), "application/json", headers);

const TITLES: Record<ProblemCode, string> = {
  "invalid-json": "Invalid JSON",
  "invalid-body": "Invalid request body",
  "not-found": "Not found",
  conflict: "Conflict",
  "internal-error": "Internal error",
};

/** RFC 9457 Problem Details (ADR 0024). `code` is the stable part clients match on. */
function problem(res: ServerResponse, status: number, code: ProblemCode, detail?: string) {
  const body = { type: `https://openasy.github.io/problems/${code}`, title: TITLES[code], status, code, ...(detail && { detail }) };
  send(res, status, JSON.stringify(body), "application/problem+json");
}

/** Serves a file from dir, or returns false when the path is outside it or missing. */
async function serveFile(res: ServerResponse, dir: string, relative: string): Promise<boolean> {
  const file = normalize(join(dir, relative));
  if (!file.startsWith(normalize(dir)) || !extname(file)) return false;
  try {
    send(res, 200, await readFile(file), TYPES[extname(file)] ?? "application/octet-stream");
    return true;
  } catch {
    return false;
  }
}

/** A JSON object body of at most limit bytes. */
async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new AwarenessError(400, "invalid-json", `The body must be JSON, at most ${Math.round(limit / 1024)} KiB.`);
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    return body as Record<string, unknown>;
  } catch {
    throw new AwarenessError(400, "invalid-json", "The body must be a JSON object.");
  }
}

/** Reads a raw text body (a CSV import), at most limit bytes. */
async function readText(req: IncomingMessage, limit = 4 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new AwarenessError(400, "invalid-body", `The body is at most ${Math.round(limit / 1024 / 1024)} MiB.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Reads and drains a body without keeping it, for the simulated form: nothing a person typed is ever read (ADR 0071). */
function discardBody(req: IncomingMessage) {
  if (!req.complete) req.resume();
}

function tokenMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

type Access = "none" | Role;
interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  body: () => Promise<Record<string, unknown>>;
  text: () => Promise<string>;
  /** Who made the request, for the audit log. */
  actor: () => string;
}
interface Route {
  method: string;
  /** Path pattern; each `:name` matches one segment. */
  path: string;
  auth: Access;
  handle: (ctx: Ctx) => unknown;
}

export function createApp({ db, awareness, version, auth, adminToken, webDir, docsDir, openapi, serveMetrics = true, products = [] }: AppOptions) {
  const spec = openapi && JSON.stringify({ ...mergeOpenApi(openapi), info: { ...(openapi.info as object), version } });
  const noContent = (res: ServerResponse) => {
    res.writeHead(204, SECURITY_HEADERS).end();
  };

  const routes: Route[] = [
    { method: "GET", path: "/api/v1/version", auth: "none", handle: () => ({ product: "awareness", version }) },
    { method: "GET", path: "/api/v1/products", auth: "viewer", handle: () => ({ products }) },
    { method: "GET", path: "/api/v1/summary", auth: "viewer", handle: () => awareness.summary() },

    // Verified domains: a recipient is only ever mailed when its address is in one (ADR 0071).
    { method: "GET", path: "/api/v1/domains", auth: "viewer", handle: () => ({ domains: awareness.domains() }) },
    {
      method: "POST",
      path: "/api/v1/domains",
      auth: "editor",
      handle: async ({ res, body, actor }) => json(res, 201, awareness.createDomain(await body(), actor())),
    },
    { method: "GET", path: "/api/v1/domains/:id", auth: "viewer", handle: ({ params }) => awareness.domain(params[0]!) },
    { method: "POST", path: "/api/v1/domains/:id/verify", auth: "editor", handle: ({ params, actor }) => awareness.verifyDomain(params[0]!, actor()) },
    {
      method: "DELETE",
      path: "/api/v1/domains/:id",
      auth: "admin",
      handle: ({ res, params, actor }) => (awareness.deleteDomain(params[0]!, actor()), noContent(res)),
    },

    // People: synced from Identity or imported from CSV, kept to verified domains.
    {
      method: "GET",
      path: "/api/v1/people",
      auth: "viewer",
      handle: ({ url }) => ({ people: awareness.people({ department: url.searchParams.get("department") }) }),
    },
    { method: "GET", path: "/api/v1/people/:id", auth: "viewer", handle: ({ params }) => awareness.person(params[0]!) },
    {
      method: "POST",
      path: "/api/v1/people/import",
      auth: "editor",
      handle: async ({ res, text, actor }) => json(res, 200, awareness.importCsv(await text(), actor())),
    },
    { method: "POST", path: "/api/v1/people/sync", auth: "admin", handle: async ({ actor }) => awareness.syncIdentity(actor()) },

    // Templates and training modules are built in and read-only.
    { method: "GET", path: "/api/v1/templates", auth: "viewer", handle: () => ({ templates: awareness.templates() }) },
    { method: "GET", path: "/api/v1/modules", auth: "viewer", handle: () => ({ modules: awareness.modulesPublic() }) },

    // Campaigns: create and send through the relay in one step; the response comes back before the mail is sent.
    { method: "GET", path: "/api/v1/campaigns", auth: "viewer", handle: () => ({ campaigns: awareness.campaigns() }) },
    {
      method: "POST",
      path: "/api/v1/campaigns",
      auth: "editor",
      handle: async ({ res, body, actor }) => json(res, 202, awareness.createCampaign(await body(), actor()).campaign),
    },
    { method: "GET", path: "/api/v1/campaigns/:id", auth: "viewer", handle: ({ params }) => awareness.campaign(params[0]!) },

    // Training assignments and the per-person, per-group risk view.
    {
      method: "GET",
      path: "/api/v1/training",
      auth: "viewer",
      handle: ({ url }) => ({
        assignments: awareness.assignments({ personId: url.searchParams.get("person") ?? undefined, moduleId: url.searchParams.get("module") ?? undefined }),
      }),
    },
    {
      method: "POST",
      path: "/api/v1/training",
      auth: "editor",
      handle: async ({ res, body, actor }) => {
        const b = await body();
        const a = awareness.assign(
          String(b.moduleId ?? ""),
          String(b.personId ?? ""),
          typeof b.reason === "string" && b.reason ? b.reason : "Assigned by an editor",
          actor(),
        );
        return json(res, 201, a);
      },
    },
    { method: "GET", path: "/api/v1/risk", auth: "viewer", handle: () => awareness.risk() },

    // Settings and the audit log: admins only.
    {
      method: "GET",
      path: "/api/v1/settings",
      auth: "admin",
      handle: () => ({ smtp: awareness.smtpStatus(), identity: awareness.identityStatus() }),
    },
    {
      method: "PUT",
      path: "/api/v1/settings/smtp",
      auth: "admin",
      handle: async ({ res, body, actor }) => (awareness.setSmtp(await body(), actor()), noContent(res)),
    },
    {
      method: "PUT",
      path: "/api/v1/settings/identity",
      auth: "admin",
      handle: async ({ res, body, actor }) => (awareness.setIdentity(await body(), actor()), noContent(res)),
    },
    { method: "GET", path: "/api/v1/audit", auth: "admin", handle: () => ({ entries: awareness.audit() }) },
  ];

  const compiled = routes.map((r) => ({ ...r, re: new RegExp(`^${r.path.replace(/:[A-Za-z]+/g, "([^/]+)")}$`) }));

  /** Returns who is calling, or null for a route anyone may call. */
  function authorize(req: IncomingMessage, access: Access): string | null {
    if (access === "none") return null;
    if (tokenMatches(req.headers.authorization, adminToken)) return "admin token";
    const p = auth.authorize(req, access);
    return p.kind === "session" ? p.user.name : `API token ${p.name}`;
  }

  /** The public pages a recipient or a trainee sees: no sign-in, no body kept for the simulated form (ADR 0071). */
  function landing(req: IncomingMessage, res: ServerResponse, path: string): string | null {
    const html = (status: number, body: string) => send(res, status, body, TYPES[".html"]!);

    let m = /^\/l\/([A-Za-z0-9]+)$/.exec(path);
    if (m && req.method === "GET") {
      // A click records the click and auto-assigns the short "spotting phishing" module, so the page can say so.
      const l = awareness.recordClick(m[1]!);
      if (!l) return (html(404, renderNotFound()), "/l/:token");
      return (html(200, renderLanding({ token: m[1]!, reportAddress: l.reportAddress, hasTraining: true })), "/l/:token");
    }
    m = /^\/l\/([A-Za-z0-9]+)\/i\.gif$/.exec(path);
    if (m && req.method === "GET") {
      awareness.recordOpen(m[1]!);
      return (send(res, 200, PIXEL, "image/gif", { "cache-control": "no-store" }), "/l/:token/i.gif");
    }
    m = /^\/l\/([A-Za-z0-9]+)\/submit$/.exec(path);
    if (m && req.method === "POST") {
      // The simulated form. Record that it was posted, then discard the body unread: nothing typed is ever read.
      const l = awareness.recordSubmit(m[1]!);
      discardBody(req);
      if (!l) return (html(404, renderNotFound()), "/l/:token/submit");
      return (html(200, renderDebrief({ reportAddress: l.reportAddress })), "/l/:token/submit");
    }
    m = /^\/r\/([A-Za-z0-9]+)$/.exec(path);
    if (m && (req.method === "GET" || req.method === "POST")) {
      const l = awareness.recordReport(m[1]!);
      discardBody(req);
      return (html(l ? 200 : 404, l ? renderReported() : renderNotFound()), "/r/:token");
    }
    m = /^\/t\/([A-Za-z0-9]+)$/.exec(path);
    if (m && req.method === "GET") {
      const t = awareness.trainingByToken(m[1]!);
      if (!t) return (html(404, renderNotFound()), "/t/:token");
      return (html(200, renderTraining({ token: m[1]!, module: t.module, personName: t.personName, completedAt: t.completedAt, score: t.score })), "/t/:token");
    }
    // POST /t/:token/complete is handled by the async caller in route(), which reads the quiz body.
    return null;
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<string> {
    const u = new URL(req.url ?? "/", "http://localhost");
    const path = u.pathname;

    if (path === "/healthz") return (json(res, 200, { status: "ok" }), "/healthz");

    if (path === "/readyz") {
      try {
        db.prepare("SELECT 1").get();
        json(res, 200, { status: "ready" });
      } catch {
        json(res, 503, { status: "database unavailable" });
      }
      return "/readyz";
    }

    if (path === "/metrics") {
      if (serveMetrics) send(res, 200, metricsText(awareness, version), "text/plain; version=0.0.4");
      else problem(res, 404, "not-found");
      return "/metrics";
    }

    if (path === "/api/openapi.json" && spec) return (send(res, 200, spec), "/api/openapi.json");

    if (docsDir && (path === "/api/docs" || path.startsWith("/api/docs/"))) {
      if (path === "/api/docs") {
        res.writeHead(301, { ...SECURITY_HEADERS, location: "/api/docs/" }).end();
        return "/api/docs";
      }
      const relative = path.slice("/api/docs/".length) || "index.html";
      if (!(await serveFile(res, docsDir, relative))) problem(res, 404, "not-found");
      return "/api/docs";
    }

    // The public recipient and training pages (ADR 0071). The quiz submission reads its form body; the phishing
    // submission never does.
    if (/^\/[lrt]\//.test(path)) {
      const tc = /^\/t\/([A-Za-z0-9]+)\/complete$/.exec(path);
      if (tc && req.method === "POST") {
        const answers = parseForm(await readText(req, 64 * 1024));
        const result = awareness.completeTraining(tc[1]!, answers);
        const t = awareness.trainingByToken(tc[1]!);
        if (!result || !t) return (send(res, 404, renderNotFound(), TYPES[".html"]!), "/t/:token/complete");
        return (send(res, 200, renderTrainingResult({ module: t.module, score: result.score, passed: result.passed }), TYPES[".html"]!), "/t/:token/complete");
      }
      const name = landing(req, res, path);
      if (name) return name;
    }

    if (await auth.handle(req, res)) return auth.routeName(req) ?? "/api/v1/auth/*";

    for (const r of compiled) {
      const mm = path.match(r.re);
      if (!mm || r.method !== req.method) continue;
      try {
        const who = authorize(req, r.auth);
        const params = mm.slice(1).map(decodeURIComponent);
        const result = await r.handle({ req, res, url: u, params, body: () => readJson(req), text: () => readText(req), actor: () => who ?? "unknown" });
        if (!res.headersSent && result !== undefined) json(res, 200, result);
      } catch (err) {
        if (err instanceof AuthError) {
          sendProblem(res, err);
          if (!req.complete) req.resume();
          return r.path;
        }
        if (!(err instanceof AwarenessError)) throw err;
        problem(res, err.status, err.code, err.message);
        if (!req.complete) req.resume();
      }
      return r.path;
    }

    if (path.startsWith("/api/")) return (problem(res, 404, "not-found"), "/api/*");

    if (webDir && (req.method === "GET" || req.method === "HEAD")) {
      if (!(await serveFile(res, webDir, path === "/" ? "index.html" : path))) send(res, 200, await readFile(join(webDir, "index.html")), TYPES[".html"]);
      return "/web";
    }

    problem(res, 404, "not-found");
    return "unmatched";
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = performance.now();
    let routeName = "error";
    try {
      routeName = await route(req, res);
    } catch (err) {
      log("error", "request failed", { error: String(err), path: req.url });
      if (!res.headersSent) problem(res, 500, "internal-error");
    }
    countRequest(req.method ?? "GET", routeName, res.statusCode);
    if (routeName !== "/healthz" && routeName !== "/metrics") {
      log("info", "request", { method: req.method, path: pathOnly(req), status: res.statusCode, ms: Math.round(performance.now() - started) });
    }
  };
}

/** The chosen option index per question, from a quiz form body (q0=1&q1=0). Not sensitive; the phishing form is
 * different and reads nothing (ADR 0071). */
function parseForm(body: string): number[] {
  const answers: number[] = [];
  for (const pair of body.split("&")) {
    const [k, v] = pair.split("=");
    const m = /^q(\d+)$/.exec(decodeURIComponent(k ?? ""));
    if (m) answers[Number(m[1])] = Number(decodeURIComponent(v ?? ""));
  }
  return answers;
}

/** The path without the query string. */
const pathOnly = (req: IncomingMessage) => (req.url ?? "/").split("?")[0];
