/**
 * Give a clone the one secret only its own backend can supply: `JWT_SECRET`.
 *
 * ## What this fixes
 *
 * A clone's custom auth mints Supabase access tokens itself, and the clone's
 * own project validates them. The signing key for that is the project's
 * `jwt_secret`, which is why `JWT_SECRET` is `tenant_scoped`: never inherited
 * from the prime (that would let the clone mint tokens the PRIME's database
 * accepts) and never generated (PostgREST validates against the project's own
 * key, so a fresh random value produces tokens rejected by the very database
 * they are for).
 *
 * Never INHERITED is not never WRITTEN. `planCloneSecrets` now writes the
 * project's own key at provisioning time — but only for clones provisioned
 * after that existed. Every clone already in the fleet has `JWT_SECRET`
 * missing, and the remedy on the operator's secret list is a person opening
 * the clone's Supabase settings and pasting a signing key into a box. Mission
 * Control can read that value itself, from the clone's own PostgREST config,
 * so asking a person to fetch it is asking them to do a job that has an API.
 *
 * ## The rule that governs the write
 *
 * **The ref that reads is the ref that writes.** `getProjectJwtSecret` returns
 * one project's signing key and `setCloneSecretValue` writes an environment
 * variable onto one project; if those two refs could ever differ, this hands
 * one tenant another tenant's signing key — the exact defect `tenant_scoped`
 * exists to prevent, arrived at from the other direction. So there is one
 * `projectRef` const in `repairCloneJwtSecret` and both calls take it, and it
 * comes from `resolveCloneSecretTarget`, which refuses the prime's project,
 * refuses Mission Control's own, and refuses when it cannot tell.
 *
 * The value is never logged, never returned, and never put in an event row.
 * It is a signing key: possession is authority, and a prefix is still a leak
 * of key material into a table more people can read than can read the project.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  resolveCloneSecretTarget,
  CloneSecretTargetError,
  type CloneSecretTarget,
} from "./cloneAllowedOrigins.server";
import type { CloneSecretRefusal } from "./cloneSecretTarget.pure";
import { decideJwtSecretRepair, type JwtRepairFacts, type JwtRepairSkip } from "./cloneSecretRepair.pure";

type Db = SupabaseClient<Database>;

/**
 * The settable spelling. `SUPABASE_JWT_SECRET` cannot be written at all — the
 * `SUPABASE_` prefix is reserved by the secrets API — which is why the ledger
 * row under that name could only ever read `missing`.
 */
export const JWT_SECRET_NAME = "JWT_SECRET";

export type JwtRepairFailure =
  | CloneSecretRefusal
  | "not_readable"
  | "write_failed";

export type JwtRepairResult =
  | { ok: true; cloneId: string; projectRef: string; changed: true }
  | { ok: true; cloneId: string; changed: false; skipped: JwtRepairSkip }
  | { ok: false; cloneId: string; reason: JwtRepairFailure; error: string };

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Read the ledger row for `JWT_SECRET`, if there is one.
 *
 * A read that FAILED is not a row that is ABSENT: absent means "never
 * recorded", which this treats as repairable, and a database fault dressed as
 * absent would send the sweep to the Management API for every clone on every
 * pass. So it throws, and the caller reports the clone as unreadable.
 */
