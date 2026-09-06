/**
 * Write a clone's internal signing pair: ONE value to the vault and to the
 * function environment, so `cron_signed_internal_headers` and `auth_v2.ts`
 * agree. The rules and the measurement are in `signingPair.pure.ts`.
 *
 * ## The rule that governs the write
 *
 * **The ref that reads is the ref that writes.** The vault is read on one
 * project and the environment written on the SAME project, and both take the
 * one `projectRef` from `resolveCloneSecretTarget`, which refuses the prime,
 * refuses Mission Control's own, and refuses when it cannot tell. The
 * service-role key placed in the vault is read from that same project's API
 * keys, so it can only ever be the clone's own.
 *
 * The value is never logged, never put in an event row, and never returned to
 * anything but the provisioning pipeline that must hand it to the secrets
 * batch — `ensureCloneSigningPair` returns it in-process for that one purpose,
 * and the recorded result (`SigningPairOutcome`) carries none of it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import type { Database } from "@/integrations/supabase/types";
import {
  resolveCloneSecretTarget,
  CloneSecretTargetError,
  type CloneSecretTarget,
} from "./cloneAllowedOrigins.server";
import type { CloneSecretRefusal } from "./cloneSecretTarget.pure";
import {
  planSigningPair,
  decideSigningPairRepair,
  ENV_INTERNAL_EDGE_SECRET,
  VAULT_INTERNAL_EDGE_SECRET,
  VAULT_SERVICE_ROLE_KEY,
  type SigningPairRepairSkip,
} from "./signingPair.pure";

type Db = SupabaseClient<Database>;

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** What is recorded and reported. Deliberately carries no secret material. */
export type SigningPairOutcome = {
  source: "vault" | "minted";
  vaultSecretWritten: boolean;
  vaultServiceKeyWritten: boolean;
  envWritten: boolean;
  why: string;
};

export type EnsureSigningPairResult =
  | { ok: true; outcome: SigningPairOutcome; /** In-process only. Never log. */ value: string }
  | { ok: false; stage: "vault_read" | "vault_write" | "env_write"; error: string };

/**
 * Bring one project's signing pair into agreement.
 *
 * `serviceRoleKey` is the clone's OWN key — the caller has just read it from
 * this same project (`selectProjectKeys(await getProjectApiKeys(projectRef))`),
 * which is the only source it may come from.
 */
export async function ensureCloneSigningPair(
  projectRef: string,
  serviceRoleKey: string,
): Promise<EnsureSigningPairResult> {
  const { runSqlOnProject, sqlLiteral, setCloneSecretValues } =
    await import("./backend-provisioning.server");

  // One read for both facts. The service-role comparison happens INSIDE the
  // database so the key is not round-tripped for a boolean.
  let vaultValue: string | null = null;
  let serviceKeyMatches: boolean | null = null;
  try {
    const rows = (await runSqlOnProject(
      projectRef,
      `select
         (select decrypted_secret from vault.decrypted_secrets
            where name = ${sqlLiteral(VAULT_INTERNAL_EDGE_SECRET)} limit 1) as edge_secret,
         (select decrypted_secret = ${sqlLiteral(serviceRoleKey)} from vault.decrypted_secrets
            where name = ${sqlLiteral(VAULT_SERVICE_ROLE_KEY)} limit 1) as service_key_matches;`,
    )) as Array<{ edge_secret?: unknown; service_key_matches?: unknown }>;
    const row = Array.isArray(rows) ? rows[0] : undefined;
    vaultValue = typeof row?.edge_secret === "string" ? row.edge_secret : null;
    serviceKeyMatches =
      typeof row?.service_key_matches === "boolean" ? row.service_key_matches : null;
  } catch (e) {
    return { ok: false, stage: "vault_read", error: `Could not read the clone's vault: ${msg(e)}` };
  }

  const plan = planSigningPair(
    { vaultInternalEdgeSecret: vaultValue, vaultServiceRoleKeyMatches: serviceKeyMatches },
    () => randomBytes(32).toString("hex"),
  );

  // Vault FIRST. If the environment write then fails, the next pass reads this
  // value back and re-asserts the environment with it — convergence rather
  // than rotation. An `update` on an existing row keeps the vault's own id.
  if (plan.writeVaultSecret || plan.writeVaultServiceKey) {
    const upsert = (name: string, value: string, description: string) => `
      if exists (select 1 from vault.secrets where name = ${sqlLiteral(name)}) then
        perform vault.update_secret(
          (select id from vault.secrets where name = ${sqlLiteral(name)} limit 1),
          ${sqlLiteral(value)}, ${sqlLiteral(name)}, ${sqlLiteral(description)});
      else
        perform vault.create_secret(${sqlLiteral(value)}, ${sqlLiteral(name)}, ${sqlLiteral(description)});
      end if;`;
    const body =
      (plan.writeVaultSecret
        ? upsert(
            VAULT_INTERNAL_EDGE_SECRET,
            plan.value,
            "Shared secret accepted by fail-closed edge functions",
          )
        : "") +
      (plan.writeVaultServiceKey
        ? upsert(
            VAULT_SERVICE_ROLE_KEY,
            serviceRoleKey,
            "Service-role JWT used by pg_cron to call edge functions",
          )
        : "");
    try {
      await runSqlOnProject(projectRef, `do $pair$ begin ${body} end $pair$;`);
    } catch (e) {
      return { ok: false, stage: "vault_write", error: `Could not write the clone's vault: ${msg(e)}` };
    }
  }

  // Then the environment, with the SAME value.
  const env = await setCloneSecretValues(projectRef, [
    { name: ENV_INTERNAL_EDGE_SECRET, value: plan.value },
  ]);
  if (!env.ok) {
    return { ok: false, stage: "env_write", error: env.error };
  }

  return {
    ok: true,
    value: plan.value,
    outcome: {
      source: plan.source,
      vaultSecretWritten: plan.writeVaultSecret,
      vaultServiceKeyWritten: plan.writeVaultServiceKey,
      envWritten: true,
      why: plan.why,
    },
  };
}

