/**
 * What a cut cascade pass leaves behind, and what the next one may reuse.
 *
 * A first module-scope cascade to `preflight-property-group` is 353 files —
 * a content read and a blob create each, after two tree listings and the
 * deletion probes, before the tree, the commit and the pull request. The
 * hook that runs it is abandoned at 60 seconds. Measured 2 Sep 2026 at 14:10
 * and again at 14:14: the pass was still preparing blobs when it was cut,
 * the reclaim requeued it ten minutes later, and the next attempt did the
 * same 353 reads and creates again. Three attempts and the event was dead,
 * with nothing delivered.
 *
 * The blobs a cut pass created are not lost. They exist in the clone's
 * repository, addressed by SHA, whether or not a tree ever referenced them.
 * What was lost was the list. `CascadeProgress` is that list: for every path
 * prepared, the blob SHA the clone now holds and the prime blob SHA it was
 * made from, keyed by the prime commit the pass was for.
 *
 * One rule carries all of it. **An entry is reused only while the prime blob
 * it was made from is still the one prime holds at that path** — checked
 * against the CURRENT pass's own prime tree listing, entry by entry, in
 * `resumableBlobs`. A path that changed upstream between passes is read
 * again, never delivered stale from a list.
 *
 * The record used to also be pinned to one prime commit — "a record made for
 * another source SHA is not consulted at all, because a different commit is
 * a different diff". The pin was a PROXY for the per-entry check, and the
 * September 2026 freeze measured what the proxy cost: prime merged ~50
 * commits a day, each one opened a fresh pass, and a fresh pass reused
 * nothing — so three clones re-read and re-created ~300 nearly identical
 * blobs per commit, the App's hourly budget went to work already done, and
 * the queue grew faster than it drained. A blob SHA is a hash of the bytes;
 * "prime still holds this exact blob at this path" is the fact the commit
 * pin was standing in for, and it holds across commits exactly as well as
 * within one. The `source_sha` field stays on the record as provenance —
 * which pass wrote it — and gates nothing.
 *
 * ## Evidence is bought once, like blobs
 *
 * The deletion probe asks prime's history about every clone-only path — one
 * `listCommits` and a couple of content reads each. An approved retirement
 * sweep is 442 paths (~1,300 calls per clone), which no single 45-second tick
 * survives and no hourly App budget enjoys twice. So a SETTLED answer rides
 * the same ledger, keyed by the clone blob it was asked about: prime's
 * history only grows, a path prime re-adds stops being a deletion candidate
 * before any cache is consulted, and a clone blob that changed invalidates
 * its entry by the key. `unsettled` is never stored — a failed read is
 * retried, not remembered — and a malformed entry is DROPPED alone rather
 * than voiding the record, because the cost of dropping is one re-probe
 * while the cost of keeping garbage is deleting the wrong file.
 *
 * ## A variant merge is decided once, like a probe
 *
 * A held line variant's three-way merge is up to five requests (the line's
 * history of the file, the named revision, three copies). The CRM line holds
 * twenty-six to thirty of them on an ordinary cascade, so the merge phase
 * alone is ~130 requests — and it ran in full on EVERY pass, because nothing
 * remembered what the last pass decided. Measured 11–12 Oct 2026 on
 * `npc-crm-independent-6505dc`: four consecutive events spent their whole
 * window re-merging the same paths, prepared four files of 368 each time,
 * recorded nothing new, and were retired after three attempts — and because a
 * paused clone ends the pass, the other line's three clones were never reached
 * at all.
 *
 * So a verdict rides the ledger, keyed to what it was computed from: the
 * clone's copy (ours), prime's current copy (theirs), and the clone's head
 * commit, whose history of the path decides the base. The two blobs are not
 * enough on their own: a commit can touch the path and leave the same bytes
 * behind (a change, then its revert, or a reconcile that names a newer prime
 * revision and restores the line's text), and the base then moves while both
 * blobs stand still. The merge reads its history and its copy of ours AT that
 * head, so the key is exactly what was read; the cost is one re-merge of the
 * held paths whenever the clone's branch moves, which it does not do while a
 * cascade is still being proposed to it. A `write`
 * carries the blob SHA its merged text was stored under in the clone's
 * repository, and the next pass reads that blob back rather than merging
 * again. A hold that a RETRY could change (a read that failed, a revision
 * that could not be resolved for a reason other than its absence) is recorded
 * as `transient`: it is never reused as an answer — only as the fact that the
 * path was already asked, so the next pass asks the never-asked first and
 * does not pause forever on a path that keeps failing.
 */

