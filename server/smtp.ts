// Sends the simulated mail through the admin's own SMTP relay (ADR 0071). Awareness never sends mail any other way,
// and runs no relay of its own: the organisation points it at the server it already uses. A small, dependency-free
// SMTP conversation covers plain, STARTTLS and implicit TLS, with optional AUTH LOGIN. Tests and the local smoke
// send to a catcher they start, so no real mail leaves the machine. The relay password is sealed with the install's
// key (ADR 0021) and opened only here, in memory, to send.
import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

export type Security = "none" | "starttls" | "tls";

export interface SmtpConfig {
  host: string;
  port: number;
  security: Security;
  username?: string;
  /** The password in the clear, already opened from its sealed form. */
  password?: string;
  /** For a test relay with a self-signed certificate; never set in production. */
  insecureTls?: boolean;
  timeoutMs?: number;
}

export interface Mail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** A line-oriented SMTP reply: the final 3-digit code and the joined text. */
interface Reply {
  code: number;
  text: string;
}

class Conn {
  private buffer = "";
  private waiters: Array<(r: Reply) => void> = [];
  private pending: Reply[] = [];
  private error: Error | null = null;
  private socket: Socket | TLSSocket;

  constructor(socket: Socket | TLSSocket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", (err: Error) => this.fail(err));
    socket.on("close", () => this.fail(new Error("the SMTP connection closed")));
  }

  private fail(err: Error) {
    this.error = err;
    for (const w of this.waiters.splice(0)) w({ code: 0, text: err.message });
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, "");
      this.buffer = this.buffer.slice(nl + 1);
      // A multi-line reply has a hyphen after the code on every line but the last.
      const m = /^(\d{3})([ -])(.*)$/.exec(line);
      if (!m) continue;
      this.lineParts.push(m[3]!);
      if (m[2] === " ") {
        const reply = { code: Number(m[1]), text: this.lineParts.join(" ") };
        this.lineParts = [];
        const w = this.waiters.shift();
        if (w) w(reply);
        else this.pending.push(reply);
      }
    }
  }
  private lineParts: string[] = [];

  read(): Promise<Reply> {
    if (this.error) return Promise.reject(this.error);
    const ready = this.pending.shift();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  write(line: string) {
    this.socket.write(line + "\r\n");
  }

  /** Sends a command and checks the reply code is one of `expect`. */
  async cmd(line: string, expect: number[]): Promise<Reply> {
    this.write(line);
    const reply = await this.read();
    if (!expect.includes(reply.code)) throw new Error(`SMTP ${line.split(" ")[0]} got ${reply.code}: ${reply.text}`);
    return reply;
  }

  get raw() {
    return this.socket;
  }
}

/** The RFC 5322 message, multipart/alternative so a client shows either the text or the HTML part. */
export function buildMessage(mail: Mail): string {
  const boundary = "oa-" + Math.random().toString(36).slice(2);
  const headers = [
    `From: ${mail.from}`,
    `To: ${mail.to}`,
    `Subject: ${mail.subject}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    // A header that marks every simulation mail, so a mail team can filter and audit it (ADR 0071).
    "X-OpenAsy-Awareness: simulation",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const dotStuff = (s: string) => s.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    "",
    dotStuff(mail.text),
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    "",
    dotStuff(mail.html),
    `--${boundary}--`,
    "",
  ];
  return headers.join("\r\n") + "\r\n\r\n" + parts.join("\r\n");
}

async function openSocket(config: SmtpConfig): Promise<Socket | TLSSocket> {
  const timeout = config.timeoutMs ?? 15_000;
  if (config.security === "tls") {
    const socket = tlsConnect({ host: config.host, port: config.port, rejectUnauthorized: !config.insecureTls });
    await once(socket, "secureConnect");
    socket.setTimeout(timeout);
    return socket;
  }
  const socket = createConnection({ host: config.host, port: config.port });
  await once(socket, "connect");
  socket.setTimeout(timeout);
  return socket;
}

async function ehlo(conn: Conn, host: string): Promise<string> {
  try {
    return (await conn.cmd(`EHLO ${host}`, [250])).text;
  } catch {
    // An old relay that does not speak ESMTP still answers HELO.
    await conn.cmd(`HELO ${host}`, [250]);
    return "";
  }
}

/** A mailer bound to one relay. Each send opens a fresh connection, which keeps one stuck send from blocking others. */
export function createMailer(config: SmtpConfig): Mailer {
  const ourName = "awareness.openasy.local";
  return {
    async send(mail) {
      let conn = new Conn(await openSocket(config));
      try {
        await conn.read(); // the 220 greeting
        let caps = await ehlo(conn, ourName);
        if (config.security === "starttls") {
          await conn.cmd("STARTTLS", [220]);
          const secure = tlsConnect({ socket: conn.raw, servername: config.host, rejectUnauthorized: !config.insecureTls });
          await once(secure, "secureConnect");
          conn = new Conn(secure);
          caps = await ehlo(conn, ourName);
        }
        if (config.username && config.password) {
          if (!/AUTH[ =].*LOGIN/i.test(caps)) throw new Error("the relay does not offer AUTH LOGIN");
          await conn.cmd("AUTH LOGIN", [334]);
          await conn.cmd(Buffer.from(config.username).toString("base64"), [334]);
          await conn.cmd(Buffer.from(config.password).toString("base64"), [235]);
        }
        const envelopeFrom = mail.from.replace(/^.*</, "").replace(/>.*$/, "").trim() || mail.from;
        await conn.cmd(`MAIL FROM:<${envelopeFrom}>`, [250]);
        await conn.cmd(`RCPT TO:<${mail.to}>`, [250, 251]);
        await conn.cmd("DATA", [354]);
        conn.raw.write(buildMessage(mail) + "\r\n.\r\n");
        const done = await conn.read();
        if (done.code !== 250) throw new Error(`SMTP DATA got ${done.code}: ${done.text}`);
        await conn.cmd("QUIT", [221]).catch(() => {});
      } finally {
        conn.raw.destroy();
      }
    },
  };
}