export type SigningPairRepairFailure =
  | CloneSecretRefusal
  | "keys_unreadable"
  | "vault_read"
  | "vault_write"
  | "env_write";

export type SigningPairRepairResult =
  | { ok: true; cloneId: string; projectRef: string; changed: boolean; outcome: SigningPairOutcome }
  | { ok: true; cloneId: string; changed: false; skipped: SigningPairRepairSkip }
  | { ok: false; cloneId: string; reason: SigningPairRepairFailure; error: string };

/**
 * Repair one clone's pair, reading everything from that clone's own project.
 *
 * Never throws for an expected refusal — the callers are a cron sweep and an
 * operator action, and one clone's misconfiguration must not stop the others.
 */
export async function repairCloneSigningPair(
  supabase: Db,
  cloneId: string,
  opts?: { actorUserId?: string | null; force?: boolean; now?: number },
): Promise<SigningPairRepairResult> {
  let target: CloneSecretTarget;
  try {
    target = await resolveCloneSecretTarget(supabase, cloneId);
  } catch (e) {
    const reason = e instanceof CloneSecretTargetError ? e.reason : "unreadable";
    return { ok: false, cloneId, reason, error: msg(e) };
  }
  // One ref. Every read and every write below takes it — see the header.
  const projectRef = target.projectRef;

  if (!opts?.force) {
    let ledger: { status: string | null; lastError: string | null; updatedAt: string | null };
    try {
      ledger = await readLedger(supabase, cloneId);
    } catch (e) {
      return { ok: false, cloneId, reason: "unreadable", error: msg(e) };
    }
    const verdict = decideSigningPairRepair({
      projectRef,
      ledgerStatus: ledger.status,
      lastError: ledger.lastError,
      updatedAt: ledger.updatedAt,
      now: opts?.now ?? Date.now(),
    });
    if (!verdict.act) return { ok: true, cloneId, changed: false, skipped: verdict.reason };
  }

  const { getProjectApiKeys, selectProjectKeys } = await import("./backend-provisioning.server");
  let serviceRoleKey: string | null = null;
  try {
    serviceRoleKey = selectProjectKeys(await getProjectApiKeys(projectRef)).serviceRoleKey;
  } catch (e) {
    await recordFailure(supabase, cloneId, `Could not read the project's API keys: ${msg(e)}`, opts?.actorUserId);
    return { ok: false, cloneId, reason: "keys_unreadable", error: msg(e) };
  }
  if (!serviceRoleKey) {
    const error = `The Management API returned no service-role key for project ${projectRef}.`;
    await recordFailure(supabase, cloneId, error, opts?.actorUserId);
    return { ok: false, cloneId, reason: "keys_unreadable", error };
  }

  const res = await ensureCloneSigningPair(projectRef, serviceRoleKey);
  const now = new Date().toISOString();

  // Checked deliberately: an unrecorded success re-runs the vault read on
  // every pass forever, and an unrecorded failure never starts its cool-off.
  const { error: trackErr } = await supabase.from("clone_backend_secrets").upsert(
    {
      clone_id: cloneId,
      name: ENV_INTERNAL_EDGE_SECRET,
      status: res.ok ? "set" : "failed",
      last_set_at: res.ok ? now : null,
      last_error: res.ok ? null : `${res.stage}: ${res.error}`,
      set_by: opts?.actorUserId ?? null,
    },
    { onConflict: "clone_id,name" },
  );
  if (trackErr) {
    console.error("[signing_pair] pair written but tracking row not updated", {
      cloneId,
      projectRef,
      error: trackErr.message,
    });
  }

  await recordEvent(
    supabase,
    cloneId,
    res.ok,
    res.ok ? null : `${res.stage}: ${res.error}`,
    res.ok ? res.outcome : null,
    opts?.actorUserId,
  );

  if (!res.ok) return { ok: false, cloneId, reason: res.stage, error: res.error };
  const changed = res.outcome.vaultSecretWritten || res.outcome.vaultServiceKeyWritten;
  return { ok: true, cloneId, projectRef, changed, outcome: res.outcome };
}

