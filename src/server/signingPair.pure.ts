/**
 * The clone's internal signing pair — ONE value, written to BOTH sides.
 *
 * ## What this fixes
 *
 * Every scheduled job on the prime calls an edge function through
 * `cron_signed_internal_headers`, which HMAC-signs the request with
 * `internal_edge_secret` read from the database's vault, and the function
 * verifies it against `INTERNAL_EDGE_SECRET` read from its environment. The
 * two are one secret in two places, and the request works only while they are
 * the same string.
 *
 * Provisioning wrote exactly one of them. `planCloneSecrets` classifies
 * `INTERNAL_EDGE_SECRET` as an identity secret — correctly never inherited
 * from the prime, since a shared value makes a request signed for either
 * deployment valid on the other — and MINTED a random value for the function
 * environment. It retained that value nowhere. Nothing wrote the vault half.
 *
 * Measured 6 Sep 2026, identically on all three clones: the vault held
 * `supabase_url` and nothing else, and `cron.job_run_details` recorded
 * ~13,900 failed runs in 24 hours per clone — every one of them
 * `cron_signed_internal_headers: internal_edge_secret not configured in
 * vault`. The 138 HTTP calls a day that did leave the database (the jobs that
 * do not sign) came back 400 or 401. No background job on any clone had ever
 * run. That is the prime's own "17,174 refused invocations" incident,
 * replayed on every tenant from the day it was built.
 *
 * ## The rules
 *
 * **The vault is the source of truth, because the environment cannot be read
 * back.** The Management API lists secret NAMES and never returns a value, so
 * the only side that can say what the pair IS is the database. A pass that
 * finds a usable vault value reuses it and re-asserts the environment; a pass
 * that finds none mints one, writes the vault first, then the environment. If
 * the environment write fails, the next pass finds the vault value and tries
 * the environment again — it converges rather than rotating.
 *
 * **Never rotate on a repair.** Before this, every repair pass minted a fresh
 * random for the environment (the generic generator has no memory), so even a
 * vault that HAD been populated would have been out of step after the next
 * repair. One writer decides the value; the generic generator is told the
 * value rather than inventing one — see `selfValues` on `planCloneSecrets`.
 *
 * **The verifier's floor is the plan's floor.** `auth_v2.ts` ignores a key
 * shorter than 16 characters, and `cron_signed_internal_headers` raises on
 * one — so a vault value below that is treated as absent and replaced, not
 * trusted.
 *
 * **`supabase_service_role_key` travels with it.** `cron_signed_internal_headers`
 * also needs a gateway credential from the vault (anon preferred, service-role
 * as fallback), and the prime's vault carries the service-role key. It is the
 * clone's OWN key, read from the clone's own project by the same ref that is
 * written to — never the prime's.
 *
 * Pure: no I/O, so every rule above is asserted without a database.
 */

/** `auth_v2.ts` and `cron_signed_internal_headers` both refuse anything shorter. */
export const MIN_SIGNING_SECRET_LENGTH = 16;

/** Vault name on the database side; env name on the function side. One value. */
export const VAULT_INTERNAL_EDGE_SECRET = "internal_edge_secret";
export const ENV_INTERNAL_EDGE_SECRET = "INTERNAL_EDGE_SECRET";
export const VAULT_SERVICE_ROLE_KEY = "supabase_service_role_key";

export type SigningPairFacts = {
  /** The vault's current `internal_edge_secret`, or null when absent. */
  vaultInternalEdgeSecret: string | null;
  /**
   * Whether the vault's `supabase_service_role_key` already equals the
   * clone's own key. `null` when the vault holds no such row. Compared inside
   * the database so the key is not round-tripped for a boolean.
   */
  vaultServiceRoleKeyMatches: boolean | null;
};

