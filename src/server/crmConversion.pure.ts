/**
 * MOVING A CLONE FROM ONE CRM LINE TO THE OTHER — every decision, no I/O.
 *
 * The fleet has two lines (`crmMode.pure.ts`). A clone belongs to one by the
 * TREE it carries and by the parent it receives cascades through, so
 * converting it is not a flag flip: it is a delivery of the other line's tree,
 * a removal of what only the line it leaves carried, and then a change of
 * parent. This module decides all of it; `crmConversion.server.ts` does the
 * reading and writing around it.
 *
 * ## What a conversion is
 *
 * One pull request on the clone, built by the cascade engine itself
 * (`processClone` with its `conversion` option) from the TARGET line's head,
 * so every guard a cascade has — the exclusion policy, the backend-identity
 * hold, the config and registry pumps, the membrane, the held-file checks —
 * applies to it unchanged. Three things differ, and each is decided here:
 *
 *  - **What is removed is keyed on the line the clone LEAVES**, never on the
 *    prime's history. A cascade removes a path only where the prime deleted
 *    it; a conversion removes the files the old line carried and the new one
 *    does not — `crm-send-message` leaving a CRM-independent clone, or the
 *    GoHighLevel-only wiring leaving a dependent one. `decideConversionDeletion`
 *    is the rule, and it removes a file only where the clone's copy is
 *    byte-identical to the leaving line's: a clone's own file, or one it
 *    edited, is kept and named in the pull request.
 *  - **It is never merged by the platform.** Merging the pull request IS the
 *    conversion — a person decides the moment a deployment changes CRM — so
 *    the engine proposes in `pr` mode whatever the fleet's cascade mode, on a
 *    branch none of the cascade's own machinery recognises
 *    (`CONVERSION_BRANCH_PREFIX`), so the merge drain, the conflict resolver
 *    and the proposal repair never touch it.
 *  - **It finishes on the merge.** Only once the pull request lands does the
 *    clone's record move: parent, mode and pointer are written through
 *    `crmChildFields`, the same function provisioning uses, the functions the
 *    new line declares are deployed and the ones it retired come off the
 *    project. A pull request closed unmerged cancels the conversion and
 *    changes nothing.
 *
 * ## What it refuses
 *
 * `judgeConversion` refuses by name, before anything is proposed, and every
 * refusal sends an operator somewhere specific: a read that failed (retry), a
 * clone whose CRM was never recorded, the head of a line (moving it would
 * leave the line with nothing to create clones from), a clone other clones
 * receive their tree through (converting it would carry them across
 * unasked), a module-scoped clone (it receives globs, not a line's tree), a
 * conversion already open, an open cascade proposal (whichever landed second
 * would undo the other), and a target line whose head cannot be created from.
 *
 * ## What it does not do
 *
 * Records are not moved. A dependent clone's clients and conversations live in
 * GoHighLevel and an independent clone's in its own tables; the conversion
 * changes which one the deployment talks to and says so in the pull request.
 */

import type { CrmMode } from "@/lib/crmMode.pure";
import { CRM_MODE_COPY, crmModeLabel, isCrmMode } from "@/lib/crmMode.pure";
import type { CrmParent, CrmParentJudgement } from "./crmLineage.pure";
import { crmChildFields } from "./crmLineage.pure";
import type { DeletionPlan, DeletionVerdict } from "./cascade/deletionPropagation.pure";
import type { SyncExclusion } from "./cascade/syncExclusions.pure";

// ─────────────────────────────────────────────────────────────────────────────
// Vocabulary
// ─────────────────────────────────────────────────────────────────────────────

// The statuses, the open-slot test and the one-line description live in
// `@/lib/crmConversionStatus.pure` because the clone page renders them, and a
// client module may import nothing under `server/` (TanStack's import
// protection refuses the build). Re-exported so the server reads one copy.
export {
  CONVERSION_STATUSES,
  OPEN_CONVERSION_STATUSES,
  describeConversion,
  isOpenConversionStatus,
  type ConversionStatus,
} from "@/lib/crmConversionStatus.pure";