async function readLedger(
  supabase: Db,
  cloneId: string,
): Promise<{ status: string | null; lastError: string | null; updatedAt: string | null }> {
  const { data, error } = await supabase
    .from("clone_backend_secrets")
    .select("status, last_error, updated_at")
    .eq("clone_id", cloneId)
    .eq("name", ENV_INTERNAL_EDGE_SECRET)
    .maybeSingle();
  // A read that FAILED is not a row that is ABSENT.
  if (error) throw new Error(`Could not read the ${ENV_INTERNAL_EDGE_SECRET} ledger row: ${error.message}`);
  const row = data as { status?: string | null; last_error?: string | null; updated_at?: string | null } | null;
  return {
    status: row?.status ?? null,
    lastError: row?.last_error ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

async function recordFailure(
  supabase: Db,
  cloneId: string,
  error: string,
  actorUserId?: string | null,
): Promise<void> {
  const { error: trackErr } = await supabase.from("clone_backend_secrets").upsert(
    {
      clone_id: cloneId,
      name: ENV_INTERNAL_EDGE_SECRET,
      status: "failed",
      last_set_at: null,
      last_error: error,
      set_by: actorUserId ?? null,
    },
    { onConflict: "clone_id,name" },
  );
  if (trackErr) {
    console.error("[signing_pair] could not record the failed attempt", { cloneId, error: trackErr.message });
  }
  await recordEvent(supabase, cloneId, false, error, null, actorUserId);
}

async function recordEvent(
  supabase: Db,
  cloneId: string,
  success: boolean,
  errorMessage: string | null,
  outcome: SigningPairOutcome | null,
  actorUserId?: string | null,
): Promise<void> {
  // `result` carries no value and never will: this is a signing key, and an
  // event row is read by more people than can read the project it came from.
  const { error } = await supabase.from("deployment_events").insert({
    clone_id: cloneId,
    provider_slug: "supabase",
    action: "set_internal_signing_pair",
    success,
    error_message: errorMessage,
    actor_user_id: actorUserId ?? null,
    result: {
      secret_name: ENV_INTERNAL_EDGE_SECRET,
      vault_name: VAULT_INTERNAL_EDGE_SECRET,
      ...(outcome ?? {}),
    },
  });
  if (error) {
    console.error("[signing_pair] could not record deployment_event", { cloneId, error: error.message });
  }
}

export type SigningPairReconcileResult = {
  considered: number;
  repaired: number;
  alreadyPaired: number;
  skipped: Record<string, number>;
  refused: { cloneId: string; reason: SigningPairRepairFailure }[];
};

/**
 * Carry every clone whose pair is missing or out of step.
 *
 * Deliberately NOT settled by a ledger reading of `set` — see
 * `decideSigningPairRepair`. What makes a settled fleet cheap instead is the
 * pair step itself: one vault read per clone, and no write at all when both
 * halves already agree. The Management API is called only to read the clone's
 * own keys and to re-assert the environment, which is idempotent.
 */
export async function reconcileCloneSigningPairs(
  supabase: Db,
  opts: { now?: number } = {},
): Promise<SigningPairReconcileResult> {
  const now = opts.now ?? Date.now();

  const { data, error } = await supabase
    .from("clone_backends")
    .select("clone_id, supabase_project_ref")
    .not("supabase_project_ref", "is", null);
  // A candidate list that could not be READ is not an empty one.
  if (error) throw new Error(`Could not list clone backends: ${error.message}`);

  const candidates = (data ?? [])
    .map((r) => r as { clone_id: string | null })
    .filter((r): r is { clone_id: string } => typeof r.clone_id === "string" && r.clone_id.length > 0);

  const out: SigningPairReconcileResult = {
    considered: candidates.length,
    repaired: 0,
    alreadyPaired: 0,
    skipped: {},
    refused: [],
  };

  for (const c of candidates) {
    const res = await repairCloneSigningPair(supabase, c.clone_id, { now });
    if (!res.ok) {
      out.refused.push({ cloneId: c.clone_id, reason: res.reason });
    } else if ("skipped" in res) {
      out.skipped[res.skipped] = (out.skipped[res.skipped] ?? 0) + 1;
    } else if (res.changed) {
      out.repaired += 1;
    } else {
      out.alreadyPaired += 1;
    }
  }
  return out;
}
