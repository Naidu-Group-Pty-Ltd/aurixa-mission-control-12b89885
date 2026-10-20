/**
 * The deploy ledger's reads and writes — `clone_function_deploys`.
 *
 * The rule for what a row PROVES is in `edgeBundleLedger.pure.ts`; this module
 * only moves rows, and it moves them in the direction that cannot skip a
 * deploy. A read that fails is `unavailable`, never an empty ledger presented
 * as a read one: the lane then vouches for nothing from it and charges a
 * prime merge exactly as it did before the ledger existed. That includes the
 * hours between this code shipping and its migration running, when the table
 * is not there at all.
 *
 * A write that fails is reported, never thrown. The bundles it would have
 * recorded are already on the clone; losing the row costs one redeploy the
 * next time the prime moves, and failing the pass for it would cost the run.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { LedgerEntry } from "@/server/edgeBundleLedger.pure";

/**
 * More than a clone has functions, by an order of magnitude. A row past it is
 * simply not read, which leaves its bundle owed — the safe direction.
 */
const LEDGER_READ_LIMIT = 5_000;

export type LedgerReading =
  | { readonly state: "read"; readonly entries: ReadonlyMap<string, LedgerEntry> }
  | { readonly state: "unavailable"; readonly why: string };

/** Every bundle this lane has recorded deploying to one clone. */
export async function readFunctionDeployLedger(cloneId: string): Promise<LedgerReading> {
  try {
    const { data, error } = await supabaseAdmin
      .from("clone_function_deploys")
      .select("slug, digest, function_id, function_version")
      .eq("clone_id", cloneId)
      .limit(LEDGER_READ_LIMIT);
    if (error) return { state: "unavailable", why: error.message };
    const entries = new Map<string, LedgerEntry>();
    for (const row of data ?? []) {
      // A row that cannot be read proves nothing, so its bundle stays owed;
      // one with no id or version is kept but can never match a copy.
      if (!row.slug || !row.digest) continue;
      entries.set(row.slug, {
        digest: row.digest,
        functionId: row.function_id ?? null,
        functionVersion: typeof row.function_version === "number" ? row.function_version : null,
      });
    }
    return { state: "read", entries };
  } catch (e) {
    return { state: "unavailable", why: e instanceof Error ? e.message : String(e) };
  }
}

/** One bundle a pass landed: what it sent, which deploy that made, and when. */
export type LandedBundle = {
  readonly slug: string;
  readonly digest: string;
  readonly sourceSha: string | null;
  /** The function id and version the deploy call answered with, where it did. */
  readonly functionId: string | null;
  readonly functionVersion: number | null;
  readonly deployedFromMs: number;
  readonly deployedToMs: number;
};

export type LedgerWrite =
  | { readonly ok: true; readonly recorded: number }
  | { readonly ok: false; readonly error: string };

/** Record what a pass landed, replacing whatever each bundle's row said before. */
export async function recordFunctionDeploys(
  cloneId: string,
  landed: readonly LandedBundle[],
): Promise<LedgerWrite> {
  if (landed.length === 0) return { ok: true, recorded: 0 };
  try {
    const recordedAt = new Date().toISOString();
    const { error } = await supabaseAdmin.from("clone_function_deploys").upsert(
      landed.map((b) => ({
        clone_id: cloneId,
        slug: b.slug,
        digest: b.digest,
        source_sha: b.sourceSha,
        function_id: b.functionId,
        function_version: b.functionVersion,
        deployed_from: new Date(b.deployedFromMs).toISOString(),
        deployed_to: new Date(b.deployedToMs).toISOString(),
        recorded_at: recordedAt,
      })),
      { onConflict: "clone_id,slug" },
    );
    if (error) {
      console.error("[edge-deploy] could not record the deploy ledger:", error.message);
      return { ok: false, error: error.message };
    }
    return { ok: true, recorded: landed.length };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("[edge-deploy] could not record the deploy ledger:", error);
    return { ok: false, error };
  }
}
