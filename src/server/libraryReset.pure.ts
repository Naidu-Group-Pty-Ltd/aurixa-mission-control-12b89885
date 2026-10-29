/**
 * What a library reset records before it wipes anything, what a reset run
 * after one that failed restores, and how two resets keep out of each other's
 * way.
 *
 * A reset deletes every module, and `clone_modules` goes with them (its
 * foreign key cascades), so which modules each clone had installed survives
 * the wipe only in the snapshot the reset takes first. That snapshot used to
 * live in the invocation's memory and nowhere else. An invocation that died
 * between the wipe and the restore took it with it, and the next reset
 * snapshotted the empty table it had left, restored nothing, and reported
 * success. The detection a reset runs reads thousands of files inside a Worker
 * isolate of 128 MB, so dying there is not hypothetical (`docs/CASCADE_LARGE_FILES.md`).
 *
 * So a reset keeps its record in the audit log, in two rows:
 *
 * - `module_library.reset`, written before anything is deleted, holds the
 *   snapshot of what to restore;
 * - `module_library.reingest_complete`, written on every way out after that,
 *   names the reset it completes and holds what it could not restore
 *   (`unrestored`): everything, when detection failed after the wipe, and
 *   nothing, when every install and pin was written back.
 *
 * A reset row with no completion is a reset still running, or one that died.
 * Inside the window it is taken to be running, and no other reset or
 * detection starts. Past it, it died, and the next reset restores its
 * snapshot. A completion's `unrestored` is owed the same way, with no wait,
 * because a completion is written by a reset that has stopped.
 *
 * What a reset owes stays with its own record until a reset that goes on
 * takes it on, by naming it in `restores_owed_by`, and from then on that
 * reset's record carries it. So the next reset restores what every earlier
 * one still owes, not only the newest: of two that started together, the one
 * that stepped aside may well have written the newer record.
 *
 * No database lock spans an invocation, so exclusivity is the audit log's
 * too. Each reset records its row and then looks again: if another reset is
 * running beside it, it stops before the wipe. Each looks only after its own
 * row is written, so whichever looks second sees the other, and two can never
 * both go on. Both may stop, and then neither has wiped anything. A reset
 * that stops there completes with `wiped: false`: it owes nothing, and takes
 * on nothing either, so what an earlier reset owes stays with that reset.
 */
import type { Json } from "@/integrations/supabase/types";

/** The audit action a reset records its snapshot under, before the wipe. */
export const RESET_AUDIT_ACTION = "module_library.reset";

/** The audit action that completes a reset, on every way out after its record. */
export const RESET_COMPLETE_AUDIT_ACTION = "module_library.reingest_complete";

export type CloneInstallSnapshot = {
  cloneId: string;
  slugs: string[];
};

export type PinSnapshot = {
  cloneId: string;
  slug: string;
  version: number;
};

/** Every clone's installs and pins, by slug: what survives a re-ingest. */
export type ResetSnapshot = {
  installs: CloneInstallSnapshot[];
  pins: PinSnapshot[];
};

export const EMPTY_SNAPSHOT: ResetSnapshot = { installs: [], pins: [] };

