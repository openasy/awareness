import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createAuth, oidcFromEnv, readSecretsKey } from "@openasy/auth";
import { createApp, createMetricsHandler } from "./app.ts";
import { createAwareness } from "./awareness.ts";
import { openDb } from "./db.ts";
import { systemDns } from "./dns.ts";
import { log } from "./log.ts";
import { parseProducts } from "./products.ts";
import { sealer } from "./seal.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const port = Number(process.env.PORT ?? 8080);
const dbPath = process.env.AWARENESS_DB ?? "/data/awareness.db";
const recheckHours = Number(process.env.AWARENESS_RECHECK_HOURS ?? 24);
const dnsServers = (process.env.AWARENESS_DNS_SERVERS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const webDir = new URL("../dist/web", import.meta.url).pathname;
const docsDir = new URL("../dist/docs", import.meta.url).pathname;
const openapi = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Record<string, unknown>;
const headless = process.env.AWARENESS_HEADLESS === "true";
// Set it to keep /metrics off the port that is published or behind an ingress (ADR 0026).
const metricsPort = process.env.AWARENESS_METRICS_PORT ? Number(process.env.AWARENESS_METRICS_PORT) : undefined;

if (!Number.isFinite(recheckHours) || recheckHours < 1 || recheckHours > 168) throw new Error("AWARENESS_RECHECK_HOURS must be a number of hours, 1 to 168");

const db = openDb(dbPath);
// The address people and recipients open Awareness at, behind the TLS proxy (ADR 0026). The links in the simulated
// mail and the training point here, so it must be reachable by the recipients' browsers.
const publicUrl = (process.env.AWARENESS_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const secretsKeyFile = process.env.AWARENESS_SECRETS_KEY_FILE ?? "/run/secrets/openasy-kek";
const secretsKey = readSecretsKey(secretsKeyFile);
const auth = createAuth({
  db,
  product: "awareness",
  productName: "OpenAsy Awareness",
  origin: publicUrl,
  // Locally the same Awareness is often opened as 127.0.0.1 too.
  trustedOrigins: publicUrl.startsWith("http://localhost:") ? [publicUrl.replace("localhost", "127.0.0.1")] : [],
  passwords: process.env.AWARENESS_PASSWORD_SIGN_IN !== "false",
  oidc: oidcFromEnv(process.env, "AWARENESS_"),
  secretsKey,
  // Audit log (ADR 0013): every sign-in, failure and change to members and tokens.
  onEvent: (event) => log(event.type === "sign-in-failed" ? "warn" : "info", "auth", { event }),
});
const products = parseProducts(process.env.OPENASY_PRODUCTS);
if (products.invalid.length) log("warn", "OPENASY_PRODUCTS: left out entries that are not id=https://address", { entries: products.invalid });

const awareness = createAwareness(db, { dns: systemDns(dnsServers), sealer: sealer(secretsKey), publicUrl });

const server = createServer(
  createApp({
    db,
    awareness,
    version,
    auth,
    webDir: !headless && existsSync(webDir) ? webDir : undefined,
    docsDir: existsSync(docsDir) ? docsDir : undefined,
    openapi,
    serveMetrics: metricsPort === undefined,
    products: products.products,
  }),
);
const metricsServer = metricsPort !== undefined ? createServer(createMetricsHandler(awareness, version)) : undefined;
metricsServer?.listen(metricsPort, () => log("info", "metrics on their own port", { port: metricsPort }));

server.listen(port, () => log("info", "awareness started", { version, port, db: dbPath, headless, recheckHours }));
if (!publicUrl.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(publicUrl)) {
  log("warn", "AWARENESS_PUBLIC_URL is not https: browsers will not keep secure cookies or allow passkeys. Put Awareness behind TLS (ADR 0026)", {
    url: publicUrl,
  });
}
if (!secretsKey)
  log("warn", "no secrets key: the SMTP password and Identity token are not encrypted. Mount a 32-byte key (openssl rand -hex 32)", { file: secretsKeyFile });
const setup = auth.setupLink();
// No default password (ADR 0013): the first person to open this link becomes the owner.
if (setup) log("info", "no owner yet: open this link once to create the owner account", { url: setup });

// The schedule, asked hourly: re-read the verified domains' TXT records so a domain whose record has gone stops
// being a place campaigns can reach.
const tick = () => {
  void awareness.recheckDomains();
};
const timers: NodeJS.Timeout[] = [setInterval(() => auth.purge(), 5 * 60_000), setInterval(tick, recheckHours * 3_600_000)];

function shutdown(signal: string) {
  log("info", "shutting down", { signal });
  for (const t of timers) clearInterval(t);
  metricsServer?.close();
  void awareness.idle().then(() => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
