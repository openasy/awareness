import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPENAPI } from "../scripts/openapi.ts";
import { ADMIN_TOKEN, startApp } from "./test-app.ts";

// Contract tests (ADR 0024): every response the API sends must match openapi.json.

type Spec = {
  info: { version: string };
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>>;
  components: { responses: Record<string, { content: Record<string, { schema: object }> }> };
};

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(spec, "openapi");

const docsDir = mkdtempSync(join(tmpdir(), "awareness-docs-"));
writeFileSync(join(docsDir, "index.html"), "<!doctype html><title>API</title>");

let app: Awaited<ReturnType<typeof startApp>>;
let base: string;
const covered = new Set<string>();

beforeAll(async () => {
  app = await startApp({ version, openapi: spec, docsDir });
  base = app.base;
});

afterAll(() => app.close());

/** Calls the API and checks status, content type and body against the description. */
async function call(method: string, path: string, init: RequestInit = {}, concrete = path) {
  const res = await fetch(base + concrete, { ...init, method });
  const operation = spec.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is not in openapi.json`).toBeDefined();
  covered.add(`${method} ${path}`);

  const declared = operation!.responses[String(res.status)];
  expect(declared, `${method} ${concrete} answered ${res.status}, which openapi.json does not list`).toBeDefined();
  const shared = declared!.$ref?.split("/").pop();
  const response = shared ? spec.components.responses[shared]! : declared!;
  const at = shared
    ? `openapi#/components/responses/${shared}`
    : `openapi#/paths/${path.replaceAll("/", "~1")}/${method.toLowerCase()}/responses/${res.status}`;

  if (!response.content) {
    expect(res.headers.get("content-length") ?? "0", `${method} ${path} ${res.status} should have no body`).toBe("0");
    return { res, body: undefined };
  }
  const type = res.headers.get("content-type")!.split(";")[0]!;
  expect(response.content?.[type], `${method} ${path} ${res.status} sent ${type}, which openapi.json does not list`).toBeDefined();

  const body = type.endsWith("json") ? await res.json() : await res.text();
  const schema = `${at}/content/${type.replace("/", "~1")}/schema`;
  const validate = ajv.getSchema(schema)!;
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return { res, body };
}

const auth = (token: string, body?: string, type = "application/json") => ({
  headers: { authorization: `Bearer ${token}`, "content-type": type },
  ...(body !== undefined && { body }),
});
const admin = (body?: unknown, type = "application/json") =>
  auth(ADMIN_TOKEN, body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body), type);

