/**
 * When prime deletes a file, the clone has to lose it too — and the whole
 * difficulty is that "the clone does not have this file" and "the clone has a
 * file prime does not" look identical from a tree comparison.
 *
 * ## What went wrong, exactly
 *
 * The cascade delivered modifications and additions and silently dropped every
 * deletion. On 30 Aug 2026 prime's `9f9abe594` did seven things at once: it
 * rewrote `AmlOverview.tsx`, rewrote the test that covers it under a NEW name
 * (`amlComplianceHomeShape.test.tsx`), and DELETED the old one
 * (`amlComplianceHomeQueues.test.tsx`). The cascade carried six of the seven.
 *
 * The clone was then running a test prime had deleted against a page prime had
 * rewritten. `verify` went red on the cascade's own pull request — a pull
 * request that could never go green, because nothing in the engine could ever
 * remove the file that was failing. One clone stalls; a fleet of them stalls
 * the same way on the same commit, and each one needs a person.
 *
 * ## Why this is not simply "prune what prime lacks"
 *
 * A clone legitimately carries files prime has never had. On the client-facing
 * mirror there are nine of them right now — its backend-isolation spec, its
 * schema-transfer scripts, its `client-facing.d.ts`, its invariant checker.
 * They are the difference between a clone and a copy, and a cascade that
 * pruned "everything prime lacks" would delete every one of them on its first
 * run.
 *
 * So a tree comparison is NOT evidence of a deletion. It produces candidates.
 * The evidence has to come from prime's own history, and this module is the
 * rule that reads it.
 *
 * ## The rule
 *
 * A deletion is delivered only where **the clone's copy is byte-identical to
 * the version prime deleted**.
 *
 * That single test settles all three cases:
 *
 *   - prime never had the path        → the clone owns it        → keep
 *   - prime deleted it, bytes match   → unmodified prime content → delete
 *   - prime deleted it, bytes differ  → somebody edited it       → keep
 *
 * The third is the one worth stating out loud: a clone that edited a file prime
 * later deleted has done work, and deleting it destroys that work with no
 * warning and no recovery through any surface this product offers. Bytes match
 * or the file stays.
 *
 * Blob SHAs are compared, never contents. A blob SHA IS a hash of the bytes, so
 * it settles binaries as exactly as it settles text — and the cascade has
 * already been wrong once by comparing UTF-8 readings instead of bytes.
 *
 * ## The three refusals
 *
 * **Never delete something that is still imported.** A file prime deleted can
 * still be referenced by a file the cascade cannot deliver — a `manual_reconcile`
 * held path like `src/App.tsx`, or a file the clone alone has. Deleting the
 * module breaks the build, and the cascade would have done it to itself. So
 * every surviving source the engine can see is scanned first, and a referenced
 * path is kept and named.
 *
 * Files that are byte-identical in prime and clone are deliberately NOT
 * scanned, and that is sound rather than a shortcut: prime compiles without the
 * deleted path, so prime's copy cannot import it, so a byte-identical copy
 * cannot either.
 *
 * **Never delete in bulk.** Past `MAX_DELETIONS_PER_CASCADE` the whole set is
 * refused rather than trimmed. A cascade that suddenly wants to remove a
 * hundred files is not a big refactor to be applied in instalments — it is
 * evidence gone wrong, and the response to suspect evidence is to stop, not to
 * act on the first twenty-five of it.
 *
 * **Never delete without evidence.** A probe that fails, times out or returns
 * something unrecognised is `unsettled`, and unsettled keeps the file. This is
 * the same asymmetry the rest of the engine runs on: a read that FAILED is not
 * a fact that is ABSENT.
 *
 * Client-safe: pure. Imports only the two parsing helpers, which are pure too.
 */
import { resolveSpecifier, stripNonCode } from "./heldFileStaleness.pure";

/**
 * The most files one cascade may delete before it stops and asks.
 *
 * Sized against what a real retirement looks like in this codebase: the
 * partner-agreement removal took out three Edge Functions and eleven shared
 * modules in one change — fourteen. Twenty-five leaves room above the largest
 * real one and is far below anything that could be a mistake worth applying.
 */
export const MAX_DELETIONS_PER_CASCADE = 25;

/**
 * The most candidates one run will ask prime's history about.
 *
 * Each probe is one or two API calls against the same budget the cascade's
 * content reads come from. Clone-only files are a small fixed set in practice
 * (nine on the mirror this was written against), so this is a ceiling for a
 * clone that has grown its own tree, not a working limit.
 */
