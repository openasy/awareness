import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMailer, buildMessage } from "./smtp.ts";
import { startSmtpSink } from "./test-app.ts";

describe("buildMessage", () => {
  it("writes a multipart/alternative message with a text and an HTML part", () => {
    const msg = buildMessage({ from: "Sec <security@example.com>", to: "alice@example.com", subject: "Test", text: "plain", html: "<p>rich</p>" });
    expect(msg).toContain("From: Sec <security@example.com>");
    expect(msg).toContain("To: alice@example.com");
    expect(msg).toContain("X-OpenAsy-Awareness: simulation");
    expect(msg).toContain("multipart/alternative");
    expect(msg).toContain("plain");
    expect(msg).toContain("<p>rich</p>");
  });

  it("dot-stuffs a line that starts with a dot, so the body cannot end the DATA early", () => {
    const msg = buildMessage({ from: "a@example.com", to: "b@example.com", subject: "s", text: ".hidden", html: "x" });
    expect(msg).toContain("..hidden");
  });
});

describe("createMailer against a local catcher", () => {
  let sink: Awaited<ReturnType<typeof startSmtpSink>>;
  beforeAll(async () => {
    sink = await startSmtpSink();
  });
  afterAll(() => sink.close());

  it("delivers a message with its envelope and content", async () => {
    const mailer = createMailer({ host: "127.0.0.1", port: sink.port, security: "none" });
    await mailer.send({ from: "Security <security@example.com>", to: "alice@example.com", subject: "Drill", text: "hi", html: "<p>hi</p>" });
    expect(sink.messages).toHaveLength(1);
    expect(sink.messages[0]!.from).toBe("security@example.com");
    expect(sink.messages[0]!.to).toEqual(["alice@example.com"]);
    expect(sink.messages[0]!.data).toContain("Subject: Drill");
  });
});
