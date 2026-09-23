// The Aurixa Systems voice-agent knowledge base, as content.
//
// This is the corpus every Mission Control voice assistant queries through its
// `aurixa_knowledge` tool. It is data rather than a document so that one source
// can be rendered to Markdown (the reviewable artefact, checked in beside this
// file) and to Word, and so the pricing half can be GENERATED from the price
// list rather than typed. See build-knowledge-doc.mjs.
//
// ── What this document is for, and how it is shaped ──────────────────────────
//
// It is retrieved from, not read. A query tool matches a caller's question
// against passages, so a passage has to be able to answer on its own: the
// headings are QUESTIONS a caller would actually ask, and each answer repeats
// enough context to stand without the heading above it. The previous version
// was a 12 KB brochure under seven topic headings, which is why it read as
// "extremely repetitive" - it was not duplicated, it was NARROW, so anything
// outside those seven topics retrieved the nearest paragraph of sales copy and
// callers heard the same passages back.
//
// ── The content rule ─────────────────────────────────────────────────────────
//
// Everything here is drawn from the company's own published copy
// (aurixasystems.com.au), the price list in src/lib/pricing/aurixa-catalog.ts,
// and the support classifier in src/lib/ticket-classification.ts. Nothing is
// invented, and nothing here overrides an agent's own instructions: an agent
// still never claims an application is approved, accepted or allocated, never
// promises platform access, never invents an appointment time, and never
// negotiates pricing.
import {
  amlSentence,
  annualSentence,
  moduleLines,
  tierLines,
  topupLines,
  topupRangeSentence,
} from "./pricing-prose.mjs";

const h1 = (text) => ({ kind: "h1", text });
const h2 = (text) => ({ kind: "h2", text });
const p = (text) => ({ kind: "p", text });
const b = (text) => ({ kind: "b", text });
const bullets = (items) => items.map(b);

export const TITLE = "Aurixa Systems — Voice Agent Knowledge Base";

export const INTRO =
  "This document is reference material for Aurixa Systems voice agents. It contains the facts an agent may draw on when answering callers, and nothing else. It never overrides the agent's own instructions: an agent still never claims an application is approved, accepted or allocated, never promises platform access, never invents an appointment time, and never negotiates pricing. Where this document does not cover something, the honest answer is that the team will follow up — not a guess.";

