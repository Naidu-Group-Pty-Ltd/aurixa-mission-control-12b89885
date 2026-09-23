// Cook: a cloning plan -> the recipe book's inputs.
//
// The planner produces plain words (a list of claims, a closing line, the
// duties of a role). This module owns every formatting decision - quotes,
// bullets, wrapping, tool names - so a model never writes Markdown that a
// prompt depends on, and two plans with the same words compile to the same
// bytes. Nothing here reads the network or the clock.
import { ARCHETYPES } from "../voice-recipe/archetypes.pure.ts";
import {
  DEFAULT_TOOL_NAMES,
  type AgentSpec,
  type BusinessVoiceContext,
  type ToolKey,
  type ToolNames,
} from "../voice-recipe/types.pure.ts";
import type { AgentContent, BookingWindow, BusinessProfile, CloningPlan, PlanTopology, VoiceContextDraft } from "./schemas.pure.ts";

const WRAP = 76;

/** Wrap prose at word boundaries. `prefix` starts every line. */
export function wrap(text: string, prefix = "", width = WRAP): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (!line) line = w;
    else if (prefix.length + line.length + 1 + w.length <= width) line += " " + w;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines.map((l) => prefix + l).join("\n");
}

/** `> "..."` quote block, wrapped. */
export function quote(text: string): string {
  const body = text.trim().replace(/^"+|"+$/g, "");
  return wrap(`"${body}"`, "> ");
}

/** `- item` bullets with hanging indent. */
export function bullets(items: string[]): string {
  return items
    .map((it) => {
      const w = wrap(it, "", WRAP - 2).split("\n");
      return w.map((l, i) => (i === 0 ? `- ${l}` : `  ${l}`)).join("\n");
    })
    .join("\n");
}

/** A lowercase slug from a business name: "Acme Dental Pty Ltd" -> "acme_dental". */
export function businessSlug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/\b(pty|ltd|limited|inc|llc|group|co)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (s || "business").slice(0, 30);
}

/** The tool names a client's assistants call - fixed except the knowledge base. */
export function toolNamesFor(slug: string): ToolNames {
  return { ...DEFAULT_TOOL_NAMES, kb_query: `${slug}_knowledge` };
}

const WEEKDAY = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function spokenTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map((x) => Number.parseInt(x, 10));
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m || 0).padStart(2, "0")} ${suffix}`;
}

function dayRange(days: number[]): string {
  const sorted = [...new Set(days)].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
  if (!sorted.length) return "no days";
  const contiguous = sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
  if (contiguous && sorted.length > 2) return `${WEEKDAY[sorted[0]]} to ${WEEKDAY[sorted[sorted.length - 1]]}`;
  return sorted.map((d) => WEEKDAY[d]).join(", ");
}

/** "Monday to Friday 9:00 am to 5:00 pm Sydney time, at least 24 hours ahead, up to 30 days out." */
export function bookingWindowSpoken(w: BookingWindow | null, timezone: string): string {
  if (!w) return "Slots follow the business's booking rules.";
  const city = timezone.split("/").pop()?.replace(/_/g, " ") ?? timezone;
  return (
    `Slots are ${w.slotMinutes} minutes, ${dayRange(w.days)} ${spokenTime(w.startTime)} to ` +
    `${spokenTime(w.endTime)} ${city} time, at least ${w.minNoticeHours} hours ahead, up to ` +
    `${w.horizonDays} days out.`
  );
}

/** The business-owned slots, formatted from the planner's plain words. */
export function buildBusinessContext(profile: BusinessProfile, v: VoiceContextDraft): BusinessVoiceContext {
  const city = profile.timezone.split("/").pop()?.replace(/_/g, " ") ?? profile.timezone;
  const confirmNote = v.bookingConfirmationNote.trim();
  return {
    businessName: profile.businessName,
    productionTag: "Production - Mission Control voice fleet",
    identityParagraph: wrap(v.identityParagraph),
    kb: {
      materials: bullets([`**Why customers choose ${profile.businessName}** - ${v.kbWhy}`, `**The facts** - ${v.kbFacts}`]),
      factualQueries: wrap(v.factualQueryExamples.map((q) => `"${q.replace(/"/g, "")}"`).join(", ") + "."),
      valueTriggers: bullets(v.valueTriggers),
    },
    speechRules: bullets(v.speechRules),
    skeptical: { context: wrap(v.skepticalContext), quotes: v.skepticalLines.map(quote) },
    facts: { title: v.factsTitle, body: v.factsParagraphs.map((p) => wrap(p)).join("\n\n") },
    transferDestination: v.transferDestination,
    humanFollowUpQuote: quote(v.followUpPromise),
    boundaries: {
      adviceDomains: wrap(joinWithOr(v.adviceDomains)),
      adviceDeflectQuote: quote(v.adviceDeflect),
      claimsDiscipline: bullets(v.claimsNever),
      pricingDiscipline: wrap(`Pricing discipline: ${v.pricingDiscipline}`),
    },
    closingQuote: quote(v.closingLine),
    booking: {
      intro: wrap(`{persona} ${v.bookingIntro.replace(/^\{persona\}\s*/, "")}`),
      timezoneNote: wrap(`All times are ${city} time - say so if the caller may be elsewhere.`),
      successExpectation: v.bookingIsRequest
        ? wrap(`confirm the day and time back naturally, then set the expectation honestly: "${confirmNote}"`, "", 72).replace(/\n/g, "\n  ")
        : "confirm the day and time back naturally.",
      finalityBoundary: v.bookingIsRequest
        ? "Never present the booking as final beyond the confirmation rule."
        : "Never confirm a booking the tool did not confirm.",
      afterBookingRule: v.bookingIsRequest
        ? "State the confirmation rule after every successful booking"
        : "Confirm the booked day and time back after every successful booking",
    },
    absolute: { baseNever: v.baseNever, baseAlways: v.baseAlways },
  };
}

