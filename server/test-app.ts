// Starts the app on a random port for tests, with fake DNS and a local SMTP catcher: nothing a test does leaves this
// machine, and no real mail is ever sent (ADR 0071). The catcher is a real SMTP server the test starts, so the SMTP
// client in smtp.ts is exercised end to end.
import { createHmac } from "node:crypto";
import { createServer as createHttp, type RequestListener, type Server } from "node:http";
import { createServer as createTcp, type Server as TcpServer } from "node:net";
import type { AddressInfo } from "node:net";
import { createAuth } from "@openasy/auth";
import { createApp, type AppOptions } from "./app.ts";
import { createAwareness, type AwarenessOptions } from "./awareness.ts";
import { openDb } from "./db.ts";
import type { Dns } from "./dns.ts";

export const ADMIN_TOKEN = "test-admin-token";
export const T0 = Date.parse("2026-10-28T06:00:00Z");

/** DNS from a table the test changes as it goes. `asked` lists every name looked up. */
export function fakeDns(zone: Record<string, string[]> = {}): Dns & { zone: Record<string, string[]>; asked: string[] } {
  const asked: string[] = [];
  return {
    zone,
    asked,
    txt: async (name) => (asked.push(name), zone[name] ?? []),
  };
}

export interface CaughtMail {
  from: string;
  to: string[];
  data: string;
}

/** A tiny SMTP server that accepts a message and keeps it, so a test can see what was sent without sending anything. */
export function startSmtpSink(): Promise<{ port: number; messages: CaughtMail[]; close: () => Promise<void> }> {
  const messages: CaughtMail[] = [];
  const server: TcpServer = createTcp((socket) => {
    let from = "";
    let to: string[] = [];
    let inData = false;
    let data = "";
    let buffer = "";
    socket.setEncoding("utf8");
    socket.write("220 sink.test ESMTP\r\n");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (inData) {
          if (line === ".") {
            inData = false;
            messages.push({ from, to, data });
            from = "";
            to = [];
            data = "";
            socket.write("250 OK queued\r\n");
          } else data += line.replace(/^\.\./, ".") + "\n";
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO" || cmd === "HELO") socket.write("250-sink.test\r\n250 AUTH LOGIN\r\n");
        else if (cmd === "AUTH") socket.write("235 OK\r\n");
        else if (cmd === "MAIL") ((from = /<(.*)>/.exec(line)?.[1] ?? ""), socket.write("250 OK\r\n"));
        else if (cmd === "RCPT") (to.push(/<(.*)>/.exec(line)?.[1] ?? ""), socket.write("250 OK\r\n"));
        else if (cmd === "DATA") ((inData = true), socket.write("354 End with .\r\n"));
        else if (cmd === "QUIT") (socket.write("221 Bye\r\n"), socket.end());
        else socket.write("250 OK\r\n");
      }
    });
    socket.on("error", () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ port, messages, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

/** Awareness on an in-memory database with fake DNS and a real local SMTP catcher. */
export async function testAwareness(over: Partial<AwarenessOptions> = {}) {
  const db = openDb(":memory:");
  let now = T0;
  const dns = fakeDns();
  const sink = await startSmtpSink();
  const awareness = createAwareness(db, {
    dns,
    sealer: { seal: (s) => s, open: (s) => s, sealing: false },
    publicUrl: "https://awareness.example.test",
    clock: () => now,
    ...over,
  });
  awareness.setSmtp({ host: "127.0.0.1", port: sink.port, security: "none" }, "test");

  /** Adds and verifies a domain the way its owner would: publish the TXT record this Awareness asks for, then verify.
   * Idempotent, so a shared test app can call it in several cases. */
  async function own(name: string) {
    const existing = awareness.domains().find((d) => d.name === name);
    const d = existing ?? awareness.createDomain({ name }, "Olivia");
    dns.zone[d.proof.name] = [d.proof.value];
    return awareness.verifyDomain(d.id, "Olivia");
  }
  function addPerson(email: string, name: string, department: string | null = null) {
    const line = "email,name,department\n" + `${email},${name},${department ?? ""}\n`;
    return awareness.importCsv(line, "Olivia");
  }
  /** Creates a campaign and waits for the sending to finish. */
  async function sendCampaign(body: Record<string, unknown>) {
    const { campaign, done } = awareness.createCampaign(body, "Olivia");
    await done;
    return awareness.campaign(campaign.id);
  }
  return { db, dns, sink, awareness, own, addPerson, sendCampaign, later: (ms: number) => (now += ms), now: () => now, close: () => sink.close() };
}

export async function startApp(opts: Partial<AppOptions> & { version: string; awarenessOptions?: Partial<AwarenessOptions> }) {
  const { awarenessOptions, ...appOptions } = opts;
  const t = await testAwareness(awarenessOptions);
  const { db, awareness } = t;
  // The origin is known once the port is, so the handler is set after listening.
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const server: Server = createHttp((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const baseAddr = `http://localhost:${(server.address() as AddressInfo).port}`;
  const auth = createAuth({ db, product: "awareness", productName: "OpenAsy Awareness", origin: baseAddr });
  handler = createApp({ db, awareness, auth, adminToken: ADMIN_TOKEN, ...appOptions });
  const as =
    (token: string) =>
    (path: string, init: RequestInit = {}) =>
      fetch(baseAddr + path, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers } });
  const admin = as(ADMIN_TOKEN);
  const get = async (path: string) => (await (await admin(path)).json()) as any;
  const sendApi = (method: string, path: string, body?: unknown) =>
    admin(path, { method, ...(body !== undefined && { body: typeof body === "string" ? body : JSON.stringify(body) }) });
  const close = () => Promise.all([new Promise<void>((resolve) => server.close(() => resolve())), t.close()]).then(() => undefined);

  /** The owner, signed in with a second factor, makes an API token for each role. */
  async function roles() {
    const jar = new Map<string, string>();
    const browser = async (path: string, body: unknown) => {
      const res = await fetch(baseAddr + path, {
        method: "POST",
        headers: { origin: baseAddr, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(";");
        const i = pair!.indexOf("=");
        jar.set(pair!.slice(0, i), pair!.slice(i + 1));
      }
      return res;
    };
    const setup = new URL(auth.setupLink()!).searchParams.get("setup");
    await browser("/api/v1/auth/setup", { token: setup, name: "Olivia", email: "owner@example.com", password: "correct horse battery staple 42" });
    const { secret } = (await (await browser("/api/v1/auth/me/totp", {})).json()) as { secret: string };
    await browser("/api/v1/auth/me/totp/confirm", { code: totp(secret) });
    const token = async (role: string) => ((await (await browser("/api/v1/auth/tokens", { name: role, role })).json()) as { token: string }).token;
    return { admin: as(await token("admin")), editor: as(await token("editor")), viewer: as(await token("viewer")) };
  }

  return { ...t, auth, base: baseAddr, admin, get, send: sendApi, close, roles };
}

export function totp(secret: string) {
  const bits = [...secret].map((c) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const mac = createHmac("sha1", key).update(counter).digest();
  return String((mac.readUInt32BE(mac[19]! & 15) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
