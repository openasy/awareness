import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testAwareness } from "./test-app.ts";

let t: Awaited<ReturnType<typeof testAwareness>>;
beforeEach(async () => {
  t = await testAwareness();
});
afterEach(() => t.close());

describe("verified domains gate who can be reached", () => {
  it("verifies a domain only when its TXT token is published", async () => {
    const d = t.awareness.createDomain({ name: "example.com" }, "Olivia");
    expect(d.state).toBe("pending");
    expect(d.proof.name).toBe("_openasy-awareness.example.com");
    // Not published yet.
    expect((await t.awareness.verifyDomain(d.id, "Olivia")).state).toBe("pending");
    t.dns.zone[d.proof.name] = [d.proof.value];
    expect((await t.awareness.verifyDomain(d.id, "Olivia")).state).toBe("verified");
    // If the record goes, a later check marks it lost.
    delete t.dns.zone[d.proof.name];
    expect((await t.awareness.verifyDomain(d.id, "Olivia")).state).toBe("lost");
  });

  it("refuses a person whose email is not in a verified domain", async () => {
    await t.own("example.com");
    const r = t.addPerson("outsider@elsewhere.com", "Outsider");
    expect(r.added).toBe(0);
    expect(r.rejected).toBe(1);
    expect(r.rejectedEmails).toEqual(["outsider@elsewhere.com"]);
    const ok = t.addPerson("insider@example.com", "Insider");
    expect(ok.added).toBe(1);
    expect(t.awareness.people()).toHaveLength(1);
  });

  it("refuses a campaign whose from address is outside the verified domains", async () => {
    await t.own("example.com");
    t.addPerson("a@example.com", "A");
    expect(() =>
      t.awareness.createCampaign({ name: "C", templateId: "doc-share", fromEmail: "it@evil.com", reportAddress: "report@example.com" }, "Olivia"),
    ).toThrow(/verified domain/);
  });
});

describe("a campaign sends through the relay and records behaviour", () => {
  beforeEach(async () => {
    await t.own("example.com");
    t.addPerson("alice@example.com", "Alice", "Finance");
    t.addPerson("bob@example.com", "Bob", "Finance");
  });

  it("sends one mail per recipient through the local relay", async () => {
    const c = await t.sendCampaign({ name: "Q4 drill", templateId: "doc-share", fromEmail: "security@example.com", reportAddress: "report@example.com" });
    expect(c.state).toBe("sent");
    expect(c.stats.recipients).toBe(2);
    expect(c.stats.sent).toBe(2);
    expect(t.sink.messages).toHaveLength(2);
    // The mail carries the awareness marker and the visible banner, and never a real brand.
    const mail = t.sink.messages[0]!.data;
    expect(mail).toContain("X-OpenAsy-Awareness: simulation");
    expect(mail).toContain("SECURITY AWARENESS TEST");
    expect(mail).toContain("example-corp.test");
  });

  it("records open, click and report, and a report counts for the campaign", async () => {
    const c = await t.sendCampaign({ name: "Drill", templateId: "it-password", fromEmail: "security@example.com", reportAddress: "report@example.com" });
    const [r1, r2] = t.db.prepare("SELECT token FROM recipients WHERE campaign_id = ?").all(c.id) as Array<{ token: string }>;
    t.awareness.recordOpen(r1!.token);
    t.awareness.recordClick(r1!.token);
    t.awareness.recordReport(r2!.token);
    const after = t.awareness.campaign(c.id);
    expect(after.stats.opened).toBe(1);
    expect(after.stats.clicked).toBe(1);
    expect(after.stats.reported).toBe(1);
  });
});

describe("the simulated form captures nothing", () => {
  it("records a submission without being given, or storing, any field value", async () => {
    await t.own("example.com");
    t.addPerson("alice@example.com", "Alice");
    const c = await t.sendCampaign({ name: "Drill", templateId: "doc-share", fromEmail: "security@example.com", reportAddress: "report@example.com" });
    const { token } = t.db.prepare("SELECT token FROM recipients WHERE campaign_id = ?").get(c.id) as { token: string };
    // recordSubmit takes no field argument: there is nowhere for a typed value to go.
    t.awareness.recordSubmit(token);
    const row = t.db.prepare("SELECT * FROM recipients WHERE token = ?").get(token) as Record<string, unknown>;
    expect(row.submitted_at).toBeTruthy();
    expect(row.clicked_at).toBeTruthy(); // a submit implies a click
    // No column anywhere holds a password or any typed field.
    const columns = Object.keys(row);
    expect(columns).not.toContain("password");
    expect(columns.every((col) => !/pass|secret|field|value/.test(col))).toBe(true);
  });
});

describe("training is assigned to whoever clicks, and completion is recorded", () => {
  beforeEach(async () => {
    await t.own("example.com");
    t.addPerson("alice@example.com", "Alice");
  });

  it("auto-assigns the phishing module on a click and records a passing quiz", async () => {
    const c = await t.sendCampaign({ name: "Drill", templateId: "doc-share", fromEmail: "security@example.com", reportAddress: "report@example.com" });
    const { token } = t.db.prepare("SELECT token FROM recipients WHERE campaign_id = ?").get(c.id) as { token: string };
    t.awareness.recordClick(token);
    const [a] = t.awareness.assignments();
    expect(a!.moduleId).toBe("spotting-phishing");
    const trainingToken = (t.db.prepare("SELECT token FROM assignments WHERE id = ?").get(a!.id) as { token: string }).token;
    const page = t.awareness.trainingByToken(trainingToken)!;
    expect(page.module.id).toBe("spotting-phishing");
    const result = t.awareness.completeTraining(trainingToken, [1, 1, 1]);
    expect(result).toEqual({ score: 100, passed: true });
    expect(t.awareness.assignments()[0]!.completedAt).toBeTruthy();
  });
});

describe("risk falls as people report and complete training", () => {
  it("scores a clicker higher than a reporter", async () => {
    await t.own("example.com");
    t.addPerson("clicker@example.com", "Clicker");
    t.addPerson("reporter@example.com", "Reporter");
    const c = await t.sendCampaign({ name: "Drill", templateId: "doc-share", fromEmail: "security@example.com", reportAddress: "report@example.com" });
    const rows = t.db.prepare("SELECT token, email FROM recipients WHERE campaign_id = ?").all(c.id) as Array<{ token: string; email: string }>;
    const clicker = rows.find((r) => r.email === "clicker@example.com")!;
    const reporter = rows.find((r) => r.email === "reporter@example.com")!;
    t.awareness.recordSubmit(clicker.token);
    t.awareness.recordReport(reporter.token);
    const risk = t.awareness.risk();
    const c1 = risk.people.find((p) => p.name === "Clicker")!;
    const r1 = risk.people.find((p) => p.name === "Reporter")!;
    expect(c1.risk).toBeGreaterThan(r1.risk);
    expect(risk.timeline).toHaveLength(1);
    expect(risk.timeline[0]!.reportRate).toBeGreaterThan(0);
  });
});