async function readLedger(
  supabase: Db,
  cloneId: string,
): Promise<Pick<JwtRepairFacts, "ledgerStatus" | "lastError" | "updatedAt">> {
  const { data, error } = await supabase
    .from("clone_backend_secrets")
    .select("status, last_error, updated_at")
    .eq("clone_id", cloneId)
    .eq("name", JWT_SECRET_NAME)
    .maybeSingle();
  if (error) throw new Error(`Could not read the ${JWT_SECRET_NAME} ledger row: ${error.message}`);
  const row = data as { status?: string | null; last_error?: string | null; updated_at?: string | null } | null;
  if (!row) return { ledgerStatus: null, lastError: null, updatedAt: null };
  const status = row.status ?? null;
  return {
    // The column is CHECK-constrained to exactly these four; anything else is
    // a schema that moved under us, and `null` (repairable) is the safe read.
    ledgerStatus:
      status === "missing" || status === "set" || status === "failed" || status === "inherited"
        ? status
        : null,
    lastError: row.last_error ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

/**
 * Fetch one clone's own signing key and write it onto that same project.
 *
 * Never throws for an expected refusal — the callers are a cron sweep and an
 * operator action, and one clone's misconfiguration must not stop the others.
 *
 * `force` skips the decision entirely. Re-writing this secret is idempotent by
 * construction (the value can only ever be the project's own key, read moments
 * before), so an operator repairing something they cannot see is never told
 * "nothing to do".
 */
export async function repairCloneJwtSecret(
  supabase: Db,
  cloneId: string,
  opts?: { actorUserId?: string | null; force?: boolean; now?: number },
): Promise<JwtRepairResult> {
  let target: CloneSecretTarget;
  try {
    target = await resolveCloneSecretTarget(supabase, cloneId);
  } catch (e) {
    const reason = e instanceof CloneSecretTargetError ? e.reason : "unreadable";
    return { ok: false, cloneId, reason, error: msg(e) };
  }

  // One ref. Read and write both take it — see the header.
  const projectRef = target.projectRef;

  if (!opts?.force) {
    let ledger: Pick<JwtRepairFacts, "ledgerStatus" | "lastError" | "updatedAt">;
    try {
      ledger = await readLedger(supabase, cloneId);
    } catch (e) {
      return { ok: false, cloneId, reason: "unreadable", error: msg(e) };
    }
    const verdict = decideJwtSecretRepair({ projectRef, ...ledger, now: opts?.now ?? Date.now() });
    if (!verdict.act) return { ok: true, cloneId, changed: false, skipped: verdict.reason };
  }

  const { getProjectJwtSecret, setCloneSecretValue } = await import("./backend-provisioning.server");

  let secret: string | null;
  try {
    secret = await getProjectJwtSecret(projectRef);
  } catch (e) {
    secret = null;
    await recordFailure(supabase, cloneId, `Could not read the project's signing key: ${msg(e)}`, opts?.actorUserId);
    return { ok: false, cloneId, reason: "not_readable", error: msg(e) };
  }
  if (!secret) {
    // A refusal from the Management API, or a config response with no key in
    // it. Recorded as `failed` rather than left as `missing`, so the ledger
    // says an attempt was made and the cooling-off window starts.
    const error =
      `The Management API did not return a signing key for project ${projectRef}. ` +
      `Set ${JWT_SECRET_NAME} from the clone's Secrets page (Settings → API → JWT Settings on that project).`;
    await recordFailure(supabase, cloneId, error, opts?.actorUserId);
    return { ok: false, cloneId, reason: "not_readable", error };
  }

  const res = await setCloneSecretValue(projectRef, JWT_SECRET_NAME, secret);
  const now = new Date().toISOString();

  // Checked deliberately. If this upsert fails the secret is set on the clone's
  // project while the operator's secret list still reads `missing`, and the
  // sweep re-writes it every pass forever with nothing anywhere saying why.
  const { error: trackErr } = await supabase.from("clone_backend_secrets").upsert(
    {
      clone_id: cloneId,
      name: JWT_SECRET_NAME,
      status: res.ok ? "set" : "failed",
      last_set_at: res.ok ? now : null,
      last_error: res.ok ? null : res.error,
      set_by: opts?.actorUserId ?? null,
    },
    { onConflict: "clone_id,name" },
  );
  if (trackErr) {
    console.error("[jwt_secret] secret written but tracking row not updated", {
      cloneId,
      projectRef,
      error: trackErr.message,
    });
  }

  await recordEvent(supabase, cloneId, res.ok, res.ok ? null : res.error, opts?.actorUserId);

  return res.ok
    ? { ok: true, cloneId, projectRef, changed: true }
    : { ok: false, cloneId, reason: "write_failed", error: res.error };
}

/** Stamp the ledger for an attempt that never reached the write. */
async function recordFailure(
  supabase: Db,
  cloneId: string,
  error: string,
  actorUserId?: string | null,
): Promise<void> {
  const { error: trackErr } = await supabase.from("clone_backend_secrets").upsert(
    {
      clone_id: cloneId,
      name: JWT_SECRET_NAME,
      status: "failed",
      last_set_at: null,
      last_error: error,
      set_by: actorUserId ?? null,
    },
    { onConflict: "clone_id,name" },
  );
  if (trackErr) {
    console.error("[jwt_secret] could not record the failed attempt", { cloneId, error: trackErr.message });
  }
  await recordEvent(supabase, cloneId, false, error, actorUserId);
}

async function recordEvent(
  supabase: Db,
  cloneId: string,
  success: boolean,
  errorMessage: string | null,
  actorUserId?: string | null,
): Promise<void> {
  // `result` carries no value and never will: this is a signing key, and an
  // event row is read by more people than can read the project it came from.
  const { error } = await supabase.from("deployment_events").insert({
    clone_id: cloneId,
    provider_slug: "supabase",
    action: "set_jwt_secret",
    success,
    error_message: errorMessage,
    actor_user_id: actorUserId ?? null,
    result: { secret_name: JWT_SECRET_NAME, source: "project_postgrest_config" },
  });
  if (error) {
    // The write already happened or already failed; losing the timeline row
    // must not change what is reported, and must not be silent either.
    console.error("[jwt_secret] could not record deployment_event", { cloneId, error: error.message });
  }
}

export type JwtReconcileResult = {
  considered: number;
  repaired: number;
  skipped: Record<string, number>;
  refused: { cloneId: string; reason: JwtRepairFailure }[];
};

/**
 * Carry every clone that is missing its own signing key forward.
 *
 * Candidacy is a backend with a project ref; the decision is
 * `decideJwtSecretRepair`, and the ref that is actually written still comes
 * from `resolveCloneSecretTarget` inside the repair. The ref read here is a
 * filter and never a target.
 */
export async function reconcileCloneJwtSecrets(
  supabase: Db,
  opts: { now?: number } = {},
): Promise<JwtReconcileResult> {
  const { data, error } = await supabase
    .from("clone_backends")
    .select("clone_id")
    .not("supabase_project_ref", "is", null);
  // A candidate list that could not be READ is not an empty one. Reporting
  // "0 clones, nothing to do" would make a database fault look like a fleet
  // that is already correct — on the job whose whole purpose is noticing that
  // it is not.
  if (error) throw new Error(`Could not list clone backends: ${error.message}`);

  const cloneIds = (data ?? [])
    .map((r) => (r as { clone_id: string | null }).clone_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  const out: JwtReconcileResult = {
    considered: cloneIds.length,
    repaired: 0,
    skipped: {},
    refused: [],
  };

  for (const cloneId of cloneIds) {
    try {
      const res = await repairCloneJwtSecret(supabase, cloneId, { now: opts.now });
      if (!res.ok) {
        out.refused.push({ cloneId: res.cloneId, reason: res.reason });
      } else if (res.changed) {
        out.repaired += 1;
      } else {
        out.skipped[res.skipped] = (out.skipped[res.skipped] ?? 0) + 1;
      }
    } catch (e) {
      // One stuck clone must not stop the sweep for the rest.
      console.error("[jwt_secret] reconcile threw for a clone", { cloneId, error: msg(e) });
      out.refused.push({ cloneId, reason: "unreadable" });
    }
  }

  return out;
}
