// The built-in training modules (ADR 0071): a short page to read and a few quiz questions. Completion is recorded
// per person and becomes compliance evidence (ISO 27001 A.6.3, SOC 2 CC2.2). Modules are plain teaching content, not
// a test of the organisation's own systems. An organisation adds its own; the built-in set covers the basics a first
// release needs. A question is graded on the server from the chosen option index, so the quiz stores no free text.

export interface Question {
  prompt: string;
  options: string[];
  /** The index in `options` that is correct. Not sent to the page until after a submission. */
  answer: number;
}

export interface Module {
  id: string;
  title: string;
  minutes: number;
  required: boolean;
  /** Short paragraphs shown before the quiz. */
  body: string[];
  questions: Question[];
  /** The share of questions that must be right to pass, as a percentage. */
  pass: number;
}

export const MODULES: Module[] = [
  {
    id: "spotting-phishing",
    title: "Spotting a phishing email",
    minutes: 10,
    required: true,
    pass: 70,
    body: [
      "Phishing is a message that tries to make you act before you think: click a link, open a file, or type your password on a page that is not your company's.",
      "Three tells cover most of it. The sender address is not quite right. The message pushes you to hurry. The link, when you hover over it, points somewhere other than it claims.",
      "When something asks for your password or a payment and presses you to be quick, slow down. Open the real site yourself, or ask the sender through a channel you already trust.",
      "Reporting a suspicious email is always the right move, even if you are not sure. It never counts against you.",
    ],
    questions: [
      {
        prompt: "An email says your account will be closed in one hour unless you sign in through its link. What is the safest first step?",
        options: [
          "Click the link quickly before the hour is up",
          "Open the real site yourself in a new tab, or report the email",
          "Reply and ask if it is genuine",
          "Forward it to a colleague to click",
        ],
        answer: 1,
      },
      {
        prompt: "Which of these is the strongest sign of phishing?",
        options: [
          "The email has a company logo",
          "The link text and the real link target are different",
          "The email is addressed to you by name",
          "The email arrived in the morning",
        ],
        answer: 1,
      },
      {
        prompt: "You clicked a link in a suspicious email but typed nothing. What should you do?",
        options: ["Nothing, since you typed nothing", "Report it to your security team", "Delete the email and move on", "Turn off your computer"],
        answer: 1,
      },
    ],
  },
  {
    id: "passwords-mfa",
    title: "Passwords and second factors",
    minutes: 8,
    required: true,
    pass: 70,
    body: [
      "A password alone is a weak lock. A second factor, an app code or a passkey, means a stolen password is not enough on its own.",
      "Never type your password on a page you reached from a link in a message. Reach the site the way you normally do instead.",
      "No real IT desk asks for your password by email or chat. If someone does, that is the attack.",
    ],
    questions: [
      {
        prompt: "Someone claiming to be IT asks for your password to fix your account. You should:",
        options: ["Give it, since they are IT", "Refuse and report the request", "Give a slightly wrong one", "Change your password first, then give it"],
        answer: 1,
      },
      {
        prompt: "Why does a second factor help even if your password leaks?",
        options: [
          "It makes the password longer",
          "Signing in also needs something the attacker does not have",
          "It hides your password",
          "It changes your password every day",
        ],
        answer: 1,
      },
    ],
  },
];

export const module = (id: string): Module | undefined => MODULES.find((m) => m.id === id);

/** Grades answers (one chosen index per question) and returns the score and whether it passed. */
export function grade(m: Module, answers: number[]): { score: number; passed: boolean } {
  const correct = m.questions.reduce((n, q, i) => n + (answers[i] === q.answer ? 1 : 0), 0);
  const score = m.questions.length ? Math.round((correct / m.questions.length) * 100) : 100;
  return { score, passed: score >= m.pass };
}
