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
 *
 * ## The version moves without a deploy; the build does not
 *
 * The paragraph above held until a secret was written. Any write to a
 * project's secrets bumps the `version` of EVERY function on it, without
 * rebuilding one (`secretWriteDiff.pure.ts` measured it first). So "the
 * version is the answer to who" stopped being true the first time a
 * reconciler set a value. Measured 27 Oct 2026, the day after the database
 * password was set on all four clones (19:30–19:31 UTC on 26 Oct):
 *
 *   - every raw-deployed bundle the ledger recorded was still running the very
 *     build that deploy made — 400 of 402 on the dashboard, Preflight and NPC
 *     Test, 372 of 373 on the CRM;
 *   - and the listed `version` was one past the ledger's (two on NPC Test,
 *     whose `ALLOWED_ORIGINS` was also set at 22:05), so the ledger proved
 *     NONE of them, and the next shared-code merge would have redeployed about
 *     1,580 bundles fleet-wide, ten hours at the measured rate.
 *
 * What a secret write cannot move is the build. The platform names the
 * running build in `entrypoint_path`:
 *
 *   file:///tmp/user_fn_<project ref>_<function id>_<N>/source/<slug>/index.ts
 *
 * where N is the deploy counter AT THE DEPLOY that built it — the version the
 * deploy call answered with. A secret write leaves it where it was. Any later
 * deploy, by anybody, builds again and moves it. So `build` is what `version`
 * was meant to be: the count of the deploy whose code is running.
 *
 * It is read only where the path carries this row's own function id, so a
 * path naming some other function proves nothing. Anything else — a compressed
 * bundle, whose path is the builder's checkout; an absent or reshaped path —
 * is `null`, and the ledger falls back to the version, which is the rule as
 * it stood. A format change costs redeploys, never a skip.
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
   * The deploy counter at the deploy that built the code now running, read
   * off `entrypoint_path`; null where the path does not carry it for THIS
   * function id. See "The version moves without a deploy" above.
   */
  readonly build: number | null;
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
    const id = typeof o.id === "string" && o.id.length > 0 ? o.id : null;
    copies.set(slug, {
      updatedMs,
      id,
      version:
        typeof o.version === "number" && Number.isInteger(o.version) && o.version >= 0
          ? o.version
          : null,
      build: readBuildOf(o.entrypoint_path, id),
      active: o.status === undefined || o.status === null || o.status === "ACTIVE",
    });
  }
  return copies;
}

/**
 * The build counter in a raw deploy's `entrypoint_path`, for this function id
 * only: `…/user_fn_<ref>_<id>_<N>/source/…`. Null for anything else.
 *
 * Matched by finding the id itself rather than by a pattern for ids, so a
 * path that names a different function — or names this one in some other
 * position — can never lend its number to this row.
 */
export function readBuildOf(entrypointPath: unknown, functionId: string | null): number | null {
  if (typeof entrypointPath !== "string" || functionId === null) return null;
  const marker = `_${functionId}_`;
  const at = entrypointPath.indexOf(marker);
  if (at < 0) return null;
  // The id must sit in the `user_fn_…` directory itself, not anywhere deeper.
  const segmentStart = entrypointPath.lastIndexOf("/", at) + 1;
  if (!entrypointPath.startsWith("user_fn_", segmentStart)) return null;
  const rest = entrypointPath.slice(at + marker.length);
  const m = /^(\d+)\/source\//.exec(rest);
  if (!m) return null;
  const build = Number(m[1]);
  return Number.isSafeInteger(build) && build >= 0 ? build : null;
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