import type { SettledDeletionEvidence } from "./deletionPropagation.pure";
import type { SettledHeldEvidence } from "./heldEvidence.pure";

export type PreparedBlob = {
  /** The blob SHA the clone's repository now holds for this path. */
  blob: string;
  /** The prime blob SHA it was made from. */
  prime: string;
};

/** One settled probe answer, keyed to the clone blob it was asked about. */
export type DeletionEvidenceEntry = {
  /** The clone blob SHA the question was asked about. A changed blob is a changed question. */
  clone: string;
  /** What prime's history answered. Never `unsettled` — see the module header. */
  evidence: SettledDeletionEvidence;
};

/** One settled hold probe, keyed the same way: to the clone blob asked about. */
export type HeldEvidenceEntry = {
  clone: string;
  /** Never `unsettled` — the same rule as the deletion ledger. */
  evidence: SettledHeldEvidence;
};

/**
 * One variant merge verdict, keyed to the clone blob and the prime blob it was
 * computed from. A `write` names the clone-repository blob its merged text was
 * stored under — never the text itself, which can be hundreds of kilobytes on
 * a row read every tick.
 */
export type VariantEvidenceEntry = {
  /** The clone blob SHA (ours) the merge read. */
  clone: string;
  /** The prime blob SHA (theirs) the merge read. */
  prime: string;
  /**
   * The clone head commit the merge read its history and its copy of ours at.
   * The base is decided by that history, which can move while both blobs stay
   * the same, so a verdict is reused only at this same head.
   */
  head: string;
  verdict:
    | { act: "hold"; why: string; transient?: true }
    | { act: "current"; base: string }
    | { act: "write"; base: string; fromPrime: number; fromClone: number; blob: string };
};

export type CascadeProgress = {
  version: 1;
  /** The prime commit this pass was delivering. */
  source_sha: string;
  /** Path → what was prepared. */
  prepared: Record<string, PreparedBlob>;
  /** Path → what prime's history said about deleting it. Absent on old records. */
  deletion_evidence?: Record<string, DeletionEvidenceEntry>;
  /**
   * Path → what prime's history said about a held path's divergence. Absent
   * on old records. Measured 16 Sep 2026: without this, every pass re-walked
   * the same held paths — ~90 calls and ~30 seconds of fixed cost that
   * pushed every working tick past the 60-second isolate window.
   */
  held_evidence?: Record<string, HeldEvidenceEntry>;
  /**
   * Path → the variant merge verdict for a held line variant. Absent on old
   * records. See "A variant merge is decided once" in the module header.
   */
  variant_evidence?: Record<string, VariantEvidenceEntry>;
  /** Files the pass had to prepare in total, for the sentence. */
  total: number;
};

/** How many freshly prepared blobs between writes of the list. */
export const PROGRESS_FLUSH_EVERY = 25;

const SHA = /^[0-9a-f]{40}$/;

/**
 * Read a stored record, or nothing.
 *
 * Nothing rather than a guess on any doubt: a malformed entry, a SHA that is
 * not one. A wrong reuse delivers the wrong bytes to a clone; a missed reuse
 * costs one read.
 *
 * A record for ANOTHER prime commit is read, not refused: what makes an
 * entry reusable is that prime's current tree still holds the blob it was
 * made from, and `resumableBlobs` checks exactly that, entry by entry,
 * against the current pass's own listing. The record's `source_sha` is
 * provenance, never a gate — see the module header for what the gate cost.
 */