/**
 * The branch a conversion proposal lives on.
 *
 * Deliberately not `aurixa/cascade-…`: the engine's own open-proposal lookup,
 * the merge drain and the conflict resolver all key on that prefix, and every
 * one of them would treat a conversion as the prime's delivery — force-push
 * the old line's tree over it, or merge it unattended on green. A prefix none
 * of them match keeps the two apart, the same way the lateral lane is kept
 * apart (`LATERAL_BRANCH_PREFIX`).
 */
export const CONVERSION_BRANCH_PREFIX = "aurixa/crm-conversion-";

export function conversionBranchName(
  toMode: CrmMode,
  sourceSha: string,
  now: number = Date.now(),
): string {
  return `${CONVERSION_BRANCH_PREFIX}${toMode}-${sourceSha.slice(0, 7)}-${now.toString(36)}`;
}

/** Whether a branch is one this lane named. */
export function isConversionBranch(ref: string | null | undefined): boolean {
  return typeof ref === "string" && ref.startsWith(CONVERSION_BRANCH_PREFIX);
}

/**
 * The most files one conversion removes.
 *
 * A cascade stops at 25 because a larger removal is more likely evidence gone
 * wrong than a retirement. A conversion is a removal by design — the old
 * line's own files — and measured 28 Sep 2026 the difference between the two
 * lines' heads is under a hundred paths either way. Two hundred leaves room
 * for the lines to drift apart and still refuses a set that could only mean
 * the trees were misread; over it the whole conversion is refused rather than
 * delivered with part of the old line left behind.
 */
export const MAX_CONVERSION_DELETIONS = 200;

/**
 * How long a `proposed` row may sit with no pull request before it is taken
 * for a proposal that died. Building one is a single request that reads two
 * trees and writes one; a quarter of an hour is several times the slowest.
 */
export const STALLED_PROPOSAL_MS = 15 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// 1. May this clone be converted?
// ─────────────────────────────────────────────────────────────────────────────

/** The clone, as much of it as the judgement reads. */
export interface ConversionCloneRow {
  id: string;
  name: string | null;
  github_owner: string | null;
  github_repo: string | null;
  default_branch: string | null;
  crm_mode: string | null;
  sync_scope: string | null;
  parent_clone_id: string | null;
  last_synced_sha?: string | null;
}

/**
 * Where the clone receives its tree from TODAY — the line it is leaving.
 *
 * `parent` for a clone with a recorded parent, `prime` for one that reads the
 * prime directly. The leaving tree is what the deletion rule compares against,
 * so it must be the tree the clone actually came from.
 */
export interface LeavingSourceRow {
  kind: "parent" | "prime";
  name: string | null;
  github_owner: string | null;
  github_repo: string | null;
  default_branch: string | null;
}

export interface JudgeConversionInput {
  /** The clone, or null when no row was returned. */
  clone: ConversionCloneRow | null;
  /** The mode asked for, unvalidated — it arrives from a request. */
  toMode: unknown;
  /**
   * The first read this judgement depends on that FAILED, with its message.
   * Null when every read answered. A read that failed is never taken for a
   * fact that is absent: no children, no open conversion, no line heads.
   */
  readFailure: string | null;
  /** `prime_config`'s two line heads. */
  lineHeads: { dependent: string | null; independent: string | null };
  /** Clones whose `parent_clone_id` is this clone. */
  childCount: number;
  /** The target line's head, judged by `judgeCrmParent`. */
  target: CrmParentJudgement;
  /** What the target head's own record says about its scope. */
  targetScope: string | null;
  /** The source the clone reads today. Null when its recorded parent is missing. */
  leaving: LeavingSourceRow | null;
  /** An open conversion on this clone, if there is one. */
  openConversion: { id: string; status: string } | null;
  /** An open cascade proposal on this clone, if there is one. */
  openCascadePr: { number: number; url: string } | null;
}