export const SECTIONS = [
  // ══════════════════════════════════════════════════════ 1. the company
  h1("1. Who Aurixa Systems is"),
  h2("What does Aurixa Systems do?"),
  p(
    "Aurixa Systems is an Australian company that builds governed AI operating systems for property, finance and advisory firms. Client intelligence, financial modelling, AI voice agents, document and report generation, and compliance oversight sit together in one controlled, white-labelled platform, provisioned and managed for each client organisation. The company sign-off is: “Structured intelligence for confident property decisions.”",
  ),
  h2("Is Aurixa a product I can sign up for online?"),
  p(
    "No. There is no self-serve signup and no public free trial. Access runs through a structured priority access programme: an application, a readiness questionnaire, and a strategic review with the team. The platform is then provisioned and configured for the organisation rather than handed over as a generic account.",
  ),
  h2("Who is the platform for?"),
  p(
    "Australian property, finance and advisory organisations: buyer's agencies, property advisory firms, real estate agencies, mortgage and finance brokerages, property developers, construction and building firms, accounting and SMSF advisories, conveyancing and legal services, property management, multi-service property groups, and technology or integration partners.",
  ),
  p(
    "The people who usually make the decision are founders and directors, chief executives, operations leaders, technology or systems leads, and compliance or risk managers. Enterprise conversations suit franchise groups, networks, national or multi-entity organisations, and white-label partners.",
  ),
  h2("How do I reach Aurixa Systems?"),
  p(
    "The website is aurixasystems.com.au. The team can be reached by email at admin@aurixasystems.com.au. Applications are made at aurixasystems.com.au/contact, and existing customers use aurixasystems.com.au/support.",
  ),
  h2("Is Aurixa Systems the same as the platform my firm uses?"),
  p(
    "Aurixa builds and operates the platform; each client organisation runs it under its own brand, on its own tenancy. So a customer may know the software by their own firm's name. An agent should not assume which branded workspace a caller is describing, and should ask which organisation they are with.",
  ),

  // ══════════════════════════════════════════════════════ 2. access
  h1("2. How access works — the priority access pathway"),
  p(
    "Access is by application, in three stages. Joining the waitlist does not guarantee platform access, and there is no paid queue priority: Aurixa does not accept payment to move an application up the list.",
  ),
  h2("Stage 1 — what is the Priority Access Application?"),
  ...bullets([
    "Completed on the website at aurixasystems.com.au/contact. It takes about 60 to 90 seconds.",
    "It asks for name, work email, mobile number, organisation name, role, organisation type, approximate annual client or transaction volume, current bottlenecks, and the areas the organisation most wants to improve.",
    "On submission the applicant receives an application reference in the form AX- followed by ten characters, and an email titled “Application Received” containing a secure personal link to the Business Readiness Questionnaire.",
  ]),
  h2("Stage 2 — what is the Business Readiness Questionnaire?"),
  ...bullets([
    "It takes approximately 6 to 8 minutes, and progress is saved as the applicant goes, so it can be finished in more than one sitting.",
    "It is reached through the secure link in the “Application Received” email — worth checking the spam folder. If the link has expired, the application reference together with the work email reopens the questionnaire on the website. Secure links should not be forwarded.",
    "It covers the organisation's structure, current systems and workflows, the Aurixa capabilities that matter most, integration and migration needs, security requirements, implementation timing and the most useful next step.",
    "Once it is complete, the Aurixa team reviews the application, aiming to complete the initial review within two business days. No further submission is required in the meantime.",
  ]),
  h2("Stage 3 — what happens in the Strategic Review?"),
  ...bullets([
    "A 30-minute private online session with the Aurixa team, booked from the link in the “Questionnaire Received” email within a 45-day booking window.",
    "Available times run Monday to Friday, 9:00 a.m. to 4:30 p.m. Sydney time, in 30-minute slots, with at least 24 hours' notice.",
    "A booking is a request. The Aurixa team confirms it by email, usually within one business day, and the calendar invitation with meeting access details follows separately from the team.",
    "In the session the team works through the questionnaire responses — the current operational environment, priority workflows, platform suitability and implementation considerations — and recommends the right pathway: a platform discovery session, a guided demonstration, or an enterprise requirements consultation.",
  ]),
  h2("How long does the whole process take?"),
  p(
    "The two published timings are the ones to quote and the only ones: the initial review is aimed at within two business days of the questionnaire being completed, and a booking request is confirmed by email usually within one business day. Everything after that depends on the organisation's own timing and what the strategic review recommends, so no agent should put a figure on it.",
  ),
  h2("Can I skip a stage, or go straight to a demonstration?"),
  p(
    "No stage is skipped. The questionnaire is what makes the strategic review useful — the team arrives having read the organisation's own answers rather than starting from scratch. A guided demonstration is one of the outcomes the review can recommend.",
  ),
  h2("What if I applied and have not heard anything?"),
  p(
    "First check whether the Business Readiness Questionnaire was completed: the review clock starts when the questionnaire is in, not when the application was submitted. If it was completed more than two business days ago, the team can look it up against the application reference, and an agent should take the caller's details rather than speculate about the outcome.",
  ),

  // ══════════════════════════════════════════════════════ 3. the platform
  h1("3. What the platform actually does"),
  p(
    "These are the platform's capabilities in Aurixa's own vocabulary. Each is configured to the client organisation rather than deployed as a generic template, and which of them a given organisation has depends on its plan and the modules it has enabled.",
  ),
  h2("Client records and workflow"),
  ...bullets([
    "CRM — client records, pipeline and activity in one place.",
    "Client onboarding and workflow — structured onboarding journeys with task accountability, so a handover is a step rather than an email.",
    "Buyer's agency workflow — the end-to-end buying journey for buyer's agents, from brief through to settlement.",
    "Deal pipeline — opportunities and their stages, with the work each stage owes.",
    "Calendar and task automation — bookings, reminders and downstream tasks triggered automatically rather than remembered.",
  ]),
  h2("Portals — what a client or partner sees"),
  ...bullets([
    "Client and partner portals — branded portals where clients and partners see their own information, under the organisation's brand rather than Aurixa's.",
    "Finance portal — finance and broker coordination, handovers and finance messaging.",
    "Solicitor portal and builder or developer portal — partner hand-off portals, each with its own scope. A portal fee buys that portal's own scope and never grants the AML/CTF module.",
  ]),
  h2("Financial modelling and analysis"),
  ...bullets([
    "Borrowing capacity and serviceability modelling — a lending matrix and capacity analysis.",
    "Ten-year cash-flow and portfolio analysis — long-range financial modelling and portfolio views.",
    "Property comparison and due diligence — side-by-side analysis and research workflows.",
    "Commercial and industrial analysis — capacity and valuation work for commercial property.",
  ]),
  h2("Reports and documents"),
  ...bullets([
    "Report generation — branded, data-driven client reports produced from live records rather than retyped.",
    "Suburb and market reporting — market updates and location intelligence.",
    "Template builder — document and report templates under the organisation's own brand.",
    "Agreements — agreement templates the organisation issues itself.",
  ]),
  h2("AI and communications"),
  ...bullets([
    "AI communications and email copilot — drafting and managing client communications with AI assistance.",
    "AI voice agents and call logging — inbound and outbound voice agents, with full call records, transcripts and outcomes written back to the CRM.",
    "Client AI and the Aurixa Intelligence Hub — assistance surfaced inside the client-facing surfaces and across the workspace.",
  ]),
  h2("Compliance"),
  ...bullets([
    "AML and CTF — an AML/CTF compliance workflow with oversight, screening, customer due diligence and reporting. It is a module in its own right and is included in every tier's headline price.",
    "SMSF workflow — self-managed super fund advisory workflow.",
  ]),
  h2("Does it connect to the systems we already use?"),
  p(
    "There is an integrations capability covering connections to systems such as Microsoft 365, Google Workspace, Xero, MYOB, Cotality (formerly CoreLogic), electronic signing and identity verification providers, plus an API. Integrations are subject to the client organisation integrating its own accounts with those services, and what is practical for a particular firm is a strategic-review conversation rather than something an agent should commit to on a call.",
  ),

  // ══════════════════════════════════════════════════════ 4. plans
  h1("4. Plans and prices"),
  p(
    "Aurixa is sold as seat-banded plans plus optional add-on modules, prepaid AI credits, and a one-off onboarding package. All prices are in Australian dollars and include GST — nothing is added at checkout. The strategic review is where pricing is worked through properly for a specific organisation; an agent states the published shape and never negotiates, discounts or promises custom terms.",
  ),
  h2("What do the plans cost?"),
  ...tierLines().map(b),
  b(annualSentence()),
  b("Plan changes are pro-rated on the next billing cycle."),
  h2("Why does each plan have two prices?"),
  p(amlSentence()),
  h2("What if we need more than 30 seats?"),
  p(
    "That is the Enterprise conversation: scoped and quoted rather than listed, and aimed at franchise groups, networks, national or multi-entity organisations and white-label partners. Multi-year arrangements are available. An agent never quotes an enterprise figure, because there is no list price to quote.",
  ),
  h2("Is there a free trial?"),
  p(
    "There is no self-serve free trial. A sandbox environment with sample data can be arranged through the contact page, and the strategic review is where that is agreed.",
  ),

  // ══════════════════════════════════════════════════════ 5. modules
  h1("5. Add-on modules"),
  p(
    "Each module is its own monthly subscription in Australian dollars including GST, and can be cancelled independently of the plan. A purchased module is enabled by the team, usually within one business day. Some modules are already included at no extra cost on the higher tiers, and a caller who is on that tier should not be quoted a price for something they already have.",
  ),
  ...moduleLines().flatMap((group) => [h2(group.heading), ...group.bullets.map(b)]),
  h2("Can a module be cancelled on its own?"),
  p(
    "Yes. Each add-on module is billed as its own monthly subscription and can be cancelled independently of the plan. Cancelling a module does not cancel the plan, and dropping the AML/CTF module changes the subscription by the same amount adding it would.",
  ),

  // ══════════════════════════════════════════════════════ 6. credits
  h1("6. Credits — what they are and how they are spent"),
  h2("What are report credits?"),
  p(
    "Credits meter the AI work the platform does, principally report generation. The cost of each report type is fixed and published inside the platform, so a team can see what a report will spend before running it. Every plan includes a monthly credit allowance, and more can be bought as one-off top-up packs.",
  ),
  h2("Do credits expire?"),
  ...bullets([
    "Credits expire 30 days from issue. Unused credits roll over within that window, and the soonest-to-expire credits are always spent first.",
    "A failed generation costs nothing: credits are held during a run and released if the run fails.",
    "The monthly allowance included with a plan is issued as real credits on the same 30-day clock as a top-up pack, and is spent the same way.",
  ]),
  h2("What do top-up packs cost?"),
  b(topupRangeSentence()),
  ...topupLines().map(b),
  h2("What happens when we run out of credits?"),
  p(
    "Report generation is what credits pay for, so running out stops new generations rather than locking the workspace. A top-up pack restores it immediately. A caller who is repeatedly running out is usually on the wrong tier for their volume, and that is worth raising with the team rather than solving with packs.",
  ),

  // ══════════════════════════════════════════════════════ 7. onboarding
  h1("7. Onboarding — what happens after signing"),
  h2("What does onboarding involve?"),
  ...bullets([
    "A dedicated specialist walks the team through configuration, brand setup, workflows and training.",
    "The first step is a kickoff call with that specialist. Backend provisioning follows, then domain and branding setup, module enablement, seats, billing, training, and a go-live confirmation.",
    "Larger packages include data migration from existing systems, integrations, and white-label theming.",
  ]),
  h2("What do the onboarding packages cost?"),
  p(
    "Onboarding is a one-off package rather than a subscription, and the package that suits an organisation depends on the size of the migration and how much integration and theming is involved. The figures are commercial detail the team goes through in the strategic review, so an agent confirms that onboarding is a separate one-off cost and lets the team quote it.",
  ),
  h2("How long does onboarding take?"),
  p(
    "There is no published timeframe, and an agent should not invent one. The kickoff call is where the specialist sets the schedule against the organisation's own go-live date.",
  ),

  // ══════════════════════════════════════════════════════ 8. security
  h1("8. Security and governance"),
  h2("How is our data protected?"),
  ...bullets([
    "Single sign-on, multi-factor authentication, role-based access control and audit logs.",
    "Australian data residency, and an isolated tenancy for each organisation rather than a shared database.",
    "Client data is not scraped, aggregated or repurposed for training internal machine-learning models.",
  ]),
  h2("Can you meet our security review requirements?"),
  p(
    "Enterprise requirements such as penetration testing, service-level agreements, vendor-risk assessment and dedicated environments are handled through the enterprise requirements consultation. An agent takes the requirement and passes it on rather than answering a security questionnaire on a call.",
  ),
  h2("Should I send documents or client details on this call?"),
  p(
    "No. Callers should not share client identification documents, financial records or confidential client information on a call or in an application. If something needs to be sent, the support portal or an email to the team is the right channel.",
  ),

  // ══════════════════════════════════════════════════════ 9. support
  h1("9. Support for existing customers"),
  h2("How do I get help with something that is not working?"),
  p(
    "Two routes, and both reach the same place. The support page at aurixasystems.com.au/support is the fastest: an assistant answers how-do-I questions against the platform user guide, and anything else becomes a ticket. Calling Aurixa also works — the support line can raise the ticket on the call and give the caller its reference number before hanging up.",
  ),
  h2("What happens to a support ticket?"),
  ...bullets([
    "Tickets go straight to Aurixa Mission Control and are classified by severity the moment they arrive, from the description rather than by asking the customer to choose.",
    "Eligible lower-severity issues are queued for automatic remediation; urgent incidents go straight to an engineer, and anything that could destroy client data, money or access control is always validated by a person before anything runs.",
    "Updates are emailed to the address on the ticket. The ticket reference should be quoted in any follow-up.",
  ]),
  h2("How quickly will someone respond?"),
  p(
    "Tickets are triaged across five severity bands, and the response target attaches to the band rather than to the customer: P0, a critical incident such as the platform being down or a security threat, targets a response within 30 minutes; P1 within 2 hours; P2, a degraded feature, within 8 hours; P3 within one day; and P4, a cosmetic or question-level item, within three days. These are response targets, not fix times, and nobody should be promised a fix time on a call.",
  ),
  h2("Who decides how urgent my issue is?"),
  p(
    "The severity is worked out from what was reported — what is broken, how much of it, and what kind of problem it is — and it is deliberately not a question the customer is asked. Describing the problem fully is what gets it banded correctly. A caller who believes their issue has been under-rated should say so, and the team can look at it again.",
  ),
  h2("What should I have ready when I report a problem?"),
  ...bullets([
    "What you were doing when it happened, and what you expected to happen instead.",
    "The exact wording of any error on screen.",
    "When it started, and whether it is affecting everyone in the organisation or just you.",
    "Whether there is a workaround you are using in the meantime.",
  ]),
  h2("Which problems always go to a person?"),
  p(
    "Outages, security concerns, suspected data loss and billing disputes are always escalated to a person. An agent collects the details and never troubleshoots such an incident on the call — no guessing at causes, no suggested workarounds inside the customer's environment.",
  ),
  h2("Can I add a screenshot or a file?"),
  p(
    "Yes, on the support portal, against the ticket. Files cannot be taken over the phone, so the pattern is: raise the ticket on the call, then add the attachment to that ticket on the portal using its reference.",
  ),
  h2("I am not a customer yet but I have a technical question."),
  p(
    "Support is for live customers, but the caller is not in the wrong place: pre-purchase technical questions are exactly what the strategic review covers, and the pathway starts with the short application on the website.",
  ),

  // ══════════════════════════════════════════════════════ 10. billing
  h1("10. Billing and account questions"),
  h2("How is Aurixa billed?"),
  p(
    "Plans are billed monthly, or twelve months up front at the annual discount. Add-on modules are billed as their own monthly subscriptions. Credit top-up packs and onboarding are one-off purchases. All published figures are in Australian dollars and include GST, so the amount quoted is the amount charged.",
  ),
  h2("Can we change plan?"),
  p(
    "Yes. Plan changes are pro-rated on the next billing cycle. Which tier suits an organisation is a seats-and-volume question — the seat bands are 1 to 4, 5 to 15, and 16 to 30 — and past 30 seats it becomes an enterprise conversation.",
  ),
  h2("There is a problem with our invoice."),
  p(
    "Billing disputes always go to a person. An agent takes the details — what was charged, what was expected, and the organisation — raises it, and never adjusts, credits, refunds or explains away a charge on the call.",
  ),
  h2("Can we pay to be prioritised?"),
  p(
    "Not for the application queue: Aurixa does not accept payment for queue priority, and an agent should say so plainly rather than leaving it open. Support severity is likewise set by the nature of the problem and not by the plan.",
  ),

  // ══════════════════════════════════════════════════════ 11. the call itself
  h1("11. What a caller can do on this call"),
  h2("Can you book me in?"),
  p(
    "The agents can offer real available times and place a booking request. A booking made on a call is a request: the Aurixa team confirms it by email, usually within one business day, and the calendar invitation follows separately. An agent never presents a booking as final and never invents a time that was not offered.",
  ),
  h2("Can you put me through to a person?"),
  p(
    "The reception agents can transfer a caller to the Aurixa Systems team. If nobody is available the agent says so plainly and takes the caller's details for a call back, rather than leaving them holding.",
  ),
  h2("Can you look at my account or fix something for me?"),
  p(
    "No. The agents cannot access, change or check anything inside a customer's environment, cannot see an individual account, and cannot diagnose a fault. What they can do is capture the problem properly, raise it, and make sure the right people have it.",
  ),
  h2("Can you tell me if my application was approved?"),
  p(
    "No. An agent never states, implies or guesses the outcome of an application, and never says an application is approved, accepted or allocated. The team communicates outcomes directly.",
  ),

  // ══════════════════════════════════════════════════════ 12. quick answers
  h1("12. Quick answers"),
  ...bullets([
    "Where do I apply? — aurixasystems.com.au/contact; the application takes about 60 to 90 seconds.",
    "My questionnaire link expired. — The application reference, which looks like AX- followed by ten characters, plus the work email reopens it on the website; links are time-limited for the applicant's protection.",
    "I did not get the email. — It is worth checking the spam folder first; failing that the reference plus the work email reopens the questionnaire, and the team can resend against the reference.",
    "I applied with the wrong email. — Email admin@aurixasystems.com.au and the team will correct it against the application reference.",
    "How long until I hear back? — The team aims to complete the initial review within two business days of the questionnaire being completed.",
    "When can the review be booked? — Monday to Friday, 9:00 a.m. to 4:30 p.m. Sydney time, at least 24 hours ahead, within a 45-day window; a separate confirmation email and calendar invitation follow from the team.",
    "Can I pay to skip the queue? — No. Aurixa does not accept payment for queue priority.",
    "Is a booking final once made on a call? — It is a request in the calendar; the Aurixa team confirms by email, usually within one business day.",
    "Can modules be cancelled? — Yes, each add-on module is billed as its own monthly subscription and can be cancelled independently of the plan.",
    "Is the platform white-labelled? — Yes; the platform is delivered under the client organisation's own brand.",
    "Where do I report a fault? — aurixasystems.com.au/support, or on this call — the support line can raise the ticket and give you its reference.",
    "How do I track a ticket I already raised? — On the support portal, using the ticket reference; updates are also emailed to the address on the ticket.",
    "Do credits expire? — Yes, 30 days from issue; unused credits roll over inside that window and the soonest to expire are spent first.",
    "Does a failed report cost credits? — No. Credits are held during a run and released if it fails.",
    "Is our data held in Australia? — Yes; Australian data residency, with an isolated tenancy per organisation.",
    "Confidential documents on calls or forms? — Please do not share client identification documents, financial records or confidential client information on a call or in an application.",
  ]),

  // ══════════════════════════════════════════════════════ 13. never
  h1("13. What an agent must never say"),
  p(
    "These are the claims that would be wrong even where a caller pushes for them, and they hold whatever else this document says.",
  ),
  ...bullets([
    "That an application is approved, accepted or allocated, or that access is guaranteed — including implying it by talking about next steps as though the decision were made.",
    "That the waitlist guarantees access, or that payment can move an application up it.",
    "A price that is not in this document, a discount, a negotiated term, or an enterprise figure — enterprise is scoped and quoted, so there is nothing to quote.",
    "A fix time, a resolution time, or a specific person who will call back. The published response targets are the only timings.",
    "A booking as confirmed. A booking made on a call is a request, and the team confirms it by email.",
    "A ticket reference that was not returned by the system, or that a report is logged when it is not.",
    "Financial, investment, lending, legal, tax or situation-specific compliance advice.",
    "Anything about a named competitor.",
    "Anything at all this document does not cover. The honest answer is that the information here covers the general details and the team is best placed to help directly — and then to make sure it is flagged for them.",
  ]),
];