export function readProgress(raw: unknown): CascadeProgress | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<CascadeProgress>;
  if (r.version !== 1) return null;
  if (typeof r.source_sha !== "string" || !SHA.test(r.source_sha)) return null;
  if (!r.prepared || typeof r.prepared !== "object" || Array.isArray(r.prepared)) return null;
  const prepared: Record<string, PreparedBlob> = {};
  for (const [path, entry] of Object.entries(r.prepared as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") return null;
    const { blob, prime } = entry as Partial<PreparedBlob>;
    if (typeof blob !== "string" || typeof prime !== "string") return null;
    if (!SHA.test(blob) || !SHA.test(prime)) return null;
    prepared[path] = { blob, prime };
  }
  const total = typeof r.total === "number" && Number.isFinite(r.total) ? r.total : 0;
  const deletion_evidence: Record<string, DeletionEvidenceEntry> = {};
  const rawEvidence = (r as { deletion_evidence?: unknown }).deletion_evidence;
  if (rawEvidence && typeof rawEvidence === "object" && !Array.isArray(rawEvidence)) {
    for (const [path, entry] of Object.entries(rawEvidence as Record<string, unknown>)) {
      const parsed = readEvidenceEntry(entry);
      if (parsed) deletion_evidence[path] = parsed;
    }
  }
  const held_evidence: Record<string, HeldEvidenceEntry> = {};
  const rawHeld = (r as { held_evidence?: unknown }).held_evidence;
  if (rawHeld && typeof rawHeld === "object" && !Array.isArray(rawHeld)) {
    for (const [path, entry] of Object.entries(rawHeld as Record<string, unknown>)) {
      const parsed = readHeldEntry(entry);
      if (parsed) held_evidence[path] = parsed;
    }
  }
  const variant_evidence: Record<string, VariantEvidenceEntry> = {};
  const rawVariant = (r as { variant_evidence?: unknown }).variant_evidence;
  if (rawVariant && typeof rawVariant === "object" && !Array.isArray(rawVariant)) {
    for (const [path, entry] of Object.entries(rawVariant as Record<string, unknown>)) {
      const parsed = readVariantEntry(entry);
      if (parsed) variant_evidence[path] = parsed;
    }
  }
  return {
    version: 1,
    source_sha: r.source_sha,
    prepared,
    deletion_evidence,
    held_evidence,
    variant_evidence,
    total,
  };
}

/**
 * One variant verdict, or nothing — dropped alone, by the evidence rule: the
 * cost of dropping is one re-merge, and the cost of keeping garbage is
 * delivering bytes nobody merged.
 */
function readVariantEntry(raw: unknown): VariantEvidenceEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const { clone, prime, head, verdict } = raw as {
    clone?: unknown;
    prime?: unknown;
    head?: unknown;
    verdict?: unknown;
  };
  if (typeof clone !== "string" || !SHA.test(clone)) return null;
  if (typeof prime !== "string" || !SHA.test(prime)) return null;
  // A verdict recorded before the head was kept names no history, so it is
  // dropped and merged again rather than reused at a base nobody checked.
  if (typeof head !== "string" || !SHA.test(head)) return null;
  if (!verdict || typeof verdict !== "object") return null;
  const v = verdict as Record<string, unknown>;
  if (v.act === "hold") {
    if (typeof v.why !== "string") return null;
    return v.transient === true
      ? { clone, prime, head, verdict: { act: "hold", why: v.why, transient: true } }
      : { clone, prime, head, verdict: { act: "hold", why: v.why } };
  }
  if (v.act === "current") {
    if (typeof v.base !== "string" || !SHA.test(v.base)) return null;
    return { clone, prime, head, verdict: { act: "current", base: v.base } };
  }
  if (v.act === "write") {
    if (typeof v.base !== "string" || !SHA.test(v.base)) return null;
    if (typeof v.blob !== "string" || !SHA.test(v.blob)) return null;
    const count = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 0;
    if (!count(v.fromPrime) || !count(v.fromClone)) return null;
    return {
      clone,
      prime,
      head,
      verdict: {
        act: "write",
        base: v.base,
        blob: v.blob,
        fromPrime: v.fromPrime as number,
        fromClone: v.fromClone as number,
      },
    };
  }
  return null;
}

/**
 * The variant verdicts a new pass may reuse as ANSWERS: settled ones (never a
 * transient hold) whose clone blob AND prime blob are still the ones the
 * merge read, at the clone head commit it read them at. Without either
 * listing or the head nothing is reused, because nothing can be checked.
 */
export function resumableVariantEvidence(
  progress: CascadeProgress | null,
  cloneShaByPath: ReadonlyMap<string, string> | null,
  primeShaByPath: ReadonlyMap<string, string> | null,
  cloneHead: string | null,
): Map<string, VariantEvidenceEntry> {
  const out = new Map<string, VariantEvidenceEntry>();
  if (!progress?.variant_evidence || !cloneShaByPath || !primeShaByPath || !cloneHead) return out;
  for (const [path, entry] of Object.entries(progress.variant_evidence)) {
    if (entry.verdict.act === "hold" && entry.verdict.transient) continue;
    if (!sameVariantInputs(entry, path, cloneShaByPath, primeShaByPath, cloneHead)) continue;
    out.set(path, entry);
  }
  return out;
}

/** Whether a kept verdict was decided from exactly what this pass would read. */
function sameVariantInputs(
  entry: VariantEvidenceEntry,
  path: string,
  cloneShaByPath: ReadonlyMap<string, string>,
  primeShaByPath: ReadonlyMap<string, string>,
  cloneHead: string,
): boolean {
  return (
    entry.head === cloneHead &&
    cloneShaByPath.get(path) === entry.clone &&
    primeShaByPath.get(path) === entry.prime
  );
}

