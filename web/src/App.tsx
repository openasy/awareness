import {
  AppShell,
  Badge,
  BrandProvider,
  Button,
  Callout,
  DataTable,
  Dialog,
  EmptyState,
  KpiCard,
  KpiGrid,
  navigate,
  OverviewGrid,
  PageHeader,
  Panel,
  PRODUCT_IDS,
  SearchInput,
  SelectField,
  StatusBadge,
  TextField,
  toLocale,
  useLocalePreference,
  usePath,
  useThemePreference,
  type Column,
  type ProductId,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAccountMenu, useAuth, useInstallBrand } from "@openasy/auth/react";
import colophon from "virtual:openasy-colophon";
import { BookOpenCheck, FileStack, Fish, LogOut, Mail, Plug, RefreshCw, ScrollText, ShieldAlert, Upload, UserRound, Users } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  api,
  MfaSetupRequired,
  Unauthorized,
  type Assignment,
  type AuditEntry,
  type Campaign,
  type Domain,
  type Module,
  type Person,
  type ProductLink,
  type Risk,
  type Settings,
  type Summary,
  type Template,
} from "./api.ts";
import { useT, type T } from "./i18n.ts";

const PAGES = ["campaigns", "people", "domains", "training", "risk", "connections", "audit", "account", "members", "signin", "tokens"] as const;
type Page = "overview" | (typeof PAGES)[number];
export const PATHS = ["overview", ...PAGES];
function parsePage(path: string): Page {
  const page = path.replace(/^\//, "").split("/")[0] ?? "";
  return (PAGES as readonly string[]).includes(page) ? (page as Page) : "overview";
}

/** Data loading with the session; when it ends, the sign-in screen comes back. */
function useApi() {
  const { expired, refresh } = useAuth();
  return useCallback(
    async <R,>(path: string, init?: RequestInit): Promise<R> => {
      try {
        return await api<R>(path, init);
      } catch (err) {
        if (err instanceof Unauthorized) expired();
        if (err instanceof MfaSetupRequired) void refresh();
        throw err;
      }
    },
    [expired, refresh],
  );
}
type Call = ReturnType<typeof useApi>;

function useLoad<R>(call: Call, path: string | null, every?: number) {
  const [data, setData] = useState<R>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    if (!path) return;
    void call<R>(path).then(
      (d) => (setData(d), setError(undefined)),
      (err: Error) => setError(err.message),
    );
  }, [call, path]);
  useEffect(() => {
    load();
    if (!every) return;
    const t = setInterval(load, every);
    return () => clearInterval(t);
  }, [load, every]);
  return [data, error, load] as const;
}

