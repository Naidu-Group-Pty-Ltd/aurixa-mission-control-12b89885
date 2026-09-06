/**
 * Set `ALLOWED_ORIGINS` on a clone's own Supabase project, and on nothing else.
 *
 * ## What this fixes
 *
 * `ALLOWED_ORIGINS` is classified `deployment_config`, so provisioning never
 * copies the prime's value onto a clone — correct, and only half the job. The
 * class was implemented as SKIP rather than DERIVE, on a comment claiming
 * `applyAuthConfig` covered it. It does not: that patches GoTrue's
 * `/config/auth`, while `ALLOWED_ORIGINS` is an EDGE FUNCTION environment
 * variable read by `Deno.env.get('ALLOWED_ORIGINS')` in the prime's
 * `_shared/auth.ts`.
 *
 * Unset does not mean "no origins". The prime's CORS helper falls back to a
 * hard-coded pair of the PRIME's production hostnames, so every clone answered
 * every request with somebody else's origin and `allow-credentials: true`.
 * Measured on the live clone before this existed:
 *
 *     Origin: https://npc.aurixasystems.com.au
 *       → access-control-allow-origin: https://command-centre.npcservices.com.au
 *
 * The browser refuses to hand that response to the script, so sign-in fails
 * with correct credentials, a healthy account and no server-side error.
 *
 * `planCloneSecrets` now derives the value at provisioning time. This module is
 * the other two moments: a deployment reaching `live` (its origins are only
 * knowable then) and an operator back-filling a clone that is already running.
 *
 * ## The rule that governs every one of them
 *
 * The project ref is never an argument. `resolveCloneSecretTarget` is the only
 * way to obtain one, and it refuses the prime, refuses Mission Control's own
 * project, and refuses when it cannot tell. See `cloneSecretTarget.pure.ts`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { cloneAllowedOrigins, type CloneOrigins } from "./backend-provisioning.server";
import { ownProjectRef } from "./prime-backend.server";
import {
  decideCloneSecretTarget,
  type CloneSecretRefusal,
} from "./cloneSecretTarget.pure";

type Db = SupabaseClient<Database>;

export const ALLOWED_ORIGINS_SECRET = "ALLOWED_ORIGINS";

export type CloneSecretTarget = { cloneId: string; cloneName: string; projectRef: string };

export class CloneSecretTargetError extends Error {
  readonly reason: CloneSecretRefusal;
  constructor(reason: CloneSecretRefusal, message: string) {
    super(message);
    this.reason = reason;
    this.name = "CloneSecretTargetError";
  }
}

/**
 * The ONE way to obtain a project ref for a clone-scoped secret write.
 *
 * Deliberately returns the ref rather than validating one, so no caller can
 * hold a ref this did not produce. Throws on every refusal.
 *
 * The prime's ref is resolved through `resolvePrimeBackendRef`, which itself
 * throws when `prime_config.supabase_project_ref` is unset. That throw is
 * caught here and turned into `primeBackendRef: null`, which the decision
 * treats as a refusal — the deployment cannot confirm this target is not the
 * prime, so it does not write.
 */
export async function resolveCloneSecretTarget(
  supabase: Db,
  cloneId: string,
): Promise<CloneSecretTarget> {
  let readError: string | null = null;

  const cloneRes = await supabase
    .from("clones")
    .select("id, name")
    .eq("id", cloneId)
    .maybeSingle();
  if (cloneRes.error) readError = cloneRes.error.message;

  // `clone_backends.clone_id` is `uuid NOT NULL UNIQUE`, so this lookup is
  // structurally incapable of returning the prime — its ref lives in
  // `prime_config`, a different table. The value comparison below is the guard
  // against the row being WRONG rather than against the query being wrong.
  const backendRes = await supabase
    .from("clone_backends")
    .select("supabase_project_ref")
    .eq("clone_id", cloneId)
    .maybeSingle();
  if (!readError && backendRes.error) readError = backendRes.error.message;

  let primeBackendRef: string | null = null;
  try {
    const { resolvePrimeBackendRef } = await import("./prime-backend.server");
    primeBackendRef = await resolvePrimeBackendRef(supabase);
  } catch {
    primeBackendRef = null; // refusal, not a pass — see the decision module
  }

  const decision = decideCloneSecretTarget({
    cloneId,
    cloneExists: Boolean(cloneRes.data),
    backendRef: (backendRes.data as { supabase_project_ref?: string | null } | null)
      ?.supabase_project_ref,
    ownRef: ownProjectRef(),
    primeBackendRef,
    readError,
  });

  if (!decision.ok) throw new CloneSecretTargetError(decision.reason, decision.message);

  return {
    cloneId,
    cloneName: (cloneRes.data as { name?: string | null } | null)?.name ?? cloneId,
    projectRef: decision.projectRef,
  };
}

