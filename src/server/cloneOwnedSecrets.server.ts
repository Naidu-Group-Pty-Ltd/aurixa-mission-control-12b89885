/**
 * Write a project's OWN secrets — the peppers, the VAPID pair, and the two
 * cron pairs — to their database mirror and to the function environment, so
 * a repair pass re-asserts rather than rotates. The rules and the measurement
 * are in `cloneOwnedSecrets.pure.ts`.
 *
 * ## The rule that governs the write
 *
 * **The ref that reads is the ref that writes.** The mirror is read on one
 * project and both halves are written on the SAME project. For a clone every
 * ref comes from `resolveCloneSecretTarget`, which refuses the prime, refuses
 * Mission Control's own, and refuses when it cannot tell; the prime is read
 * for one thing only — the NAMES it holds, so a clone mirrors the prime's
 * shape — and never for a value. The prime's own pairs are written by
 * `primeSecretPairs.server.ts`, through the writer below, and that is the one
 * caller that hands this module the prime's ref.
 *
 * **The vault is the only mirror.** A database-level setting looked like a
 * second one, and is not: on this platform the `postgres` role is not a
 * superuser, and a placeholder parameter can be set database-wide or on a role
 * only by one — `42501: permission denied to set parameter`, measured 6 Sep
 * 2026 from the role that owns the database. The market jobs were moved onto
 * the vault instead; see the prime's `market_cron_secret_from_vault` migration.
 *
 * The values are never logged, never put in an event row, and never returned
 * to anything but the provisioning pipeline that hands them to the secrets
 * batch; the recorded outcome carries names and reasons only.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import type { Database } from "@/integrations/supabase/types";
import {
  resolveCloneSecretTarget,
  CloneSecretTargetError,
  type CloneSecretTarget,
} from "./cloneAllowedOrigins.server";
import type { CloneSecretRefusal } from "./cloneSecretTarget.pure";
import {
  OWNED_SECRET_SPECS,
  planOwnedSecrets,
  ownedSecretEnvNames,
  ownedSecretVaultNames,
  decideOwnedSecretsRepair,
  type OwnedSecretSkip,
  type OwnedSecretSpec,
  type OwnedSecretsPlan,
  type OwnedSecretsRepairSkip,
  type PrimeShape,
} from "./cloneOwnedSecrets.pure";

type Db = SupabaseClient<Database>;

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const OWNED_SECRETS_EVENT_ACTION = "set_owned_secrets";

/**
 * A P-256 pair in the form `web-push` takes: the public key as the 65-byte
 * uncompressed point and the private key as the 32-byte scalar, both
 * base64url. `setVapidDetails` throws on anything else, which would fail every
 * push rather than none.
 */
export function mintVapidKeyPair(): { publicKey: string; privateKey: string } {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" }) as { x?: string; y?: string; d?: string };
  if (!jwk.x || !jwk.y || !jwk.d) throw new Error("EC key export produced no JWK coordinates");
  const publicKey = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url"),
  ]).toString("base64url");
  return { publicKey, privateKey: jwk.d };
}

/**
 * The NAMES the prime's vault holds — never a value. Null when the prime could
 * not be read, which the planner treats as "unknown" rather than "none".
 */
export async function readPrimeShape(primeRef: string | null): Promise<PrimeShape | null> {
  if (!primeRef) return null;
  try {
    const { runSqlOnProject } = await import("./backend-provisioning.server");
    const rows = (await runSqlOnProject(primeRef, "select name from vault.secrets;")) as Array<{ name?: unknown }>;
    const vaultNames = new Set<string>();
    for (const row of Array.isArray(rows) ? rows : []) {
      if (typeof row?.name === "string" && row.name.length > 0) vaultNames.add(row.name);
    }
    return { vaultNames };
  } catch (e) {
    console.error("[owned_secrets] could not read the prime's shape", { primeRef, error: msg(e) });
    return null;
  }
}

/** What is recorded and reported. Deliberately carries no secret material. */
export type OwnedSecretsOutcome = {
  minted: string[];
  reused: string[];
  skipped: OwnedSecretSkip[];
  why: string[];
};

export type EnsureOwnedSecretsResult =
  | { ok: true; outcome: OwnedSecretsOutcome; /** In-process only. Never log. */ values: Record<string, string> }
  | { ok: false; stage: "mirror_read" | "plan" | "mirror_write" | "env_write"; error: string };

function vaultUpsertSql(
  sqlLiteral: (v: string) => string,
  name: string,
  value: string,
  description: string,
): string {
  return `
      if exists (select 1 from vault.secrets where name = ${sqlLiteral(name)}) then
        perform vault.update_secret(
          (select id from vault.secrets where name = ${sqlLiteral(name)} limit 1),
          ${sqlLiteral(value)}, ${sqlLiteral(name)}, ${sqlLiteral(description)});
      else
        perform vault.create_secret(${sqlLiteral(value)}, ${sqlLiteral(name)}, ${sqlLiteral(description)});
      end if;`;
}

