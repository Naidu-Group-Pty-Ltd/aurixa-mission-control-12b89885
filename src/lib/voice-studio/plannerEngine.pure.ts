// The planning run as a stage machine - pure, with the model and the store
// injected, so the whole run can be driven in a test with fakes.
//
//   extract_docs -> profile -> topology -> agent_content -> voice_context
//     -> kb_draft -> validate (+ one repair of the topology) -> assemble
//
// Every unit of work is an ARTIFACT keyed (kind, key), written as soon as it
// exists. A run that stops - the tick's budget ran out, the worker died, the
// model refused - resumes from the artifacts it already has and never pays for
// a finished unit twice. That is what lets a plan that takes twenty model calls
// run on a worker that can only be trusted for a few minutes at a time.
import type * as z from "zod/v4";
import { KB_PART_KEYS, type KbPartKey } from "../voice-recipe/kb.pure.ts";
import { RECIPE_BOOK_VERSION } from "../voice-recipe/recipeBook.pure.ts";
import { checkCitations, collectCitations, computePlanConfidence } from "./confidence.pure.ts";
import { businessSlug } from "./cook.pure.ts";
import {
  agentContentPrompt,
  factsPrompt,
  kbPartPrompt,
  profilePrompt,
  topologyPrompt,
  voiceContextPrompt,
  type PromptDoc,
  type StagePrompt,
} from "./plannerPrompts.pure.ts";
import {
  AgentContent,
  BusinessProfile,
  DocumentFacts,
  KbPartDraft,
  PlanTopology,
  VoiceContextDraft,
  type CloningPlan,
} from "./schemas.pure.ts";
import { hasErrors, validatePlan } from "./validate.pure.ts";

export const STAGES = [
  "extract_docs",
  "profile",
  "topology",
  "agent_content",
  "voice_context",
  "kb_draft",
  "validate",
  "assemble",
] as const;
export type Stage = (typeof STAGES)[number];

/** How hard the model thinks at each stage: design decisions get the most. */
export const STAGE_EFFORT: Record<Stage, "low" | "medium" | "high"> = {
  extract_docs: "medium",
  profile: "high",
  topology: "high",
  agent_content: "high",
  voice_context: "high",
  kb_draft: "medium",
  validate: "high",
  assemble: "low",
};

export interface SourceDocument {
  /** "doc:1", "doc:2" ... in upload order, or "ctx:target". */
  docId: string;
  title: string;
  text: string | null;
  fileId: string | null;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  model: string;
}

export interface StructuredCall<T> {
  stage: Stage;
  key: string;
  schema: z.ZodType<T>;
  prompt: StagePrompt;
}

export interface PlannerModel {
  structured<T>(call: StructuredCall<T>): Promise<{ data: T; usage: Usage }>;
}

export interface PlannerStore {
  saveArtifact(kind: string, key: string, data: unknown, usage: Usage | null): Promise<void>;
  /** Called after every unit so the run row always shows where it is and what it has cost. */
  recordProgress(stage: Stage, costUsd: number): Promise<void>;
}

export interface RunInput {
  sources: SourceDocument[];
  /** Everything the run has already produced, keyed `${kind}:${key}`. */
  artifacts: Map<string, unknown>;
  costSoFar: number;
  maxCostUsd: number;
  /** ms since epoch; no new unit starts after it. */
  deadline: number;
  now: () => number;
  recipeSha: string;
  /** How many units of one stage may be in flight at once. */
  concurrency?: number;
}

export type RunOutcome =
  | { status: "continue"; stage: Stage; costUsd: number }
  | { status: "complete"; plan: CloningPlan; costUsd: number };

export class CostCapError extends Error {
  constructor(spent: number, cap: number) {
    super(`this plan has spent $${spent.toFixed(2)} of its $${cap.toFixed(2)} cap - raise VOICE_STUDIO_MAX_RUN_USD or re-plan with fewer documents`);
    this.name = "CostCapError";
  }
}

export class NoSourcesError extends Error {
  constructor() {
    super("the project has no readable documents and no Mission Control context to plan from");
    this.name = "NoSourcesError";
  }
}

const artifactKey = (kind: string, key: string) => `${kind}:${key}`;

