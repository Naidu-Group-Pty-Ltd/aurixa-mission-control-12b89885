// Knowledge-base rendering, shared by every fleet this repository builds.
//
// scripts/voice/build-knowledge-doc.mjs renders Mission Control's own corpus
// through this module, and the Voice Cloning Studio renders every client's.
// One implementation, so the rules the Aurixa corpus paid for hold for all of
// them:
//
//   - ASCII only. The file is carried between this repository and VAPI's file
//     store, and every step of that journey is somewhere an encoding can be
//     mangled silently; an ASCII artefact compares byte for byte at both ends.
//   - A denylist checked on the RENDERED text, so it sees exactly what is
//     uploaded - including anything generated from a catalog or drafted by a
//     model - rather than the source it was built from.
//   - Uploaded as text/plain with a .txt name. VAPI stores a text/markdown
//     upload and marks it status=failed without parsing it (measured
//     23 Sep 2026); a failed file binds to a query tool like a good one and the
//     agents simply have nothing to retrieve. See KB_UPLOAD below.

export type KbBlockKind = "h1" | "h2" | "p" | "b";
export interface KbBlock {
  kind: KbBlockKind;
  text: string;
}

const ASCII_RULES: Array<[RegExp, string]> = [
  [/[\u2018\u2019\u201a\u201b]/g, "'"],
  [/[\u201c\u201d\u201e\u201f]/g, '"'],
  [/[\u2013\u2014\u2015]/g, "-"],
  [/\u2026/g, "..."],
  [/\u00a0/g, " "],
];

export class NonAsciiError extends Error {
  readonly characters: string[];
  constructor(characters: string[]) {
    super(`non-ASCII characters remain in the corpus: ${characters.join(" ")}`);
    this.characters = characters;
  }
}

/** Typographic punctuation to ASCII; throws naming any character it cannot map. */
export function toAscii(text: string): string {
  let out = text;
  for (const [re, to] of ASCII_RULES) out = out.replace(re, to);
  // eslint-disable-next-line no-control-regex -- tab and newline are the two controls a KB may hold
  const stray = out.match(/[^\x09\x0a\x20-\x7e]/g);
  // Named rather than stripped: a character nobody decided about is a content
  // question, not something a renderer should quietly resolve.
  if (stray) throw new NonAsciiError([...new Set(stray)]);
  return out;
}

/** Title, intro and blocks -> the Markdown that is committed and uploaded. */
export function renderKbMarkdown(title: string, intro: string, blocks: KbBlock[]): string {
  const out = [`# ${title}`, "", intro, ""];
  let inBullets = false;
  for (const block of blocks) {
    if (block.kind === "b") {
      out.push(`- ${block.text}`);
      inBullets = true;
      continue;
    }
    if (inBullets) {
      out.push("");
      inBullets = false;
    }
    if (block.kind === "h1") out.push(`## ${block.text}`, "");
    else if (block.kind === "h2") out.push(`### ${block.text}`, "");
    else out.push(block.text, "");
  }
  // One trailing newline, never two: the file is compared byte for byte.
  return toAscii(`${out.join("\n").replace(/\n+$/, "")}\n`);
}

export interface DenyRule {
  pattern: RegExp;
  why: string;
}

/**
 * Claims no voice agent built here may make for ANY business: they are the
 * unverifiable ones a model reaches for when it is asked to sell. A business
 * adds its own rules (a provider it must never name, a regulator it must never
 * speak for) on top of these.
 */
export const BASE_DENYLIST: DenyRule[] = [
  { pattern: /\bpatent(ed|[- ]pending)\b/i, why: "a patent claim - no application has been filed" },
  {
    pattern: /\bsoc\s*2\b|\biso(\/iec)?\s*27001\b/i,
    why: "a certification claim - held by infrastructure providers, not by the business",
  },
  {
    pattern: /\b10x\b|\bten times\b|conversion lift/i,
    why: "an outcome figure no customer has measured",
  },
  { pattern: /\bguarantee(d|s)?\s+(results|returns|approval)\b/i, why: "a guaranteed outcome" },
];

export interface DenyHit {
  line: number;
  match: string;
  why: string;
}

export function findDeniedClaims(text: string, rules: DenyRule[]): DenyHit[] {
  const hits: DenyHit[] = [];
  text.split("\n").forEach((line, i) => {
    for (const { pattern, why } of rules) {
      const m = line.match(pattern);
      if (m) hits.push({ line: i + 1, match: m[0], why });
    }
  });
  return hits;
}

/**
 * How a corpus reaches VAPI. The upload is judged by the store's own
 * `status`, never by the POST's 201.
 */
export const KB_UPLOAD = {
  mimetype: "text/plain",
  extension: ".txt",
  readyStatus: "done",
  failedStatus: "failed",
} as const;

/** The parts a client knowledge base is drafted in - the structure the Aurixa corpus proved. */
export const KB_PARTS = [
  {
    key: "why",
    title: "Why the business exists, and why now",
    purpose:
      "The problem it solves in the caller's words, what it is in one breath, and what has changed that makes it timely.",
  },
  {
    key: "for_you",
    title: "What it does for your kind of customer",
    purpose:
      "One section per customer type: what their day looks like, what changes, what matters most, a question to ask, one way to put it.",
  },
  {
    key: "different",
    title: "How it is different",
    purpose:
      "Against the alternatives a caller already uses - never naming a competitor, never running one down.",
  },
  {
    key: "hesitations",
    title: "When a caller hesitates",
    purpose:
      "Each objection answered as acknowledge, one honest reframe, one easy next step, and a question back.",
  },
  {
    key: "discovery",
    title: "Understanding a caller",
    purpose: "Discovery questions, what to listen for, and how a need maps to the next step.",
  },
  {
    key: "in_practice",
    title: "What it looks like in practice",
    purpose: "Illustrative walk-throughs, explicitly not any real customer's story.",
  },
  {
    key: "facts",
    title: "The facts",
    purpose:
      "Services, prices only where published, hours, process, policies, support and contact details.",
  },
  {
    key: "never_say",
    title: "What an agent must never say",
    purpose: "The claims that would be wrong even if a caller pushes for them.",
  },
] as const;
export type KbPartKey = (typeof KB_PARTS)[number]["key"];
export const KB_PART_KEYS = KB_PARTS.map((p) => p.key) as unknown as readonly [
  KbPartKey,
  ...KbPartKey[],
];
