// The built-in simulation templates (ADR 0071). These are not realistic lures and do not impersonate any real brand.
// Every one is an obvious training drill: a fictional "Example Corp" sender, and a visible SECURITY AWARENESS TEST
// banner at the top of the mail and again on the landing page. They are useful only inside a consented programme;
// the value of Awareness is the tracking, consent and evidence, not convincing text. An organisation that wants a
// harder drill writes its own template; the built-in set stays plainly a test.

export const BANNER = "SECURITY AWARENESS TEST";

export interface Template {
  id: string;
  name: string;
  /** What kind of lure it stands in for, so a programme can vary them. Not a real sender. */
  category: "document" | "it" | "delivery" | "hr";
  /** The fictional display sender shown in the mail. Always under example-corp.test, never a real brand. */
  displayFrom: string;
  subject: string;
  /** The teaching line: the tell a real version of this lure would show. Shown on the landing page. */
  tell: string;
  /** Plain body lines, before the single call-to-action link. */
  lines: string[];
  /** The text on the call-to-action link. */
  action: string;
}

export const TEMPLATES: Template[] = [
  {
    id: "doc-share",
    name: "Example Corp: a document was shared",
    category: "document",
    displayFrom: "Example Corp Files <files@example-corp.test>",
    subject: "[Awareness test] A document was shared with you",
    tell: "A real version would come from a sender you do not know and ask you to sign in on a page that is not your company's.",
    lines: [
      "Hello,",
      "This is a message from your security team's awareness programme. It is not a real document.",
      "A pretend document, Q4-notes.pdf, was shared with you by Example Corp, a company that does not exist.",
    ],
    action: "Open the example page",
  },
  {
    id: "it-password",
    name: "Example Corp: IT password check",
    category: "it",
    displayFrom: "Example Corp IT <it@example-corp.test>",
    subject: "[Awareness test] Password check for your account",
    tell: "A real version would press you to sign in quickly to keep access. Your IT team never asks for your password by email.",
    lines: [
      "Hello,",
      "This is a message from your security team's awareness programme. It is not a real IT request.",
      "A pretend IT desk at Example Corp asks you to confirm your password. No real system works this way.",
    ],
    action: "Open the example page",
  },
  {
    id: "delivery",
    name: "Example Corp: parcel notice",
    category: "delivery",
    displayFrom: "Example Corp Delivery <delivery@example-corp.test>",
    subject: "[Awareness test] A parcel is waiting for a small fee",
    tell: "A real version would ask for a tiny payment to release a parcel you were not expecting.",
    lines: [
      "Hello,",
      "This is a message from your security team's awareness programme. It is not a real delivery notice.",
      "A pretend courier, Example Corp Delivery, says a parcel is held. There is no parcel.",
    ],
    action: "Open the example page",
  },
  {
    id: "hr-policy",
    name: "Example Corp: a policy to acknowledge",
    category: "hr",
    displayFrom: "Example Corp People <people@example-corp.test>",
    subject: "[Awareness test] Please acknowledge an updated policy",
    tell: "A real version would use an internal-looking page to collect your sign-in while you think you are reading a policy.",
    lines: [
      "Hello,",
      "This is a message from your security team's awareness programme. It is not a real HR request.",
      "A pretend people team at Example Corp asks you to acknowledge a policy. No such policy exists.",
    ],
    action: "Open the example page",
  },
];

export const template = (id: string): Template | undefined => TEMPLATES.find((t) => t.id === id);

export interface RenderInput {
  recipientName: string | null;
  /** Where the call-to-action link points: the simulated landing page for this recipient. */
  landingUrl: string;
  /** The tracking pixel, labelled unreliable. Opens are a hint only (ADR 0071). */
  pixelUrl: string;
  /** Where a recipient reports the mail; a report counts for the campaign. */
  reportAddress: string;
}

/** The mail a recipient receives: a banner, the drill body, one link, and how to report. Text and HTML parts. */
export function render(t: Template, input: RenderInput): { subject: string; text: string; html: string } {
  const greeting = input.recipientName ? `Hello ${input.recipientName},` : "Hello,";
  const body = [greeting, ...t.lines.slice(1)];
  const text = [
    `=== ${BANNER} ===`,
    "",
    ...body,
    "",
    `${t.action}: ${input.landingUrl}`,
    "",
    "If a message like this reaches you for real, do not click. Report it:",
    `forward it to ${input.reportAddress}. Reporting counts in your favour.`,
    "",
    "Sent by your organisation's security awareness programme. From a sender that does not exist.",
  ].join("\n");
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const html = [
    "<!doctype html>",
    '<html lang="en"><body style="font-family: system-ui, sans-serif; color: #111; max-width: 36rem; margin: 0 auto;">',
    `<div style="background:#b91c1c;color:#fff;padding:12px 16px;font-weight:700;letter-spacing:.04em;text-align:center;border-radius:6px;">${BANNER}</div>`,
    `<p style="color:#555;font-size:13px;margin:8px 0 16px;">This email is a drill from your security team. ${esc(t.displayFrom)} is not a real sender.</p>`,
    ...body.map((line) => `<p>${esc(line)}</p>`),
    `<p><a href="${esc(input.landingUrl)}" style="display:inline-block;background:#1d4ed8;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;">${esc(t.action)}</a></p>`,
    `<p style="color:#555;font-size:13px;">If a message like this reaches you for real, do not click. Report it: forward it to <a href="mailto:${esc(input.reportAddress)}">${esc(input.reportAddress)}</a>. Reporting counts in your favour.</p>`,
    `<img src="${esc(input.pixelUrl)}" width="1" height="1" alt="" style="display:none" />`,
    '<p style="color:#888;font-size:12px;">Sent by your organisation\'s security awareness programme.</p>',
    "</body></html>",
  ].join("\n");
  return { subject: t.subject, text, html };
}