export type ConversionRefusalKind =
  | "unreadable"
  | "missing"
  | "bad_mode"
  | "unrecorded"
  | "same_mode"
  | "line_head"
  | "has_children"
  | "not_mirror"
  | "no_repository"
  | "already_open"
  | "cascade_open"
  | "target_parent"
  | "target_unsynced"
  | "leaving_unknown";

/** A readable reference to the tree the clone is leaving. */
export interface LeavingRef {
  owner: string;
  repo: string;
  branch: string;
  label: string;
}

export type ConversionJudgement =
  | {
      ok: true;
      fromMode: CrmMode;
      toMode: CrmMode;
      target: CrmParent;
      leaving: LeavingRef;
      /**
       * What an operator should know before starting, which is not a reason
       * to refuse. Shown on the preview and carried into the pull request.
       */
      cautions: string[];
    }
  | { ok: false; kind: ConversionRefusalKind; reason: string };

export function judgeConversion(input: JudgeConversionInput): ConversionJudgement {
  if (input.readFailure) {
    return refuse(
      "unreadable",
      `Could not read what this conversion depends on (${input.readFailure}). Nothing was proposed: ` +
        `a read that failed is not an answer, and converting on a guess could move a clone other ` +
        `clones depend on. Try again.`,
    );
  }

  const clone = input.clone;
  if (!clone) return refuse("missing", "No such clone.");
  const name = clone.name?.trim() || clone.github_repo || clone.id;

  if (!isCrmMode(input.toMode)) {
    return refuse(
      "bad_mode",
      `"${String(input.toMode)}" is not a CRM line. A clone is converted to "dependent" or "independent".`,
    );
  }
  const toMode: CrmMode = input.toMode;

  if (!isCrmMode(clone.crm_mode)) {
    return refuse(
      "unrecorded",
      `${name} does not record which CRM it runs, so there is no line to convert it FROM — and the ` +
        `files a conversion removes are the ones only that line carries. Record its CRM first.`,
    );
  }
  const fromMode: CrmMode = clone.crm_mode;

  if (fromMode === toMode) {
    return refuse("same_mode", `${name} already runs ${crmModeLabel(toMode)}.`);
  }

  const headOf = (["dependent", "independent"] as const).find(
    (m) => input.lineHeads[m] === clone.id,
  );
  if (headOf) {
    return refuse(
      "line_head",
      `${name} heads the ${CRM_MODE_COPY[headOf].title} line: every clone of that line is created from ` +
        `its tree and receives cascades through it. Converting it would leave the line with nothing ` +
        `to create clones from. Point the line at another clone in Settings first.`,
    );
  }

  if (input.childCount > 0) {
    return refuse(
      "has_children",
      `${input.childCount} clone(s) receive their tree through ${name}. Converting it would carry ` +
        `them to the other CRM with it, unasked. Convert or re-parent them first.`,
    );
  }

  if (clone.sync_scope !== "mirror") {
    return refuse(
      "not_mirror",
      `${name} is module-scoped: it receives the files of the modules it installed, not a line's ` +
        `tree, so there is no whole tree to move it onto. Only a mirror clone can change line.`,
    );
  }

  const owner = clone.github_owner?.trim();
  const repo = clone.github_repo?.trim();
  const branch = clone.default_branch?.trim();
  if (!owner || !repo || !branch) {
    return refuse(
      "no_repository",
      `${name} records no repository${owner && repo ? " branch" : ""}, so there is nothing to ` +
        `propose the conversion on.`,
    );
  }

  if (input.openConversion) {
    return refuse(
      "already_open",
      `A conversion of ${name} is already ${input.openConversion.status}. Finish or cancel it before ` +
        `starting another.`,
    );
  }

  if (input.openCascadePr) {
    return refuse(
      "cascade_open",
      `${name} has an open cascade proposal (#${input.openCascadePr.number}) built from the line it ` +
        `would be leaving. Whichever of the two landed second would undo the other, so merge or ` +
        `close it first: ${input.openCascadePr.url}`,
    );
  }

  if (!input.target.ok) {
    return refuse("target_parent", input.target.reason);
  }
  const target = input.target.parent;

  if (!target.lastSyncedSha) {
    return refuse(
      "target_unsynced",
      `${target.name}, the ${CRM_MODE_COPY[toMode].title} head, has never recorded which prime commit ` +
        `it carries. The converted clone would be moved onto a tree nothing can date, so the ` +
        `conversion waits until the head has received a cascade.`,
    );
  }

  const leaving = input.leaving;
  const leavingOwner = leaving?.github_owner?.trim();
  const leavingRepo = leaving?.github_repo?.trim();
  const leavingBranch = leaving?.default_branch?.trim();
  if (!leaving || !leavingOwner || !leavingRepo || !leavingBranch) {
    return refuse(
      "leaving_unknown",
      leaving
        ? `${name}'s current source records no repository branch, so there is no tree to tell its ` +
            `own files from the line's.`
        : `${name} records a parent (${clone.parent_clone_id}) that no longer exists, so there is no ` +
            `tree to tell its own files from the line's. Correct its parent first.`,
    );
  }

  const cautions: string[] = [];
  if (input.targetScope !== "mirror") {
    cautions.push(
      `${target.name}, the ${CRM_MODE_COPY[toMode].title} head, is module-scoped: its tree carries ` +
        `only the files of the modules it installed. ${name} becomes a copy of that tree, so every ` +
        `file the head lacks and the line ${name} is leaving carries is removed with the rest — ` +
        `each one is listed in the preview.`,
    );
  }
  if (clone.parent_clone_id === target.id) {
    cautions.push(
      `${name} already receives its tree from ${target.name}; the conversion corrects its record ` +
        `and brings across whatever it is missing.`,
    );
  }
  cautions.push(
    `Records are not moved. ${CRM_MODE_COPY[fromMode].provider} keeps what it holds, and after the ` +
      `merge the deployment reads ${CRM_MODE_COPY[toMode].provider}. ${CRM_MODE_COPY[toMode].consequence}`,
  );

  return {
    ok: true,
    fromMode,
    toMode,
    target,
    leaving: {
      owner: leavingOwner,
      repo: leavingRepo,
      branch: leavingBranch,
      label:
        leaving.kind === "prime"
          ? "prime"
          : leaving.name?.trim() || `${leavingOwner}/${leavingRepo}`,
    },
    cautions,
  };
}

