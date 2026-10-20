/**
 * What a clone's project says it holds, function by function.
 *
 * One reading of `GET /v1/projects/{ref}/functions` serves the deploy lane
 * twice, and both uses have to come from the SAME reading or they can
 * disagree about the clone:
 *
 *   - WHEN each copy was last written (`updatedMs`) — the clone's own
 *     staleness, which orders a pass (`stalestFirst`) and says what landed
 *     since a generation began (`refreshedSince`);
 *   - WHICH DEPLOY wrote it (`id` and `version`) — the function's own id and
 *     the project's deploy counter for it, which is what lets the deploy
 *     ledger prove a copy is the one this lane sent (`edgeBundleLedger.pure.ts`).
 *
 * A timestamp says a copy landed, never who landed it: the clone's own CI and
 * a Lovable publish refresh it exactly as this lane does. The version is the
 * answer to "who": every deploy of a function increments it, so a copy whose
 * id and version are the ones this lane's deploy was answered with has had
 * nothing written over it since. Measured on npc-client-dashboard 20 Oct 2026,
 * all 427 functions report both, as integers and uuids, every one ACTIVE.
 *
 * Every doubt is left ABSENT, and absent costs a redeploy rather than a skip:
 * an unreadable timestamp is no entry at all, and an unreadable id or version
 * is `null`, which the ledger can never match.
 */

/** One function as the clone's project reports it. */
export type ProjectFunctionCopy = {
  /** When the copy was last written, in epoch milliseconds. */
  readonly updatedMs: number;
  /** The function's own id, or null where the project did not report one. */
  readonly id: string | null;
  /** The project's deploy counter for the function, or null where unreported. */
  readonly version: number | null;
  /**
   * False where the project reports any status but ACTIVE. Absent status is
   * read as active, since the timestamp has always been read that way.
   */
  readonly active: boolean;
};

/**
 * Read the Management API's function list. Anything that is not a list is no
 * functions at all, and a row with no slug or no readable timestamp is left
 * out — the same rules the freshness reader always applied.
 */
export function readProjectFunctionCopies(raw: unknown): Map<string, ProjectFunctionCopy> {
  const copies = new Map<string, ProjectFunctionCopy>();
  if (!Array.isArray(raw)) return copies;
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const slug =
      typeof o.slug === "string" ? o.slug : typeof o.name === "string" ? (o.name as string) : "";
    if (!slug) continue;
    // The Management API reports epoch milliseconds. A seconds value or an
    // ISO string is accepted rather than assumed away, and anything
    // unreadable is left ABSENT — absent means "not known to be fresh",
    // which redeploys, so a format change costs work rather than coverage.
    const stamp = o.updated_at ?? o.created_at;
    const updatedMs =
      typeof stamp === "number"
        ? stamp < 1e12
          ? stamp * 1000
          : stamp
        : typeof stamp === "string"
          ? Date.parse(stamp)
          : Number.NaN;
    if (!Number.isFinite(updatedMs)) continue;
    copies.set(slug, {
      updatedMs,
      id: typeof o.id === "string" && o.id.length > 0 ? o.id : null,
      version:
        typeof o.version === "number" && Number.isInteger(o.version) && o.version >= 0
          ? o.version
          : null,
      active: o.status === undefined || o.status === null || o.status === "ACTIVE",
    });
  }
  return copies;
}

/** The clone's own staleness, for `refreshedSince` and `stalestFirst`. */
export function freshnessOf(copies: ReadonlyMap<string, ProjectFunctionCopy>): Map<string, number> {
  const fresh = new Map<string, number>();
  for (const [slug, copy] of copies) fresh.set(slug, copy.updatedMs);
  return fresh;
}

/**
 * Which deploy a successful deploy call created, read off the call's own
 * answer (`DeployFunctionResponse`: `id`, `version`). Null where the answer
 * carries neither — a ledger row without them proves nothing, which is the
 * safe direction.
 */
export function readDeployedCopy(raw: unknown): { id: string; version: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" && o.id.length > 0 ? o.id : null;
  const version =
    typeof o.version === "number" && Number.isInteger(o.version) && o.version >= 0
      ? o.version
      : null;
  return id !== null && version !== null ? { id, version } : null;
}
