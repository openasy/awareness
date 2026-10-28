import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "./test-app.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

let app: Awaited<ReturnType<typeof startApp>>;
let base: string;
beforeAll(async () => {
  app = await startApp({ version });
  base = app.base;
});
afterAll(() => app.close());

/** Adds a verified domain, a person and a sent campaign, and returns a recipient's opaque link token. */
async function aSentCampaign(email = "alice@example.com") {
  await app.own("example.com");
  app.addPerson(email, "Alice");
  const c = await app.sendCampaign({ name: "Drill", templateId: "doc-share", fromEmail: "security@example.com", reportAddress: "report@example.com" });
  return (app.db.prepare("SELECT token FROM recipients WHERE campaign_id = ? AND email = ?").get(c.id, email) as { token: string }).token;
}

describe("health, metrics and version", () => {
  it("answers health and readiness", async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
  });
  it("serves metrics with the product label and training numbers", async () => {
    const text = await (await fetch(`${base}/metrics`)).text();
    expect(text).toContain('openasy_build_info{product="awareness"');
    expect(text).toContain("openasy_awareness_training_completion_ratio");
    expect(text).toContain("openasy_awareness_last_campaign_reported");
  });
});

describe("the landing page records behaviour but captures nothing", () => {
  it("records a click and shows the labelled drill page", async () => {
    const token = await aSentCampaign();
    const res = await fetch(`${base}/l/${token}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("SECURITY AWARENESS TEST");
    expect(html).toContain("sends nothing");
    expect(app.awareness.campaign(app.awareness.campaigns()[0]!.id).stats.clicked).toBe(1);
  });

  it("discards the body of the simulated form: a posted password is never stored", async () => {
    const token = await aSentCampaign("bob@example.com");
    const res = await fetch(`${base}/l/${token}/submit`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "email=bob@example.com&password=hunter2-should-never-be-stored",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Nothing was sent");
    // The submission is recorded, but the posted password appears nowhere in the database file.
    const row = app.db.prepare("SELECT * FROM recipients WHERE token = ?").get(token) as Record<string, unknown>;
    expect(row.submitted_at).toBeTruthy();
    const everything = JSON.stringify(app.db.prepare("SELECT * FROM recipients").all());
    expect(everything).not.toContain("hunter2");
  });

  it("serves the open pixel as a gif", async () => {
    const token = await aSentCampaign("carol@example.com");
    const res = await fetch(`${base}/l/${token}/i.gif`);
    expect(res.headers.get("content-type")).toBe("image/gif");
  });

  it("counts a report and thanks the recipient", async () => {
    const token = await aSentCampaign("dan@example.com");
    const res = await fetch(`${base}/r/${token}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Thank you for reporting");
  });

  it("gives an invalid token a plain not-found page, not an error", async () => {
    const res = await fetch(`${base}/l/deadbeef`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("not valid");
  });
});

describe("the training page grades the quiz on the server", () => {
  it("renders the module and records a passing completion from the form", async () => {
    const token = await aSentCampaign("erin@example.com");
    await fetch(`${base}/l/${token}`); // click auto-assigns the module
    const person = app.awareness.people().find((p) => p.email === "erin@example.com")!;
    const assignment = app.awareness.assignments({ personId: person.id })[0]!;
    const trainingToken = (app.db.prepare("SELECT token FROM assignments WHERE id = ?").get(assignment.id) as { token: string }).token;
    expect(await (await fetch(`${base}/t/${trainingToken}`)).text()).toContain("Spotting a phishing email");
    const res = await fetch(`${base}/t/${trainingToken}/complete`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "q0=1&q1=1&q2=1",
    });
    expect(await res.text()).toContain("You passed");
    expect(app.awareness.assignments({ personId: person.id })[0]!.passed).toBe(true);
  });
});

describe("roles (ADR 0003)", () => {
  it("lets a viewer read but not create, and an editor create a campaign", async () => {
    const { viewer, editor } = await app.roles();
    await app.own("example.com");
    app.addPerson("fay@example.com", "Fay");
    expect((await viewer("/api/v1/campaigns")).status).toBe(200);
    expect((await viewer("/api/v1/campaigns", { method: "POST", body: JSON.stringify({}) })).status).toBe(403);
    const made = await editor("/api/v1/campaigns", {
      method: "POST",
      body: JSON.stringify({ name: "Role drill", templateId: "doc-share", fromEmail: "security@example.com", reportAddress: "report@example.com" }),
    });
    expect(made.status).toBe(202);
    // Settings are admin only.
    expect((await editor("/api/v1/settings")).status).toBe(403);
  });
});