/**
 * The paths a previous pass ASKED and got only a transient answer for — at
 * the same two blobs. They are asked again, but last: a path that keeps
 * failing must not hold the never-asked behind it, and must not hold the pass
 * itself. Keyed like the answers, so a path whose blobs or clone head moved
 * is never-asked again rather than last.
 */
export function variantRetryPaths(
  progress: CascadeProgress | null,
  cloneShaByPath: ReadonlyMap<string, string> | null,
  primeShaByPath: ReadonlyMap<string, string> | null,
  cloneHead: string | null,
): Map<string, VariantEvidenceEntry> {
  const out = new Map<string, VariantEvidenceEntry>();
  if (!progress?.variant_evidence || !cloneShaByPath || !primeShaByPath || !cloneHead) return out;
  for (const [path, entry] of Object.entries(progress.variant_evidence)) {
    if (!(entry.verdict.act === "hold" && entry.verdict.transient)) continue;
    if (!sameVariantInputs(entry, path, cloneShaByPath, primeShaByPath, cloneHead)) continue;
    out.set(path, entry);
  }
  return out;
}

/** The one sentence a clone's row carries while its variant merges are paused. */
export function describeVariantMergePause(input: { settled: number; total: number }): string {
  return (
    `Paused at the invocation budget — line variant merges asked for ${input.settled} of ` +
    `${input.total} held path(s); the rest resume next tick`
  );
}

/** What a variant verdict means for "did the ledger move?" — its identity, not its prose. */
function variantKey(e: VariantEvidenceEntry): string {
  const v = e.verdict;
  const what =
    v.act === "write"
      ? `write:${v.base}:${v.blob}`
      : v.act === "current"
        ? `current:${v.base}`
        : v.transient
          ? "transient"
          : "hold";
  return `${e.clone}:${e.prime}:${e.head}:${what}`;
}

/**
 * Whether a pass moved its ledger forward — an entry that is new, or that now
 * says something different, in ANY of its sections.
 *
 * This is what a paused pass is judged by. It used to be the COUNT of
 * `prepared` plus `deletion_evidence`, and a count can stand still while the
 * ledger moves: a pass whose window went to the variant merges and the held
 * probes recorded dozens of new answers and read as "no progress", spent its
 * attempt, and after three the event was retired with the work it had done
 * thrown away. A count can also move while nothing does — a spec is
 * re-prepared on every pass and never reused, so it re-enters the list
 * unchanged — which is why identity, not size, is compared.
 *
 * A transient variant hold counts only the FIRST time a path is asked at a
 * given pair of blobs: from then on the path is "asked" and the pass does
 * not pause on it, so counting a repeat would refund a pass that changed
 * nothing. Its `why` is prose and is not compared.
 */
export function ledgerGrew(prior: CascadeProgress | null, now: CascadeProgress | null): boolean {
  if (!now) return false;
  const p = prior;
  for (const [path, e] of Object.entries(now.prepared)) {
    const was = p?.prepared[path];
    if (!was || was.blob !== e.blob || was.prime !== e.prime) return true;
  }
  for (const [path, e] of Object.entries(now.deletion_evidence ?? {})) {
    const was = p?.deletion_evidence?.[path];
    if (
      !was ||
      was.clone !== e.clone ||
      JSON.stringify(was.evidence) !== JSON.stringify(e.evidence)
    ) {
      return true;
    }
  }
  for (const [path, e] of Object.entries(now.held_evidence ?? {})) {
    const was = p?.held_evidence?.[path];
    if (
      !was ||
      was.clone !== e.clone ||
      JSON.stringify(was.evidence) !== JSON.stringify(e.evidence)
    ) {
      return true;
    }
  }
  for (const [path, e] of Object.entries(now.variant_evidence ?? {})) {
    const was = p?.variant_evidence?.[path];
    if (!was || variantKey(was) !== variantKey(e)) return true;
  }
  return false;
}

/** One held-evidence entry, or nothing — dropped alone by the deletion rule. */
function readHeldEntry(raw: unknown): HeldEvidenceEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const { clone, evidence } = raw as { clone?: unknown; evidence?: unknown };
  if (typeof clone !== "string" || !SHA.test(clone)) return null;
  if (!evidence || typeof evidence !== "object") return null;
  const e = evidence as { kind?: unknown };
  if (e.kind === "never_primes") return { clone, evidence: { kind: "never_primes" } };
  if (e.kind !== "prime_versions") return null;
  const { versions, versionsExhaustive } = evidence as {
    versions?: unknown;
    versionsExhaustive?: unknown;
  };
  if (!Array.isArray(versions) || versions.some((v) => typeof v !== "string" || !SHA.test(v))) {
    return null;
  }
  if (typeof versionsExhaustive !== "boolean") return null;
  return {
    clone,
    evidence: { kind: "prime_versions", versions: versions as string[], versionsExhaustive },
  };
}