export type SigningPairPlan = {
  /** The one value both sides receive. Never log it. */
  value: string;
  /** Where the value came from. `minted` means the vault had nothing usable. */
  source: "vault" | "minted";
  /** Create or update `internal_edge_secret` in the vault. */
  writeVaultSecret: boolean;
  /** Create or update `supabase_service_role_key` in the vault. */
  writeVaultServiceKey: boolean;
  /**
   * Always true. The environment is write-only, so it is re-asserted with the
   * same value on every pass; that is what makes a failed write converge and
   * what stops a repair from ever holding a different value from the vault.
   */
  writeEnv: true;
  /** Why, in one line, for the status trail. Carries no secret material. */
  why: string;
};

export function planSigningPair(
  facts: SigningPairFacts,
  generate: () => string,
): SigningPairPlan {
  const held = (facts.vaultInternalEdgeSecret ?? "").trim();
  const usable = held.length >= MIN_SIGNING_SECRET_LENGTH;

  const value = usable ? held : generate();
  if (!usable && value.length < MIN_SIGNING_SECRET_LENGTH) {
    // A generator that cannot meet the verifier's floor would write a pair
    // that both sides refuse — worse than writing nothing, because the ledger
    // would then say `set`.
    throw new Error(
      `signing pair generator produced ${value.length} characters; the verifier requires at least ${MIN_SIGNING_SECRET_LENGTH}`,
    );
  }

  const writeVaultServiceKey = facts.vaultServiceRoleKeyMatches !== true;

  return {
    value,
    source: usable ? "vault" : "minted",
    writeVaultSecret: !usable,
    writeVaultServiceKey,
    writeEnv: true,
    why: usable
      ? held.length === (facts.vaultInternalEdgeSecret ?? "").length
        ? "vault holds a usable internal_edge_secret — reused, environment re-asserted"
        : "vault holds a usable internal_edge_secret (trimmed) — reused, environment re-asserted"
      : held.length === 0
        ? "vault holds no internal_edge_secret — minted, written to vault then environment"
        : `vault internal_edge_secret is ${held.length} characters, below the verifier's floor of ${MIN_SIGNING_SECRET_LENGTH} — replaced`,
  };
}

/** What the reconcile sweep needs to decide whether to touch a clone at all. */
export type SigningPairRepairFacts = {
  projectRef: string | null;
  /** The ledger row for `INTERNAL_EDGE_SECRET`, absent when nothing recorded it. */
  ledgerStatus: string | null;
  lastError: string | null;
  updatedAt: string | null;
  now: number;
};

export type SigningPairRepairSkip = "no_backend" | "cooling_off";

export type SigningPairRepairVerdict =
  | { act: true; why: string }
  | { act: false; reason: SigningPairRepairSkip };

/**
 * A failed pass is left alone for this long. A project whose vault refuses the
 * write, or whose secrets API refuses the environment, is a standing refusal
 * until somebody changes something.
 */
export const SIGNING_PAIR_REPAIR_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Unlike the JWT repair, a ledger row reading `set` does NOT stop this sweep.
 * That status was being written by the generic generator for a value the vault
 * never received, so on the fleet as it stands `set` is exactly the state that
 * needs repairing. The sweep is cheap enough to run on every clone every pass:
 * one vault read, and no write at all when both sides already agree.
 */
export function decideSigningPairRepair(facts: SigningPairRepairFacts): SigningPairRepairVerdict {
  if (!facts.projectRef) return { act: false, reason: "no_backend" };

  if (facts.lastError && facts.updatedAt && facts.ledgerStatus === "failed") {
    const since = facts.now - Date.parse(facts.updatedAt);
    if (Number.isFinite(since) && since >= 0 && since < SIGNING_PAIR_REPAIR_COOLDOWN_MS) {
      return { act: false, reason: "cooling_off" };
    }
  }

  return {
    act: true,
    why:
      facts.ledgerStatus === null
        ? "no ledger row yet"
        : `ledger says ${facts.ledgerStatus} — the vault half is verified regardless`,
  };
}
