/**
 * What a library reset records before it wipes anything, and what a reset run
 * after one that died restores.
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
 * So the reset writes its snapshot into the `module_library.reset` audit row
 * before it deletes anything, and writes `module_library.reingest_complete`
 * only once it has restored. A reset whose last predecessor has no completion
 * after it restores that predecessor's snapshot as well as its own.
 */
import type { Json } from "@/integrations/supabase/types";

/** The audit action a reset records its snapshot under, before the wipe. */
export const RESET_AUDIT_ACTION = "module_library.reset";

/** The audit action a reset records once it has restored, and only then. */
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

/** The snapshot as the audit row carries it. */
export function snapshotForAudit(snapshot: ResetSnapshot): Json {
  return {
    installs: snapshot.installs.map((i) => ({ clone_id: i.cloneId, slugs: i.slugs })),
    pins: snapshot.pins.map((p) => ({ clone_id: p.cloneId, slug: p.slug, version: p.version })),
  };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The snapshot a reset's audit row recorded, or null where it recorded none:
 * every reset before snapshots were recorded, the one of 31 Jul 2026 among
 * them. A row whose snapshot is not the shape `snapshotForAudit` writes is
 * null too, never half read.
 */
export function snapshotOfResetRow(metadata: Json | null | undefined): ResetSnapshot | null {
  if (!isObject(metadata)) return null;
  const snapshot = metadata.snapshot;
  if (!isObject(snapshot)) return null;
  const { installs, pins } = snapshot;
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
 * This reset's snapshot with an unfinished predecessor's folded in.
 *
 * Installs are the union, per clone, so a slug the predecessor recorded and
 * the wipe took is restored, and one installed since is kept. A pin is the
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