/** Resume a run: do as many missing units as the deadline and the budget allow. */
export async function advanceRun(input: RunInput, model: PlannerModel, store: PlannerStore): Promise<RunOutcome> {
  const docs = input.sources.filter((s) => s.docId.startsWith("doc:") && (s.text || s.fileId));
  const context = input.sources.find((s) => s.docId === "ctx:target") ?? null;
  if (docs.length === 0 && !context) throw new NoSourcesError();

  const a = input.artifacts;
  let cost = input.costSoFar;
  const concurrency = Math.max(1, input.concurrency ?? 3);

  const outOfTime = () => input.now() >= input.deadline;
  const charge = (u: Usage) => {
    cost += u.costUsd;
  };

  /** Run the missing units of one stage, a few at a time, stopping at the deadline. */
  const runUnits = async <T>(stage: Stage, kind: string, units: Array<{ key: string; call: () => StructuredCall<T> }>) => {
    const missing = units.filter((u) => !a.has(artifactKey(kind, u.key)));
    for (let i = 0; i < missing.length; i += concurrency) {
      if (outOfTime()) return false;
      if (cost >= input.maxCostUsd) throw new CostCapError(cost, input.maxCostUsd);
      const batch = missing.slice(i, i + concurrency);
      const results = await Promise.all(
        batch.map(async (u) => {
          const { data, usage } = await model.structured(u.call());
          return { u, data, usage };
        }),
      );
      for (const { u, data, usage } of results) {
        charge(usage);
        a.set(artifactKey(kind, u.key), data);
        await store.saveArtifact(kind, u.key, data, usage);
      }
      await store.recordProgress(stage, cost);
    }
    return true;
  };

  const toPromptDoc = (s: SourceDocument): PromptDoc => ({
    docId: s.docId,
    title: s.title,
    ...(s.text ? { text: s.text } : {}),
    ...(s.fileId && !s.text ? { fileId: s.fileId } : {}),
  });

  // 1. Facts, one call per document (and one for the context, when it exists).
  const factSources = [...docs, ...(context ? [context] : [])];
  if (
    !(await runUnits("extract_docs", "facts", factSources.map((s) => ({
      key: s.docId,
      call: () => ({ stage: "extract_docs" as const, key: s.docId, schema: DocumentFacts, prompt: factsPrompt(toPromptDoc(s)) }),
    }))))
  ) return { status: "continue", stage: "extract_docs", costUsd: cost };
  const facts = factSources.map((s) => a.get(artifactKey("facts", s.docId)) as DocumentFacts);

  // 2. Profile.
  if (
    !(await runUnits("profile", "profile", [{
      key: "main",
      call: () => ({
        stage: "profile" as const,
        key: "main",
        schema: BusinessProfile,
        prompt: profilePrompt(facts, context ? toPromptDoc(context) : null),
      }),
    }]))
  ) return { status: "continue", stage: "profile", costUsd: cost };
  const profile = a.get(artifactKey("profile", "main")) as BusinessProfile;

  // 3. Topology - the repaired one wins once it exists.
  if (
    !(await runUnits("topology", "topology", [{
      key: "main",
      call: () => ({ stage: "topology" as const, key: "main", schema: PlanTopology, prompt: topologyPrompt(profile, null) }),
    }]))
  ) return { status: "continue", stage: "topology", costUsd: cost };
  const currentTopology = () =>
    (a.get(artifactKey("topology", "repaired")) ?? a.get(artifactKey("topology", "main"))) as PlanTopology;

  const sourcesByDocId = Object.fromEntries(
    input.sources.filter((s) => s.text).map((s) => [s.docId, s.text as string]),
  );

  // Stages 4-6 run until nothing is missing; after a repair they only fill in
  // the agents the repaired topology added.
  for (let pass = 0; pass < 2; pass++) {
    const topology = currentTopology();

    if (
      !(await runUnits("agent_content", "agent", topology.agents.map((ag) => ({
        key: ag.key,
        call: () => ({
          stage: "agent_content" as const,
          key: ag.key,
          schema: AgentContent,
          prompt: agentContentPrompt(profile, topology, ag.key),
        }),
      }))))
    ) return { status: "continue", stage: "agent_content", costUsd: cost };
    const agents = topology.agents.map((ag) => a.get(artifactKey("agent", ag.key)) as AgentContent);

    if (
      !(await runUnits("voice_context", "voice_context", [{
        key: "main",
        call: () => ({
          stage: "voice_context" as const,
          key: "main",
          schema: VoiceContextDraft,
          prompt: voiceContextPrompt(profile, topology, agents),
        }),
      }]))
    ) return { status: "continue", stage: "voice_context", costUsd: cost };
    const voiceContext = a.get(artifactKey("voice_context", "main")) as VoiceContextDraft;

    const parts: KbPartKey[] = [...KB_PART_KEYS];
    if (
      !(await runUnits("kb_draft", "kb", parts.map((part) => ({
        key: part,
        call: () => ({
          stage: "kb_draft" as const,
          key: part,
          schema: KbPartDraft,
          prompt: kbPartPrompt(profile, topology, facts, part),
        }),
      }))))
    ) return { status: "continue", stage: "kb_draft", costUsd: cost };
    const kb = parts.map((p) => a.get(artifactKey("kb", p)) as KbPartDraft);

    // 7. Validate. One repair of the topology is allowed; what remains after it
    // is recorded on the plan and blocks its approval.
    const result = validatePlan({ profile, topology, agents, voiceContext, kb, sources: sourcesByDocId });
    const errors = result.issues.filter((i) => i.severity === "error");
    if (errors.length && pass === 0 && !a.has(artifactKey("topology", "repaired"))) {
      if (
        !(await runUnits("validate", "topology", [{
          key: "repaired",
          call: () => ({ stage: "validate" as const, key: "repaired", schema: PlanTopology, prompt: topologyPrompt(profile, errors) }),
        }]))
      ) return { status: "continue", stage: "validate", costUsd: cost };
      continue;
    }

    // 8. Assemble.
    const citations = checkCitations(collectCitations(profile, kb), sourcesByDocId);
    const openItems = [
      ...topology.openItems.map((o) => ({ ...o, source: "planner" as const })),
      ...result.openItems,
    ];
    const plan: CloningPlan = {
      recipeVersion: RECIPE_BOOK_VERSION,
      recipeSha: input.recipeSha,
      businessSlug: businessSlug(profile.businessName),
      profile,
      topology: result.topology,
      agents: result.topology.agents.map((ag) => agents.find((x) => x.agentKey === ag.key) ?? (a.get(artifactKey("agent", ag.key)) as AgentContent)),
      voiceContext,
      kb,
      issues: result.issues,
      openItems,
      confidence: computePlanConfidence({
        citations,
        gapCount: profile.gaps.length,
        issues: result.issues,
        openItemCount: openItems.length,
      }),
    };
    await store.recordProgress("assemble", cost);
    return { status: "complete", plan, costUsd: cost };
  }
  // Unreachable: the second pass always assembles.
  throw new Error("planner did not converge");
}

/** Whether an assembled plan may be approved. */
export function planIsApprovable(plan: CloningPlan): boolean {
  return !hasErrors(plan.issues);
}
