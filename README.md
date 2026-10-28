# awareness

[![CI](https://github.com/openasy/awareness/actions/workflows/ci.yml/badge.svg)](https://github.com/openasy/awareness/actions/workflows/ci.yml)
[![Node.js 26 LTS](https://img.shields.io/badge/node-26%20LTS-339933?logo=nodedotjs&logoColor=white)](./.nvmrc)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)

The [OpenAsy](https://github.com/openasy) Awareness product: **run phishing simulations for your own people, train
whoever clicks, and keep the training records an audit asks for** (ADR 0071). Most breaches start with a person. This
is the management system a security team runs for its own organisation, the same kind of tool as GoPhish or a
commercial awareness platform: it produces the consent, tracking and compliance evidence (ISO 27001 A.6.3, PCI DSS
12.6.1), not convincing lures.

```
example.com ──TXT proof──▶ awareness ──▶ your people (Identity or CSV) ──campaign, your SMTP relay──▶ simulated mail
  (you own it)                  │                                                                         │
                               └──▶ only verified domains are reachable                 click / report / open ──▶ landing page
                                                                                         (no field is ever captured)
                                                                                                │
                                                                       training module + quiz ──▶ completion ──▶ /metrics ──▶ Compliance
```

## Only your own people, and nothing deceptive kept

This is a defensive tool for a consented, internal programme. Its first rules are safety rules:

- **A recipient is only ever mailed when its address is in a domain you have proven**, the same TXT check Attack
  Surface uses for its scan roots. Awareness gives a random token, and the domain is verified when
  `_openasy-awareness.example.com` has the TXT record `openasy-awareness-verification=<token>`. The campaign's from
  address must be in a verified domain too. A domain whose record has gone is marked lost and can no longer be
  reached. People come only from the Identity directory you connect or a CSV you import, and an address outside the
  verified domains is left out, with a count of how many.
- **Mail goes only through your own SMTP relay**, whose password is sealed with the install's key (ADR 0021). Awareness
  runs no relay of its own and sends mail no other way. Every simulation message carries an `X-OpenAsy-Awareness:
  simulation` header so a mail team can filter and audit it.
- **The landing page captures nothing.** It records that a link was clicked or a form submitted, and no more. The
  simulated sign-in form has inputs with no name, and the handler reads no request body (`server/app.ts`,
  `discardBody`), so nothing a person types is ever sent to or stored by the server. There is no column for it. The
  page then shows a short debrief. The open pixel is optional and labelled unreliable.
- **The built-in templates are obvious drills.** Each shows a visible `SECURITY AWARENESS TEST` banner and a fictional
  `Example Corp` sender under `example-corp.test`; none impersonates a real brand (`server/templates.ts`). They are
  useful only inside this programme. Write your own for a harder drill; the built-in set stays plainly a test.
- **Every campaign names an admin, is audited, and has a report-phish address.** A reported mail counts for the
  campaign, the behaviour the programme is trying to grow.

## What it does

- **Campaigns.** Choose a template, a from address in a verified domain and a report address; Awareness builds a
  recipient for every eligible person and sends through your relay. Each recipient gets an opaque token; the links in
  the mail carry only that token.
- **Tracking without capture.** A click, a form submission and a report are each recorded once, by token. Clicking a
  simulation auto-assigns the short "Spotting a phishing email" module.
- **Training.** Short modules with a quiz, graded on the server (the answers are never sent to the page). Completion
  is recorded per person and becomes compliance evidence.
- **Risk.** A per-person and per-group score over time: a submitted form weighs most, a click next, reporting lowers
  it, and training not finished keeps it up. The campaign timeline shows click and report rate per campaign.
- **Evidence.** `/metrics` serves training completion and the last campaign's numbers for Compliance (ADR 0058).

## Run

```bash
openssl rand -hex 32 > openasy-kek
docker compose up -d
docker compose logs awareness | grep 'no owner yet'
```

Open the link from the log once to create the owner account; there is no default password (ADR 0013). The UI and API
are on http://localhost:8080, the API reference at http://localhost:8080/api/docs/. Then: add a domain under Domains
and publish its TXT record, set your SMTP relay under Connections, add people under People, and create a campaign.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `AWARENESS_PUBLIC_URL` | `http://localhost:8080` | The address people and recipients open, with `https://` behind your TLS proxy |
| `AWARENESS_RECHECK_HOURS` | `24` | Hours between re-reading the verified domains' TXT records, 1 to 168 |
| `AWARENESS_DNS_SERVERS` | the system's | Resolvers to ask, such as `1.1.1.1,9.9.9.9` |
| `OPENASY_PRODUCTS` | | The install's other OpenAsy products, for the product switcher |
| `AWARENESS_SECRETS_KEY_FILE` | `/run/secrets/openasy-kek` | 32-byte key-encryption key for the SMTP password, Identity token and sign-in secrets |
| `AWARENESS_DB` | `/data/awareness.db` | SQLite file (WAL), on the `/data` volume |
| `AWARENESS_METRICS_PORT` | | Serve `/metrics` on this port only (ADR 0026) |
| `AWARENESS_HEADLESS` | `false` | `true` serves only the API |
| `AWARENESS_PASSWORD_SIGN_IN`, `OPENASY_OIDC_*` | | Sign-in, as in every OpenAsy product ([@openasy/auth](https://github.com/openasy/auth)) |

The SMTP relay and the Identity viewer token are set at runtime, under Connections (or `PUT /api/v1/settings/smtp` and
`/identity`), and sealed with the key (ADR 0021). Awareness will not send a campaign until a relay is set.

`/metrics` has `openasy_awareness_domains` by state, `openasy_awareness_people`, `openasy_awareness_campaigns`,
`openasy_awareness_training_assigned`, `openasy_awareness_training_completed`, `openasy_awareness_training_overdue`,
`openasy_awareness_training_completion_ratio`, and `openasy_awareness_last_campaign_recipients`, `_clicked`,
`_submitted`, `_reported` and `_timestamp_seconds`. Compliance judges A.6.3 and CC2.2 on these (ADR 0058).

The container runs as non-root with a read-only root filesystem, no capabilities and `no-new-privileges`.

## Roles

Viewers see everything; editors also add and verify domains, import people and create campaigns; admins also connect
the SMTP relay and Identity, sync the directory, delete domains, read the audit log, and manage members and API tokens
(ADR 0003). Every campaign, domain change, directory sync and setting change is written to an append-only audit log in
SQLite and to the log as an audit event (ADR 0013).

## Not yet

A 0.1.0, with these not built: ingesting a real report-phish mailbox (a report is recorded through the report link or
`POST`, not by parsing forwarded mail); scheduling and recurring campaigns; reminders to overdue trainees; custom
templates and modules in the UI (the built-in sets are read-only); per-landing-page custom debrief content; sending
evidence packs to Compliance directly rather than through `/metrics`; STARTTLS/implicit-TLS verified against a pinned
CA; and bounce handling. Anything deceptive beyond the plainly-labelled built-in drills is deliberately out of scope.

## Develop

```bash
npm install
npm test        # domains, the verified-domain gate, SMTP against a local catcher, tracking with no capture, training, risk, and every API response against openapi.json
npm run dev     # the UI, with the API on :8080
node scripts/openapi.ts   # after changing the API
```

The tests never send real mail or touch the internet: DNS is a fake, and every campaign is sent to an SMTP catcher the
test starts on this machine.

## Licence

AGPL-3.0 (ADR 0008).