export const MAX_DELETION_PROBES = 100;

/** What prime's history says about a path the clone has and prime does not. */
export type DeletionEvidence =
  /** No commit in prime has ever touched this path: the clone owns it. */
  | { kind: "never_primes" }
  /**
   * Prime removed it. `preImageSha` is the blob prime held immediately before
   * — `null` when the probe could not recover it, which is unsettled rather
   * than a licence to delete.
   */
  | { kind: "removed"; deletedIn: string; preImageSha: string | null }
  /** The probe could not answer. Never an argument for deleting. */
  | { kind: "unsettled"; why: string };

export type DeletionCandidate = {
  path: string;
  /** The blob the clone holds at this path right now. */
  cloneSha: string;
  evidence: DeletionEvidence;
};

export type DeletionKeepReason =
  /** Prime never had it — it is the clone's own file. */
  | "clone_owns"
  /** Prime deleted it, but this clone's copy is not the one prime deleted. */
  | "clone_edited"
  /** Prime's history could not be read. */
  | "unsettled"
  /** A file that survives this cascade still imports it. */
  | "still_referenced";

export type DeletionVerdict =
  | { act: "delete"; path: string; deletedIn: string }
  | { act: "keep"; path: string; reason: DeletionKeepReason; why: string };

/**
 * One candidate, one answer.
 *
 * Note what is NOT consulted: how old the deletion is, how large the file is,
 * what kind of file it is, whether it looks like a test. A rule that treated
 * `.test.ts` as safer than `.ts` would be guessing about consequences it cannot
 * see, and the byte comparison already answers the only question that matters.
 */
export function decideDeletion(candidate: DeletionCandidate): DeletionVerdict {
  const { path, cloneSha, evidence } = candidate;

  if (evidence.kind === "never_primes") {
    return {
      act: "keep",
      path,
      reason: "clone_owns",
      why: "No commit in prime has ever touched this path, so it is this clone's own file.",
    };
  }

  if (evidence.kind === "unsettled") {
    return {
      act: "keep",
      path,
      reason: "unsettled",
      why: `Prime's history for this path could not be read (${evidence.why}), and an unreadable history is not an absent one.`,
    };
  }

  if (!evidence.preImageSha) {
    return {
      act: "keep",
      path,
      reason: "unsettled",
      why:
        `Prime removed this in ${shortish(evidence.deletedIn)}, but the version it removed could ` +
        `not be recovered, so there is nothing to compare this clone's copy against.`,
    };
  }

  if (evidence.preImageSha !== cloneSha) {
    return {
      act: "keep",
      path,
      reason: "clone_edited",
      why:
        `Prime removed this in ${shortish(evidence.deletedIn)}, but this clone's copy is not the ` +
        `one prime removed — it has been edited here. Deleting it would destroy that work.`,
    };
  }

  return { act: "delete", path, deletedIn: evidence.deletedIn };
}

/**
 * Every module specifier a source file names, in any of the forms that make the
 * named module a build dependency.
 *
 * `namedImportsOf` deliberately reads only the brace group, because it is
 * answering "which SYMBOLS does this take". The question here is different and
 * blunter — "does this file need that module to exist at all" — so a default
 * import, a namespace import, a side-effect import, a re-export and a dynamic
 * `import()` all count.
 */
export function moduleSpecifiersOf(source: string): string[] {
  const code = stripNonCode(source);
  const out: string[] = [];
  const patterns = [
    // import X from "s" / import {a} from "s" / import * as N from "s" / import type … from "s"
    /\bimport\s+(?:type\s+)?[^;'"]*?\bfrom\s*["']([^"']+)["']/g,
    // import "s" — side effect only
    /\bimport\s*["']([^"']+)["']/g,
    // export … from "s"
    /\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})\s*(?:as\s+[\w$]+\s*)?from\s*["']([^"']+)["']/g,
    // import("s") and require("s")
    /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) out.push(m[1]);
  }
  return [...new Set(out)];
}

/**
 * Withhold any deletion a file that survives this cascade still imports.
 *
 * `survivingFiles` is what the engine can actually see: the held files it read
 * because it could not deliver them, and any clone-only source. That is
 * sufficient rather than partial — see the header.
 */
