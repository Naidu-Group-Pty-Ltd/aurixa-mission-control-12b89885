// Deterministic checks on a cloning plan - the half of planning a model does
// not get to do.
//
// The schema already stops a plan naming anything the recipe book does not
// have. This checks what a schema cannot: that the pieces fit together, that
// each tool can actually be built, and that the words a model wrote carry
// nothing a voice agent must never say. Three outcomes, never a silent drop:
//
//   - a safe, mechanical repair (an agent missing the end-call tool gets it) is
//     applied and recorded as a warning;
//   - something a person must supply or decide becomes an OPEN ITEM;
//   - anything else is an ERROR, and an errored plan cannot be approved.
import { ARCHETYPES } from "../voice-recipe/archetypes.pure.ts";
import { BASE_DENYLIST, findDeniedClaims } from "../voice-recipe/kb.pure.ts";
import { BACKEND_MENU, TOOL_CATALOG, isDeployable, type BackendKey } from "../voice-recipe/tools.pure.ts";
import { DEFAULT_TOOL_NAMES, TOOL_KEYS, type ToolKey } from "../voice-recipe/types.pure.ts";
import { assistantName } from "./cook.pure.ts";
import type { AgentContent, BusinessProfile, KbPartDraft, OpenItem, PlanTopology, ValidationIssue, VoiceContextDraft } from "./schemas.pure.ts";

export interface ValidateInput {
  profile: BusinessProfile;
  topology: PlanTopology;
  agents: AgentContent[];
  voiceContext: VoiceContextDraft | null;
  kb: KbPartDraft[];
  /** Extracted text of every source, by docId - to tell a quoted number from an invented one. */
  sources?: Record<string, string>;
}

export interface ValidateResult {
  topology: PlanTopology;
  issues: ValidationIssue[];
  openItems: OpenItem[];
}

/** The backend a tool gets when validation has to add it. */
const NATURAL_BACKEND: Partial<Record<ToolKey, BackendKey>> = {
  end_call: "vapi_native",
  kb_query: "vapi_native",
  squad_handoff: "vapi_native",
  resolve_contact: "mission_control_tenant",
  get_call_context: "mission_control_tenant",
  phone_number_inject: "mission_control_tenant",
  check_availability: "mission_control_tenant",
  book_appointment: "mission_control_tenant",
  raise_support_ticket: "mission_control_tenant",
};

const INJECTION = /\b(ignore (all|any|the|previous|prior)|disregard (the|all|previous)|system prompt|you are now|new instructions|developer message)\b/i;
const URL_LIKE = /\bhttps?:\/\/|\bwww\.[a-z0-9-]+\.|\b[a-z0-9-]+\.(com|com\.au|net|org|io|ai|co)(\/|\b)/i;
const PHONE_LIKE = /(\+?\d[\d\s-]{7,}\d)/g;