/** The hold answers a new pass may reuse — the deletion rule, word for word. */
export function resumableHeldEvidence(
  progress: CascadeProgress | null,
  cloneShaByPath: ReadonlyMap<string, string> | null,
): Map<string, SettledHeldEvidence> {
  const out = new Map<string, SettledHeldEvidence>();
  if (!progress?.held_evidence || !cloneShaByPath) return out;
  for (const [path, entry] of Object.entries(progress.held_evidence)) {
    if (cloneShaByPath.get(path) === entry.clone) out.set(path, entry.evidence);
  }
  return out;
}

/**
 * One evidence entry, or nothing. Unlike a malformed BLOB entry — which voids
 * the record, because delivering a wrong blob is delivering wrong bytes — a
 * malformed evidence entry is dropped alone: the safe direction here is a
 * re-probe, and hundreds of sound prepared blobs must not be discarded over
 * one unreadable answer. `unsettled` parses to nothing by the same rule that
 * keeps it out of the ledger on the way in.
 */
function readEvidenceEntry(raw: unknown): DeletionEvidenceEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const { clone, evidence } = raw as { clone?: unknown; evidence?: unknown };
  if (typeof clone !== "string" || !SHA.test(clone)) return null;
  if (!evidence || typeof evidence !== "object") return null;
  const e = evidence as { kind?: unknown };
  if (e.kind === "never_primes") return { clone, evidence: { kind: "never_primes" } };
  if (e.kind !== "removed") return null;
  const { deletedIn, versions, versionsExhaustive } = evidence as {
    deletedIn?: unknown;
    versions?: unknown;
    versionsExhaustive?: unknown;
  };
  if (typeof deletedIn !== "string" || !SHA.test(deletedIn)) return null;
  if (!Array.isArray(versions) || versions.some((v) => typeof v !== "string" || !SHA.test(v))) {
    return null;
  }
  if (typeof versionsExhaustive !== "boolean") return null;
  return {
    clone,
    evidence: { kind: "removed", deletedIn, versions: versions as string[], versionsExhaustive },
  };
}

/**
 * The probe answers a new pass may reuse: those asked about the blob the
 * clone STILL holds at the path. `cloneShaByPath` is the clone tree listing;
 * without it (a truncated listing) nothing is reused, the same rule
 * `resumableBlobs` runs on. A path that is no longer a deletion candidate is
 * simply never looked up, so an entry for a path prime re-added is inert.
 */
export function resumableDeletionEvidence(
  progress: CascadeProgress | null,
  cloneShaByPath: ReadonlyMap<string, string> | null,
): Map<string, SettledDeletionEvidence> {
  const out = new Map<string, SettledDeletionEvidence>();
  if (!progress?.deletion_evidence || !cloneShaByPath) return out;
  for (const [path, entry] of Object.entries(progress.deletion_evidence)) {
    if (cloneShaByPath.get(path) === entry.clone) out.set(path, entry.evidence);
  }
  return out;
}

/** The one sentence a clone's row carries while its probe phase is paused. */
export function describeProbePause(input: { settled: number; total: number }): string {
  return (
    `Paused at the invocation budget — deletion evidence settled for ${input.settled} of ` +
    `${input.total} candidate(s); the rest resume next tick`
  );
}

/**
 * The blobs a new pass may reuse: those whose prime SHA is still what prime
 * holds for the path. `primeShaByPath` is the prime tree listing; without it
 * (a truncated listing) nothing is reused, because nothing can be checked.
 */
export function resumableBlobs(
  progress: CascadeProgress | null,
  primeShaByPath: ReadonlyMap<string, string> | null,
): Map<string, string> {
  const out = new Map<string, string>();
  if (!progress || !primeShaByPath) return out;
  for (const [path, entry] of Object.entries(progress.prepared)) {
    if (primeShaByPath.get(path) === entry.prime) out.set(path, entry.blob);
  }
  return out;
}

/** The one sentence a clone's row carries while its pass is paused. */
export function describePreparePause(input: { prepared: number; total: number }): string {
  return (
    `Paused at the invocation budget — ${input.prepared} of ${input.total} file(s) prepared; ` +
    "the rest resume next tick"
  );
}