export function withholdReferencedDeletions(
  verdicts: readonly DeletionVerdict[],
  survivingFiles: Readonly<Record<string, string>>,
): DeletionVerdict[] {
  const deleting = new Set(verdicts.filter((v) => v.act === "delete").map((v) => v.path));
  if (deleting.size === 0) return [...verdicts];

  /** path being deleted → the files that still name it */
  const referencedBy = new Map<string, string[]>();
  for (const [fromPath, source] of Object.entries(survivingFiles)) {
    for (const specifier of moduleSpecifiersOf(source)) {
      for (const target of resolveSpecifier(fromPath, specifier)) {
        if (!deleting.has(target)) continue;
        const list = referencedBy.get(target) ?? [];
        if (!list.includes(fromPath)) list.push(fromPath);
        referencedBy.set(target, list);
      }
    }
  }

  return verdicts.map((v) => {
    if (v.act !== "delete") return v;
    const by = referencedBy.get(v.path);
    if (!by || by.length === 0) return v;
    return {
      act: "keep" as const,
      path: v.path,
      reason: "still_referenced" as const,
      why:
        `Prime removed this, but ${by.map((p) => `\`${p}\``).join(", ")} still import(s) it on ` +
        `this clone and the cascade cannot change ${by.length === 1 ? "it" : "them"}. ` +
        `Deleting it would break the build.`,
    };
  });
}

export type DeletionPlan = {
  /** Paths to remove from the clone's tree. */
  deletes: string[];
  /** Everything kept, with the reason — for the pull request body. */
  kept: Array<{ path: string; reason: DeletionKeepReason; why: string }>;
  /** Set when the whole set was refused for being too large. */
  refusal: string | null;
};

/**
 * Turn verdicts into a plan, applying the bulk refusal.
 *
 * The refusal is all-or-nothing on purpose. Trimming to the cap would deliver
 * an arbitrary subset of a set we have just decided we do not trust, and would
 * do it again next run with a different subset.
 */
export function planDeletions(
  verdicts: readonly DeletionVerdict[],
  maxDeletions: number = MAX_DELETIONS_PER_CASCADE,
): DeletionPlan {
  const deletes = verdicts.filter((v) => v.act === "delete").map((v) => v.path);
  const kept = verdicts
    .filter((v): v is Extract<DeletionVerdict, { act: "keep" }> => v.act === "keep")
    .map(({ path, reason, why }) => ({ path, reason, why }));

  if (deletes.length > maxDeletions) {
    return {
      deletes: [],
      kept,
      refusal:
        `${deletes.length} file(s) would be deleted, above the ${maxDeletions} this engine will ` +
        `remove without a person. Nothing was deleted. A set this size is more likely to be ` +
        `evidence gone wrong than a retirement, so it is refused whole rather than applied in part.`,
    };
  }

  return { deletes, kept, refusal: null };
}

/**
 * The phrase a cascade summary uses for what it removed.
 *
 * Only deletions and refusals are worth a summary line. A kept clone-only file
 * is the ordinary state of every healthy clone on every run, and putting nine
 * of those in every summary is how an operator learns not to read them; they
 * belong in the pull request body, where somebody is already looking.
 */
export function deletionSuffixFor(plan: DeletionPlan): string {
  if (plan.refusal) return ` · deletions REFUSED: ${plan.refusal}`;
  if (plan.deletes.length === 0) return "";
  const shown = plan.deletes.slice(0, 3).join(", ");
  const more = plan.deletes.length > 3 ? ` (+${plan.deletes.length - 3} more)` : "";
  return ` · ${plan.deletes.length} deleted: ${shown}${more}`;
}

/** The pull request body's section on removals. Empty when there is nothing to say. */
export function describeDeletionPlan(plan: DeletionPlan): string {
  const parts: string[] = [];

  if (plan.refusal) {
    parts.push(`**Deletions refused.** ${plan.refusal}`);
  } else if (plan.deletes.length > 0) {
    parts.push(
      `**Removed (${plan.deletes.length}).** Prime deleted these and this clone's copies were ` +
        `byte-identical to the versions prime deleted:\n` +
        plan.deletes.map((p) => `- \`${p}\``).join("\n"),
    );
  }

  // Only the reasons a person can act on. `clone_owns` is every healthy clone's
  // own tree and listing it would bury the two that matter.
  const actionable = plan.kept.filter((k) => k.reason !== "clone_owns");
  if (actionable.length > 0) {
    parts.push(
      `**Kept, though prime removed them (${actionable.length}).**\n` +
        actionable.map((k) => `- \`${k.path}\` — ${k.why}`).join("\n"),
    );
  }

  return parts.join("\n\n");
}

function shortish(sha: string): string {
  return sha.slice(0, 7);
}