/**
 * Every origin a browser may load this clone's application from.
 *
 * Lifted verbatim out of `backend-provisioning.functions.ts`, which computed it
 * inline for `applyAuthConfig`, so provisioning, the deployment drain and the
 * operator back-fill cannot each arrive at a different answer for the same
 * clone. A CORS allow-list that disagrees with the auth redirect allow-list is
 * two half-configured deployments rather than one.
 */
export async function resolveCloneOrigins(supabase: Db, cloneId: string): Promise<CloneOrigins> {
  const { data: cloneRow } = await supabase
    .from("clones")
    .select("slug, subdomain, subdomain_fqdn, deploy_url, lovable_project_url")
    .eq("id", cloneId)
    .maybeSingle();
  const [{ data: cfRow }, { data: deploymentRow }, { data: hostingCfg }] = await Promise.all([
    supabase
      .from("cloudflare_clone_config")
      .select("zone_name")
      .eq("clone_id", cloneId)
      .maybeSingle(),
    supabase
      .from("clone_deployments")
      .select("domain, provider_origin, status")
      .eq("clone_id", cloneId)
      .maybeSingle(),
    supabase
      .from("platform_hosting_config")
      .select("primary_domain")
      .eq("singleton", true)
      .maybeSingle(),
  ]);

  const { cloneFqdn, resolveCloneOrigin } = await import("@/server/hosting/dnsTarget.pure");
  const deploymentOrigin = resolveCloneOrigin({
    domain: (deploymentRow as { domain?: string | null } | null)?.domain,
    providerOrigin: (deploymentRow as { provider_origin?: string | null } | null)?.provider_origin,
    deploymentStatus: (deploymentRow as { status?: string | null } | null)?.status,
  });
  const row = cloneRow as {
    slug?: string | null;
    subdomain?: string | null;
    subdomain_fqdn?: string | null;
    deploy_url?: string | null;
    lovable_project_url?: string | null;
  } | null;

  // The ALLOCATED name, never the slug.
  //
  // This block came out of `backend-provisioning.functions.ts`, where it read
  // `cloneFqdn(cloneRow?.slug, …)`. `slug` is not the clone's hostname and is
  // not reliably even close to it: `reserveCloneSubdomain` runs the slug
  // through `normaliseLabel` (lossy), honours an operator-supplied `preferred`
  // instead, and appends a numeric suffix when the name is taken or reserved.
  //
  // The collision case is the dangerous one. A clone whose slug is `npc` but
  // whose allocated subdomain is `npc-2` would derive
  // `https://npc.aurixasystems.com.au` — ANOTHER TENANT'S HOSTNAME — into its
  // ALLOWED_ORIGINS, trusting that origin for credentialed responses, while
  // omitting the host it is actually served on.
  //
  // `clone-provisioning.functions.ts` records the same defect being removed
  // from the deployment drain: "The drain used to fall back to `clone.slug`
  // when no subdomain was recorded, which silently bypassed `reserved_slugs` —
  // a clone slugged `admin` would have taken `admin.aurixasystems.com.au`."
  // The fallback survived here.
  //
  // There is deliberately NO slug fallback now. Before allocation a clone has
  // no planned hostname, and guessing one is how you end up trusting somebody
  // else's.
  const allocatedFqdn =
    row?.subdomain_fqdn ??
    cloneFqdn(
      row?.subdomain,
      (hostingCfg as { primary_domain?: string | null } | null)?.primary_domain,
    );

  // The origin this clone is FOR, as opposed to the one GoTrue redirects to
  // today: the allocated hostname outranks the provider's, which `siteUrl`
  // falls back to until the custom domain is live. Passkeys and invite links
  // bound to a provider hostname go wrong the moment the domain goes live.
  const deploymentStatus = (deploymentRow as { status?: string | null } | null)?.status ?? null;
  const liveOrigin = deploymentStatus === "live" ? deploymentOrigin : null;

  return {
    siteUrl: row?.deploy_url ?? deploymentOrigin ?? row?.lovable_project_url ?? null,
    canonicalOrigin:
      row?.deploy_url ??
      liveOrigin ??
      (allocatedFqdn ? `https://${allocatedFqdn}` : null) ??
      deploymentOrigin ??
      null,
    additionalRedirectUrls: [
      row?.deploy_url ?? null,
      deploymentOrigin,
      (deploymentRow as { provider_origin?: string | null } | null)?.provider_origin ?? null,
      row?.lovable_project_url ?? null,
      (cfRow as { zone_name?: string | null } | null)?.zone_name
        ? `https://${(cfRow as { zone_name: string }).zone_name}`
        : null,
      allocatedFqdn ? `https://${allocatedFqdn}` : null,
    ],
  };
}

