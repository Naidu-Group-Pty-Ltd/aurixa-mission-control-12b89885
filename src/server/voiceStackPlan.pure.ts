/**
 * Building a tenant's voice stack — the ORDER, and what one tick may do next.
 * No I/O.
 *
 * ## One step, one object, one ledger row
 *
 * A stack is about forty objects across two vendors: a folder, nine hooks,
 * five data stores, a code library, a CFG record and nine scenarios in Make;
 * a credential, knowledge-base files, structured outputs, a scorecard, seven
 * tools, thirteen assistants and a squad in Vapi. No vendor offers a
 * transaction across them, and no single request has time to make them all.
 * So each object is ONE step with a stable key, and the moment it exists its
 * id goes in the ledger (`clone_voice_stack_ledger`). A tick that runs out of
 * time stops between steps; the next tick reads the ledger and carries on
 * from the first step not done. Nothing is created twice, because nothing is
 * created without first asking the ledger whether it already was.
 *
 * ## The order is the dependency
 *
 * Every step names what it needs (`after`). Hooks come before the scenarios
 * that are triggered by them; data stores before scenarios that read them;
 * the clone's tools after the hooks they call; assistants after the tools,
 * files and outputs they reference; the squad after its members. The CFG
 * record is written twice — once with the hook URLs (so scenarios can run),
 * and again with the assistant map once the assistants exist — because the
 * map names objects that do not exist on the first write. Activation is LAST:
 * a scenario is created inactive and switched on only when the whole stack
 * exists, so a half-built stack never answers a call.
 *
 * ## A step that needs a person is WAITING, not failed
 *
 * The dependent line's GoHighLevel modules wait on the tenant's OAuth grant.
 * Their scenarios are built, unbound, and left inactive; the stack reads
 * `awaiting_connections` and goes live by itself when the grant arrives. A
 * failure is a vendor error, retried on a back-off and then handed to an
 * operator — never mistaken for a wait, because the two send people to
 * opposite remedies.
 *
 * Pure: tested beside it.
 */

import type { CrmMode } from "@/lib/crmMode.pure";
import type { VoiceStackStatus } from "@/lib/voiceStack.pure";
import type { StackManifest } from "./voiceStackTemplate.pure";

export type StepKind =
  | "discover"
  | "make_folder"
  | "make_hook"
  | "make_data_store"
  | "make_records"
  | "make_cfg"
  | "make_scenario"
  | "clone_call_log_secret"
  | "vapi_call_log_credential"
  | "vapi_file"
  | "vapi_structured_output"
  | "vapi_scorecard"
  | "vapi_tool"
  | "vapi_assistant"
  | "vapi_squad"
  | "make_cfg_assistants"
  | "make_connection_request"
  | "make_activate"
  | "voice_automation_register"
  | "verify";

export type PlanStep = {
  /** Stable across ticks and re-plans: the ledger's key. */
  key: string;
  kind: StepKind;
  /** The template object (or role) the step is about. */
  ref: string;
  label: string;
  /** Keys that must be done first. */
  after: string[];
};

/** What reading the template org once found, persisted on the stack row. */
export type Discovery = {
  /** Template tool id → its function name (null for a tool with none). */
  tools: Record<string, string | null>;
  files: string[];
  structuredOutputs: string[];
  scorecards: string[];
  /** Slots the stack itself must request (the dependent line's GoHighLevel). */
  stackSlots: string[];
};

export const DISCOVER_KEY = "discover";

