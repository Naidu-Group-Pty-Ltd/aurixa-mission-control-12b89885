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
// headings are QUESTIONS a caller would actually ask - or, in the hesitation
// section, the caller's own words - and each answer repeats enough context to
// stand without the heading above it.
//
// It is also SPOKEN. Every answer leads with the answer, runs two to four
// sentences, fits comfortably inside thirty seconds, and where it is sales
// guidance it ends on a question the agent can ask back. A passage a model
// cannot say aloud without paraphrasing into a monologue is a passage the
// caller hears as a monologue.
//
// ── Why it was rewritten (24 Sep 2026) ───────────────────────────────────────
//
// The previous corpus was accurate and could not sell. Measured, it was about
// half process, support and billing rules, a third price lists, and the rest
// one-line feature definitions - with no value proposition, no statement of
// the problem, nothing about any particular kind of firm, no differentiation
// and no answer to a single hesitation beyond price and trial. So when a
// caller asked "why would a firm like mine need this?", the nearest passage
// was a price or a feature bullet, and that is what they heard - which is
// exactly how "it keeps repeating features and pricing" was reported.
//
// Parts A to C below are the new material: why Aurixa exists, what it does for
// each kind of firm, how it differs, how to answer hesitation, how to ask, and
// what it looks like in practice. Part D is the reference material, kept,
// corrected and made to match the catalog.
//
// ── The content rules ────────────────────────────────────────────────────────
//
// 1. NOTHING IS INVENTED. There are no customer names, testimonials, case
//    studies or measured outcomes anywhere in this document, because none has
//    been verified, and a figure spoken to a prospect is a claim. Outcomes are
//    described in plain words, and every walk-through says it is illustrative.
//    Sources: the company's own published copy (aurixasystems.com.au), the
//    price list in src/lib/pricing/aurixa-catalog.ts and tier-features.ts, the
//    platform's user guide, and the support classifier.
// 2. NO PROPERTY-DATA PROVIDER IS NAMED, and one in particular is never
//    mentioned at all. build-knowledge-doc.mjs refuses to render a corpus that
//    names it, and the same refusal covers the other claims this document
//    must not make (see DENYLIST there).
// 3. NOTHING HERE OVERRIDES AN AGENT'S OWN INSTRUCTIONS. The sales guidance is
//    guidance on substance, never permission: an agent still never claims an
//    application is approved, never promises access, never invents a time,
//    never negotiates price, and never re-offers past its own prompt's limits.
import {
  amlSentence,
  amlUplift,
  annualSentence,
  moduleLines,
  tierFitLines,
  tierInclusionLines,
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
  "This document is reference material for Aurixa Systems voice agents. It holds two kinds of material: why firms choose Aurixa and how to talk with them about it, and the facts about the platform, plans, access and support. Everything in it is guidance on substance and never permission: it never overrides the agent's own instructions. An agent still never claims an application is approved, accepted or allocated, never promises platform access, never invents an appointment time, never negotiates pricing, and never re-offers or persists beyond what its own instructions allow. There are no customer names, testimonials or measured results in this document, and an agent never supplies any. Where this document does not cover something, the honest answer is that the team will follow up — not a guess.";

export const SECTIONS = [
  // ════════════════════════════════════════════════════════════════════════
  // PART A — Why Aurixa exists, and why now
  // ════════════════════════════════════════════════════════════════════════

  h1("1. Why Aurixa exists"),
  h2("What problem does Aurixa solve?"),
  p(
    "Most property, finance and advisory firms run on a patchwork: client details in one system, spreadsheets for the numbers, reports built by hand in a document, partners chased by email, and compliance tracked somewhere else again. The same client gets typed in several times, nobody can see at a glance where a deal is up to, and every new client adds admin rather than capacity. Aurixa brings that work into one connected platform, so the firm's time goes on advice instead of assembly.",
  ),
  p(
    "A useful question back: \"Where does most of your team's time go at the moment — is it the client work itself, or pulling it all together?\"",
  ),
  h2("What does Aurixa Systems do?"),
  p(
    "Aurixa Systems is an Australian company that builds governed AI operating systems for property, finance and advisory firms. In plain terms, it is one platform where a firm's clients, financial modelling, reports, partner handovers and compliance live together, under the firm's own brand. Each firm gets its own workspace, configured to how it works, rather than a generic account. The company sign-off is: \"Structured intelligence for confident property decisions.\"",
  ),
  h2("Who built Aurixa, and does it understand how a firm like ours works?"),
  p(
    "Aurixa was built inside a working Australian property advisory firm and is used there every day, so it was shaped by the day-to-day of client briefs, finance handovers, reports and compliance rather than designed from the outside. That is why its workflows follow the way an advisory practice actually runs. Anything specific about how it would fit a particular firm is exactly what the strategic review with the team is for.",
  ),
  h2("Why are firms looking at this now?"),
  p(
    "Three things have changed at once. Clients now expect fast, professional analysis and a clear view of where their matter is up to. AI has arrived in advisory work, and the real question for a regulated firm is how to use it safely, inside its own records, rather than in a separate tool nobody governs. And the anti-money-laundering reforms have brought real estate, conveyancing, legal and accounting firms into AML/CTF regulation for the first time, which means new customer-due-diligence work on top of everything else.",
  ),
  p(
    "On the regulatory point an agent never gives advice: the dates, and whether a particular firm is covered, are questions for the firm's own adviser or AUSTRAC, and the team can talk through how the platform supports the workflow.",
  ),
  h2("What does \"governed AI\" actually mean?"),
  p(
    "It means the AI works inside the firm's own records and rules rather than beside them. Access follows each person's role, sensitive actions are logged, the firm can see which AI model powers each feature, and the people in the firm stay in charge of what goes to a client. Client data is not scraped, aggregated or used to train internal machine-learning models. It is AI a regulated business can explain to its clients and its compliance team.",
  ),
  h2("What actually changes for a firm day to day?"),
  ...bullets([
    "One client record that everyone works from, instead of the same details retyped across systems.",
    "Reports and analysis generated from the live record, branded as the firm's own, rather than assembled by hand.",
    "Handovers — to finance, to a solicitor, to a builder — that are a step in the platform rather than an email chain.",
    "A pipeline anyone can read at a glance, so nothing depends on one person remembering.",
    "Compliance checks run in the same place as the client work, with the evidence kept.",
    "Clients who see a professional, branded portal rather than a collection of attachments.",
  ]),
  p(
    "The honest summary: less assembly, fewer handover gaps, and a firm that can take on more clients without the admin growing at the same rate.",
  ),
  h2("Is Aurixa a product I can sign up for online?"),
  p(
    "No. There is no self-serve signup and no public free trial. Access runs through a structured priority access programme — a short application, a readiness questionnaire, and a strategic review with the team — because each firm's workspace is provisioned and configured for it rather than handed over as a generic account. The structure is there so the team can recommend the right setup rather than sell the wrong one.",
  ),
  h2("Who is the platform for?"),
  p(
    "Australian property, finance and advisory organisations: buyer's agencies, property advisory and investment firms, wealth advisers, real estate agencies, mortgage and finance brokerages, conveyancers and legal practices, accounting and SMSF advisory firms, property developers and builders, property managers, and multi-office groups, networks and franchises.",
  ),
  p(
    "The people who usually make the decision are founders and directors, chief executives, operations leaders, technology leads, and compliance or risk managers.",
  ),
  h2("How do I reach Aurixa Systems?"),
  p(
    "The website is aurixasystems.com.au. The team can be reached by email at admin@aurixasystems.com.au. Applications are made at aurixasystems.com.au/contact, and existing customers use aurixasystems.com.au/support.",
  ),
  h2("Is Aurixa Systems the same as the platform my firm uses?"),
  p(
    "Aurixa builds and operates the platform; each client organisation runs it under its own brand, in its own workspace. So a customer may know the software by their own firm's name. An agent should not assume which branded workspace a caller is describing, and should ask which organisation they are with.",
  ),

  // ════════════════════════════════════════════════════════════════════════
  // PART B — What Aurixa does for each kind of firm
  // ════════════════════════════════════════════════════════════════════════

  h1("2. What Aurixa does for your kind of firm"),
  p(
    "Each answer below describes what the work usually looks like for that kind of firm, what changes with Aurixa, which parts of the platform matter most, a good question to ask, and one way to put it. They describe how the platform is designed to be used — not the results of any particular client.",
  ),

  h2("What would Aurixa do for a buyer's agency?"),
  p(
    "A buyer's agent's week is property searches, due diligence, and turning research into something a client can act on — and much of that is done by hand, then rebuilt as a presentation. Aurixa keeps each client's brief, finances and shortlist in one record, and produces branded investment reports, ten-year cash flows and side-by-side comparisons from that record, so due diligence turns into a professional client briefing without the rebuild. Clients see their reports in the firm's own portal, and the deal pipeline shows every purchase from brief to settlement.",
  ),
  p(
    "A good question to ask: \"When you find a property for a client, how long does it take to get from your research to something you'd be happy to send them?\" One way to put it: Aurixa turns your research into client-ready analysis, under your brand.",
  ),

  h2("What would Aurixa do for a property advisory or investment firm?"),
  p(
    "Property advisers usually juggle market research, client financials and long-range modelling across separate tools, and the hard part is presenting it as one coherent strategy. Aurixa puts the client's position, borrowing capacity, ten-year cash flow, portfolio view and market reporting in one place, and adds a phased game plan for each client, so the advice reads as a single strategy rather than a stack of spreadsheets. Because it is all under the firm's brand, what the client receives looks like the firm, not the software.",
  ),
  p(
    "A good question to ask: \"How do you currently pull a client's borrowing position, their cash flow and your property research together into one recommendation?\" One way to put it: your whole advisory process in one governed place, presented as your firm.",
  ),

  h2("What would Aurixa do for a wealth or financial adviser?"),
  p(
    "For a wealth adviser, property is often one part of a wider strategy, and it is hard to keep property advice consistent and well documented across a team. Aurixa gives property the same structure as the rest of the practice: the client's financial profile, borrowing capacity and long-range cash flow modelled consistently, reports generated the same way every time, and an audit trail of what was prepared and shared. The platform supports the process; the advice, and the licensing behind it, remain the firm's own.",
  ),
  p(
    "A good question to ask: \"How consistent is the way property gets modelled and documented across your advisers today?\" One way to put it: property advice with the same structure and record-keeping as the rest of your practice.",
  ),

  h2("What would Aurixa do for a mortgage or finance broker?"),
  p(
    "Brokers often see the loan in isolation from the property strategy, and the relationship can go quiet after settlement. Aurixa connects borrowing capacity to the property plan and the ten-year holding picture, gives brokers a dedicated finance portal where the clients and files shared with them arrive ready to work on, and keeps finance messages in the same record. That turns a one-off transaction into a continuing client relationship, with reasons to stay in touch after settlement.",
  ),
  p(
    "A good question to ask: \"What happens with your clients after settlement — how do you stay involved in what they do next?\" One way to put it: borrowing capacity connected to the whole property journey, so clients stay with you.",
  ),

  h2("What would Aurixa do for a real estate agency?"),
  p(
    "Agencies compete in a crowded market, and investor clients increasingly want more than a listing — they want to know whether a property stacks up. Aurixa lets an agency hand an investor branded analysis, cash-flow projections and market reporting under its own name, which lifts how the agency is seen and gives clients a reason to come back. The same platform also supports the customer-due-diligence work that AML/CTF regulation now asks of agencies.",
  ),
  p(
    "A good question to ask: \"When an investor asks whether a property is a good buy, what can you give them today beyond the listing?\" One way to put it: give investors real analysis under your own brand, and stand out from agencies that only list.",
  ),

  h2("What would Aurixa do for a conveyancer or solicitor?"),
  p(
    "Conveyancers and solicitors sit in the middle of the property transaction, usually waiting on documents and chasing parties by email, and they now carry AML/CTF customer-due-diligence obligations as well. Aurixa gives them a dedicated solicitor portal where they see only the clients and files shared with them, and a compliance workflow — identity verification, screening, review and record-keeping — in the same place. Where a client has already been verified through a Compliance Passport, an authorised professional can rely on that shared record instead of collecting the same documents again.",
  ),
  p(
    "A good question to ask: \"How much of a typical matter is spent waiting on documents or chasing the other parties?\" One way to put it: the matter, the documents and the compliance checks in one place, without the chasing.",
  ),

  h2("What would Aurixa do for an accountant or SMSF adviser?"),
  p(
    "Accountants are often the adviser clients trust most, yet property decisions — including property inside a self-managed super fund — tend to happen in conversations and spreadsheets the practice cannot see. Aurixa gives the practice a structured view of a client's property position: portfolio analysis, long-range cash flow and borrowing capacity, documented the same way every time. It also supports the AML/CTF customer-due-diligence work that the reforms have brought to accounting practices.",
  ),
  p(
    "A good question to ask: \"How involved does your practice get when a client is buying property, and how is that advice recorded today?\" One way to put it: a clear, documented view of your clients' property decisions, in the same place as the compliance work.",
  ),

  h2("What would Aurixa do for a developer or builder?"),
  p(
    "Developers and builders often sell on price alone and send the same stock list to dozens of agents, where it is out of date within days. With Aurixa a builder publishes its stock once, so advisers and agents on the platform work from the current list, and they can generate snapshot reports and cash-flow projections that show a buyer the long-term value of a lot or an off-the-plan purchase. Buyers' identity checks can arrive already done through a Compliance Passport, rather than being collected again.",
  ),
  p(
    "A good question to ask: \"How do the agents and advisers who sell your stock find out what's still available?\" One way to put it: publish your stock once, and let buyers see its long-term value, not just its price.",
  ),

  h2("What would Aurixa do for a multi-office group, network or franchise?"),
  p(
    "Larger groups find that growth means more people doing the same work in different ways, and keeping quality and branding consistent across offices gets harder with every one added. Aurixa gives a group one governed platform with role-based access, activity logs and brand control across every office and entity, so each office works the same way and the head office can see across all of them. Groups of this size are an Enterprise conversation — scoped and quoted by the team rather than listed.",
  ),
  p(
    "A good question to ask: \"How consistent is the client experience across your offices today, and how do you see it from head office?\" One way to put it: one standard of delivery across every office, with the oversight to prove it.",
  ),

  h2("What if my kind of business isn't listed?"),
  p(
    "The platform is used across property, finance and advisory work, and the pattern is usually the same: client information, analysis and handovers spread across too many places. The best next step is to describe how the business works in the short application, so the strategic review can look at the fit properly rather than guessing on a call.",
  ),

  // ════════════════════════════════════════════════════════════════════════
  // PART C — Handling a real conversation
  // ════════════════════════════════════════════════════════════════════════

  h1("3. How Aurixa is different"),
  p(
    "These answers explain the difference without criticising anyone. An agent never names a competitor or another product, and never runs down what a caller uses today.",
  ),
  h2("How is Aurixa different from what we use now?"),
  p(
    "Most firms use a set of separate tools that each do one job — a CRM, spreadsheets, a document template, an email inbox, something for compliance — with a person holding it all together. Aurixa is built around the advisory work itself, so the client record, the analysis, the reports, the partner handovers and the compliance checks are connected. The difference is less time moving information between tools and fewer places for something to fall through.",
  ),
  h2("We already have a CRM. How is this different?"),
  p(
    "A general CRM is good at storing contacts and activity. Aurixa is built specifically for regulated property, finance and advisory work: it models borrowing capacity and cash flow, generates branded reports, runs partner portals for finance, legal and building partners, and handles compliance, with governance and white-labelling built in rather than bolted on. Whether it sits alongside an existing system or replaces part of it is a question for the strategic review, where the team looks at what the firm already runs.",
  ),
  h2("Why not just use a general AI tool?"),
  p(
    "A general AI tool sits outside the firm's records and outside its controls. Aurixa's AI works inside the firm's own workspace, on the firm's own client records, with access by role, activity logged, and visibility of which AI model powers each feature — and client data is not used to train internal models. That is the difference between an assistant a regulated firm can govern and one it cannot.",
  ),
  h2("Why not build something like this ourselves?"),
  p(
    "Firms can and sometimes do, but the build is the easy part: the ongoing work is keeping it secure, compliant and up to date. Aurixa is maintained centrally, so improvements flow to every client workspace rather than each firm maintaining its own. The firm keeps its own brand and its own workspace without carrying the engineering.",
  ),
  h2("What does white-labelled mean for us?"),
  p(
    "It means clients and partners see the firm, not Aurixa. The dashboard, the client portal and the reports carry the firm's own brand, so every report and every client interaction strengthens the firm's name.",
  ),
  h2("How is the AML/CTF side different from doing it by hand?"),
  p(
    "Done by hand, customer due diligence tends to be forms, emails, follow-ups and more emails, with the evidence scattered. In Aurixa it runs as one journey — invite, verify identity, screen, review, approve — with the evidence retained and every action recorded in a tamper-evident log. A verified client can carry a Compliance Passport that authorised partners can rely on, instead of each professional collecting the same documents again. The platform supports the workflow and prepares report drafts from the case; the firm itself lodges with AUSTRAC through its own account, and each firm remains responsible for its own obligations.",
  ),

  h1("4. When a caller hesitates"),
  p(
    "Each answer below follows the same shape: acknowledge what the caller said, offer one honest reframe, and suggest one easy next step. Say one point, then ask a question back — never argue, never stack several reasons at once, and never go beyond the agent's own instructions on how often to re-offer. If a caller says no clearly, respect it.",
  ),
  h2("\"It sounds expensive.\""),
  p(
    "That's a fair thing to weigh. The useful comparison is not the plan price on its own but what the firm spends today — separate software subscriptions, and the hours spent retyping, building reports by hand and chasing handovers. Plans are sized by seats, the smallest is built for a solo adviser or small team, and modules can be added one at a time rather than paying for everything. The strategic review is where the team sizes it properly for the firm, rather than pushing a plan it does not need.",
  ),
  p("Ask back: \"Roughly how many hours a week would you say go on admin and pulling reports together?\""),
  h2("\"We're too small for something like this.\""),
  p(
    "The smallest plan is designed for exactly that — a solo adviser or a small team — and a small firm often feels the admin most, because there is nobody else to absorb it. Starting on a well-structured platform early also means the firm does not have to rebuild how it works once it grows.",
  ),
  p("Ask back: \"If you could take a few hours of admin off your week, where would you put that time?\""),
  h2("\"We already have systems that work.\""),
  p(
    "That's good to hear — and nobody needs to replace what is working. The question is usually where the systems meet: where information gets retyped, where a handover waits on an email, or where a report still gets built by hand. Those gaps are where Aurixa is designed to help.",
  ),
  p("Ask back: \"Where do things tend to slow down between your systems?\""),
  h2("\"Now isn't the right time.\""),
  p(
    "Understood — timing matters. Applying early is a simple way to understand the options, even if the firm acts later; the application takes a minute or two and commits the firm to nothing. That way, when the time is right, the groundwork is already done.",
  ),
  p("Ask back: \"Is there a point later in the year when this would make more sense to look at?\""),
  h2("\"Can I just try it first?\""),
  p(
    "There is no self-serve free trial, because each firm's workspace is set up for it rather than handed over as a generic account. What can be arranged is a sandbox with sample data, and the strategic review is where that is agreed — so the firm sees the platform against its own situation rather than a generic demo.",
  ),
  h2("\"Why do I have to apply? Can't I just buy it?\""),
  p(
    "The application is deliberately short — about a minute or two — and it exists so the team can recommend the right setup instead of selling the wrong one. The readiness questionnaire that follows means the strategic review starts from the firm's own answers rather than from scratch, which makes the conversation genuinely useful.",
  ),
  h2("\"We already handle AML another way.\""),
  p(
    `That's fine — the AML/CTF module is optional. Every plan can be taken without it, at ${amlUplift()} a month less, and everything else in the platform works the same. Having customer due diligence in the same place as the client record can still be useful, but that is the firm's call.`,
  ),
  h2("\"I'm not comfortable putting client data into an AI system.\""),
  p(
    "That's exactly the right instinct for a regulated firm. Each firm has its own isolated workspace, access follows each person's role, sensitive actions are logged, and client data is not scraped, aggregated or used to train internal machine-learning models. The firm stays in control of what the AI does and what reaches a client. Detailed security requirements can be worked through with the team.",
  ),
  h2("\"Switching sounds like a lot of work.\""),
  p(
    "It's a fair concern, and it is why onboarding is a guided process rather than a do-it-yourself setup. A dedicated specialist handles configuration, branding, workflows and training, and the larger onboarding packages include migrating data from existing systems. The firm is not left to move everything over alone.",
  ),
  p("Ask back: \"What would you most want to bring across from your current setup?\""),
  h2("\"I need to talk to my business partner first.\""),
  p(
    "Of course — this is a decision for the people who run the firm. It often helps to bring them into the strategic review, so everyone hears the same thing and can ask their own questions. The application itself commits nobody to anything.",
  ),
  p("Ask back: \"Would it be easier to book a time when you can both be there?\""),
  h2("\"Can you just send me some information?\""),
  p(
    "The website at aurixasystems.com.au covers the platform and the access process. The most useful information, though, is specific to the firm, and that comes from the strategic review, which is built around the firm's own answers. The application is the quickest way to get there.",
  ),
  h2("\"Is this real, or just AI hype?\""),
  p(
    "A healthy question. Aurixa is working software built inside an Australian property advisory firm and used there every day — client records, financial modelling, reports, partner portals and compliance, with AI inside those workflows rather than bolted on as a gimmick. The strategic review is the place to see it against the firm's own work rather than take anyone's word for it.",
  ),
  h2("\"What if it doesn't suit how we work?\""),
  p(
    "That is exactly what the process is designed to find out before anyone commits. The readiness questionnaire and the strategic review look at how the firm actually works, and the team recommends a pathway — or says so honestly if it is not the right fit. Each workspace is configured to the firm rather than forcing the firm into a template.",
  ),
  h2("\"I'm just looking — I'm not sure what I need yet.\""),
  p(
    "That's a perfectly good place to start. A couple of questions usually make it clearer — where the team's time goes, and what slows the work down. From there it is easy to see whether Aurixa is worth a closer look.",
  ),
  p("Ask back: \"What made you look into this in the first place?\""),

  h1("5. Understanding a firm — discovery"),
  h2("What questions help me understand what a firm needs?"),
  p(
    "Ask one at a time, listen, and follow what the caller cares about rather than working through a list. Useful questions:",
  ),
  ...bullets([
    "\"What kind of business are you, and roughly how many people are in the team?\"",
    "\"Where does your client information live today — a CRM, spreadsheets, email, a few different apps?\"",
    "\"Roughly how many hours a week do you think go on admin, retyping and pulling reports together?\"",
    "\"When you hand a client over to a broker, solicitor or builder, how does that happen?\"",
    "\"How do you see where every deal or matter is up to right now?\"",
    "\"How are you handling customer due diligence and AML/CTF at the moment?\"",
    "\"What would you most like to fix first?\"",
  ]),
  h2("What should I listen for, and what does it point to?"),
  ...bullets([
    "The same details typed into several systems — points to the single client record.",
    "Reports built by hand, or \"it takes ages to put the report together\" — points to generated, branded reports.",
    "Waiting on brokers, solicitors or builders — points to the partner portals and handovers.",
    "\"I can't see where everything's up to\" — points to the deal pipeline and client tracker.",
    "Identity checks and compliance paperwork chased by email — points to the AML/CTF workflow and the Compliance Passport.",
    "\"We can't take on more clients without hiring\" — points to less admin per client across the whole platform.",
    "Clients asking for more than a listing or a loan — points to branded analysis and the client portal.",
  ]),
  h2("How do I move from a conversation to a next step?"),
  p(
    "Connect one thing the caller said to one part of the platform, check it lands, and then offer the next step: for a new enquiry that is the short application at aurixasystems.com.au/contact, and for someone already in the process it is booking or confirming the strategic review. Never stack several features to make the case — one relevant point, tied to what they said, is more persuasive than ten.",
  ),

  h1("6. What it looks like in practice"),
  p(
    "These walk-throughs show how the platform is designed to be used. They are illustrative, not stories about a particular client, and an agent should present them as \"here's how that tends to work\" — never as a named firm's results.",
  ),
  h2("What does it look like when a new client comes in?"),
  p(
    "A new enquiry becomes a client record, and the client fills in their details through a form rather than over several emails. The adviser runs borrowing capacity and a ten-year cash flow from that record, generates a branded investment report on a shortlisted property, and the client reads it in the firm's own portal. The deal moves along the pipeline from there, so everyone can see where it is up to without asking.",
  ),
  h2("What does a handover to a broker look like?"),
  p(
    "When the client is ready for finance, the adviser sends the relevant details to finance from the client record. The broker sees that client in their finance portal — only the clients and files shared with them, never the firm's whole book — and the finance messages stay attached to the same record. Nobody re-enters the client, and nobody has to chase an email to know where the loan is up to.",
  ),
  h2("What does a compliance check look like?"),
  p(
    "Instead of forms, emails and follow-ups, the client receives an invitation, verifies their identity, and provides what is needed. The firm screens, reviews and approves in one place, with the evidence kept and every step logged. Once the client holds a Compliance Passport, other authorised professionals on the transaction can rely on it rather than collecting the same documents again.",
  ),
  h2("What does it look like for a builder's stock?"),
  p(
    "The builder publishes its available stock once. Advisers and agents on the platform see the current list rather than an old PDF, and can generate a snapshot report or a cash-flow projection for a buyer in a few clicks — so the conversation is about long-term value rather than only the price.",
  ),

  // ════════════════════════════════════════════════════════════════════════
  // PART D — The reference material
  // ════════════════════════════════════════════════════════════════════════

  h1("7. What the platform does"),
  p(
    "These are the platform's capabilities, described by what each one does for the firm. Each firm's workspace is configured to it, and which capabilities a firm has depends on its plan and the modules it has enabled.",
  ),
  h2("Client records and day-to-day workflow"),
  ...bullets([
    "Clients and the Client Tracker — one record per client holding their personal, employment, financial and property details, notes, files, reports and history, so nothing lives in someone's inbox.",
    "Game Plan — a phased strategy for each client, so the long-term plan is written down rather than remembered.",
    "Reminders and checklists — follow-ups that are scheduled rather than remembered, and a consistent checklist for each stage of the work.",
    "Deal Pipeline — every deal from lead to settlement on one board, including commissions, so anyone can see where things are up to.",
    "Client Forms — clients enter their own details through a form, instead of the firm retyping them from emails.",
    "Calendar — appointments in the same place as the client work.",
  ]),
  h2("Portals — what clients and partners see"),
  ...bullets([
    "Client Portal — clients see their reports, request new ones and book appointments, all under the firm's brand.",
    "Finance Portal — brokers and finance partners work on the clients and files shared with them, with finance messages kept on the record.",
    "Solicitor Portal — solicitors and conveyancers see the matters shared with them, without a separate email trail.",
    "Builder and Developer Portal — builders publish and manage their stock in one place, and keep it current. A portal fee buys that portal's own scope and never grants the AML/CTF module.",
  ]),
  h2("Financial modelling and analysis"),
  ...bullets([
    "Borrowing Capacity — a structured serviceability assessment, including a conservative mode for figures that will be shown to a client.",
    "Ten-year cash flow — income, expenses, loan and tax over ten years, with scenarios and interest-rate sensitivity, so a client sees the long-term picture rather than one year.",
    "Comparisons — side-by-side reports and cash flows, so a client can weigh two properties or two strategies properly.",
    "Portfolio Analysis — a whole-portfolio view with equity, lending position and yield, which can be sent to the client as a branded document.",
    "Commercial and Industrial — analysis tools for commercial and industrial property.",
  ]),
  h2("Reports and client documents"),
  ...bullets([
    "Generated Reports — branded, data-driven investment reports produced from the live client record, covering the property, the market, risk and the numbers, in several formats from a detailed report to a short snapshot.",
    "Suburb and postcode reports — location reporting for a client weighing up an area.",
    "Send Portfolio To Client — the client's portfolio position as a professional document under the firm's brand.",
    "Agreements — the firm's agreements generated from the client record and sent for electronic signature.",
    "Marketing — tools for the firm's own client marketing.",
  ]),
  h2("Market information and opportunities"),
  ...bullets([
    "Market Updates — a feed of market news ranked by relevance, with answers grounded in the sources and scheduled digests.",
    "Opportunity Marketplace — listings sent in by agents become a searchable marketplace, and a report can be generated on any of them in one step.",
    "Builder stock — current stock published by builders on the platform, kept up to date rather than circulated as an old PDF.",
  ]),
  h2("AI inside the workspace"),
  ...bullets([
    "Email Copilot — help drafting and managing client emails.",
    "Aurixa Intelligence Hub — ask questions of the firm's own reports and information.",
    "Client AI — AI assistance inside the client record.",
    "Aurixa Agent — an assistant that can carry out tasks inside the workspace and run the firm's playbooks, with an audit log of what it did.",
    "Model Hub — shows which AI model powers each feature, so the firm can see and explain how the AI is used.",
    "Call Logs and voice agents — call recording, transcripts and alerts, plus inbound and outbound voice agents that answer enquiries, qualify callers, book appointments and update the record. Voice agents are configured for each firm rather than templated.",
  ]),
  h2("Compliance"),
  ...bullets([
    "AML/CTF Compliance — a customer-due-diligence workflow: identity verification, screening against sanctions and politically-exposed-person lists, risk ratings, enhanced due diligence, review by the firm's compliance officer, retention of evidence and a tamper-evident activity log. It prepares report drafts from case data; the firm lodges with AUSTRAC through its own account.",
    "Compliance Passport — a verified client's compliance record that authorised professionals on the same transaction can rely on, so the client is not asked for the same documents again and again.",
    "Each organisation remains responsible for its own obligations; the platform supports the workflow and never gives compliance advice.",
  ]),
  h2("Administration and control"),
  ...bullets([
    "Branding — the firm's own brand across the dashboard, portal and reports.",
    "User management and role-based access — each person sees and does what their role allows.",
    "Activity logs — a record of who did what.",
    "API Usage — visibility of the platform's usage for the firm.",
  ]),
  h2("Does it connect to the systems we already use?"),
  p(
    "There is an integrations capability covering the kinds of systems firms already rely on — email and calendar, accounting, electronic signing and identity verification — plus an API. Integrations are subject to the firm connecting its own accounts with those services. Exactly what is practical for a particular firm is a strategic-review conversation, not something an agent commits to on a call, and an agent does not name specific vendors or data providers.",
  ),

  h1("8. Plans and prices"),
  p(
    "Aurixa is sold as seat-banded plans plus optional add-on modules, prepaid AI credits, and a one-off onboarding package. All prices are in Australian dollars and include GST — nothing is added at checkout. The strategic review is where pricing is worked through properly for a specific organisation; an agent states the published shape and never negotiates, discounts or promises custom terms.",
  ),
  h2("What do the plans cost?"),
  ...tierLines().map(b),
  b(annualSentence()),
  b("Plan changes are pro-rated on the next billing cycle."),
  h2("Which plan fits a firm like ours?"),
  p(
    "The plans are sized mainly by the number of people who need a seat, and each is designed for a particular stage of firm:",
  ),
  ...tierFitLines().map(b),
  p(
    "Past 30 seats it becomes an Enterprise conversation. The right plan is worked out properly in the strategic review, and the aim is to size it to what the firm needs rather than push a bigger plan.",
  ),
  h2("What does each plan include?"),
  ...tierInclusionLines().map(b),
  h2("Why does each plan have two prices?"),
  p(amlSentence()),
  h2("What if we need more than 30 seats?"),
  p(
    "That is the Enterprise conversation: scoped and quoted rather than listed, and aimed at franchise groups, networks, national or multi-entity organisations and white-label partners. Multi-year arrangements are available. An agent never quotes an enterprise figure, because there is no list price to quote.",
  ),
  h2("Is there a free trial?"),
  p(
    "There is no self-serve free trial. A sandbox environment with sample data can be arranged, and the strategic review is where that is agreed.",
  ),

  h1("9. Add-on modules"),
  p(
    "Each module is its own monthly subscription in Australian dollars including GST, and can be cancelled independently of the plan. A purchased module is enabled by the team, usually within one business day. Some modules are already included at no extra cost on the higher tiers, and a caller who is on that tier should not be quoted a price for something they already have.",
  ),
  ...moduleLines().flatMap((group) => [h2(group.heading), ...group.bullets.map(b)]),
  h2("Can a module be cancelled on its own?"),
  p(
    "Yes. Each add-on module is billed as its own monthly subscription and can be cancelled independently of the plan. Cancelling a module does not cancel the plan, and dropping the AML/CTF module changes the subscription by the same amount adding it would.",
  ),
  h2("Can we add just one module without changing plan?"),
  p(
    "Yes. Modules are designed to be added one at a time, so a firm that needs only one capability — say, the deal pipeline on a smaller plan — can take that module without moving to a bigger plan.",
  ),

  h1("10. Credits — what they are and how they are spent"),
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

  h1("11. How access works — the priority access pathway"),
  p(
    "Access is by application, in three stages. Joining the waitlist does not guarantee platform access, and there is no paid queue priority: Aurixa does not accept payment to move an application up the list.",
  ),
  h2("Stage 1 — what is the Priority Access Application?"),
  ...bullets([
    "Completed on the website at aurixasystems.com.au/contact. It takes about 60 to 90 seconds.",
    "It asks for name, work email, mobile number, organisation name, role, organisation type, approximate annual client or transaction volume, current bottlenecks, and the areas the organisation most wants to improve.",
    "On submission the applicant receives an application reference in the form AX- followed by ten characters, and an email titled \"Application Received\" containing a secure personal link to the Business Readiness Questionnaire.",
  ]),
  h2("Stage 2 — what is the Business Readiness Questionnaire?"),
  ...bullets([
    "It takes approximately 6 to 8 minutes, and progress is saved as the applicant goes, so it can be finished in more than one sitting.",
    "It is reached through the secure link in the \"Application Received\" email — worth checking the spam folder. If the link has expired, the application reference together with the work email reopens the questionnaire on the website. Secure links should not be forwarded.",
    "It covers the organisation's structure, current systems and workflows, the Aurixa capabilities that matter most, integration and migration needs, security requirements, implementation timing and the most useful next step.",
    "Once it is complete, the Aurixa team reviews the application, aiming to complete the initial review within two business days. No further submission is required in the meantime.",
  ]),
  h2("Stage 3 — what happens in the Strategic Review?"),
  ...bullets([
    "A 30-minute private online session with the Aurixa team, booked from the link in the \"Questionnaire Received\" email within a 45-day booking window.",
    "Available times run Monday to Friday, 9:00 a.m. to 4:30 p.m. Sydney time, in 30-minute slots, with at least 24 hours' notice.",
    "A booking is a request. The Aurixa team confirms it by email, usually within one business day, and the calendar invitation with meeting access details follows separately from the team.",
    "In the session the team works through the questionnaire responses — the current operational environment, priority workflows, platform suitability and implementation considerations — and recommends the right pathway: a platform discovery session, a guided demonstration, or an enterprise requirements consultation.",
  ]),
  h2("Why is the strategic review worth the time?"),
  p(
    "Because it is built around the firm's own answers rather than a generic demo. The team has read the questionnaire before the call, so the half hour goes on the firm's actual workflows, what would help most, and what a sensible starting point looks like — and the firm leaves with a clear recommendation, whichever way it goes.",
  ),
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

  h1("12. Onboarding — what happens after signing"),
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

  h1("13. Security and governance"),
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

  h1("14. Support for existing customers"),
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

  h1("15. Billing and account questions"),
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

  h1("16. What a caller can do on this call"),
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

  h1("17. Quick answers"),
  ...bullets([
    "What is Aurixa in one line? — One governed platform for property, finance and advisory firms, where clients, analysis, reports, partners and compliance live together under the firm's own brand.",
    "Where do I apply? — aurixasystems.com.au/contact; the application takes about 60 to 90 seconds.",
    "My questionnaire link expired. — The application reference, which looks like AX- followed by ten characters, plus the work email reopens it on the website; links are time-limited for the applicant's protection.",
    "I did not get the email. — It is worth checking the spam folder first; failing that the reference plus the work email reopens the questionnaire, and the team can resend against the reference.",
    "I applied with the wrong email. — Email admin@aurixasystems.com.au and the team will correct it against the application reference.",
    "How long until I hear back? — The team aims to complete the initial review within two business days of the questionnaire being completed.",
    "When can the review be booked? — Monday to Friday, 9:00 a.m. to 4:30 p.m. Sydney time, at least 24 hours ahead, within a 45-day window; a separate confirmation email and calendar invitation follow from the team.",
    "Can I pay to skip the queue? — No. Aurixa does not accept payment for queue priority.",
    "Is a booking final once made on a call? — It is a request in the calendar; the Aurixa team confirms by email, usually within one business day.",
    "Is it only for big firms? — No. The smallest plan is designed for a solo adviser or a small team, and groups past 30 seats are an Enterprise conversation.",
    "Is the AML/CTF module compulsory? — No. Every plan can be taken without it, for less.",
    "Can modules be cancelled? — Yes, each add-on module is billed as its own monthly subscription and can be cancelled independently of the plan.",
    "Is the platform white-labelled? — Yes; clients and partners see the firm's own brand, not Aurixa's.",
    "Where do I report a fault? — aurixasystems.com.au/support, or on this call — the support line can raise the ticket and give you its reference.",
    "How do I track a ticket I already raised? — On the support portal, using the ticket reference; updates are also emailed to the address on the ticket.",
    "Do credits expire? — Yes, 30 days from issue; unused credits roll over inside that window and the soonest to expire are spent first.",
    "Does a failed report cost credits? — No. Credits are held during a run and released if it fails.",
    "Is our data held in Australia? — Yes; Australian data residency, with an isolated tenancy per organisation.",
    "Confidential documents on calls or forms? — Please do not share client identification documents, financial records or confidential client information on a call or in an application.",
  ]),

  h1("18. What an agent must never say"),
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
    "A customer's name, a testimonial, a case study, or a measured result — how many hours saved, how much faster, how much more business. None is published, so any figure would be invented.",
    "That a walk-through in this document is a real client's story. They are illustrative.",
    "The name of any property-data provider or other third-party vendor, or any claim about where the platform's property data comes from.",
    "That a firm will be compliant, that it is or is not a reporting entity, or any compliance deadline. Those are questions for the firm's own adviser or AUSTRAC.",
    "That the platform lodges reports with AUSTRAC. It prepares drafts; the firm lodges through its own account.",
    "That any capability is protected by intellectual-property registration, or that Aurixa itself holds a particular security certification.",
    "Financial, investment, lending, legal, tax or situation-specific compliance advice.",
    "Anything about a named competitor, or anything critical of a product a caller already uses.",
    "Anything at all this document does not cover. The honest answer is that the information here covers the general details and the team is best placed to help directly — and then to make sure it is flagged for them.",
  ]),
];