/**
 * Bring one project's owned secrets into agreement for the given specs:
 * mirror first, then the environment, every value in ONE secrets request.
 * The gated specs consult `primeShape`; an ungated spec ignores it.
 */
export async function ensureOwnedSecrets(
  projectRef: string,
  specs: readonly OwnedSecretSpec[],
  primeShape: PrimeShape | null,
): Promise<EnsureOwnedSecretsResult> {
  const { runSqlOnProject, sqlLiteral, setCloneSecretValues } =
    await import("./backend-provisioning.server");

  const vaultNames = ownedSecretVaultNames(specs);
  const vault: Record<string, string | null> = Object.fromEntries(vaultNames.map((n) => [n, null]));
  try {
    if (vaultNames.length > 0) {
      const rows = (await runSqlOnProject(
        projectRef,
        `select name as key, decrypted_secret as value
           from vault.decrypted_secrets where name in (${vaultNames.map(sqlLiteral).join(", ")});`,
      )) as Array<{ key?: unknown; value?: unknown }>;
      for (const row of Array.isArray(rows) ? rows : []) {
        if (typeof row?.key === "string" && typeof row?.value === "string") vault[row.key] = row.value;
      }
    }
  } catch (e) {
    return { ok: false, stage: "mirror_read", error: `Could not read the project's mirror: ${msg(e)}` };
  }

  let plan: OwnedSecretsPlan;
  try {
    plan = planOwnedSecrets(
      specs,
      { vault, primeShape },
      { random: (bytes) => randomBytes(bytes).toString("hex"), vapid: mintVapidKeyPair },
    );
  } catch (e) {
    return { ok: false, stage: "plan", error: msg(e) };
  }

  // Mirror FIRST, and only what was minted: a reused value is already there.
  const minted = plan.writes.filter((w) => w.source === "minted");
  if (minted.length > 0) {
    const body = minted
      .map((w) => vaultUpsertSql(sqlLiteral, w.key, w.value, `Owned secret mirrored from the function environment's ${w.env}`))
      .join("");
    try {
      await runSqlOnProject(projectRef, `do $owned$ begin ${body} end $owned$;`);
    } catch (e) {
      return { ok: false, stage: "mirror_write", error: `Could not write the project's mirror: ${msg(e)}` };
    }
  }

  // Then the environment, with the SAME values, in one request.
  if (plan.writes.length > 0) {
    const env = await setCloneSecretValues(
      projectRef,
      plan.writes.map((w) => ({ name: w.env, value: w.value })),
    );
    if (!env.ok) return { ok: false, stage: "env_write", error: env.error };
  }

  return {
    ok: true,
    values: Object.fromEntries(plan.writes.map((w) => [w.env, w.value])),
    outcome: {
      minted: minted.map((w) => w.env),
      reused: plan.writes.filter((w) => w.source === "mirror").map((w) => w.env),
      skipped: plan.skipped,
      why: plan.why,
    },
  };
}

/** A CLONE's owned secrets: the gated list, against the prime's shape. */
export function ensureCloneOwnedSecrets(
  projectRef: string,
  primeShape: PrimeShape | null,
): Promise<EnsureOwnedSecretsResult> {
  return ensureOwnedSecrets(projectRef, OWNED_SECRET_SPECS, primeShape);
}

export type OwnedSecretsRepairFailure =
  | CloneSecretRefusal
  | "mirror_read"
  | "plan"
  | "mirror_write"
  | "env_write";

export type OwnedSecretsRepairResult =
  | { ok: true; cloneId: string; projectRef: string; changed: boolean; outcome: OwnedSecretsOutcome }
  | { ok: true; cloneId: string; changed: false; skipped: OwnedSecretsRepairSkip }
  | { ok: false; cloneId: string; reason: OwnedSecretsRepairFailure; error: string };

async function primeShapeForSweep(supabase: Db): Promise<PrimeShape | null> {
  let primeRef: string | null = null;
  try {
    const { resolvePrimeBackendRef } = await import("./prime-backend.server");
    primeRef = await resolvePrimeBackendRef(supabase);
  } catch {
    primeRef = null; // unknown, never "none" — see the planner
  }
  return readPrimeShape(primeRef);
}

/**
 * Repair one clone, reading everything from that clone's own project. Never
 * throws for an expected refusal — one clone's misconfiguration must not stop
 * the others in a sweep.
 */