export function planStackSteps(
  m: StackManifest,
  crmMode: CrmMode,
  d: Discovery | null,
): PlanStep[] {
  const steps: PlanStep[] = [];
  const add = (s: PlanStep) => steps.push(s);

  add({
    key: DISCOVER_KEY,
    kind: "discover",
    ref: "template",
    label: "Read the template's assistants and tools",
    after: [],
  });
  if (!d) return steps; // Nothing else can be planned until the template has been read.

  add({
    key: "make_folder",
    kind: "make_folder",
    ref: "folder",
    label: "Make folder",
    after: [DISCOVER_KEY],
  });
  for (const h of m.make.hooks)
    add({
      key: `make_hook:${h.role}`,
      kind: "make_hook",
      ref: h.role,
      label: `Hook: ${h.role}`,
      after: ["make_folder"],
    });
  for (const s of m.make.dataStores) {
    add({
      key: `make_data_store:${s.role}`,
      kind: "make_data_store",
      ref: s.role,
      label: `Data store: ${s.role}`,
      after: ["make_folder"],
    });
    if (s.records === "copy")
      add({
        key: `make_records:${s.role}`,
        kind: "make_records",
        ref: s.role,
        label: `Records: ${s.role}`,
        after: [`make_data_store:${s.role}`],
      });
  }
  const hookKeys = m.make.hooks.map((h) => `make_hook:${h.role}`);
  const storeKeys = m.make.dataStores.map((s) => `make_data_store:${s.role}`);
  if (m.make.cfg)
    add({
      key: "make_cfg",
      kind: "make_cfg",
      ref: m.make.cfg.key,
      label: "CFG record (secrets minted, hook URLs)",
      after: [
        `make_data_store:${m.make.cfg.storeRole}`,
        ...hookKeys.filter((k) => Object.values(m.make.cfg!.hookUrls).includes(k.slice(10))),
      ],
    });
  for (const sc of m.make.scenarios)
    add({
      key: `make_scenario:${sc.role}`,
      kind: "make_scenario",
      ref: sc.role,
      label: `Scenario: ${sc.role}`,
      after: [...(sc.hookRole ? [`make_hook:${sc.hookRole}`] : []), ...storeKeys, ...hookKeys],
    });

  add({
    key: "clone_call_log_secret",
    kind: "clone_call_log_secret",
    ref: "VAPI_WEBHOOK_SECRET",
    label: "Call-log secret on the clone",
    after: [DISCOVER_KEY],
  });
  add({
    key: "vapi_call_log_credential",
    kind: "vapi_call_log_credential",
    ref: "call_logs",
    label: "Call-log credential in the clone's org",
    after: ["clone_call_log_secret"],
  });
  for (const f of d.files)
    add({
      key: `vapi_file:${f}`,
      kind: "vapi_file",
      ref: f,
      label: `Knowledge-base file ${f.slice(0, 8)}`,
      after: [DISCOVER_KEY],
    });
  for (const so of d.structuredOutputs)
    add({
      key: `vapi_structured_output:${so}`,
      kind: "vapi_structured_output",
      ref: so,
      label: `Structured output ${so.slice(0, 8)}`,
      after: [DISCOVER_KEY],
    });
  for (const sc of d.scorecards)
    add({
      key: `vapi_scorecard:${sc}`,
      kind: "vapi_scorecard",
      ref: sc,
      label: `Scorecard ${sc.slice(0, 8)}`,
      after: [DISCOVER_KEY],
    });
  for (const t of m.vapi.tools)
    add({
      key: `vapi_tool:${t.templateToolId}`,
      kind: "vapi_tool",
      ref: t.templateToolId,
      label: `Tool ${d.tools[t.templateToolId] ?? t.templateToolId.slice(0, 8)}`,
      after: t.hookRole ? [`make_hook:${t.hookRole}`] : [DISCOVER_KEY],
    });
  const toolKeys = m.vapi.tools.map((t) => `vapi_tool:${t.templateToolId}`);
  const depKeys = [
    ...d.files.map((f) => `vapi_file:${f}`),
    ...d.structuredOutputs.map((s) => `vapi_structured_output:${s}`),
    ...d.scorecards.map((s) => `vapi_scorecard:${s}`),
  ];
  for (const a of m.vapi.assistants)
    add({
      key: `vapi_assistant:${a.templateAssistantId}`,
      kind: "vapi_assistant",
      ref: a.templateAssistantId,
      label: `Assistant: ${a.role}`,
      after: [...toolKeys, ...depKeys, "vapi_call_log_credential"],
    });
  const assistantKeys = m.vapi.assistants.map((a) => `vapi_assistant:${a.templateAssistantId}`);
  if (m.vapi.squad)
    add({
      key: "vapi_squad",
      kind: "vapi_squad",
      ref: m.vapi.squad.templateSquadId,
      label: "Squad",
      after: assistantKeys,
    });
  if (m.make.cfg?.assistantMapField)
    add({
      key: "make_cfg_assistants",
      kind: "make_cfg_assistants",
      ref: m.make.cfg.assistantMapField,
      label: "CFG: the assistants' ids",
      after: ["make_cfg", ...assistantKeys],
    });
  for (const slot of d.stackSlots)
    add({
      key: `make_connection_request:${slot}`,
      kind: "make_connection_request",
      ref: slot,
      label: `Ask the tenant to connect: ${slot}`,
      after: ["make_folder"],
    });
  const scenarioKeys = m.make.scenarios.map((s) => `make_scenario:${s.role}`);
  const built = [
    ...scenarioKeys,
    ...(m.make.cfg ? ["make_cfg"] : []),
    ...(m.make.cfg?.assistantMapField ? ["make_cfg_assistants"] : []),
    ...m.make.dataStores.filter((s) => s.records === "copy").map((s) => `make_records:${s.role}`),
    ...(m.vapi.squad ? ["vapi_squad"] : assistantKeys),
  ];
  for (const sc of m.make.scenarios)
    add({
      key: `make_activate:${sc.role}`,
      kind: "make_activate",
      ref: sc.role,
      label: `Switch on: ${sc.role}`,
      after: built,
    });
  const activateKeys = m.make.scenarios.map((s) => `make_activate:${s.role}`);
  if (crmMode === "independent" && m.make.cfg)
    add({
      key: "voice_automation_register",
      kind: "voice_automation_register",
      ref: "voice_automation",
      label: "Hand the calendar & email settings to voice automation",
      after: built,
    });
  add({
    key: "verify",
    kind: "verify",
    ref: "stack",
    label: "Read everything back",
    after: [
      ...activateKeys,
      ...(crmMode === "independent" && m.make.cfg ? ["voice_automation_register"] : []),
    ],
  });
  return steps;
}

