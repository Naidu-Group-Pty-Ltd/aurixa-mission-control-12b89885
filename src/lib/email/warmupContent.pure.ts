/**
 * What warmup mail says.
 *
 * It has to read like mail between two people who work with each other —
 * short, specific-sounding, a little different every time — because filters
 * read content too, and a pool that sends the same three sentences forty
 * times a day is a pattern, not a conversation.
 *
 * So each message is assembled from a topic (catching up, following up on
 * notes, a quick question, …), a greeting, a few sentences drawn from that
 * topic, a closing line and a sign-off, with small details — a day, a time, a
 * document — filled in. Thousands of combinations, chosen by a seeded random
 * source so a given seed always produces the same message (which is what
 * makes it testable) and different seeds produce different ones.
 *
 * Deliberately absent: links, images, attachments, prices, anything that
 * sells, urgency, capitals, exclamation-heavy enthusiasm. Every one of those
 * is a reason for a filter to look harder, and warmup mail exists to be
 * unremarkable.
 */

/** A deterministic random source in [0, 1) from a string seed (xmur3 → mulberry32). */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let state = (() => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  })();
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length) % items.length];
}

/** `count` distinct items, in a random order. */
function pickSome<T>(items: readonly T[], count: number, random: () => number): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (out.length < count && pool.length > 0) {
    out.push(pool.splice(Math.floor(random() * pool.length) % pool.length, 1)[0]);
  }
  return out;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Names ────────────────────────────────────────────────────────────────────

/** Words that start the display name of a shared mailbox rather than a person. */
const NOT_A_NAME = new Set([
  "accounts",
  "admin",
  "administrator",
  "bookings",
  "careers",
  "contact",
  "customer",
  "enquiries",
  "finance",
  "hello",
  "help",
  "hr",
  "info",
  "inquiries",
  "mail",
  "mailbox",
  "marketing",
  "no-reply",
  "noreply",
  "office",
  "operations",
  "orders",
  "reception",
  "sales",
  "service",
  "services",
  "shared",
  "support",
  "team",
  "the",
]);

