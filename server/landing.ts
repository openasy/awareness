// The pages a recipient sees (ADR 0071). None of them is a real sign-in page and none captures anything. The
// simulated form has inputs with no name, and its handler in app.ts reads no request body, so nothing a person types
// can be sent or stored. Every page carries the SECURITY AWARENESS TEST banner, so no one is misled for a moment.
import { BANNER } from "./templates.ts";
import type { Module } from "./training.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A 1x1 transparent GIF: the open pixel. Opens are a hint only and labelled unreliable in the UI (ADR 0071). */
export const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

function page(title: string, body: string): string {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${esc(title)}</title>`,
    "<style>",
    "body{font-family:system-ui,sans-serif;color:#111;background:#f6f7f9;margin:0;padding:24px;}",
    ".card{max-width:40rem;margin:0 auto;background:#fff;border-radius:10px;padding:24px;box-shadow:0 1px 4px rgba(0,0,0,.08);}",
    ".banner{background:#b91c1c;color:#fff;padding:12px 16px;font-weight:700;letter-spacing:.04em;text-align:center;border-radius:6px;margin:-24px -24px 20px;}",
    "h1{font-size:1.4rem;margin:0 0 .5rem;} p{line-height:1.5;} .muted{color:#555;font-size:.9rem;}",
    "label{display:block;margin:.75rem 0 .25rem;font-weight:600;} input[type=text],input[type=password]{width:100%;padding:.5rem;border:1px solid #cbd2d9;border-radius:6px;box-sizing:border-box;}",
    ".btn{display:inline-block;margin-top:1rem;background:#1d4ed8;color:#fff;border:0;padding:.6rem 1.1rem;border-radius:6px;font-size:1rem;cursor:pointer;text-decoration:none;}",
    ".ok{color:#15803d;font-weight:600;} ul{line-height:1.6;}",
    '</style></head><body><div class="card">',
    `<div class="banner">${BANNER}</div>`,
    body,
    "</div></body></html>",
  ].join("\n");
}

/** The page shown when a recipient clicks the link: it says plainly this is a drill, then offers a mock form that
 * sends nothing, so the moment of "entering a password" is practised without any password being handled. */
export function renderLanding(opts: { token: string; reportAddress: string; hasTraining: boolean }): string {
  return page(
    "Security awareness test",
    [
      "<h1>This was a security awareness test</h1>",
      "<p>You clicked a link in a simulated phishing email sent by your own security team. No harm was done, and this is a safe place to learn.</p>",
      "<p>A real phishing page would now show a sign-in box like the one below to steal your password. Try it: this one is a mock and <strong>sends nothing</strong>. The boxes are not even connected to the form.</p>",
      `<form method="post" action="/l/${esc(opts.token)}/submit">`,
      // The inputs have no name, so a browser sends no value even if someone types; the handler reads no body either.
      '<label>Email</label><input type="text" autocomplete="off" />',
      '<label>Password</label><input type="password" autocomplete="off" />',
      '<p class="muted">Nothing typed here is sent or stored. The form posts that the test was completed, and no more.</p>',
      '<button class="btn" type="submit">Sign in (mock)</button>',
      "</form>",
      `<p class="muted" style="margin-top:1.5rem;">When a message like this reaches you for real, do not click. Report it by forwarding to <strong>${esc(opts.reportAddress)}</strong>. Reporting always counts in your favour.</p>`,
      opts.hasTraining ? "<p>A short training module has been assigned to you. Look for it in your email.</p>" : "",
    ].join("\n"),
  );
}

/** Shown after the mock form is posted. Reinforces that nothing was captured. */
export function renderDebrief(opts: { reportAddress: string }): string {
  return page(
    "Security awareness test",
    [
      "<h1>Nothing was sent</h1>",
      '<p class="ok">You submitted the mock form, and nothing you typed left your browser. On a real phishing page, your password would now be in an attacker\'s hands.</p>',
      "<p>Three tells give most phishing away:</p>",
      "<ul><li>The sender address is not quite right.</li><li>The message pushes you to hurry.</li><li>The link points somewhere other than it claims.</li></ul>",
      `<p class="muted">Next time, report it instead: forward to <strong>${esc(opts.reportAddress)}</strong>.</p>`,
    ].join("\n"),
  );
}

/** Shown when a recipient uses a report link. A report counts for the campaign (ADR 0071). */
export function renderReported(): string {
  return page(
    "Thank you for reporting",
    [
      "<h1>Thank you for reporting</h1>",
      '<p class="ok">You spotted a simulated phishing email and reported it. That is exactly right, and it counts in your favour.</p>',
    ].join("\n"),
  );
}

/** The training module: the page to read, then a quiz that posts the chosen options (not sensitive). */
export function renderTraining(opts: { token: string; module: Module; personName: string; completedAt: string | null; score: number | null }): string {
  if (opts.completedAt) {
    return page(
      opts.module.title,
      [
        `<h1>${esc(opts.module.title)}</h1>`,
        `<p class="ok">You finished this module${opts.score == null ? "" : ` with a score of ${opts.score}%`}. Thank you.</p>`,
      ].join("\n"),
    );
  }
  const quiz = opts.module.questions
    .map((q, i) => {
      const options = q.options
        .map((o, j) => `<label style="font-weight:400;"><input type="radio" name="q${i}" value="${j}" required /> ${esc(o)}</label>`)
        .join("\n");
      return `<fieldset style="border:1px solid #e2e8f0;border-radius:8px;margin:1rem 0;padding:1rem;"><legend>${esc(q.prompt)}</legend>${options}</fieldset>`;
    })
    .join("\n");
  return page(
    opts.module.title,
    [
      `<h1>${esc(opts.module.title)}</h1>`,
      `<p class="muted">About ${opts.module.minutes} minutes.</p>`,
      ...opts.module.body.map((p) => `<p>${esc(p)}</p>`),
      `<form method="post" action="/t/${esc(opts.token)}/complete">`,
      '<h2 style="font-size:1.1rem;">Quick quiz</h2>',
      quiz,
      '<button class="btn" type="submit">Finish module</button>',
      "</form>",
    ].join("\n"),
  );
}

export function renderTrainingResult(opts: { module: Module; score: number; passed: boolean }): string {
  return page(
    opts.module.title,
    [
      `<h1>${esc(opts.module.title)}</h1>`,
      opts.passed
        ? `<p class="ok">You passed with ${opts.score}%. Your completion is recorded as training evidence.</p>`
        : `<p>You scored ${opts.score}%, below the pass mark. Read the page again and retry from your training link.</p>`,
    ].join("\n"),
  );
}

export function renderNotFound(): string {
  return page("Not found", ["<h1>This link is not valid</h1>", "<p>The link may have expired or been mistyped.</p>"].join("\n"));
}