export async function repairCloneOwnedSecrets(
  supabase: Db,
  cloneId: string,
  opts?: {
    actorUserId?: string | null;
    force?: boolean;
    now?: number;
    /** Read once per sweep by the caller; `undefined` means read it here. */
    primeShape?: PrimeShape | null;
  },
): Promise<OwnedSecretsRepairResult> {
  let target: CloneSecretTarget;
  try {
    target = await resolveCloneSecretTarget(supabase, cloneId);
  } catch (e) {
    const reason = e instanceof CloneSecretTargetError ? e.reason : "unreadable";
    return { ok: false, cloneId, reason, error: msg(e) };
  }
  const projectRef = target.projectRef;
  const envNames = ownedSecretEnvNames();

  if (!opts?.force) {
    const { data, error } = await supabase
      .from("clone_backend_secrets")
      .select("status, last_error, updated_at")
      .eq("clone_id", cloneId)
      .in("name", envNames);
    // A read that FAILED is not a row that is ABSENT.
    if (error) return { ok: false, cloneId, reason: "unreadable", error: `Could not read the ledger: ${error.message}` };
    const verdict = decideOwnedSecretsRepair({
      projectRef,
      ledger: (data ?? []).map((r) => ({
        status: (r as { status?: string | null }).status ?? null,
        lastError: (r as { last_error?: string | null }).last_error ?? null,
        updatedAt: (r as { updated_at?: string | null }).updated_at ?? null,
      })),
      now: opts?.now ?? Date.now(),
    });
    if (!verdict.act) return { ok: true, cloneId, changed: false, skipped: verdict.reason };
  }

  const primeShape = opts?.primeShape === undefined ? await primeShapeForSweep(supabase) : opts.primeShape;

  const res = await ensureCloneOwnedSecrets(projectRef, primeShape);
  const now = new Date().toISOString();
  const written = res.ok ? Object.keys(res.values) : envNames;
  const { error: trackErr } = await supabase.from("clone_backend_secrets").upsert(
    written.map((name) => ({
      clone_id: cloneId,
      name,
      status: res.ok ? "set" : "failed",
      last_set_at: res.ok ? now : null,
      last_error: res.ok ? null : `${res.stage}: ${res.error}`,
      set_by: opts?.actorUserId ?? null,
    })),
    { onConflict: "clone_id,name" },
  );
  if (trackErr) {
    console.error("[owned_secrets] written but tracking rows not updated", { cloneId, projectRef, error: trackErr.message });
  }

  await recordEvent(supabase, cloneId, res.ok, res.ok ? null : `${res.stage}: ${res.error}`, res.ok ? res.outcome : null, opts?.actorUserId);

  if (!res.ok) return { ok: false, cloneId, reason: res.stage, error: res.error };
  return { ok: true, cloneId, projectRef, changed: res.outcome.minted.length > 0, outcome: res.outcome };
}

async function recordEvent(
  supabase: Db,
  cloneId: string,
  success: boolean,
  errorMessage: string | null,
  outcome: OwnedSecretsOutcome | null,
  actorUserId?: string | null,
): Promise<void> {
  // Names and reasons only — an event row is read by more people than can
  // read the project the secrets belong to.
  const { error } = await supabase.from("deployment_events").insert({
    clone_id: cloneId,
    provider_slug: "supabase",
    action: OWNED_SECRETS_EVENT_ACTION,
    success,
    error_message: errorMessage,
    actor_user_id: actorUserId ?? null,
    result: outcome ?? {},
  });
  if (error) {
    console.error("[owned_secrets] could not record deployment_event", { cloneId, error: error.message });
  }
}

export type OwnedSecretsReconcileResult = {
  considered: number;
  repaired: number;
  alreadyHeld: number;
  skipped: Record<string, number>;
  refused: { cloneId: string; reason: OwnedSecretsRepairFailure }[];
  primeReadable: boolean;
};

/**
 * Carry every clone whose owned secrets are missing or malformed. One mirror
 * read per clone, nothing written when the mirror already agrees; the prime's
 * shape is read once for the whole sweep.
 */
export async function reconcileCloneOwnedSecrets(
  supabase: Db,
  opts: { now?: number } = {},
): Promise<OwnedSecretsReconcileResult> {
  const now = opts.now ?? Date.now();

  const { data, error } = await supabase
    .from("clone_backends")
    .select("clone_id, supabase_project_ref")
    .not("supabase_project_ref", "is", null);
  // A candidate list that could not be READ is not an empty one.
  if (error) throw new Error(`Could not list clone backends: ${error.message}`);

  const primeShape = await primeShapeForSweep(supabase);

  const candidates = (data ?? [])
    .map((r) => r as { clone_id: string | null })
    .filter((r): r is { clone_id: string } => typeof r.clone_id === "string" && r.clone_id.length > 0);

  const out: OwnedSecretsReconcileResult = {
    considered: candidates.length,
    repaired: 0,
    alreadyHeld: 0,
    skipped: {},
    refused: [],
    primeReadable: primeShape !== null,
  };

  for (const c of candidates) {
    const res = await repairCloneOwnedSecrets(supabase, c.clone_id, { now, primeShape });
    if (!res.ok) {
      out.refused.push({ cloneId: c.clone_id, reason: res.reason });
    } else if ("skipped" in res) {
      out.skipped[res.skipped] = (out.skipped[res.skipped] ?? 0) + 1;
    } else if (res.changed) {
      out.repaired += 1;
    } else {
      out.alreadyHeld += 1;
    }
  }
  return out;
}