// ─── The ledger ──────────────────────────────────────────────────────────

export type LedgerStatus = "done" | "waiting" | "failed";

export type LedgerRow = {
  step_key: string;
  status: LedgerStatus;
  external_id: string | null;
  external_ref: string | null;
  payload_sha: string | null;
  detail: string | null;
  attempts: number;
  next_attempt_at: string | null;
};

/** Retries per step before an operator is told. */
export const MAX_STEP_ATTEMPTS = 8;

/** 2, 4, 8 … minutes, capped at six hours. */
export function retryDelayMs(attempts: number): number {
  return Math.min(2 ** Math.max(1, attempts) * 60_000, 6 * 60 * 60_000);
}

/**
 * The steps one tick may run now, in plan order: every step not done whose
 * dependencies are all done, skipping a step waiting on a person and one whose
 * back-off has not passed. A step out of attempts is not run again until an
 * operator retries it.
 */
export function runnableSteps(
  steps: readonly PlanStep[],
  ledger: ReadonlyMap<string, LedgerRow>,
  now: number,
): PlanStep[] {
  const done = (k: string) => ledger.get(k)?.status === "done";
  return steps.filter((s) => {
    const row = ledger.get(s.key);
    if (row?.status === "done") return false;
    if (
      row?.status === "waiting" &&
      s.kind !== "make_activate" &&
      s.kind !== "make_connection_request"
    )
      return false;
    if (row?.status === "failed") {
      if (row.attempts >= MAX_STEP_ATTEMPTS) return false;
      if (row.next_attempt_at && Date.parse(row.next_attempt_at) > now) return false;
    }
    if (row?.status === "waiting" && row.next_attempt_at && Date.parse(row.next_attempt_at) > now)
      return false;
    return s.after.every(done);
  });
}