function joinWithOr(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "specialist advice";
  return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}

/** The squad-routing section for an entry agent, modelled on MC Front Desk's section 14. */
export function squadRoutingSection(
  persona: string,
  topology: PlanTopology,
  agentsByKey: Map<string, { name: string; purpose: string }>,
  names: ToolNames,
): string | null {
  const squad = topology.squad;
  if (!squad) return null;
  const entry = squad.members.find((m) => m.agentKey === squad.entryAgentKey);
  const targets = (entry?.handoffTo ?? []).map((k) => agentsByKey.get(k)).filter(Boolean) as Array<{ name: string; purpose: string }>;
  if (!targets.length) return null;
  const intents = squad.handoffIntents.map((i) => `\`${i.intent}\``).join(", ");
  const nameList = targets.map((t) => `'${t.name}'`).join(", ");
  return `# 14. Squad Routing & Handoff

${persona} does not do the specialists' work. ${persona}'s role is to recognise
when the caller needs a specialist, confirm the intent clearly, and hand off
cleanly.

## 14.1 Downstream Specialists

${targets.map((t) => `**${t.name}** - ${wrap(t.purpose)}`).join("\n\n")}

${persona} thinks only in terms of these destinations.

## 14.2 When to Route

Route only when the caller clearly wants that conversation. While they are
still gathering information, unsure, or skeptical - keep helping instead of
routing.

## 14.3 Intent Confirmation

Before any handoff, confirm naturally and wait for a clear yes:

> "It sounds like you'd like to talk that through with the right person. Is
> that right?"

## 14.4 Tool-Based Handoff

After clear confirmation:

1. Ensure \`${names.resolve_contact}\` and \`${names.get_call_context}\` have been attempted
   (Section 0A/0B). Do not delay a confirmed handoff because resolution
   failed - hand off with what is known.
2. Silently call \`${names.phone_number_inject}\` once, with:
   - \`confirmedIntent\`: one of ${intents || "the agreed intents"}
   - \`callerReason\`: the caller's own words for why they called
3. Say one short natural line: "Perfect - I'll get you through to the
   right place."
4. Transfer to the confirmed destination assistant by its name -
   ${nameList} - silently. Do not output routing text, tool names, or IDs,
   and do not keep speaking after the transfer.

---
`;
}