function useAct(reload: () => void) {
  const [error, setError] = useState<string>();
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError(undefined);
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return [act, error] as const;
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 1000) / 10}%` : "–");

function ErrorText({ message }: { message?: string }) {
  return message ? <p className="m-0 text-xs text-danger">{message}</p> : null;
}

const CAMPAIGN_TONE = { draft: "neutral", sending: "info", sent: "success", failed: "danger" } as const;

// ---------------------------------------------------------------- Overview

function OverviewPage({ summary }: { summary: Summary }) {
  const t = useT();
  const last = summary.lastCampaign;
  const ready = summary.domains.verified > 0 && summary.smtp && summary.people > 0;
  return (
    <>
      <PageHeader title={t("overview.title")} description={t("overview.description")} />
      {!ready && (
        <Callout
          tone="info"
          title={t("overview.setup")}
          action={
            <Button size="sm" variant="primary" onClick={() => navigate(summary.domains.verified ? (summary.smtp ? "/people" : "/connections") : "/domains")}>
              {t("overview.setupGo")}
            </Button>
          }
        >
          {t("overview.setupDetail")}
        </Callout>
      )}
      <KpiGrid minWidth={180}>
        <KpiCard label={t("overview.kpiPeople")} value={summary.people} icon={Users} href="/people" />
        <KpiCard
          label={t("overview.kpiDomains")}
          value={summary.domains.verified}
          unit={t("overview.verified")}
          icon={ShieldAlert}
          tone={summary.domains.verified ? "success" : "warning"}
          href="/domains"
        />
        <KpiCard label={t("overview.kpiCampaigns")} value={summary.campaigns} icon={Fish} href="/campaigns" />
        <KpiCard
          label={t("overview.kpiTraining")}
          value={`${summary.training.completionPct}%`}
          unit={t("overview.ofAssigned")}
          icon={BookOpenCheck}
          tone={summary.training.overdue ? "warning" : "success"}
          href="/training"
        />
      </KpiGrid>
      {last && (
        <Panel title={t("overview.lastCampaign")} description={`${last.name} · ${when(last.createdAt)}`}>
          <dl className="as-facts text-sm">
            <dt className="text-fg-muted">{t("campaigns.recipients")}</dt>
            <dd>{last.stats.recipients}</dd>
            <dt className="text-fg-muted">{t("campaigns.clicked")}</dt>
            <dd>{pct(last.stats.clicked, last.stats.recipients)}</dd>
            <dt className="text-fg-muted">{t("campaigns.reported")}</dt>
            <dd>{pct(last.stats.reported, last.stats.recipients)}</dd>
            <dt className="text-fg-muted">{t("campaigns.state")}</dt>
            <dd>
              <StatusBadge tone={CAMPAIGN_TONE[last.state]}>{t(`campaignStates.${last.state}`)}</StatusBadge>
            </dd>
          </dl>
        </Panel>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Domains

function DomainsPage({ call, reloadSummary }: { call: Call; reloadSummary: () => void }) {
  const t = useT();
  const { can } = useAuth();
  const [data, loadError, reload] = useLoad<{ domains: Domain[] }>(call, "/api/v1/domains");
  const [act, error] = useAct(() => (reload(), reloadSummary()));
  const [name, setName] = useState("");
  const [added, setAdded] = useState<Domain>();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    await act(async () => {
      const d = await call<Domain>("/api/v1/domains", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
      setAdded(d);
      setName("");
    });
  };
  const columns: Column<Domain>[] = [
    { id: "name", header: t("domains.name"), cell: (d) => <span className="font-medium">{d.name}</span>, sortValue: (d) => d.name },
    {
      id: "state",
      header: t("domains.state"),
      cell: (d) => (
        <StatusBadge tone={d.state === "verified" ? "success" : d.state === "lost" ? "danger" : "warning"}>{t(`domainStates.${d.state}`)}</StatusBadge>
      ),
    },
    { id: "people", header: t("domains.people"), align: "right", mono: true, cell: (d) => d.people },
    {
      id: "act",
      header: <span className="sr-only">{t("domains.verify")}</span>,
      align: "right",
      cell: (d) =>
        can("editor") && d.state !== "verified" ? (
          <Button size="xs" onClick={() => void act(() => call(`/api/v1/domains/${d.id}/verify`, { method: "POST" }))}>
            {t("domains.verify")}
          </Button>
        ) : null,
    },
  ];
  return (
    <>
      <PageHeader
        title={t("domains.title")}
        description={t("domains.description")}
        actions={
          can("editor") && (
            <Button variant="primary" onClick={() => (setAdded(undefined), setName(" "), setName(""))}>
              {t("domains.add")}
            </Button>
          )
        }
      />
      <ErrorText message={error ?? loadError} />
      {added && (
        <Callout tone="info" title={t("domains.publish")}>
          <pre className="m-0 overflow-x-auto rounded-md bg-subtle px-2.5 py-2 font-mono text-xs whitespace-pre-wrap">{`${added.proof.name}  TXT  "${added.proof.value}"`}</pre>
          <p className="mt-2 mb-0 text-xs text-fg-muted">{t("domains.thenVerify")}</p>
        </Callout>
      )}
      {can("editor") && (
        <Panel title={t("domains.add")} description={t("domains.addDetail")}>
          <form className="flex items-end gap-2.5" onSubmit={save}>
            <TextField label={t("domains.name")} value={name} onChange={(e) => setName(e.target.value)} placeholder="example.com" mono />
            <Button type="submit" variant="primary" disabled={!name.trim()}>
              {t("domains.add")}
            </Button>
          </form>
        </Panel>
      )}
      <Panel title={t("domains.title")} flush>
        <DataTable
          label={t("domains.title")}
          columns={columns}
          rows={data?.domains ?? []}
          loading={!data}
          getRowId={(d) => d.id}
          minWidth={620}
          empty={<EmptyState title={t("domains.none")}>{t("domains.noneDetail")}</EmptyState>}
        />
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- People

function PeoplePage({ call, reloadSummary }: { call: Call; reloadSummary: () => void }) {
  const t = useT();
  const { can } = useAuth();
  const [data, loadError, reload] = useLoad<{ people: Person[] }>(call, "/api/v1/people");
  const [act, error] = useAct(() => (reload(), reloadSummary()));
  const [q, setQ] = useState("");
  const [csv, setCsv] = useState("email,name,department\n");
  const [note, setNote] = useState<string>();
  const importCsv = () =>
    void act(async () => {
      const r = await call<{ added: number; updated: number; rejected: number }>("/api/v1/people/import", {
        method: "POST",
        headers: { "content-type": "text/csv" },
        body: csv,
      });
      setNote(t("people.imported", { added: r.added, updated: r.updated, rejected: r.rejected }));
    });
  const rows = (data?.people ?? []).filter((p) => !q || `${p.name} ${p.email} ${p.department ?? ""}`.toLowerCase().includes(q.toLowerCase()));
  const columns: Column<Person>[] = [
    { id: "name", header: t("people.name"), cell: (p) => <span className="font-medium">{p.name}</span>, sortValue: (p) => p.name },
    { id: "email", header: t("people.email"), mono: true, cell: (p) => <span className="text-xs">{p.email}</span> },
    { id: "dept", header: t("people.department"), cell: (p) => p.department ?? "–" },
    { id: "source", header: t("people.source"), cell: (p) => <Badge>{p.source}</Badge> },
  ];
  return (
    <>
      <PageHeader
        title={t("people.title")}
        description={t("people.description")}
        actions={
          <>
            <SearchInput label={t("people.search")} value={q} onChange={(e) => setQ(e.target.value)} className="w-56" />
            {can("admin") && (
              <Button icon={<RefreshCw />} onClick={() => void act(() => call("/api/v1/people/sync", { method: "POST" }))}>
                {t("people.sync")}
              </Button>
            )}
          </>
        }
      />
      <ErrorText message={error ?? loadError} />
      {note && (
        <p role="status" className="text-sm text-success">
          {note}
        </p>
      )}
      {can("editor") && (
        <Panel title={t("people.import")} description={t("people.importDetail")}>
          <div className="flex flex-col gap-2.5">
            <textarea className="as-textarea" rows={4} value={csv} onChange={(e) => setCsv(e.target.value)} aria-label={t("people.import")} />
            <Button className="self-start" icon={<Upload />} onClick={importCsv}>
              {t("people.import")}
            </Button>
          </div>
        </Panel>
      )}
      <Panel title={t("people.title")} description={t("people.shown", { n: rows.length })} flush>
        <DataTable
          label={t("people.title")}
          columns={columns}
          rows={rows}
          loading={!data}
          getRowId={(p) => p.id}
          minWidth={720}
          empty={<EmptyState title={t("people.none")}>{t("people.noneDetail")}</EmptyState>}
        />
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- Campaigns

function NewCampaignDialog({ call, open, onClose, onSaved }: { call: Call; open: boolean; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const [templates] = useLoad<{ templates: Template[] }>(call, open ? "/api/v1/templates" : null);
  const [domains] = useLoad<{ domains: Domain[] }>(call, open ? "/api/v1/domains" : null);
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [fromEmail, setFromEmail] = useState("");
  const [reportAddress, setReportAddress] = useState("");
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (open) (setName(""), setTemplateId(""), setFromEmail(""), setReportAddress(""), setError(undefined));
  }, [open]);
  const verified = (domains?.domains ?? []).filter((d) => d.state === "verified");
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await call("/api/v1/campaigns", { method: "POST", body: JSON.stringify({ name, templateId, fromEmail, reportAddress }) });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("campaigns.new")}
      description={t("campaigns.newDetail")}
      onSubmit={(e) => void save(e)}
      footer={
        <>
          <Button onClick={onClose}>{t("campaigns.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || !templateId || !fromEmail.trim() || !reportAddress.trim()}>
            {t("campaigns.create")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2.5">
        <TextField label={t("campaigns.name")} value={name} onChange={(e) => setName(e.target.value)} />
        <SelectField
          label={t("campaigns.template")}
          value={templateId}
          onChange={(e) => setTemplateId(e.target.value)}
          options={[{ value: "", label: t("campaigns.pickTemplate") }, ...(templates?.templates ?? []).map((tp) => ({ value: tp.id, label: tp.name }))]}
        />
        <SelectField
          label={t("campaigns.from")}
          value={fromEmail}
          onChange={(e) => setFromEmail(e.target.value)}
          options={[
            { value: "", label: verified.length ? t("campaigns.pickFrom") : t("campaigns.noVerified") },
            ...verified.map((d) => ({ value: `security@${d.name}`, label: `security@${d.name}` })),
          ]}
        />
        <TextField
          label={t("campaigns.report")}
          value={reportAddress}
          onChange={(e) => setReportAddress(e.target.value)}
          placeholder="report-phish@example.com"
          mono
        />
        <ErrorText message={error} />
      </div>
    </Dialog>
  );
}

function CampaignsPage({ call, reloadSummary }: { call: Call; reloadSummary: () => void }) {
  const t = useT();
  const { can } = useAuth();
  const [data, loadError, reload] = useLoad<{ campaigns: Campaign[] }>(call, "/api/v1/campaigns", 10_000);
  const [open, setOpen] = useState(false);
  const columns: Column<Campaign>[] = [
    {
      id: "name",
      header: t("campaigns.campaign"),
      cell: (c) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{c.name}</span>
          <span className="text-2xs text-fg-muted">{when(c.createdAt)}</span>
        </span>
      ),
      sortValue: (c) => c.name,
    },
    { id: "recipients", header: t("campaigns.recipients"), align: "right", mono: true, cell: (c) => c.stats.recipients },
    { id: "clicked", header: t("campaigns.clicked"), align: "right", mono: true, cell: (c) => pct(c.stats.clicked, c.stats.recipients) },
    { id: "submitted", header: t("campaigns.submitted"), align: "right", mono: true, cell: (c) => c.stats.submitted },
    { id: "reported", header: t("campaigns.reported"), align: "right", mono: true, cell: (c) => pct(c.stats.reported, c.stats.recipients) },
    { id: "state", header: t("campaigns.state"), cell: (c) => <StatusBadge tone={CAMPAIGN_TONE[c.state]}>{t(`campaignStates.${c.state}`)}</StatusBadge> },
  ];
  return (
    <>
      <PageHeader
        title={t("campaigns.title")}
        description={t("campaigns.description")}
        actions={
          can("editor") && (
            <Button variant="primary" icon={<Fish />} onClick={() => setOpen(true)}>
              {t("campaigns.new")}
            </Button>
          )
        }
      />
      <ErrorText message={loadError} />
      <Panel title={t("campaigns.title")} flush>
        <DataTable
          label={t("campaigns.title")}
          columns={columns}
          rows={data?.campaigns ?? []}
          loading={!data}
          getRowId={(c) => c.id}
          minWidth={820}
          empty={<EmptyState title={t("campaigns.none")}>{t("campaigns.noneDetail")}</EmptyState>}
        />
      </Panel>
      <NewCampaignDialog call={call} open={open} onClose={() => setOpen(false)} onSaved={() => (setOpen(false), reload(), reloadSummary())} />
    </>
  );
}

// ---------------------------------------------------------------- Training

function TrainingPage({ call }: { call: Call }) {
  const t = useT();
  const [modules] = useLoad<{ modules: Module[] }>(call, "/api/v1/modules");
  const [data, loadError] = useLoad<{ assignments: Assignment[] }>(call, "/api/v1/training", 15_000);
  const columns: Column<Assignment>[] = [
    { id: "person", header: t("training.person"), cell: (a) => <span className="font-medium">{a.personName}</span>, sortValue: (a) => a.personName },
    { id: "module", header: t("training.module"), cell: (a) => a.moduleTitle },
    { id: "assigned", header: t("training.assigned"), cell: (a) => <span className="text-xs text-fg-muted">{when(a.assignedAt)}</span> },
    {
      id: "state",
      header: t("training.state"),
      cell: (a) =>
        a.completedAt ? (
          <StatusBadge tone={a.passed ? "success" : "warning"}>
            {a.passed ? t("training.passed", { score: a.score ?? 0 }) : t("training.failed", { score: a.score ?? 0 })}
          </StatusBadge>
        ) : a.dueAt && Date.parse(a.dueAt) < Date.now() ? (
          <StatusBadge tone="danger">{t("training.overdue")}</StatusBadge>
        ) : (
          <StatusBadge tone="info">{t("training.open")}</StatusBadge>
        ),
    },
  ];
  return (
    <>
      <PageHeader title={t("training.title")} description={t("training.description")} />
      <ErrorText message={loadError} />
      <OverviewGrid>
        <Panel title={t("training.assignments")} flush>
          <DataTable
            label={t("training.assignments")}
            columns={columns}
            rows={data?.assignments ?? []}
            loading={!data}
            getRowId={(a) => a.id}
            minWidth={620}
            empty={<EmptyState title={t("training.none")}>{t("training.noneDetail")}</EmptyState>}
          />
        </Panel>
        <Panel title={t("training.modules")} description={t("training.modulesDetail")}>
          <ul className="as-list flex flex-col gap-2.5">
            {(modules?.modules ?? []).map((m) => (
              <li key={m.id} className="flex flex-col">
                <span className="font-medium">{m.title}</span>
                <span className="text-xs text-fg-muted">
                  {t("training.minutes", { n: m.minutes })} · {m.required ? t("training.required") : t("training.optional")} ·{" "}
                  {t("training.questions", { n: m.questions.length })}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </OverviewGrid>
    </>
  );
}

// ---------------------------------------------------------------- Risk

function RiskPage({ call }: { call: Call }) {
  const t = useT();
  const [data, loadError] = useLoad<Risk>(call, "/api/v1/risk", 15_000);
  const groupCols: Column<Risk["groups"][number]>[] = [
    { id: "dept", header: t("risk.team"), cell: (g) => <span className="font-medium">{g.department}</span>, sortValue: (g) => g.department },
    { id: "people", header: t("risk.people"), align: "right", mono: true, cell: (g) => g.people },
    {
      id: "risk",
      header: t("risk.risk"),
      align: "right",
      cell: (g) => <Badge tone={g.risk >= 70 ? "danger" : g.risk >= 40 ? "warning" : "success"}>{g.risk}</Badge>,
    },
    { id: "reported", header: t("risk.reported"), align: "right", mono: true, cell: (g) => g.reported },
  ];
  const peopleCols: Column<Risk["people"][number]>[] = [
    { id: "name", header: t("risk.person"), cell: (p) => <span className="font-medium">{p.name}</span>, sortValue: (p) => p.name },
    { id: "team", header: t("risk.team"), cell: (p) => p.department ?? "–" },
    { id: "clicked", header: t("risk.clicked"), align: "right", mono: true, cell: (p) => `${p.clicked}/${p.campaigns}` },
    { id: "reported", header: t("risk.reported"), align: "right", mono: true, cell: (p) => `${p.reported}/${p.campaigns}` },
    { id: "training", header: t("risk.training"), align: "right", mono: true, cell: (p) => `${p.trainingDone}/${p.trainingDue}` },
    {
      id: "risk",
      header: t("risk.risk"),
      align: "right",
      cell: (p) => <Badge tone={p.risk >= 70 ? "danger" : p.risk >= 40 ? "warning" : "success"}>{p.risk}</Badge>,
    },
  ];
  return (
    <>
      <PageHeader title={t("risk.title")} description={t("risk.description")} />
      <ErrorText message={loadError} />
      <OverviewGrid>
        <Panel title={t("risk.byTeam")} flush>
          <DataTable
            label={t("risk.byTeam")}
            columns={groupCols}
            rows={data?.groups ?? []}
            loading={!data}
            getRowId={(g) => g.department}
            defaultSort={{ id: "risk", direction: "desc" }}
            minWidth={480}
            empty={<EmptyState title={t("risk.none")} />}
          />
        </Panel>
        <Panel title={t("risk.timeline")} description={t("risk.timelineDetail")}>
          <ul className="as-list flex flex-col gap-1.5 text-sm">
            {(data?.timeline ?? []).map((c) => (
              <li key={c.id} className="flex items-baseline justify-between gap-2">
                <span className="truncate">{c.name}</span>
                <span className="font-mono text-xs text-fg-muted">
                  {t("risk.click")} {c.clickRate}% · {t("risk.report")} {c.reportRate}%
                </span>
              </li>
            ))}
            {!data?.timeline.length && <li className="text-fg-muted">{t("risk.noTimeline")}</li>}
          </ul>
        </Panel>
      </OverviewGrid>
      <Panel title={t("risk.byPerson")} flush>
        <DataTable
          label={t("risk.byPerson")}
          columns={peopleCols}
          rows={data?.people ?? []}
          loading={!data}
          getRowId={(p) => p.id}
          defaultSort={{ id: "risk", direction: "desc" }}
          minWidth={720}
          empty={<EmptyState title={t("risk.none")}>{t("risk.noneDetail")}</EmptyState>}
        />
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- Connections (SMTP + Identity)

function ConnectionsPage({ call, reloadSummary }: { call: Call; reloadSummary: () => void }) {
  const t = useT();
  const { can } = useAuth();
  const [data, loadError, reload] = useLoad<Settings>(call, can("admin") ? "/api/v1/settings" : null);
  const [act, error] = useAct(() => (reload(), reloadSummary()));
  const [host, setHost] = useState("");
  const [port, setPort] = useState("587");
  const [security, setSecurity] = useState("starttls");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [idUrl, setIdUrl] = useState("");
  const [idToken, setIdToken] = useState("");
  if (!can("admin")) return <EmptyState title={t("settingsPage.adminsOnly")}>{t("settingsPage.askAnAdmin")}</EmptyState>;
  const saveSmtp = (e: FormEvent) => {
    e.preventDefault();
    void act(() =>
      call("/api/v1/settings/smtp", {
        method: "PUT",
        body: JSON.stringify({ host, port: Number(port), security, username: username || undefined, password: password || undefined }),
      }),
    );
  };
  const saveIdentity = (e: FormEvent) => {
    e.preventDefault();
    void act(() => call("/api/v1/settings/identity", { method: "PUT", body: JSON.stringify({ url: idUrl, token: idToken }) }));
  };
  return (
    <>
      <PageHeader title={t("connections.title")} description={t("connections.description")} />
      <ErrorText message={error ?? loadError} />
      <OverviewGrid>
        <Panel
          title={t("connections.smtp")}
          description={data?.smtp ? t("connections.smtpSet", { host: data.smtp.host, port: data.smtp.port }) : t("connections.smtpNone")}
        >
          <form className="flex flex-col gap-2.5" onSubmit={saveSmtp}>
            <TextField label={t("connections.host")} value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.example.com" mono />
            <TextField label={t("connections.port")} value={port} onChange={(e) => setPort(e.target.value)} mono />
            <SelectField
              label={t("connections.security")}
              value={security}
              onChange={(e) => setSecurity(e.target.value)}
              options={[
                { value: "starttls", label: "STARTTLS" },
                { value: "tls", label: "TLS" },
                { value: "none", label: t("connections.securityNone") },
              ]}
            />
            <TextField label={t("connections.username")} value={username} onChange={(e) => setUsername(e.target.value)} />
            <TextField label={t("connections.password")} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <Button className="self-start" type="submit" variant="primary" icon={<Mail />} disabled={!host.trim()}>
              {t("connections.save")}
            </Button>
          </form>
        </Panel>
        <Panel
          title={t("connections.identity")}
          description={data?.identity ? t("connections.identitySet", { url: data.identity.url }) : t("connections.identityNone")}
        >
          <form className="flex flex-col gap-2.5" onSubmit={saveIdentity}>
            <TextField
              label={t("connections.identityUrl")}
              value={idUrl}
              onChange={(e) => setIdUrl(e.target.value)}
              placeholder="https://identity.example.com"
              mono
            />
            <TextField label={t("connections.identityToken")} type="password" value={idToken} onChange={(e) => setIdToken(e.target.value)} />
            <Button className="self-start" type="submit" variant="primary" icon={<Plug />} disabled={!idUrl.trim() || !idToken.trim()}>
              {t("connections.save")}
            </Button>
          </form>
        </Panel>
      </OverviewGrid>
    </>
  );
}

// ---------------------------------------------------------------- Audit

function AuditPage({ call }: { call: Call }) {
  const t = useT();
  const { can } = useAuth();
  const [data, error] = useLoad<{ entries: AuditEntry[] }>(call, can("admin") ? "/api/v1/audit" : null);
  if (!can("admin")) return <EmptyState title={t("settingsPage.adminsOnly")}>{t("settingsPage.askAnAdmin")}</EmptyState>;
  const columns: Column<AuditEntry>[] = [
    { id: "at", header: t("auditPage.when"), width: "170px", cell: (e) => <span className="text-xs whitespace-nowrap">{when(e.at)}</span> },
    { id: "actor", header: t("auditPage.who"), cell: (e) => <span className="text-xs">{e.actor}</span> },
    { id: "action", header: t("auditPage.action"), cell: (e) => <Badge mono>{e.action}</Badge> },
    { id: "target", header: t("auditPage.target"), cell: (e) => <span className="font-mono text-xs">{e.target}</span> },
    { id: "detail", header: t("auditPage.detail"), width: "36%", cell: (e) => <span className="as-wrap text-xs text-fg-muted">{e.detail || "–"}</span> },
  ];
  return (
    <>
      <PageHeader title={t("auditPage.audit")} description={t("auditPage.description")} />
      <ErrorText message={error} />
      <Panel title={t("auditPage.audit")} flush>
        <DataTable
          label={t("auditPage.audit")}
          columns={columns}
          rows={data?.entries ?? []}
          loading={!data}
          getRowId={(e) => String(e.id)}
          minWidth={900}
          empty={<EmptyState title={t("auditPage.none")} />}
        />
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- Shell

function SettingsPage({ page }: { page: "account" | "members" | "signin" | "tokens" }) {
  const t = useT();
  const { signOut, can } = useAuth();
  if (page !== "account" && !can("admin")) return <EmptyState title={t("settingsPage.adminsOnly")}>{t("settingsPage.askAnAdmin")}</EmptyState>;
  return (
    <>
      <PageHeader
        title={t(`settingsPage.${page}.title`)}
        description={t(`settingsPage.${page}.description`)}
        actions={
          page === "account" && (
            <Button icon={<LogOut />} onClick={() => void signOut()}>
              {t("settingsPage.signOut")}
            </Button>
          )
        }
      />
      {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : page === "signin" ? <SignInSettings /> : <TokensSettings />}
    </>
  );
}

function pageOf(msg: T, page: Page, call: Call, summary: Summary, reloadSummary: () => void) {
  if (page === "overview") return <OverviewPage summary={summary} />;
  if (page === "campaigns") return <CampaignsPage call={call} reloadSummary={reloadSummary} />;
  if (page === "people") return <PeoplePage call={call} reloadSummary={reloadSummary} />;
  if (page === "domains") return <DomainsPage call={call} reloadSummary={reloadSummary} />;
  if (page === "training") return <TrainingPage call={call} />;
  if (page === "risk") return <RiskPage call={call} />;
  if (page === "connections") return <ConnectionsPage call={call} reloadSummary={reloadSummary} />;
  if (page === "audit") return <AuditPage call={call} />;
  return <EmptyState title={msg("product.loading")} />;
}

function Product() {
  const msg = useT();
  const [theme, setTheme] = useThemePreference();
  const [, setLocale] = useLocalePreference();
  const { me, can } = useAuth();
  const account = useAccountMenu();
  const page = parsePage(usePath());
  const [summary, setSummary] = useState<Summary>();
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);
  const call = useApi();

  useEffect(() => {
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) =>
        setProducts(r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "awareness" && (PRODUCT_IDS as readonly string[]).includes(p.id))),
      () => {},
    );
  }, [call]);

  const reloadSummary = useCallback(() => void call<Summary>("/api/v1/summary").then(setSummary, () => {}), [call]);
  useEffect(() => {
    reloadSummary();
    const t = setInterval(reloadSummary, 15_000);
    return () => clearInterval(t);
  }, [reloadSummary]);

  const nav = [
    { id: "overview", label: msg("product.overview"), icon: ShieldAlert },
    { id: "campaigns", label: msg("product.campaigns"), icon: Fish, count: summary?.campaigns || undefined },
    { id: "people", label: msg("product.people"), icon: Users, count: summary?.people || undefined },
    { id: "domains", label: msg("product.domains"), icon: FileStack, count: summary ? summary.domains.pending + summary.domains.lost || undefined : undefined },
    { id: "training", label: msg("product.training"), icon: BookOpenCheck, count: summary?.training.overdue || undefined },
    { id: "risk", label: msg("product.risk"), icon: ShieldAlert },
  ];
  const footerNav = [
    ...(can("admin")
      ? [
          { id: "connections", label: msg("product.connections"), icon: Plug },
          { id: "audit", label: msg("product.audit"), icon: ScrollText },
          { id: "members", label: msg("product.members"), icon: Users },
          { id: "signin", label: msg("product.signIn"), icon: Plug },
          { id: "tokens", label: msg("product.apiTokens"), icon: ScrollText },
        ]
      : []),
    { id: "account", label: msg("product.account"), icon: UserRound },
  ];
  const roleName = me.user.role.charAt(0).toUpperCase() + me.user.role.slice(1);
  const settings = page === "account" || page === "members" || page === "signin" || page === "tokens";

  return (
    <AppShell
      product="awareness"
      about={colophon}
      nav={nav}
      activeNav={page}
      onNavigate={(id) => navigate(`/${id}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={account.settings(footerNav)}
      user={{ name: me.user.name, role: roleName, ...account.user }}
      theme={theme}
      onThemeChange={setTheme}
      onLanguageChange={(code) => setLocale(toLocale(code))}
    >
      {settings ? (
        <SettingsPage page={page as "account" | "members" | "signin" | "tokens"} />
      ) : !summary ? (
        <EmptyState title={msg("product.loading")} icon={<RefreshCw />}>
          {msg("product.reading")}
        </EmptyState>
      ) : (
        pageOf(msg, page, call, summary, reloadSummary)
      )}
    </AppShell>
  );
}

export function App() {
  const installBrand = useInstallBrand();
  const [theme] = useThemePreference();
  const [locale] = useLocalePreference();
  return (
    <BrandProvider theme={theme} locale={locale} brand={{ name: "OpenAsy", organization: undefined, ...installBrand }} className="min-h-screen">
      <AuthGate product="OpenAsy Awareness">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}