function refuse(kind: ConversionRefusalKind, reason: string): ConversionJudgement {
  return { ok: false, kind, reason };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. What leaves with the old line
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The tree the clone is leaving, as the deletion rule reads it.
 *
 * `complete` is false when the listing was truncated. Then a path missing from
 * `shaByPath` may simply not have been listed, and absence proves nothing — a
 * path the listing DOES carry is still evidence either way.
 */
export interface LeavingTree {
  shaByPath: ReadonlyMap<string, string>;
  complete: boolean;
  /** The leaving line's head, recorded on each removal. */
  headSha: string;
  label: string;
}

/**
 * One path the clone holds and the target line does not: remove it or keep it.
 *
 * - The leaving line carries it with THIS clone's exact bytes → it came with
 *   the old line and nothing here changed it: removed.
 * - The leaving line carries it with different bytes → edited here, or older
 *   than the line's copy. "Edited" is the case that loses work, so it is kept,
 *   and the pull request names it for a person to remove by hand.
 * - The leaving line does not carry it → the clone's own file: kept, as every
 *   cascade keeps a clone's own files.
 * - The listing was truncated and does not carry it → unknown: kept.
 *
 * Nothing about the file's kind is consulted, for the reason `decideDeletion`
 * gives: the byte comparison already answers the only question that matters.
 */
export function decideConversionDeletion(
  candidate: { path: string; cloneSha: string },
  leaving: LeavingTree,
): DeletionVerdict {
  const { path, cloneSha } = candidate;
  const theirs = leaving.shaByPath.get(path);

  if (theirs === cloneSha) {
    return { act: "delete", path, deletedIn: leaving.headSha };
  }

  if (theirs !== undefined) {
    return {
      act: "keep",
      path,
      reason: "clone_edited",
      why:
        `${leaving.label} carries this path with different content, so this clone's copy was edited ` +
        `here or is older than the line's. Removing it could destroy work; delete it by hand if it ` +
        `belongs to the old line alone.`,
    };
  }

  if (!leaving.complete) {
    return {
      act: "keep",
      path,
      reason: "unsettled",
      why:
        `The listing of ${leaving.label} was truncated and does not show this path, and a path not ` +
        `listed cannot be told from one that is not there.`,
    };
  }

  return {
    act: "keep",
    path,
    reason: "clone_owns",
    why: `Neither line carries this path, so it is this clone's own file.`,
  };
}

/** The directory an edge function's files sit under, or null for the shared tree. */
function functionSlugOf(path: string): string | null {
  const m = /^supabase\/functions\/([^/]+)\//.exec(path);
  if (!m) return null;
  const slug = m[1];
  return slug.startsWith("_") ? null : slug;
}

/**
 * The edge functions this conversion takes out of the clone's tree.
 *
 * A function is retired where its entry point is removed AND the target line
 * carries nothing under its directory. Only then do the derived files — the
 * `config.toml` block, the security registry entry, the counted baselines —
 * have nothing left to describe, and the cascade's pumps are handed exactly
 * this list as `withheld`, the way they are handed what the prime keeps for
 * itself.
 */
export function functionsRetiredByConversion(
  deletes: Iterable<string>,
  targetPaths: Iterable<string>,
): string[] {
  const entryRemoved = new Set<string>();
  for (const path of deletes) {
    const slug = functionSlugOf(path);
    if (slug && path === `supabase/functions/${slug}/index.ts`) entryRemoved.add(slug);
  }
  if (entryRemoved.size === 0) return [];
  const carried = new Set<string>();
  for (const path of targetPaths) {
    const slug = functionSlugOf(path);
    if (slug && entryRemoved.has(slug)) carried.add(slug);
  }
  return [...entryRemoved].filter((slug) => !carried.has(slug)).sort();
}

/**
 * Retired functions whose entry point the FINAL plan keeps.
 *
 * The retired list is decided from the verdicts before the reference check
 * runs, and that check can still keep a file something imports. A retired
 * function whose `index.ts` survives would leave a function directory with no
 * `config.toml` block — which the clone's own CI reads as `verify_jwt = true`
 * on a function nobody declared — so any name here refuses the proposal.
 */
export function retiredFunctionsKept(
  retired: readonly string[],
  plannedDeletes: ReadonlySet<string>,
): string[] {
  return retired.filter((slug) => !plannedDeletes.has(`supabase/functions/${slug}/index.ts`));
}

// ─────────────────────────────────────────────────────────────────────────────
// 2b. The four files that ARE the line
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The browser files that decide which CRM a deployment talks to.
 *
 * On the independent line each routes through `src/lib/crm/crmProvider.ts`; on
 * the dependent line each calls GoHighLevel's functions directly. They are the
 * files a cascade once silently reverted on the independent head (`2fc9c46`),
 * which is why a clone that runs the independent line holds them as
 * `manual_reconcile` exclusions — and why those holds are the one exclusion a
 * conversion must see past: delivering the other line's copy of exactly these
 * files is what a conversion is for.
 */
export const CRM_ROUTING_FILES = [
  "src/components/clients/ClientConversationsTab.tsx",
  "src/hooks/useGHLCalendar.tsx",
  "src/pages/ClientTracker.tsx",
  "src/pages/Conversations.tsx",
] as const;

const ROUTING = new Set<string>(CRM_ROUTING_FILES);

/**
 * The clone's exclusions as a conversion applies them.
 *
 * A `manual_reconcile` row whose pattern is EXACTLY one of the routing files
 * is released for the conversion: it protects the line the clone is leaving
 * from the prime, and the conversion's whole purpose is to replace it. Nothing
 * else is released — a `protected` row stays protected whatever the file, a
 * glob that happens to cover a routing file is left alone (it was written
 * about something wider), and every other hold stands exactly as a cascade
 * would apply it.
 */
export function conversionExclusions(exclusions: readonly SyncExclusion[]): {
  exclusions: SyncExclusion[];
  released: string[];
} {
  const released: string[] = [];
  const kept: SyncExclusion[] = [];
  for (const row of exclusions) {
    if (row.reason === "manual_reconcile" && ROUTING.has(row.pattern)) {
      released.push(row.pattern);
      continue;
    }
    kept.push(row);
  }
  return { exclusions: kept, released: released.sort() };
}

/**
 * The exclusion rows a finished conversion takes off the clone.
 *
 * Only on arrival at the DEPENDENT line: the rows exist to stop a cascade
 * reverting the independent routing, and once the clone receives the dependent
 * line's tree through its new parent they would do the opposite — hold the
 * independent copies against the line's own delivery for ever. Arriving at the
 * independent line removes nothing: the new parent carries the independent
 * copies, and a clone that recorded the holds anyway is protected, not harmed.
 */
export function routingHoldsToRetire(
  exclusions: readonly SyncExclusion[],
  toMode: CrmMode,
): string[] {
  if (toMode !== "dependent") return [];
  return exclusions
    .filter((row) => row.reason === "manual_reconcile" && ROUTING.has(row.pattern))
    .map((row) => row.pattern)
    .sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. The pull request
// ─────────────────────────────────────────────────────────────────────────────

export interface ConversionWording {
  cloneName: string;
  fromMode: CrmMode;
  toMode: CrmMode;
  /** The target line's head, as the pull request names it. */
  targetLabel: string;
  /** The line the clone leaves. */
  leavingLabel: string;
  /** The target head's commit the tree was read at. */
  sourceSha: string;
  conversionId: string;
}

export function conversionTitle(w: ConversionWording, files: number): string {
  return (
    `Aurixa CRM conversion · ${CRM_MODE_COPY[w.fromMode].title} → ${CRM_MODE_COPY[w.toMode].title} ` +
    `· ${w.targetLabel}@${w.sourceSha.slice(0, 7)} (${files} file(s))`
  );
}

/**
 * The subject line of the proposal's commit.
 *
 * Not the cascade's `chore(aurixa): cascade …`: `isEngineOnlyBranch` recognises
 * an unmodified cascade proposal by that exact prefix, and a conversion must
 * never be mistaken for one by anything that rebuilds cascade proposals.
 */
export function conversionCommitSubject(w: ConversionWording, files: number): string {
  return (
    `chore(aurixa): convert to ${CRM_MODE_COPY[w.toMode].title} — ${files} file(s) from ` +
    `${w.targetLabel}@${w.sourceSha.slice(0, 7)}`
  );
}

/** The opening of the pull request body. */
export function conversionLead(w: ConversionWording, cautions: readonly string[]): string {
  const from = CRM_MODE_COPY[w.fromMode];
  const to = CRM_MODE_COPY[w.toMode];
  return (
    `This pull request moves **${w.cloneName}** from the **${from.title}** line (${w.leavingLabel}) ` +
    `to the **${to.title}** line (${w.targetLabel}). It carries ${w.targetLabel}'s tree at ` +
    `\`${w.sourceSha.slice(0, 7)}\` and removes the files only the ${from.title} line carried.\n\n` +
    `**Merging it is the conversion.** Mission Control never merges it. When it merges, Mission ` +
    `Control moves the clone under ${w.targetLabel}, deploys the edge functions the ` +
    `${to.title} line declares and takes off the project the ones this proposal retires. Closing it ` +
    `unmerged cancels the conversion and changes nothing.\n\n` +
    `Cascades to this clone are held while this is open.` +
    (cautions.length > 0 ? `\n\n${cautions.map((c) => `> ${c}`).join("\n>\n")}` : "") +
    `\n\n_Conversion \`${w.conversionId}\`._`
  );
}

/** The body's section on removals — the conversion's own wording, never the cascade's. */
export function describeConversionDeletions(plan: DeletionPlan, leavingLabel: string): string {
  const parts: string[] = [];
  if (plan.refusal) {
    parts.push(`**Removals refused.** ${plan.refusal}`);
  } else if (plan.deletes.length > 0) {
    parts.push(
      `**Removed (${plan.deletes.length}).** ${leavingLabel} carries each of these and this clone's ` +
        `copy was byte-identical to it; the line this clone joins does not carry them:\n` +
        plan.deletes.map((p) => `- \`${p}\``).join("\n"),
    );
  }
  const actionable = plan.kept.filter((k) => k.reason !== "clone_owns");
  if (actionable.length > 0) {
    parts.push(
      `**Kept — decide by hand (${actionable.length}).** Each is absent from the line this clone ` +
        `joins, but removing it here could lose work:\n` +
        actionable.map((k) => `- \`${k.path}\` — ${k.why}`).join("\n"),
    );
  }
  const own = plan.kept.filter((k) => k.reason === "clone_owns").length;
  if (own > 0) {
    parts.push(`_${own} path(s) belong to this clone alone and stay as they are._`);
  }
  return parts.join("\n\n");
}

/** The body's section on functions the proposal retires. Empty when it retires none. */
export function describeRetiredFunctions(retired: readonly string[], toMode: CrmMode): string {
  if (retired.length === 0) return "";
  return (
    `**Edge functions retired (${retired.length}).** The ${CRM_MODE_COPY[toMode].title} line does not ` +
    `carry these, so their \`config.toml\` blocks and registry entries go with their files, and ` +
    `once this merges they are deleted from the clone's project:\n` +
    retired.map((s) => `- \`${s}\``).join("\n")
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Where an open conversion stands
// ─────────────────────────────────────────────────────────────────────────────

/** What GitHub says about the proposal's pull request. */
export type ConversionPrReading =
  | { kind: "open" }
  | { kind: "merged"; mergeSha: string | null }
  | { kind: "closed" }
  /** 404: the pull request, or its repository, is gone. */
  | { kind: "missing" }
  /** The read failed. Never taken for "closed". */
  | { kind: "unreadable"; why: string };

export type ConversionStep =
  | { act: "wait"; why: string }
  | { act: "finalise" }
  | { act: "cancel"; why: string }
  | { act: "fail"; why: string }
  | { act: "none" };

export function decideConversionStep(input: {
  status: string;
  prNumber: number | null;
  pr: ConversionPrReading | null;
  /** When the row was created, ms since epoch. */
  createdAt: number;
  now: number;
}): ConversionStep {
  const { status } = input;
  if (status === "completed" || status === "cancelled" || status === "failed") {
    return { act: "none" };
  }
  // The pull request already landed; finalising is idempotent and resumes here.
  if (status === "merged") return { act: "finalise" };
  if (status !== "proposed") return { act: "none" };

  if (input.prNumber === null) {
    // Claimed, and either still being built or dead in the attempt.
    return input.now - input.createdAt > STALLED_PROPOSAL_MS
      ? {
          act: "fail",
          why:
            "The proposal was never recorded: the request that was building it did not finish. " +
            "Nothing on the clone changed; start the conversion again.",
        }
      : { act: "wait", why: "The proposal is still being built." };
  }

  const pr = input.pr;
  if (!pr) return { act: "wait", why: "The pull request has not been read yet." };
  switch (pr.kind) {
    case "open":
      return {
        act: "wait",
        why: `Waiting for pull request #${input.prNumber} to be merged or closed.`,
      };
    case "merged":
      return { act: "finalise" };
    case "closed":
      return {
        act: "cancel",
        why: `Pull request #${input.prNumber} was closed without merging. Nothing on the clone changed.`,
      };
    case "missing":
      return {
        act: "cancel",
        why: `Pull request #${input.prNumber} no longer exists. Nothing on the clone changed.`,
      };
    case "unreadable":
      return {
        act: "wait",
        why: `Pull request #${input.prNumber} could not be read (${pr.why}); asking again later.`,
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Finishing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The clone's new lineage columns, once the proposal has merged.
 *
 * `crmChildFields` is the one writer of "a clone under this parent", shared
 * with provisioning. The pointer is the one exception: it is the prime commit
 * the target head carried WHEN ITS TREE WAS READ for the proposal — the bytes
 * that merged — not whatever the head carries now. A pointer that ran ahead of
 * the content would tell the cascade this clone already holds commits it was
 * never sent; one that trails is corrected by the next delivery.
 */
export function finalisedCloneFields(
  target: CrmParent,
  cloneDefaultBranch: string | null,
  deliveredSha: string | null,
): ReturnType<typeof crmChildFields> {
  const fields = crmChildFields(target, cloneDefaultBranch);
  return { ...fields, last_synced_sha: deliveredSha ?? fields.last_synced_sha };
}

/**
 * The functions to take off the clone's project.
 *
 * Only what the proposal retired, only what the project actually runs, and
 * NEVER a function the prime declares: a prime function belongs to the prime's
 * own deploy lane, which decides what a clone's project runs, and a line that
 * lacks one is a line that is behind rather than one that retired it. When the
 * project's functions could not be read, every retired name is attempted — a
 * delete of a function that is not there answers 404, which is the outcome.
 */
export function functionsToUndeploy(input: {
  retired: readonly string[];
  live: readonly string[] | null;
  primeDeclared: readonly string[];
}): string[] {
  const prime = new Set(input.primeDeclared);
  const live = input.live ? new Set(input.live) : null;
  return input.retired
    .filter((slug) => !prime.has(slug) && (live === null || live.has(slug)))
    .sort();
}

/**
 * What a conversion that opened no pull request may do.
 *
 * `processClone` answers `skipped` for several reasons, and only one of them
 * means the clone already carries the target line's tree. A skip that carries
 * no `delivered_sha` verified nothing. A skip whose old-line files were all
 * WITHHELD from removal (kept because the clone edited or references them, or
 * because the removal was over the cap) still has the leaving line's files in
 * it; moving the record onto the new line would then claim a tree the
 * repository does not have. Both refuse, and name what a person has to settle.
 * The clone's own exclusions are not a reason to refuse: the engine counts a
 * difference the clone chose to keep as delivered, and so does this.
 */
export function settleWithoutProposal(input: {
  status: string;
  deliveredSha: string | null | undefined;
  summary: string;
  error: string | null;
  keptDeletions: readonly string[];
  deletionRefusal: string | null;
}): { act: "finish" } | { act: "refuse"; why: string } {
  if (input.status !== "skipped") {
    return { act: "refuse", why: input.error || input.summary || "The proposal was refused." };
  }
  if (input.deletionRefusal) {
    return { act: "refuse", why: input.deletionRefusal };
  }
  if (input.keptDeletions.length > 0) {
    const shown = input.keptDeletions.slice(0, 5).join(", ");
    const more =
      input.keptDeletions.length > 5 ? ` and ${input.keptDeletions.length - 5} more` : "";
    return {
      act: "refuse",
      why:
        `Nothing was proposed, but ${input.keptDeletions.length} file(s) from the line being ` +
        `left are still in the clone and were withheld from removal: ${shown}${more}. ` +
        `Settle them on the clone first; the conversion can then be proposed again.`,
    };
  }
  if (!input.deliveredSha) {
    return {
      act: "refuse",
      why: `Nothing was proposed and nothing was verified (${input.summary || "no reason given"}), so the clone was not moved.`,
    };
  }
  return { act: "finish" };
}
