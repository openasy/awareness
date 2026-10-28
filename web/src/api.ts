// The UI is an ordinary client of the public API (ADR 0014, 0018). Types follow openapi.json.

export interface ProductLink {
  id: string;
  url: string;
}

export interface Domain {
  id: string;
  name: string;
  state: "pending" | "verified" | "lost";
  proof: { name: string; type: "TXT"; value: string };
  createdAt: string;
  createdBy: string;
  verifiedAt: string | null;
  checkedAt: string | null;
  error: string | null;
  people: number;
}

export interface Person {
  id: string;
  email: string;
  name: string;
  department: string | null;
  source: "identity" | "csv";
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Template {
  id: string;
  name: string;
  category: "document" | "it" | "delivery" | "hr";
  displayFrom: string;
  subject: string;
  tell: string;
  lines: string[];
  action: string;
}

export interface CampaignStats {
  recipients: number;
  sent: number;
  failed: number;
  opened: number;
  clicked: number;
  submitted: number;
  reported: number;
}

export interface Campaign {
  id: string;
  name: string;
  templateId: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  reportAddress: string;
  department: string | null;
  state: "draft" | "sending" | "sent" | "failed";
  createdAt: string;
  createdBy: string;
  sentAt: string | null;
  error: string | null;
  stats: CampaignStats;
}

export interface Module {
  id: string;
  title: string;
  minutes: number;
  required: boolean;
  body: string[];
  questions: Array<{ prompt: string; options: string[] }>;
}

export interface Assignment {
  id: string;
  moduleId: string;
  moduleTitle: string;
  personId: string;
  personName: string;
  reason: string;
  assignedAt: string;
  dueAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  score: number | null;
  passed: boolean | null;
}

export interface RiskPerson {
  id: string;
  name: string;
  department: string | null;
  campaigns: number;
  clicked: number;
  submitted: number;
  reported: number;
  trainingDue: number;
  trainingDone: number;
  risk: number;
}

export interface RiskGroup {
  department: string;
  people: number;
  risk: number;
  clicked: number;
  reported: number;
}

export interface Risk {
  groups: RiskGroup[];
  people: RiskPerson[];
  timeline: Array<{ id: string; name: string; at: string; clickRate: number; reportRate: number }>;
}

export interface Summary {
  domains: { verified: number; pending: number; lost: number };
  people: number;
  campaigns: number;
  lastCampaign: Campaign | null;
  training: { assigned: number; completed: number; overdue: number; completionPct: number };
  smtp: boolean;
  identity: { url: string; connected: boolean } | null;
}

export interface SmtpStatus {
  host: string;
  port: number;
  security: string;
  username: string | null;
  hasPassword: boolean;
}

export interface Settings {
  smtp: SmtpStatus | null;
  identity: { url: string; connected: boolean } | null;
}

export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  action: string;
  target: string;
  detail: string;
}

export class Unauthorized extends Error {}
/** The signed-in owner or admin has no second factor yet; the sign-in gate asks for one. */
export class MfaSetupRequired extends Error {}
export class ApiError extends Error {}

// The session is an HttpOnly cookie set by sign-in (@openasy/auth); the browser sends it, nothing is stored here.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(init.body && !(init.headers as Record<string, string>)?.["content-type"] ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
    if (res.status === 401) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new ApiError(problem.detail ?? `${path}: ${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}
