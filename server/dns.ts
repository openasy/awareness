// DNS, read the way any resolver reads it: the proof that a domain is the organisation's own. A recipient is only
// ever sent to when its address is in a domain proven here, so the same TXT check Attack Surface uses for its scan
// roots (attack-surface/server/dns.ts) gates who a campaign can reach (ADR 0071).
import { Resolver } from "node:dns/promises";

/** What is asked of DNS: only TXT, since Awareness proves ownership and sends nothing else. Tests replace it whole. */
export interface Dns {
  txt(name: string): Promise<string[]>;
}

/** Answers that mean "nothing there"; any other failure, such as a timeout, is thrown so a check does not read a
 * verified domain as lost on a blip. */
const EMPTY = new Set(["ENODATA", "ENOTFOUND", "ENONAME", "NXDOMAIN", "ENOTIMP"]);

async function orEmpty<T>(lookup: Promise<T[]>): Promise<T[]> {
  try {
    return await lookup;
  } catch (err) {
    if (EMPTY.has((err as { code?: string }).code ?? "")) return [];
    throw err;
  }
}

/** The system's resolver, or the servers in AWARENESS_DNS_SERVERS. */
export function systemDns(servers: string[] = []): Dns {
  const r = new Resolver({ timeout: 5000, tries: 2 });
  if (servers.length) r.setServers(servers);
  return {
    txt: async (name) => (await orEmpty(r.resolveTxt(name))).map((parts) => parts.join("")),
  };
}

/** Where the proof of ownership of a domain is published, as _acme-challenge is for Let's Encrypt. */
export const proofName = (domain: string) => `_openasy-awareness.${domain}`;
export const proofValue = (token: string) => `openasy-awareness-verification=${token}`;

/** Whether the domain's proof record holds this token. */
export async function hasProof(dns: Dns, domain: string, token: string): Promise<boolean> {
  return (await dns.txt(proofName(domain))).some((t) => t.trim() === proofValue(token));
}