export type StackReading = {
  status: VoiceStackStatus;
  done: number;
  total: number;
  waiting: string[];
  failed: { key: string; detail: string | null; exhausted: boolean }[];
};

/**
 * The stack's status, DERIVED from the plan and the ledger — never stored as a
 * second opinion. `blocked` is the gate's answer (`judgeStackProvision`).
 */
export function readStack(
  steps: readonly PlanStep[],
  ledger: ReadonlyMap<string, LedgerRow>,
  flags: { blocked: boolean; parked: boolean; discovered: boolean },
): StackReading {
  const total = steps.length;
  const done = steps.filter((s) => ledger.get(s.key)?.status === "done").length;
  const waiting = steps.filter((s) => ledger.get(s.key)?.status === "waiting").map((s) => s.key);
  const failed = steps
    .filter((s) => ledger.get(s.key)?.status === "failed")
    .map((s) => {
      const r = ledger.get(s.key)!;
      return { key: s.key, detail: r.detail, exhausted: r.attempts >= MAX_STEP_ATTEMPTS };
    });
  // `failed` is a stack that has STOPPED: a step out of attempts, which runs
  // again only when an operator retries it. A step that failed with a retry
  // still scheduled is a stack still building — a Make 5xx on one tick is not
  // a failed stack, and drawing it red teaches an operator to ignore red.
  let status: VoiceStackStatus;
  if (flags.parked) status = "parked";
  else if (flags.blocked) status = "awaiting_requirements";
  else if (failed.some((f) => f.exhausted)) status = "failed";
  else if (failed.length > 0) status = "provisioning";
  else if (flags.discovered && done === total) status = "live";
  else if (
    waiting.length > 0 &&
    steps
      .filter((s) => ledger.get(s.key)?.status !== "done")
      .every(
        (s) => ledger.get(s.key)?.status === "waiting" || isBlockedOnlyByWaiting(s, steps, ledger),
      )
  )
    status = "awaiting_connections";
  else if (done === 0) status = "ready";
  else status = "provisioning";
  return { status, done, total, waiting, failed };
}

/** Whether a step that has not run yet can only be waiting behind a waiting step. */
function isBlockedOnlyByWaiting(
  s: PlanStep,
  steps: readonly PlanStep[],
  ledger: ReadonlyMap<string, LedgerRow>,
): boolean {
  const byKey = new Map(steps.map((x) => [x.key, x]));
  const seen = new Set<string>();
  const behindWaiting = (k: string): boolean => {
    if (seen.has(k)) return false;
    seen.add(k);
    const row = ledger.get(k);
    if (row?.status === "waiting") return true;
    if (row?.status === "done") return false;
    const step = byKey.get(k);
    return !!step && step.after.some(behindWaiting);
  };
  return s.after.some(behindWaiting);
}

/**
 * Names the clone's assistants will get, unique within its org. Vapi names
 * them by display name in a squad's handoffs, so two assistants truncated to
 * one name would make a handoff ambiguous; a collision gets the role instead.
 */
export function uniqueNames(
  entries: readonly { key: string; name: string; role: string }[],
  max: number,
): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Map<string, number>();
  for (const e of entries) used.set(e.name, (used.get(e.name) ?? 0) + 1);
  const taken = new Set<string>();
  for (const e of entries) {
    let name = e.name;
    if ((used.get(e.name) ?? 0) > 1 || taken.has(name)) {
      const suffix = ` ${e.role.replace(/_/g, " ")}`;
      name = `${e.name.slice(0, Math.max(1, max - suffix.length)).trim()}${suffix}`.slice(0, max);
      let n = 2;
      while (taken.has(name)) name = `${name.slice(0, max - 3).trim()} ${n++}`;
    }
    taken.add(name);
    out.set(e.key, name);
  }
  return out;
}