function asName(word: string | undefined): string | null {
  if (!word) return null;
  const clean = word.replace(/[^A-Za-z'-]/g, "");
  if (clean.length < 2 || clean.length > 15) return null;
  if (!/^[A-Za-z]/.test(clean)) return null;
  if (NOT_A_NAME.has(clean.toLowerCase())) return null;
  // ALL-CAPS words are usually company initials, not first names.
  if (clean === clean.toUpperCase()) return null;
  return clean[0].toUpperCase() + clean.slice(1).toLowerCase();
}

/**
 * What to call the person behind a mailbox in a greeting, or null when it is
 * not a person's mailbox (or nothing reliable can be said). "Jones, Sam" and
 * "Sam Jones" are both Sam; "sam.jones@" is Sam; "Sales Team" is nobody.
 */
export function firstNameFor(
  displayName: string | null | undefined,
  address: string,
): string | null {
  const display = String(displayName ?? "").trim();
  if (display) {
    if (display.includes(",")) {
      const [, after] = display.split(",", 2);
      const name = asName(after?.trim().split(/\s+/)[0]);
      if (name) return name;
    }
    return asName(display.split(/\s+/)[0]);
  }
  const local = String(address).split("@")[0] ?? "";
  const chunks = local.split(/[._-]+/);
  if (chunks.length >= 2) return asName(chunks[0]);
  return null;
}

// ── The corpus ───────────────────────────────────────────────────────────────

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"] as const;
const TIMES = ["9:30", "10am", "10:30", "11:15", "1pm", "2pm", "2:30", "3:15", "4pm"] as const;
const DOCS = [
  "the notes",
  "the draft",
  "the summary",
  "the checklist",
  "the schedule",
  "the outline",
  "the latest version",
  "the spreadsheet",
  "the agenda",
  "the plan",
] as const;
const SUBJECTS = [
  "the rollout",
  "the new process",
  "the handover",
  "the quarterly review",
  "the training session",
  "the site visit",
  "the planning meeting",
  "the onboarding plan",
  "the timeline",
  "the roster",
  "the next phase",
  "the workshop",
] as const;
const TEAMS = ["the team", "everyone here", "our side", "the group"] as const;
const PAST = ["yesterday", "earlier today", "last week", "the other day"] as const;

/**
 * A topic: one main point (`leads`, one is chosen), up to two supporting
 * lines (`follows`, kept in the order written so they read in sequence), an
 * opener and a closer.
 */
type Topic = {
  subjects: readonly string[];
  openers: readonly string[];
  leads: readonly string[];
  follows: readonly string[];
  closers: readonly string[];
};

const TOPICS: readonly Topic[] = [
  {
    subjects: [
      "Catch-up {when}?",
      "Quick catch-up",
      "Time for a chat {when}?",
      "Catching up on {subject}",
    ],
    openers: [
      "Hope your week is going well.",
      "Hope things are good on your end.",
      "Thanks again for the chat {past}.",
    ],
    leads: [
      "Would you have half an hour {when} to go over {subject}?",
      "I was hoping we could catch up {when} about {subject}.",
      "Do you have time {when} for a quick chat about {subject}?",
    ],
    follows: [
      "Around {time} would suit me, but I'm happy to work around your schedule.",
      "It would be good to compare notes before things get busy.",
      "I can bring {doc} along.",
    ],
    closers: ["Let me know what suits.", "Either way works for me.", "No rush at all."],
  },
  {
    subjects: [
      "Notes from {day}",
      "Following up on {subject}",
      "Our conversation {past}",
      "{doc_cap} for {subject}",
    ],
    openers: [
      "Just following up from {past}.",
      "Good to talk {past}.",
      "Thanks for your time {past}.",
    ],
    leads: [
      "I've put together {doc} from our conversation and will tidy them up {when}.",
      "I think we're nearly there with {subject}.",
      "I had another look at {doc} and made a couple of small changes.",
    ],
    follows: [
      "The main thing left is to agree on timing.",
      "Most of it matches what we discussed.",
      "I'll send the final version around {when}.",
    ],
    closers: [
      "Let me know if I've missed anything.",
      "Happy to talk it through if anything looks off.",
      "I'll keep you posted.",
    ],
  },
  {
    subjects: ["Thank you", "Thanks for your help", "Much appreciated", "Thanks again"],
    openers: ["Just a quick note to say thanks.", "I wanted to say thank you."],
    leads: [
      "Thanks so much for your help with {subject}.",
      "I really appreciated you taking the time to go through {doc}.",
      "Your help with {subject} {past} made a real difference.",
    ],
    follows: [
      "It made things a lot easier on our side.",
      "{team} were really pleased with how it came together.",
    ],
    closers: [
      "Let me know if I can return the favour.",
      "Speak soon.",
      "Hope the rest of your week is a good one.",
    ],
  },
  {
    subjects: [
      "Quick question",
      "Question about {subject}",
      "One small question",
      "A question on {doc}",
    ],
    openers: ["Hope you're well.", "Hope all is good with you."],
    leads: [
      "Do you know who looks after {subject} on your side these days?",
      "I wanted to check whether {doc} is still the latest version.",
      "Is {day} still the plan for {subject}, or has it moved?",
    ],
    follows: [
      "I'm happy to send through {doc} first if that's easier.",
      "It's only so I can plan the next few weeks.",
    ],
    closers: ["No rush on this one.", "Whenever you get a moment is fine.", "Thanks in advance."],
  },
  {
    subjects: [
      "Update on {subject}",
      "Small update",
      "Where we're at with {subject}",
      "Progress on {subject}",
    ],
    openers: ["Just a quick update from our end.", "Wanted to keep you in the loop."],
    leads: [
      "{subject_cap} is moving along nicely.",
      "We've finished the first part of {subject} and should have the rest done {when}.",
      "{team} have been working through {doc} for {subject} this week.",
    ],
    follows: [
      "Nothing major to report, but I didn't want you to wonder where things were at.",
      "So far everything is on track.",
    ],
    closers: [
      "I'll send another note once it's wrapped up.",
      "Shout if you have any questions.",
      "More soon.",
    ],
  },
  {
    subjects: [
      "Confirming {day}",
      "Still good for {day}?",
      "{day} at {time}",
      "Our meeting on {day}",
    ],
    openers: ["Hope you're having a good week.", "Just checking in."],
    leads: [
      "Just confirming we're still on for {day} at {time}.",
      "I've pencilled in {day} at {time} for {subject}.",
    ],
    follows: [
      "If that time no longer works, just let me know and we'll find another.",
      "I'll bring {doc} along so we can go through it together.",
    ],
    closers: ["Looking forward to it.", "See you then.", "Talk then."],
  },
  {
    subjects: ["Moving our {day} chat", "Can we shift {day}?", "Change of plan for {day}"],
    openers: ["Sorry for the shuffle.", "Apologies for the change."],
    leads: [
      "Something has come up on {day} — would {when} work instead?",
      "Would {time} on {day} suit you instead?",
    ],
    follows: ["Happy to keep it short if that helps.", "We can do it by phone if that's easier."],
    closers: [
      "Thanks for being flexible.",
      "Let me know what works best.",
      "Thanks for understanding.",
    ],
  },
  {
    subjects: ["That book I mentioned", "A book you might enjoy"],
    openers: ["This reminded me of our chat {past}.", "I said I'd pass this on."],
    leads: ["I finally finished the book I mentioned — I think you'd enjoy it."],
    follows: [
      "It had a few ideas that would work well for {subject}.",
      "Happy to lend you my copy if you'd like it.",
    ],
    closers: [
      "Let me know what you think if you get a chance.",
      "Curious to hear your take.",
      "Enjoy.",
    ],
  },
  {
    subjects: ["The podcast we talked about", "Something to listen to"],
    openers: ["This reminded me of our chat {past}.", "I said I'd pass this on."],
    leads: ["Remember the podcast we talked about? The latest episode was really good."],
    follows: [
      "They spent a while on how teams handle {subject}, which made me think of you.",
      "It's an easy listen on the commute.",
    ],
    closers: ["Let me know what you think.", "Curious to hear your take.", "Enjoy."],
  },
  {
    subjects: ["The event next month", "Are you going to the conference?", "Conference next month"],
    openers: ["Hope things are good.", "Quick one."],
    leads: [
      "Are you heading along to the industry event next month?",
      "Will you be at the conference next month?",
    ],
    follows: [
      "A few of us are planning to go.",
      "I hear the sessions are meant to be good this year.",
    ],
    closers: [
      "Would be great to catch up there if you're going.",
      "Hope to see you there.",
      "Would be good to say hello.",
    ],
  },
  {
    subjects: ["Away next week", "Heads up — I'm out {when}", "My leave dates"],
    openers: ["Just a heads up.", "A quick note before I head off."],
    leads: [
      "I'll be away {when} with patchy access to email.",
      "I'm taking a few days off from {when}.",
    ],
    follows: [
      "If anything comes up while I'm out, {team} can help.",
      "I'll pick up {subject} again as soon as I'm back.",
    ],
    closers: ["Back on {day}.", "Speak when I'm back.", "Thanks for your patience."],
  },
  {
    subjects: ["How was the weekend?", "Back at it", "Hope all is well", "Checking in"],
    openers: ["Hope you had a good weekend.", "Hope you're keeping well."],
    leads: [
      "How are things going with {subject} on your side?",
      "It feels like the year is flying by.",
    ],
    follows: [
      "We finally had some decent weather here.",
      "Things have been busy but in a good way.",
    ],
    closers: ["Talk soon.", "Catch up properly soon.", "Have a good week."],
  },
  {
    subjects: ["Could you look over {doc}?", "Feedback on {doc}", "Second pair of eyes"],
    openers: ["Hope you're not too snowed under.", "A small favour, if you have a moment."],
    leads: [
      "Would you mind having a quick look over {doc} when you have a moment?",
      "Could I get your thoughts on {doc} for {subject}?",
    ],
    follows: [
      "I'd value your thoughts before I send it around {team}.",
      "Mostly just checking it reads clearly.",
    ],
    closers: [
      "No pressure if you're flat out this week.",
      "Thanks in advance.",
      "Any thoughts welcome.",
    ],
  },
  {
    subjects: ["Change to {subject}", "New approach for {subject}", "Heads up on {subject}"],
    openers: ["A quick heads up.", "Wanted to let you know about a small change."],
    leads: ["We're trying a slightly different approach to {subject} from {when}."],
    follows: [
      "It should make things simpler for everyone.",
      "I'll share more detail once we've had a chance to test it.",
      "Nothing changes on your side for now.",
    ],
    closers: ["Happy to explain more if useful.", "Let me know if you see any issues.", "Thanks."],
  },
  {
    subjects: ["Coffee {when}?", "Coffee catch-up", "Lunch {when}?"],
    openers: ["It's been a while.", "Hope things are good."],
    leads: ["Are you around for a coffee {when}?", "Would you be up for lunch {when}?"],
    follows: [
      "There's a new place near us that's meant to be good.",
      "I'm around after {time} most days.",
    ],
    closers: [
      "Would be nice to catch up away from the desk.",
      "No worries if it's a busy week.",
      "Let me know if you're keen.",
    ],
  },
  {
    subjects: ["Good to see you {past}", "Great chatting {past}", "Thanks for {past}"],
    openers: ["It was great to catch up {past}.", "Good to see you {past}."],
    leads: [
      "Thanks for sharing your thoughts on {subject}.",
      "I've already put a couple of your ideas on {subject} into practice.",
    ],
    follows: ["I'll send through {doc} as promised.", "Let's not leave it so long next time."],
    closers: ["Talk soon.", "Until next time.", "Speak soon."],
  },
  {
    subjects: ["Timing for {subject}", "When suits for {subject}?", "Planning {subject}"],
    openers: ["Starting to think about {subject}.", "Hope you're well."],
    leads: ["Do you have a sense of when you'd like to get started on {subject}?"],
    follows: [
      "We could have {doc} ready {when} if that helps.",
      "There's no hard deadline, so whatever works for you.",
      "I'd suggest a short call first to agree on the basics.",
    ],
    closers: ["Let me know your thoughts.", "Happy to fit in with your plans.", "Thanks."],
  },
];

const GREETINGS_NAMED = [
  "Hi {name},",
  "Hello {name},",
  "Hey {name},",
  "{name},",
  "Hi {name},",
] as const;
const GREETINGS_MORNING = ["Morning {name},", "Good morning {name},"] as const;
const GREETINGS_PLAIN = ["Hi,", "Hello,", "Hi there,", "Hello there,"] as const;
const SIGN_OFFS = [
  "Thanks,",
  "Cheers,",
  "Best,",
  "Kind regards,",
  "Many thanks,",
  "Talk soon,",
  "Regards,",
  "All the best,",
] as const;

const REPLIES = [
  "Thanks{comma_name}, that works for me.",
  "Sounds good — {when} suits me.",
  "Thanks for letting me know.",
  "Appreciate the update.",
  "Great, thanks for sending that through.",
  "No worries at all.",
  "Will do — I'll get back to you {when}.",
  "That sounds like a good plan.",
  "Thanks, I'll take a look {when}.",
  "Perfect, see you then.",
  "Happy to help.",
  "Good to hear things are moving along.",
  "Thanks — let me check and come back to you.",
  "{day} at {time} works well for me.",
  "Yes, I'll be there.",
  "Good idea. Let's do that.",
  "Thanks for thinking of me.",
  "Makes sense to me.",
] as const;
const REPLY_EXTRAS = [
  "Hope the rest of your week goes well.",
  "Speak soon.",
  "Let me know if anything changes.",
  "I'll keep an eye out for {doc}.",
  "Looking forward to it.",
  "",
  "",
] as const;
const REPLY_SIGN_OFFS = ["Thanks,", "Cheers,", "Best,", "Thanks again,", ""] as const;

/**
 * The small particulars of one message — which day, which document — chosen
 * once, so that every sentence in it talks about the same thing.
 */
type Details = {
  day: string;
  time: string;
  doc: string;
  subject: string;
  team: string;
  when: string;
  past: string;
};

function detailsFor(random: () => number): Details {
  return {
    day: pick(DAYS, random),
    time: pick(TIMES, random),
    doc: pick(DOCS, random),
    subject: pick(SUBJECTS, random),
    team: pick(TEAMS, random),
    when: pick(
      [
        "tomorrow",
        "later this week",
        "early next week",
        `on ${pick(DAYS, random)}`,
        `next ${pick(DAYS, random)}`,
      ],
      random,
    ),
    past: pick(PAST, random),
  };
}

function fill(template: string, details: Details, name: string | null): string {
  return template
    .replace(/\{when\}/g, details.when)
    .replace(/\{past\}/g, details.past)
    .replace(/\{day\}/g, details.day)
    .replace(/\{time\}/g, details.time)
    .replace(/\{doc_cap\}/g, sentenceCase(details.doc))
    .replace(/\{doc\}/g, details.doc)
    .replace(/\{subject_cap\}/g, sentenceCase(details.subject))
    .replace(/\{subject\}/g, details.subject)
    .replace(/\{team\}/g, details.team)
    .replace(/\{comma_name\}/g, name ? ` ${name}` : "")
    .replace(/\{name\}/g, name ?? "");
}

function sentenceCase(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

export type WarmupMessage = { subject: string; html: string; text: string };

function render(paragraphs: string[][]): { html: string; text: string } {
  const kept = paragraphs.map((lines) => lines.filter(Boolean)).filter((lines) => lines.length > 0);
  return {
    html: kept.map((lines) => `<p>${lines.map(escapeHtml).join("<br>")}</p>`).join(""),
    text: kept.map((lines) => lines.join("\n")).join("\n\n"),
  };
}

/**
 * A new warmup message from one person to another.
 *
 * `localHour` is the sender's wall-clock hour, so "Good morning" is only
 * written in the morning.
 */
export function composeWarmupMessage(input: {
  seed: string;
  senderName: string | null;
  recipientName: string | null;
  localHour?: number;
}): WarmupMessage {
  const random = seededRandom(input.seed);
  const topic = pick(TOPICS, random);
  const details = detailsFor(random);
  const name = input.recipientName;
  const line = (template: string) => sentenceCase(fill(template, details, name));

  const greetings: readonly string[] = name
    ? input.localHour !== undefined && input.localHour < 11
      ? [...GREETINGS_NAMED, ...GREETINGS_MORNING]
      : GREETINGS_NAMED
    : GREETINGS_PLAIN;
  const greeting = fill(pick(greetings, random), details, name);

  const subject = line(pick(topic.subjects, random));
  const opener = random() < 0.7 ? line(pick(topic.openers, random)) : "";
  const follows = pickSome(topic.follows, Math.floor(random() * 3), random).sort(
    (a, b) => topic.follows.indexOf(a) - topic.follows.indexOf(b),
  );
  const body = [pick(topic.leads, random), ...follows].map(line);
  const closer = random() < 0.85 ? line(pick(topic.closers, random)) : "";
  const signOff = pick(SIGN_OFFS, random);

  // Opener and body as one paragraph or two, at random — people do both.
  const together = random() < 0.5;
  const paragraphs: string[][] = [
    [greeting],
    together ? [[opener, ...body].filter(Boolean).join(" ")] : [opener],
    together ? [] : [body.join(" ")],
    [closer],
    [signOff, input.senderName ?? ""],
  ];
  return { subject, ...render(paragraphs) };
}

/**
 * A reply, written above the quoted message Microsoft puts in the reply
 * draft. Shorter than a new message, and shorter again further down a thread.
 */
export function composeWarmupReply(input: {
  seed: string;
  senderName: string | null;
  recipientName: string | null;
  depth: number;
}): { html: string; text: string } {
  const random = seededRandom(input.seed);
  const details = detailsFor(random);
  const name = input.recipientName;
  const greeting =
    name && random() < 0.6 ? `${pick(["Hi", "Hey", "Thanks"], random)} ${name},` : "";
  const line = sentenceCase(fill(pick(REPLIES, random), details, greeting ? null : name));
  const extra =
    input.depth <= 1 && random() < 0.6
      ? sentenceCase(fill(pick(REPLY_EXTRAS, random), details, name))
      : "";
  const signOff = pick(REPLY_SIGN_OFFS, random);
  return render([
    greeting ? [greeting] : [],
    [[line, extra].filter(Boolean).join(" ")],
    signOff ? [signOff, input.senderName ?? ""] : [input.senderName ?? ""],
  ]);
}

/**
 * Put a reply above the quoted original in the body Microsoft generated for a
 * reply draft — inside its `<body>` when it has one, so the result is still
 * one well-formed document.
 */
export function prependToReplyBody(
  replyHtml: string,
  draftBody: string | null | undefined,
): string {
  const body = String(draftBody ?? "");
  const opening = /<body[^>]*>/i.exec(body);
  const block = `<div>${replyHtml}</div>`;
  if (!opening) return `${block}${body}`;
  const at = opening.index + opening[0].length;
  return `${body.slice(0, at)}${block}${body.slice(at)}`;
}