describe("openapi.json", () => {
  it("is what scripts/openapi.ts writes", () => {
    expect(spec).toEqual(JSON.parse(JSON.stringify(OPENAPI)));
  });

  it("has the version of this release", () => {
    expect(spec.info.version).toBe(version);
  });

  it("is served with the running version", async () => {
    const served = (await (await fetch(`${base}/api/openapi.json`)).json()) as Spec;
    expect(served.info.version).toBe(version);
    // Awareness's own operations, then sign-in from @openasy/auth (tested against its description in that package).
    expect(Object.keys(served.paths).filter((p) => !p.startsWith("/api/v1/auth/"))).toEqual(Object.keys(spec.paths));
    expect(served.paths["/api/v1/auth/login"]).toBeDefined();
  });

  it("serves the API reference at /api/docs/", async () => {
    expect((await fetch(`${base}/api/docs`, { redirect: "manual" })).headers.get("location")).toBe("/api/docs/");
    const res = await fetch(`${base}/api/docs/`);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${base}/api/docs/../../package.json`)).status).not.toBe(200);
  });
});

describe("responses match openapi.json", () => {
  let domain = "";
  let person = "";
  let campaign = "";

  it("product and health", async () => {
    await call("GET", "/api/v1/version");
    await call("GET", "/api/v1/products", admin());
    await call("GET", "/healthz");
    await call("GET", "/readyz");
    await call("GET", "/metrics");
    await call("GET", "/api/v1/summary", admin());
  });

  it("domains", async () => {
    domain = ((await call("POST", "/api/v1/domains", admin({ name: "example.com" }))).body as { id: string }).id;
    await call("POST", "/api/v1/domains", admin({ name: "example.com" })); // 409
    await call("POST", "/api/v1/domains", admin({ name: "not a domain" })); // 400
    await call("POST", "/api/v1/domains", admin("nope")); // 400 invalid-json
    await call("GET", "/api/v1/domains", admin());
    const one = "/api/v1/domains/{id}";
    await call("GET", one, admin(), `/api/v1/domains/${domain}`);
    await call("GET", one, admin(), "/api/v1/domains/missing");
    const verify = "/api/v1/domains/{id}/verify";
    await call("POST", verify, admin(), `/api/v1/domains/${domain}/verify`); // still pending
    await call("POST", verify, admin(), "/api/v1/domains/missing/verify");
    // Publish the record so later steps have a verified domain to send from.
    const d = app.awareness.domain(domain);
    app.dns.zone[d.proof.name] = [d.proof.value];
    await call("POST", verify, admin(), `/api/v1/domains/${domain}/verify`);
    const other = ((await call("POST", "/api/v1/domains", admin({ name: "example.org" }))).body as { id: string }).id;
    await call("DELETE", one, admin(), `/api/v1/domains/${other}`);
    await call("DELETE", one, admin(), "/api/v1/domains/missing");
  });

  it("people", async () => {
    await call("POST", "/api/v1/people/import", admin("email,name,department\nalice@example.com,Alice,Finance\nbob@example.com,Bob,Sales\n", "text/csv"));
    await call("POST", "/api/v1/people/import", admin("no header here", "text/csv")); // 400
    await call("POST", "/api/v1/people/sync", admin()); // 400: Identity not connected
    const list = (await call("GET", "/api/v1/people", admin())).body as { people: Array<{ id: string }> };
    await call("GET", "/api/v1/people", admin(), "/api/v1/people?department=Finance");
    person = list.people[0]!.id;
    await call("GET", "/api/v1/people/{id}", admin(), `/api/v1/people/${person}`);
    await call("GET", "/api/v1/people/{id}", admin(), "/api/v1/people/missing");
  });

  it("templates, campaigns and their recipients", async () => {
    await call("GET", "/api/v1/templates", admin());
    campaign = (
      (
        await call(
          "POST",
          "/api/v1/campaigns",
          admin({ name: "Q4 drill", templateId: "doc-share", fromEmail: "security@example.com", reportAddress: "report@example.com" }),
        )
      ).body as { id: string }
    ).id;
    await call("POST", "/api/v1/campaigns", admin({ name: "bad", templateId: "nope", fromEmail: "security@example.com", reportAddress: "report@example.com" })); // 400
    await app.awareness.idle();
    await call("GET", "/api/v1/campaigns", admin());
    await call("GET", "/api/v1/campaigns/{id}", admin(), `/api/v1/campaigns/${campaign}`);
    await call("GET", "/api/v1/campaigns/{id}", admin(), "/api/v1/campaigns/missing");
  });

  it("training and risk", async () => {
    await call("GET", "/api/v1/modules", admin());
    await call("POST", "/api/v1/training", admin({ moduleId: "passwords-mfa", personId: person })); // 201
    await call("POST", "/api/v1/training", admin({ moduleId: "nope", personId: person })); // 400
    await call("POST", "/api/v1/training", admin({ moduleId: "passwords-mfa", personId: "missing" })); // 404
    await call("GET", "/api/v1/training", admin());
    await call("GET", "/api/v1/training", admin(), `/api/v1/training?person=${person}`);
    await call("GET", "/api/v1/risk", admin());
  });

  it("settings and audit", async () => {
    await call("GET", "/api/v1/settings", admin());
    await call("PUT", "/api/v1/settings/smtp", {
      method: "PUT",
      ...admin({ host: "mail.example.com", port: 587, security: "starttls", username: "u", password: "p" }),
    });
    await call("PUT", "/api/v1/settings/smtp", { method: "PUT", ...admin({ host: "mail.example.com" }) }); // 400
    await call("PUT", "/api/v1/settings/identity", { method: "PUT", ...admin({ url: "https://identity.example.com", token: "oa_identity_x" }) });
    await call("PUT", "/api/v1/settings/identity", { method: "PUT", ...admin({ url: "not a url", token: "x" }) }); // 400
    await call("GET", "/api/v1/audit", admin());
  });

  it("covers every operation in openapi.json", () => {
    const all = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`));
    expect([...covered].sort()).toEqual(all.sort());
  });
});