/** Every agent in the plan as an AgentSpec the compiler can render. */
export function buildAgentSpecs(plan: CloningPlan, names: ToolNames): AgentSpec[] {
  const contentByKey = new Map(plan.agents.map((a) => [a.agentKey, a]));
  const nameOf = (key: string) => {
    const t = plan.topology.agents.find((a) => a.key === key);
    const c = contentByKey.get(key);
    return assistantName(plan.profile.businessName, c?.roleTitle ?? t?.archetype ?? key);
  };
  const summaries = new Map(
    plan.topology.agents.map((a) => [a.key, { name: nameOf(a.key), purpose: ARCHETYPES[a.archetype].purpose }]),
  );

  return plan.topology.agents.map((t) => {
    const arch = ARCHETYPES[t.archetype];
    const c: AgentContent = contentByKey.get(t.key) ?? emptyContent(t.key);
    const tools = [...new Set<ToolKey>(t.tools.map((x) => x.tool))];
    const isEntry = plan.topology.squad?.entryAgentKey === t.key;
    const squadSection = isEntry ? squadRoutingSection(t.personaName, plan.topology, summaries, names) : null;
    const routerNever = isEntry && squadSection
      ? [
          "Trigger a transfer before the caller clearly confirms the intent",
          "Continue speaking after the silent transfer",
        ]
      : [];
    const routerAlways = isEntry && squadSection
      ? [
          `Call ${names.phone_number_inject} once, silently, before every transfer, with confirmedIntent and callerReason`,
          `Transfer only to the named specialists, by name, silently`,
        ]
      : [];
    return {
      key: t.key,
      name: nameOf(t.key),
      persona: t.personaName,
      temperament: c.temperament,
      direction: arch.direction,
      tools,
      roleTitle: c.roleTitle,
      roleSummary: roleSummary(t.personaName, plan.profile.businessName, c),
      opening: opening(arch.direction, c),
      canDo: c.canDo,
      cannotDo: c.cannotDo,
      extraSections: squadSection,
      dialogues: c.dialogues.map((d) => ({ title: d.title, caller: d.caller, reply: d.reply })),
      extraNever: [...routerNever, ...c.extraNever],
      extraAlways: [...routerAlways, ...c.extraAlways],
      playbooks: arch.playbooks,
    };
  });
}

/** VAPI caps an assistant name at 40 characters. */
export function assistantName(businessName: string, roleTitle: string): string {
  const role = roleTitle.replace(/\s*\(.*\)\s*$/, "").trim();
  const full = `${businessName} ${role}`;
  if (full.length <= 40) return full;
  const short = businessName.split(/\s+/)[0];
  return `${short} ${role}`.slice(0, 40).trim();
}

function roleSummary(persona: string, businessName: string, c: AgentContent): string {
  const duties = c.roleSummary.map((d, i) => wrap(`${i + 1}. ${d}`).replace(/\n/g, "\n   "));
  return [
    `You are **${persona}**, the ${c.roleTitle.toLowerCase()} for **${businessName}**.`,
    "",
    "Your job is to:",
    "",
    ...duties,
    "",
    wrap(c.notThisRole),
  ].join("\n");
}

function opening(direction: "inbound" | "outbound", c: AgentContent): string {
  const lead =
    direction === "outbound"
      ? "The first message identifies the business and the reason for the call, and may use the recipient's first name from the campaign variables. After they respond, run Section 0A/0B silently to resolve the contact, check early that the timing is okay, and get to the point - this is their time."
      : "The first spoken message stays neutral. Do not attempt first-name personalisation before contact resolution and stored context have completed.";
  return [
    "## 0.1 Opening Behaviour",
    "",
    wrap(lead),
    ...c.openingNotes.flatMap((n) => ["", wrap(n)]),
    "",
    "Never say raw variables aloud; if a variable looks unresolved, speak without it.",
  ].join("\n");
}

function emptyContent(key: string): AgentContent {
  return {
    agentKey: key,
    roleTitle: key,
    temperament: "calm and helpful",
    roleSummary: [],
    notThisRole: "",
    firstMessage: "",
    openingNotes: [],
    canDo: [],
    cannotDo: [],
    dialogues: [],
    extraNever: [],
    extraAlways: [],
    voicemailMessage: "",
  };
}