export type ApplyAllowedOriginsResult =
  | { ok: true; cloneId: string; projectRef: string; value: string; changed: boolean }
  | { ok: false; cloneId: string; reason: CloneSecretRefusal | "no_origins" | "write_failed"; error: string };

/**
 * What Mission Control last WROTE into this clone's `ALLOWED_ORIGINS`.
 *
 * Read from the event this module records after every successful write, so
 * there is one record of the fact rather than a cache beside it.
 *
 * This answers "does it still need setting", not "what is the secret now". The
 * two differ if an operator edits the value in the Supabase dashboard, and the
 * reconciler deliberately leaves that alone: it only re-writes when its OWN
 * derivation has moved. A scheduler that stomps a value a person set by hand is
 * worse than one that is occasionally behind.
 */
async function lastWrittenValue(supabase: Db, cloneId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("deployment_events")
    .select("result")
    .eq("clone_id", cloneId)
    .eq("action", "set_allowed_origins")
    .eq("success", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  // A read that FAILED is not "never written". Returning null here would make
  // the reconciler re-write on every tick during a database fault, which is a
  // Management API call per clone per run against a project that is fine.
  if (error) throw new Error(`Could not read the last ALLOWED_ORIGINS write: ${error.message}`);
  const result = (data as { result?: { allowed_origins?: unknown } | null } | null)?.result;
  const v = result?.allowed_origins;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Derive and write `ALLOWED_ORIGINS` for one clone.
 *
 * Records the outcome in `clone_backend_secrets` (so the operator's secret list
 * shows it) and in `deployment_events` (so a failure is visible on the clone's
 * own timeline rather than only in a log). Never throws for an expected
 * refusal — the callers here are a webhook drain and a bulk sweep, and one
 * clone's misconfiguration must not stop the others.
 */
export async function applyCloneAllowedOrigins(
  supabase: Db,
  cloneId: string,
  opts?: {
    actorUserId?: string | null;
    providerSlug?: string | null;
    /**
     * Write even when the derived value matches what was last written.
     * The operator's button passes this: "nothing changed" is not what
     * somebody who just pressed a button wants to be told, and a person
     * pressing it is usually repairing something they cannot see.
     */
    force?: boolean;
  },
): Promise<ApplyAllowedOriginsResult> {
  let target: CloneSecretTarget;
  try {
    target = await resolveCloneSecretTarget(supabase, cloneId);
  } catch (e) {
    const reason = e instanceof CloneSecretTargetError ? e.reason : "unreadable";
    const error = e instanceof Error ? e.message : String(e);
    await recordEvent(supabase, cloneId, opts?.providerSlug, false, error, null, opts?.actorUserId);
    return { ok: false, cloneId, reason, error };
  }

  const origins = await resolveCloneOrigins(supabase, cloneId);
  const value = cloneAllowedOrigins(origins);
  if (!value) {
    // Unset beats a guess. A clone with no resolvable origin has nothing this
    // could honestly write, and writing an empty string would trust nothing at
    // all — which takes sign-in down rather than fixing it.
    const error =
      `No usable origin for clone ${cloneId}: it has no deploy_url, no deployment origin, ` +
      "no Lovable URL and no allocated subdomain. Leaving ALLOWED_ORIGINS unset.";
    await recordEvent(supabase, cloneId, opts?.providerSlug, false, error, null, opts?.actorUserId);
    return { ok: false, cloneId, reason: "no_origins", error };
  }

  if (!opts?.force) {
    let lastWritten: string | null;
    try {
      lastWritten = await lastWrittenValue(supabase, cloneId);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return { ok: false, cloneId, reason: "unreadable", error };
    }
    if (lastWritten === value) {
      // Already correct, by our own last write. No Management API call, no
      // event row: a reconciler that logs "no change" on every clone every
      // fifteen minutes buries the runs that did something.
      return { ok: true, cloneId, projectRef: target.projectRef, value, changed: false };
    }
  }

  const { setCloneSecretValue } = await import("./backend-provisioning.server");
  const res = await setCloneSecretValue(target.projectRef, ALLOWED_ORIGINS_SECRET, value);
  const now = new Date().toISOString();

  // Checked on purpose, and worth a note: `check:discarded-errors` counts this
  // statement as checked because the word `error` occurs inside it (in
  // `res.error`, which is the SECRET WRITE's error, not this upsert's). The
  // guard is pattern-based and that shape fools it. Tightening the pattern
  // would reclassify statements across ninety-nine files at once, so the guard
  // is left alone and this is simply written correctly.
  //
  // It matters: if this upsert fails, the secret is set on the clone's project
  // while the operator's secret list still shows ALLOWED_ORIGINS as missing —
  // a divergence with no signal anywhere.
  const { error: trackErr } = await supabase.from("clone_backend_secrets").upsert(
    {
      clone_id: cloneId,
      name: ALLOWED_ORIGINS_SECRET,
      status: res.ok ? "set" : "failed",
      last_set_at: res.ok ? now : null,
      last_error: res.ok ? null : res.error,
      set_by: opts?.actorUserId ?? null,
    },
    { onConflict: "clone_id,name" },
  );
  if (trackErr) {
    console.error("[allowed_origins] secret written but tracking row not updated", {
      cloneId,
      projectRef: target.projectRef,
      error: trackErr.message,
    });
  }

  await recordEvent(
    supabase,
    cloneId,
    opts?.providerSlug,
    res.ok,
    res.ok ? null : res.error,
    res.ok ? value : null,
    opts?.actorUserId,
  );

  return res.ok
    ? { ok: true, cloneId, projectRef: target.projectRef, value, changed: true }
    : { ok: false, cloneId, reason: "write_failed", error: res.error };
}

async function recordEvent(
  supabase: Db,
  cloneId: string,
  providerSlug: string | null | undefined,
  success: boolean,
  errorMessage: string | null,
  value?: string | null,
  actorUserId?: string | null,
) {
  // `result`, not a `detail` column — this table has `payload`/`result` and no
  // `detail`. Named columns only, and no cast: PostgREST answers 42703 for a
  // column that does not exist, and a discarded error there turns a refused
  // write into a timeline that silently records nothing.
  const { error } = await supabase.from("deployment_events").insert({
    clone_id: cloneId,
    provider_slug: providerSlug ?? "supabase",
    action: "set_allowed_origins",
    success,
    error_message: errorMessage,
    actor_user_id: actorUserId ?? null,
    // The clone's own public hostnames. Not a secret in any sense — it is what
    // a browser sends — and reading back what was written is the whole point of
    // an event row here.
    result: value ? { allowed_origins: value } : {},
  });
  if (error) {
    // The write to the clone's project already happened or already failed;
    // losing the audit row must not change what is reported about it, but it
    // must not be silent either.
    console.error("[allowed_origins] could not record deployment_event", {
      cloneId,
      error: error.message,
    });
  }
}


/**
 * Keep every clone's `ALLOWED_ORIGINS` equal to its own origins.
 *
 * ## Why a sweep rather than only the two event points
 *
 * Provisioning derives it and `onLive` completes it, and between them they
 * cover a clone's first hour. They do not cover the rest of its life. The
 * origins move afterwards, for ordinary reasons:
 *
 *   - a custom domain is attached to a clone that has been live for a month;
 *   - a subdomain is re-allocated, or detached and re-attached;
 *   - a redeploy changes the provider origin;
 *   - the platform's `primary_domain` changes, which moves every clone at once.
 *
 * Each of those silently invalidates a value nothing re-derives, and the
 * symptom is the one this whole area exists because of: sign-in failing CORS
 * on a deployment where the credentials are correct and nothing logs an error.
 *
 * It is also what makes the existing fleet self-heal. Every clone provisioned
 * before any of this existed has the secret unset; the first run sets it,
 * without anybody remembering to press anything.
 *
 * ## Cheap on the runs that find nothing
 *
 * A clone whose derived value matches what Mission Control last wrote costs one
 * indexed read and no Management API call, and records no event. Only a clone
 * whose origins actually moved is written and logged, so the timeline shows
 * changes rather than heartbeats.
 *
 * One clone's refusal never stops the others: `applyCloneAllowedOrigins`
 * reports rather than throws, and each result is counted separately.
 */
export type ReconcileResult = {
  considered: number;
  changed: number;
  unchanged: number;
  refused: Array<{ cloneId: string; reason: string; error: string }>;
};

export async function reconcileAllowedOrigins(supabase: Db): Promise<ReconcileResult> {
  const { data, error } = await supabase
    .from("clone_backends")
    .select("clone_id")
    .not("supabase_project_ref", "is", null);
  // A candidate list that could not be READ is not an empty candidate list.
  // Reporting "0 clones, nothing to do" would make a database fault look like
  // a healthy fleet, on the one job whose whole purpose is noticing drift.
  if (error) throw new Error(`Could not list clone backends: ${error.message}`);

  const cloneIds = (data ?? [])
    .map((r) => (r as { clone_id: string | null }).clone_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  const out: ReconcileResult = { considered: cloneIds.length, changed: 0, unchanged: 0, refused: [] };
  for (const cloneId of cloneIds) {
    const res = await applyCloneAllowedOrigins(supabase, cloneId);
    if (res.ok) {
      if (res.changed) out.changed++;
      else out.unchanged++;
    } else {
      out.refused.push({ cloneId: res.cloneId, reason: res.reason, error: res.error });
    }
  }
  return out;
}