export function validatePlan(input: ValidateInput): ValidateResult {
  const issues: ValidationIssue[] = [];
  const openItems: OpenItem[] = [];
  const err = (code: string, message: string, path: string) => issues.push({ severity: "error", code, message, path });
  const warn = (code: string, message: string, path: string) => issues.push({ severity: "warning", code, message, path });
  const open = (title: string, detail: string, owner: OpenItem["owner"] = "operator") =>
    openItems.push({ title, detail, owner, source: "validator" });

  const hasKb = input.kb.some((p) => p.blocks.length > 0);
  const topology: PlanTopology = structuredClone(input.topology);

  // ---------------------------------------------------------- agents --
  const keys = new Set<string>();
  if (!topology.agents.length) err("no_agents", "The plan has no agents.", "topology.agents");

  for (const [i, a] of topology.agents.entries()) {
    const path = `topology.agents[${i}]`;
    const arch = ARCHETYPES[a.archetype];
    if (!/^[a-z][a-z0-9_]{1,40}$/.test(a.key)) err("bad_key", `Agent key "${a.key}" must be lower_snake_case.`, `${path}.key`);
    if (keys.has(a.key)) err("duplicate_key", `Agent key "${a.key}" is used twice.`, `${path}.key`);
    keys.add(a.key);
    if (!a.personaName.trim()) err("no_persona", `Agent "${a.key}" has no persona name.`, `${path}.personaName`);
    if (arch.direction === "outbound" && !a.outboundTrigger) {
      warn("no_trigger", `Outbound agent "${a.key}" has no trigger, so nothing will dial it.`, `${path}.outboundTrigger`);
    }

    // Repair: every default tool is bound (end_call above all - SAME_TURN_END_CALL).
    const bound = new Map(a.tools.map((t) => [t.tool, t]));
    for (const d of arch.defaultTools) {
      if (d === "kb_query" && !hasKb) continue;
      if (!bound.has(d)) {
        const backend = NATURAL_BACKEND[d] ?? TOOL_CATALOG[d].allowedBackends[0];
        a.tools.push({ tool: d, backend, rationale: "Added by validation: the archetype always binds it." });
        bound.set(d, a.tools[a.tools.length - 1]);
        warn("default_tool_added", `Agent "${a.key}" was missing ${d}; it was added.`, `${path}.tools`);
      }
    }
    // kb_query only where there is a knowledge base to query.
    if (!hasKb && bound.has("kb_query")) {
      a.tools = a.tools.filter((t) => t.tool !== "kb_query");
      warn("kb_query_removed", `Agent "${a.key}" bound kb_query but the plan has no knowledge base.`, `${path}.tools`);
    }

    const allowed = new Set<ToolKey>([...arch.defaultTools, ...arch.optionalTools]);
    const seen = new Set<ToolKey>();
    for (const [j, t] of a.tools.entries()) {
      const tp = `${path}.tools[${j}]`;
      if (!TOOL_KEYS.includes(t.tool)) {
        err("unknown_tool", `Unknown tool ${String(t.tool)}.`, tp);
        continue;
      }
      if (seen.has(t.tool)) err("duplicate_tool", `Agent "${a.key}" binds ${t.tool} twice.`, tp);
      seen.add(t.tool);
      if (!allowed.has(t.tool)) {
        err("tool_not_in_archetype", `${t.tool} is not a tool a ${arch.label} binds.`, tp);
      }
      const def = TOOL_CATALOG[t.tool];
      if (!def.allowedBackends.includes(t.backend)) {
        err("backend_not_allowed", `${t.tool} cannot run on ${t.backend}; allowed: ${def.allowedBackends.join(", ")}.`, tp);
        continue;
      }
      if (!isDeployable(t.tool, t.backend)) {
        open(
          `Build ${def.label} for ${a.key}`,
          `${def.label} on "${BACKEND_MENU[t.backend].label}" is not deployable yet. ${BACKEND_MENU[t.backend].description} ` +
            "Until it is built, deploy leaves this tool out of the agent and the prompt says what it cannot do.",
          "engineering",
        );
      }
      for (const req of def.requires) {
        if (req === "squad_handoff" && !topology.squad) continue;
        if (!a.tools.some((x) => x.tool === req)) {
          err("missing_requirement", `${t.tool} needs ${req} on the same agent.`, tp);
        }
      }
    }

    if (seen.has("transfer_to_human")) {
      open(
        "Supply the transfer line",
        `Agent "${a.key}" transfers to a person through Make + Twilio. Before deploy an operator must supply the ` +
          "Make transfer webhook URL (built from NPC's 'Transfer Caller to Human via Twilio Redirect' scenario) " +
          "and the escalation number the call is redirected to.",
      );
    }
    if ((seen.has("check_availability") || seen.has("book_appointment")) && !input.profile.bookingWindow) {
      err("no_booking_window", `Agent "${a.key}" books appointments but the plan has no booking window.`, path);
    }
    if (seen.has("book_appointment") && !input.profile.bookingTypes.length) {
      err("no_booking_types", `Agent "${a.key}" books appointments but the plan has no booking types.`, path);
    }
  }

  // ------------------------------------------------------ assistant names --
  const contentByKey = new Map(input.agents.map((c) => [c.agentKey, c]));
  const names = new Set<string>();
  for (const a of topology.agents) {
    const c = contentByKey.get(a.key);
    if (!c) {
      err("no_content", `Agent "${a.key}" has no written content.`, `agents.${a.key}`);
      continue;
    }
    const n = assistantName(input.profile.businessName, c.roleTitle);
    if (names.has(n)) err("duplicate_name", `Two agents would both be called "${n}".`, `agents.${a.key}.roleTitle`);
    names.add(n);
    if (!c.canDo.length) warn("empty_can_do", `Agent "${a.key}" lists nothing it can do.`, `agents.${a.key}.canDo`);
    if (!c.firstMessage.trim()) err("no_first_message", `Agent "${a.key}" has no first message.`, `agents.${a.key}.firstMessage`);
  }
  for (const c of input.agents) {
    if (!keys.has(c.agentKey)) warn("orphan_content", `Content was written for "${c.agentKey}", which is not in the plan.`, `agents.${c.agentKey}`);
  }

  // ------------------------------------------------------------- squad --
  const byKey = new Map(topology.agents.map((a) => [a.key, a]));
  const inbound = topology.agents.filter((a) => ARCHETYPES[a.archetype].direction === "inbound");
  if (topology.squad) {
    const s = topology.squad;
    const entry = byKey.get(s.entryAgentKey);
    if (!entry) err("squad_no_entry", `Squad entry "${s.entryAgentKey}" is not an agent in the plan.`, "topology.squad.entryAgentKey");
    else if (ARCHETYPES[entry.archetype].squadRole !== "entry") {
      err("squad_entry_role", `The squad must start with an inbound front desk, not a ${ARCHETYPES[entry.archetype].label}.`, "topology.squad.entryAgentKey");
    }
    const members = new Set(s.members.map((m) => m.agentKey));
    if (!members.has(s.entryAgentKey)) err("squad_entry_not_member", "The squad's entry agent is not one of its members.", "topology.squad.members");
    for (const m of s.members) {
      const ag = byKey.get(m.agentKey);
      if (!ag) {
        err("squad_unknown_member", `Squad member "${m.agentKey}" is not an agent in the plan.`, "topology.squad.members");
        continue;
      }
      if (ARCHETYPES[ag.archetype].direction === "outbound") {
        err("squad_outbound_member", `Outbound agent "${m.agentKey}" cannot be in the inbound squad.`, "topology.squad.members");
      }
      for (const h of m.handoffTo) {
        if (!members.has(h)) err("squad_bad_handoff", `"${m.agentKey}" hands off to "${h}", which is not in the squad.`, "topology.squad.members");
        if (h === m.agentKey) err("squad_self_handoff", `"${m.agentKey}" hands off to itself.`, "topology.squad.members");
        if (m.agentKey !== s.entryAgentKey && h !== s.entryAgentKey) {
          err("squad_specialist_chain", `Specialist "${m.agentKey}" hands off to another specialist; only the front desk routes.`, "topology.squad.members");
        }
      }
    }
    if (!s.handoffIntents.length) warn("squad_no_intents", "The squad has no handoff intents.", "topology.squad.handoffIntents");
  } else if (inbound.length > 1) {
    err(
      "inbound_without_squad",
      `${inbound.length} inbound agents but no squad - a phone number reaches one assistant, so the others would never answer.`,
      "topology.squad",
    );
  }

  // ------------------------------------------------ the client's systems --
  const usesTenant = topology.agents.some((a) => a.tools.some((t) => t.backend === "mission_control_tenant"));
  const clientCrm = input.profile.systems.filter((s) => s.category === "crm" || s.category === "calendar");
  if (usesTenant && clientCrm.length) {
    open(
      "Decide where contacts and bookings live",
      `The client already uses ${clientCrm.map((s) => s.name).join(", ")}. The plan stores contacts and bookings in ` +
        "Mission Control's per-client store; syncing them into the client's own system is not built. Either accept " +
        "the separate store for now or plan the integration.",
      "client",
    );
  }

  // --------------------------------------------------------- text lint --
  const sources = input.sources ?? {};
  const corpus = Object.values(sources).join("\n");
  const foreignToolNames = Object.values(DEFAULT_TOOL_NAMES);
  const lint = (text: string, path: string, boundNames: string[] | null) => {
    if (!text) return;
    if (INJECTION.test(text)) err("injection_phrase", `Text reads like an instruction to the model: "${clip(text)}"`, path);
    if (URL_LIKE.test(text)) err("url_in_text", `Text contains a web address; addresses come from an operator, not a plan: "${clip(text)}"`, path);
    for (const m of text.match(PHONE_LIKE) ?? []) {
      const digits = m.replace(/\D/g, "");
      if (digits.length >= 8 && !corpus.replace(/\D/g, "").includes(digits)) {
        err("invented_number", `A number "${m.trim()}" appears that is in none of the source documents.`, path);
      }
    }
    if (boundNames) {
      for (const tn of foreignToolNames) {
        if (text.includes(tn) && !boundNames.includes(tn)) {
          err("foreign_tool", `Text names the tool ${tn}, which this agent does not bind.`, path);
        }
      }
    }
    for (const hit of findDeniedClaims(text, BASE_DENYLIST)) {
      err("denied_claim", `"${hit.match}" - ${hit.why}`, path);
    }
  };
  for (const c of input.agents) {
    const a = byKey.get(c.agentKey);
    const bound = a ? a.tools.map((t) => DEFAULT_TOOL_NAMES[t.tool]) : [];
    const p = `agents.${c.agentKey}`;
    [c.firstMessage, c.notThisRole, c.voicemailMessage, ...c.roleSummary, ...c.openingNotes, ...c.canDo, ...c.cannotDo, ...c.extraNever, ...c.extraAlways]
      .forEach((t) => lint(t, p, bound));
    c.dialogues.forEach((d) => [d.caller ?? "", d.reply].forEach((t) => lint(t, `${p}.dialogues`, bound)));
  }
  if (input.voiceContext) {
    for (const [k, v] of Object.entries(input.voiceContext)) {
      const texts = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
      texts.forEach((t) => lint(t, `voiceContext.${k}`, null));
    }
  } else {
    err("no_voice_context", "The plan has no business wording for the prompts.", "voiceContext");
  }
  for (const part of input.kb) {
    part.blocks.forEach((b, i) => lint(b.text, `kb.${part.part}[${i}]`, null));
  }

  // --------------------------------------------------------- planner's --
  for (const o of topology.openItems) openItems.push({ ...o, source: "planner" });

  return { topology, issues, openItems: dedupeOpenItems(openItems) };
}

function clip(s: string): string {
  return s.length > 90 ? s.slice(0, 87) + "..." : s;
}

function dedupeOpenItems(items: OpenItem[]): OpenItem[] {
  const seen = new Set<string>();
  return items.filter((o) => {
    const k = `${o.title}|${o.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function hasErrors(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === "error");
}