/** The snapshot as an audit row carries it. */
export function snapshotForAudit(snapshot: ResetSnapshot): Json {
  return {
    installs: snapshot.installs.map((i) => ({ clone_id: i.cloneId, slugs: i.slugs })),
    pins: snapshot.pins.map((p) => ({ clone_id: p.cloneId, slug: p.slug, version: p.version })),
  };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A snapshot as `snapshotForAudit` writes it, or null for anything else, never
 * half read.
 */
function readSnapshot(value: unknown): ResetSnapshot | null {
  if (!isObject(value)) return null;
  const { installs, pins } = value;
  if (!Array.isArray(installs) || !Array.isArray(pins)) return null;

  const outInstalls: CloneInstallSnapshot[] = [];
  for (const i of installs) {
    if (!isObject(i) || typeof i.clone_id !== "string" || !Array.isArray(i.slugs)) return null;
    if (!i.slugs.every((s) => typeof s === "string")) return null;
    outInstalls.push({ cloneId: i.clone_id, slugs: i.slugs as string[] });
  }
  const outPins: PinSnapshot[] = [];
  for (const p of pins) {
    if (!isObject(p) || typeof p.clone_id !== "string" || typeof p.slug !== "string") return null;
    if (typeof p.version !== "number" || !Number.isInteger(p.version)) return null;
    outPins.push({ cloneId: p.clone_id, slug: p.slug, version: p.version });
  }
  return { installs: outInstalls, pins: outPins };
}

/**
 * The snapshot a reset's audit row recorded, or null where it recorded none:
 * every reset before snapshots were recorded, the one of 31 Jul 2026 among
 * them.
 */
export function snapshotOfResetRow(metadata: Json | null | undefined): ResetSnapshot | null {
  return isObject(metadata) ? readSnapshot(metadata.snapshot) : null;
}

/**
 * This reset's snapshot with what earlier resets still owe folded in.
 *
 * Installs are the union, per clone, so a slug a predecessor recorded and its
 * wipe took is restored, and one installed since is kept. A pin is the
 * current one where the clone pins that slug now, and the predecessor's where
 * only it does.
 */
export function mergeResetSnapshots(current: ResetSnapshot, earlier: ResetSnapshot): ResetSnapshot {
  const slugsByClone = new Map<string, Set<string>>();
  for (const i of [...earlier.installs, ...current.installs]) {
    const set = slugsByClone.get(i.cloneId) ?? new Set<string>();
    for (const s of i.slugs) set.add(s);
    slugsByClone.set(i.cloneId, set);
  }
  const pinByKey = new Map<string, PinSnapshot>();
  for (const p of earlier.pins) pinByKey.set(`${p.cloneId}\u0000${p.slug}`, p);
  for (const p of current.pins) pinByKey.set(`${p.cloneId}\u0000${p.slug}`, p);
  return {
    installs: [...slugsByClone.entries()]
      .map(([cloneId, slugs]) => ({ cloneId, slugs: [...slugs].sort() }))
      .sort((a, b) => a.cloneId.localeCompare(b.cloneId)),
    pins: [...pinByKey.values()],
  };
}

/** How many installs a snapshot holds, across every clone. */
export function installCount(snapshot: ResetSnapshot): number {
  return snapshot.installs.reduce((n, i) => n + i.slugs.length, 0);
}

/** Whether a snapshot holds nothing to restore. */
export function isEmptySnapshot(snapshot: ResetSnapshot): boolean {
  return installCount(snapshot) === 0 && snapshot.pins.length === 0;
}

// ─── The audit log as the record of every reset ─────────────────────────────

/** An audit row as the state is judged from it. */
export type AuditRow = { id: string; created_at: string; metadata: Json | null };

/** The metadata of the completion that closes the reset `resetId`. */
export function completionMetadata(
  resetId: string,
  outcome: {
    /** What this reset could not restore, and the next one owes. */
    unrestored: ResetSnapshot;
    /** Why it stopped short, when it did. */
    stoppedBecause?: string;
    /**
     * It stopped before the wipe: it deleted nothing, so it owes nothing, and
     * what it had taken on stays with the resets that owe it.
     */
    beforeWipe?: boolean;
    extra?: Record<string, Json>;
  },
): Json {
  return {
    ...(outcome.extra ?? {}),
    reset_audit_id: resetId,
    unrestored: snapshotForAudit(outcome.unrestored),
    ...(outcome.stoppedBecause ? { stopped_because: outcome.stoppedBecause } : {}),
    ...(outcome.beforeWipe ? { wiped: false } : {}),
  };
}

/**
 * The earlier resets whose debt a reset's row says it took on
 * (`restores_owed_by`), folded into the snapshot it recorded.
 */
function owedByOfResetRow(metadata: Json | null | undefined): string[] {
  if (!isObject(metadata) || !Array.isArray(metadata.restores_owed_by)) return [];
  return metadata.restores_owed_by.filter((id): id is string => typeof id === "string");
}

/** Whether a completion says its reset stopped before the wipe. */
function stoppedBeforeWipe(completion: AuditRow): boolean {
  return isObject(completion.metadata) && completion.metadata.wiped === false;
}

/**
 * The reset a completion closes. A completion names it; one written before
 * completions named their reset (31 Jul 2026's) closes every reset recorded
 * before it.
 */
function closes(completion: AuditRow, reset: AuditRow): boolean {
  const named = isObject(completion.metadata) ? completion.metadata.reset_audit_id : undefined;
  if (typeof named === "string") return named === reset.id;
  return completion.created_at > reset.created_at;
}

/** What one earlier reset left on no clone, by its own record. */
export type OwedRestore = {
  /** The reset that owes it. */
  resetId: string;
  /** When that reset recorded itself. */
  from: string;
  /** It died after its record, or its completion says it could not restore everything. */
  because: "died" | "unrestored";
  snapshot: ResetSnapshot;
};

export type ResetState = {
  /** Resets recorded inside the window that nothing has completed: taken to be running. */
  running: AuditRow[];
  /**
   * What earlier resets left on no clone and no reset has taken on since,
   * oldest first: each one's snapshot when it died, or what its completion
   * says it could not restore. Empty when nothing is owed.
   */
  owed: OwedRestore[];
};

/**
 * Which resets are running and what is still owed, from the reset rows and
 * the completions the audit log holds.
 *
 * A reset that goes on takes on what is owed when it starts: it folds it into
 * the snapshot it records and names the resets it came from in
 * `restores_owed_by`, so its own record carries the debt from then on. One
 * that stopped before its wipe takes on nothing and owes nothing. Every other
 * debt is still owed, whichever reset recorded itself last. `excludeId`
 * leaves out the caller's own reset, for the look it takes after recording it.
 */
export function judgeResetState(args: {
  resets: readonly AuditRow[];
  completions: readonly AuditRow[];
  now: number;
  windowMs: number;
  excludeId?: string;
}): ResetState {
  const { completions, now, windowMs, excludeId } = args;
  const resets = args.resets.filter((r) => r.id !== excludeId);
  const completionOf = (r: AuditRow) => completions.find((c) => closes(c, r)) ?? null;

  const running = resets.filter(
    (r) => completionOf(r) === null && now - Date.parse(r.created_at) < windowMs,
  );

  const takenOn = new Set<string>();
  const debts: OwedRestore[] = [];
  for (const reset of resets) {
    const completion = completionOf(reset);
    if (completion !== null && stoppedBeforeWipe(completion)) continue;
    const owedBy = owedByOfResetRow(reset.metadata);
    // A running reset may yet restore what it recorded: it owes nothing so far.
    if (running.includes(reset)) {
      for (const id of owedBy) takenOn.add(id);
      continue;
    }
    const own =
      completion === null
        ? snapshotOfResetRow(reset.metadata)
        : isObject(completion.metadata)
          ? readSnapshot(completion.metadata.unrestored)
          : null;
    // A record that cannot be read carries nothing on, so what it took on
    // stays with the resets that owe it. Every reset before snapshots, and
    // 31 Jul 2026's completion, read this way and owe nothing.
    if (own === null) continue;
    for (const id of owedBy) takenOn.add(id);
    if (!isEmptySnapshot(own)) {
      debts.push({
        resetId: reset.id,
        from: reset.created_at,
        because: completion === null ? "died" : "unrestored",
        snapshot: own,
      });
    }
  }
  const owed = debts
    .filter((d) => !takenOn.has(d.resetId))
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  return { running, owed };
}

/**
 * This reset's snapshot with every owed one folded in, the oldest first, so
 * where two pin the same slug the later record's pin is the one kept, and the
 * clones' own pins over both.
 */
export function withOwed(current: ResetSnapshot, owed: readonly OwedRestore[]): ResetSnapshot {
  const earlier = owed.reduce<ResetSnapshot>(
    (acc, debt) => mergeResetSnapshots(debt.snapshot, acc),
    EMPTY_SNAPSHOT,
  );
  return owed.length > 0 ? mergeResetSnapshots(current, earlier) : current;
}
