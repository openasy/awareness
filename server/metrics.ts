// Prometheus text exposition, written by hand: a few lines, no client library needed. Training completion and the
// last campaign's numbers are here so Compliance can judge ISO 27001 A.6.3 and SOC 2 CC2.2 on them (ADR 0058), and
// Alerts can fire when a campaign's report rate stays low (ADR 0071).
import type { Awareness } from "./awareness.ts";

const requests = new Map<string, number>();

export function countRequest(method: string, route: string, status: number) {
  const key = `method="${method}",route="${route}",status="${status}"`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
}

export function renderMetrics(version: string, s: ReturnType<Awareness["summary"]>): string {
  const last = s.lastCampaign;
  const stat = last?.stats;
  const lines = [
    "# HELP openasy_build_info Build information.",
    "# TYPE openasy_build_info gauge",
    `openasy_build_info{product="awareness",version="${version}"} 1`,
    "# HELP openasy_http_requests_total HTTP requests handled.",
    "# TYPE openasy_http_requests_total counter",
    ...[...requests].map(([labels, n]) => `openasy_http_requests_total{${labels}} ${n}`),
    "# HELP openasy_awareness_domains Domains added, by whether their ownership is proven.",
    "# TYPE openasy_awareness_domains gauge",
    ...(["verified", "pending", "lost"] as const).map((state) => `openasy_awareness_domains{state="${state}"} ${s.domains[state]}`),
    "# HELP openasy_awareness_people Active people in the directory.",
    "# TYPE openasy_awareness_people gauge",
    `openasy_awareness_people ${s.people}`,
    "# HELP openasy_awareness_campaigns Campaigns run.",
    "# TYPE openasy_awareness_campaigns gauge",
    `openasy_awareness_campaigns ${s.campaigns}`,
    "# HELP openasy_awareness_training_assigned Training assignments made.",
    "# TYPE openasy_awareness_training_assigned gauge",
    `openasy_awareness_training_assigned ${s.training.assigned}`,
    "# HELP openasy_awareness_training_completed Training assignments completed.",
    "# TYPE openasy_awareness_training_completed gauge",
    `openasy_awareness_training_completed ${s.training.completed}`,
    "# HELP openasy_awareness_training_overdue Training assignments past their due date and not completed.",
    "# TYPE openasy_awareness_training_overdue gauge",
    `openasy_awareness_training_overdue ${s.training.overdue}`,
    "# HELP openasy_awareness_training_completion_ratio Share of training assignments completed, 0 to 1.",
    "# TYPE openasy_awareness_training_completion_ratio gauge",
    `openasy_awareness_training_completion_ratio ${(s.training.completionPct / 100).toFixed(3)}`,
    "# HELP openasy_awareness_last_campaign_recipients People in the last campaign.",
    "# TYPE openasy_awareness_last_campaign_recipients gauge",
    `openasy_awareness_last_campaign_recipients ${stat?.recipients ?? 0}`,
    "# HELP openasy_awareness_last_campaign_clicked People who clicked in the last campaign.",
    "# TYPE openasy_awareness_last_campaign_clicked gauge",
    `openasy_awareness_last_campaign_clicked ${stat?.clicked ?? 0}`,
    "# HELP openasy_awareness_last_campaign_submitted People who submitted the simulated form in the last campaign.",
    "# TYPE openasy_awareness_last_campaign_submitted gauge",
    `openasy_awareness_last_campaign_submitted ${stat?.submitted ?? 0}`,
    "# HELP openasy_awareness_last_campaign_reported People who reported in the last campaign.",
    "# TYPE openasy_awareness_last_campaign_reported gauge",
    `openasy_awareness_last_campaign_reported ${stat?.reported ?? 0}`,
    "# HELP openasy_awareness_last_campaign_timestamp_seconds When the last campaign was created.",
    "# TYPE openasy_awareness_last_campaign_timestamp_seconds gauge",
    ...(last ? [`openasy_awareness_last_campaign_timestamp_seconds ${Math.round(Date.parse(last.createdAt) / 1000)}`] : []),
    "# HELP process_uptime_seconds Seconds since the process started.",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime().toFixed(0)}`,
  ];
  return lines.join("\n") + "\n";
}
