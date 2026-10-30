/**
 * Clone-owned secrets with a database mirror — minted once, re-asserted for ever.
 *
 * ## What this fixes
 *
 * Three of the prime's features need a secret that belongs to the deployment
 * and to nobody else. Password-reset tokens are hashed with
 * `RESET_TOKEN_PEPPER`, and `resetTokens.ts` THROWS without one — so every
 * password reset on every clone failed. Web push signs with a VAPID key pair,
 * and `send-web-push` answered 503 on every clone for want of one. CSRF tokens
 * are peppered. None of the three can be inherited: a shared pepper makes reset
 * tokens interchangeable across tenants, and a shared VAPID key makes every
 * tenant's push identity the same key. Measured 6 Sep 2026 on NPC Test:
 * `RESET_TOKEN_PEPPER`, `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` all read
 * `missing` in the ledger, and the only one of the class that WAS written —
 * `CSRF_TOKEN_PEPPER` — was minted afresh on every repair pass.
 *
 * Two more are PAIRS with a vault half the prime's own cron reads:
 * `FINANCE_PORTAL_CRON_SECRET` against `finance_portal_cron_secret`, and
 * `MARKET_INGESTION_CRON_SECRET` against `market_ingestion_cron_secret`, which
 * two scheduled jobs put in an `x-cron-secret` header that ten functions
 * compare byte for byte. The prime held neither half of either, so those jobs
 * answered 401 on the prime and, faithfully, on every clone. (The market jobs
 * used to read a DATABASE SETTING instead: on this platform the `postgres`
 * role is not a superuser, and a placeholder parameter can be set
 * database-wide or on a role only by one — `42501: permission denied to set
 * parameter`, measured 6 Sep 2026 — so a setting can never be an
 * engine-writable mirror, and the jobs were moved onto the vault.)
 *
 * ## The rules
 *
 * **Minted once, mirrored in the vault, re-asserted from there.** The function
 * environment cannot be read back, so a pass that minted anew would ROTATE:
 * outstanding reset tokens stop verifying and every push subscription — bound
 * to the VAPID public key it subscribed with — goes dead. The project's own
 * vault holds the readable half, exactly as the signing pair's does; a pass
 * reuses what it finds there and mints only what is missing, vault first, then
 * environment, so a failed environment write converges on the next pass. The
 * vault is the ONLY mirror: it is the one store this role can write on every
 * project.
 *
 * **A key pair is one thing.** A VAPID public key without its private half
 * signs nothing, and a private key whose public half nobody holds delivers to
 * nobody. If either half is missing or malformed the PAIR is re-minted.
 *
 * **A clone mirrors the prime's shape; it never invents a pair the prime does
 * not hold.** A clone gets its own finance or market pair only where the
 * prime's vault carries the same name, read for NAMES and never for a value. When the prime cannot be read the answer is "unknown", never
 * "none" — a probe that fails closed rather than into a fabricated pair. The
 * prime itself is paired by `PRIME_PAIR_SPECS`, which carry no gate, because
 * on the prime the question is not "what does the prime hold" but "what do
 * the prime's own jobs read".
 *
 * ## Four that are minted only where the project holds none (30 Oct 2026)
 *
 * The prime reads `SESSION_TOKEN_PEPPER`, `STEP_UP_TOKEN_PEPPER`,
 * `MFA_TOTP_ENCRYPTION_KEY` and `MFA_RECOVERY_CODE_PEPPER` as
 * `Deno?.env?.get?.(…)`, which the function scan does not match, so no clone
 * was ever given one. Measured that day, read-only: NPC Test, Preflight and the
 * CRM had hashed none of their sessions in fourteen days, so each stored its
 * session tokens in plain text; the dashboard and the prime hashed theirs. No
 * deployment held a sealed TOTP secret, a recovery code or a step-up proof, and
 * no clone's vault mirrored any of the four.
 *
 * Unlike the peppers above, these may already be in a project's environment,
 * set by hand: the dashboard's session pepper is. The environment cannot be
 * read back, so minting over it would ROTATE it, and a rotated TOTP key
 * unseals nobody's second factor. So each is `onlyWhereAbsent`: minted only
 * where neither the vault nor the environment's list of names carries it, and
 * never when that list could not be read. A value the environment holds without
 * a mirror is left exactly as it is, and the pass says so.
 *
 * Two names are deliberately not here. `MESSAGING_HUB_PIN_PEPPER` falls back to
 * a pepper derived from the project's own service-role key, which is already
 * per deployment, and setting one later invalidates every PIN set under the
 * fallback. `STEP_UP_ENFORCED` is a recorded fail-closed policy, not a secret.
 *
 * Pure: no I/O. The server module supplies the reads and the mints.
 */

/** `resetTokens.ts`, the finance batch and the market functions all refuse a value shorter than this. */
export const MIN_OWNED_SECRET_LENGTH = 16;

/**
 * Where the readable half lives. Only the vault: a database-level setting
 * cannot be written by a non-superuser role for a placeholder parameter, so it
 * can never be a mirror the engine keeps.
 */
export type OwnedSecretStore = "vault";

export type OwnedSecretSpec =
  | {
      kind: "random";
      env: string;
      /** The vault secret that mirrors `env`. */
      store: OwnedSecretStore;
      key: string;
      /** Bytes of entropy to mint; hex by default, so twice this in characters. */
      bytes: number;
      /** The consumer's floor: a mirrored value at or above it is reused, below it replaced. */
      floor: number;
      /** How the bytes are written. A base64url value must decode to exactly `bytes` bytes. */
      encoding?: "hex" | "base64url";
      /** Only paired where the PRIME's vault holds the same key. */
      requiresPrime?: true;
      /**
       * Minted only where neither the vault nor the environment's names carry
       * it, and never when those names could not be read: a value in the
       * environment without a mirror was set by hand and would be rotated.
       */
      onlyWhereAbsent?: true;
      why: string;
    }
  | {
      kind: "vapid";
      publicEnv: string;
      privateEnv: string;
      publicVault: string;
      privateVault: string;
      why: string;
    };

const RESET_PEPPER: OwnedSecretSpec = {
  kind: "random",
  env: "RESET_TOKEN_PEPPER",
  store: "vault",
  key: "reset_token_pepper",
  bytes: 32,
  floor: MIN_OWNED_SECRET_LENGTH,
  why: "hashResetToken() throws without it, so no password reset can be issued",
};

const CSRF_PEPPER: OwnedSecretSpec = {
  kind: "random",
  env: "CSRF_TOKEN_PEPPER",
  store: "vault",
  key: "csrf_token_pepper",
  bytes: 32,
  floor: MIN_OWNED_SECRET_LENGTH,
  why: "a fresh random on every repair pass invalidated every CSRF token in flight",
};

const VAPID_PAIR: OwnedSecretSpec = {
  kind: "vapid",
  publicEnv: "VAPID_PUBLIC_KEY",
  privateEnv: "VAPID_PRIVATE_KEY",
  publicVault: "vapid_public_key",
  privateVault: "vapid_private_key",
  why: "send-web-push answers 503 without the pair, and a subscription is bound to the public key it saw",
};

/**
 * The finance reminder function compares `x-cron-secret` against this; the
 * older schedule read it from the vault under this name, and the pair is what
 * `isCronCall` needs to ever answer yes.
 */
const FINANCE_CRON_PAIR: Omit<Extract<OwnedSecretSpec, { kind: "random" }>, "requiresPrime"> = {
  kind: "random",
  env: "FINANCE_PORTAL_CRON_SECRET",
  store: "vault",
  key: "finance_portal_cron_secret",
  bytes: 32,
  floor: MIN_OWNED_SECRET_LENGTH,
  why: "finance-portal-batch6 compares x-cron-secret against the environment half; the vault half is what a schedule reads",
};

/**
 * Two scheduled jobs (`agent-planner-run-scheduled`,
 * `market-qa-subscriptions-run-due`) send the vault's
 * `market_ingestion_cron_secret` as `x-cron-secret`, and ten market functions
 * compare it against the environment.
 */
const MARKET_CRON_PAIR: Omit<Extract<OwnedSecretSpec, { kind: "random" }>, "requiresPrime"> = {
  kind: "random",
  env: "MARKET_INGESTION_CRON_SECRET",
  store: "vault",
  key: "market_ingestion_cron_secret",
  bytes: 32,
  floor: MIN_OWNED_SECRET_LENGTH,
  why: "two scheduled jobs send the vault half as x-cron-secret and ten market functions compare it against the environment",
};

/** `sessionHash.ts` stores session tokens unhashed without one (16 characters or more). */
const SESSION_PEPPER: OwnedSecretSpec = {
  kind: "random",
  env: "SESSION_TOKEN_PEPPER",
  store: "vault",
  key: "session_token_pepper",
  bytes: 32,
  floor: MIN_OWNED_SECRET_LENGTH,
  onlyWhereAbsent: true,
  why: "without it session tokens are stored in plain text; a lookup by hash falls back to the plain token, so no session is lost",
};

/** `stepUp.ts` hashes step-up proofs with an empty pepper without one. */
const STEP_UP_PEPPER: OwnedSecretSpec = {
  kind: "random",
  env: "STEP_UP_TOKEN_PEPPER",
  store: "vault",
  key: "step_up_token_pepper",
  bytes: 32,
  floor: MIN_OWNED_SECRET_LENGTH,
  onlyWhereAbsent: true,
  why: "without it a step-up proof is hashed with an empty pepper",
};

/** `recoveryCodes.ts` refuses a pepper under 32 characters, and issues no recovery codes without one. */
const MFA_RECOVERY_PEPPER: OwnedSecretSpec = {
  kind: "random",
  env: "MFA_RECOVERY_CODE_PEPPER",
  store: "vault",
  key: "mfa_recovery_code_pepper",
  bytes: 32,
  floor: 32,
  onlyWhereAbsent: true,
  why: "without it no MFA recovery code can be issued",
};

/** `totp.ts` takes a base64url 32-byte AES-256-GCM key, and no TOTP factor can be enrolled without one. */
const MFA_TOTP_KEY: OwnedSecretSpec = {
  kind: "random",
  env: "MFA_TOTP_ENCRYPTION_KEY",
  store: "vault",
  key: "mfa_totp_encryption_key",
  bytes: 32,
  floor: 43,
  encoding: "base64url",
  onlyWhereAbsent: true,
  why: "without it no TOTP factor can be enrolled; once one is, rotating the key unseals nobody's",
};

/**
 * What a CLONE owns. The two pairs are gated on the prime holding the same
 * half; the last four are minted only where the project holds none.
 */
export const OWNED_SECRET_SPECS: readonly OwnedSecretSpec[] = [
  RESET_PEPPER,
  CSRF_PEPPER,
  VAPID_PAIR,
  { ...FINANCE_CRON_PAIR, requiresPrime: true },
  { ...MARKET_CRON_PAIR, requiresPrime: true },
  SESSION_PEPPER,
  STEP_UP_PEPPER,
  MFA_RECOVERY_PEPPER,
  MFA_TOTP_KEY,
];

/**
 * What the PRIME is paired with, by the owner's decision (6 Sep 2026). No
 * gate: these are the halves the prime's own jobs read. Nothing else — the
 * prime's peppers and push identity are the owner's to hold.
 */
export const PRIME_PAIR_SPECS: readonly OwnedSecretSpec[] = [FINANCE_CRON_PAIR, MARKET_CRON_PAIR];

/** A VAPID public key is a 65-byte uncompressed P-256 point: 87 base64url chars, first byte 0x04 → 'B'. */
const VAPID_PUBLIC_RX = /^B[A-Za-z0-9_-]{86}$/;
/** A VAPID private key is a 32-byte scalar: 43 base64url chars. */
const VAPID_PRIVATE_RX = /^[A-Za-z0-9_-]{43}$/;

export function isVapidPublicKey(value: string | null | undefined): value is string {
  return typeof value === "string" && VAPID_PUBLIC_RX.test(value.trim());
}

export function isVapidPrivateKey(value: string | null | undefined): value is string {
  return typeof value === "string" && VAPID_PRIVATE_RX.test(value.trim());
}

export function ownedSecretEnvNames(specs: readonly OwnedSecretSpec[] = OWNED_SECRET_SPECS): string[] {
  return specs.flatMap((s) => (s.kind === "vapid" ? [s.publicEnv, s.privateEnv] : [s.env]));
}

/** The vault names a spec list mirrors into. */
export function ownedSecretVaultNames(specs: readonly OwnedSecretSpec[] = OWNED_SECRET_SPECS): string[] {
  return specs.flatMap((s) => (s.kind === "vapid" ? [s.publicVault, s.privateVault] : [s.key]));
}

/** The NAMES the prime's vault holds. Never a value. */
export type PrimeShape = {
  vaultNames: ReadonlySet<string>;
};

export type OwnedSecretFacts = {
  /** Vault name → decrypted value on the target project, null where absent. */
  vault: Record<string, string | null>;
  /** What the prime holds; null when the prime could not be read. Ignored by an ungated spec. */
  primeShape: PrimeShape | null;
  /**
   * The names the project's function environment holds, never a value; null or
   * absent when they could not be read. Read only by an `onlyWhereAbsent` spec,
   * which then mints nothing.
   */
  envNames?: ReadonlySet<string> | null;
};

export type OwnedSecretMint = {
  random: (bytes: number, encoding?: "hex" | "base64url") => string;
  vapid: () => { publicKey: string; privateKey: string };
};

export type OwnedSecretWrite = {
  env: string;
  store: OwnedSecretStore;
  key: string;
  /** Never log. */
  value: string;
  source: "mirror" | "minted";
};

export type OwnedSecretSkipReason = "prime_holds_none" | "prime_unreadable" | "env_unmirrored" | "env_unreadable";

/** Whether a value meets what its consumer accepts: the floor, and for base64url the exact decoded length. */
export function isUsableOwnedValue(spec: Extract<OwnedSecretSpec, { kind: "random" }>, value: string): boolean {
  if (spec.encoding === "base64url") {
    return value.length === Math.ceil((spec.bytes * 4) / 3) && /^[A-Za-z0-9_-]+$/.test(value);
  }
  return value.length >= spec.floor;
}

export type OwnedSecretSkip = { env: string; store: OwnedSecretStore; key: string; reason: OwnedSecretSkipReason };

export type OwnedSecretsPlan = {
  /** Every environment name this pass asserts, with the value both sides get. */
  writes: OwnedSecretWrite[];
  skipped: OwnedSecretSkip[];
  /** One line per spec, for the status trail. Carries no secret material. */
  why: string[];
};


export function planOwnedSecrets(
  specs: readonly OwnedSecretSpec[],
  facts: OwnedSecretFacts,
  mint: OwnedSecretMint,
): OwnedSecretsPlan {
  const writes: OwnedSecretWrite[] = [];
  const skipped: OwnedSecretSkip[] = [];
  const why: string[] = [];

  for (const spec of specs) {
    if (spec.kind === "random") {
      if (spec.requiresPrime) {
        if (facts.primeShape === null) {
          skipped.push({ env: spec.env, store: spec.store, key: spec.key, reason: "prime_unreadable" });
          why.push(`${spec.env}: the prime could not be read — not paired this pass`);
          continue;
        }
        if (!facts.primeShape.vaultNames.has(spec.key)) {
          skipped.push({ env: spec.env, store: spec.store, key: spec.key, reason: "prime_holds_none" });
          why.push(`${spec.env}: the prime's vault holds no ${spec.key} — nothing to mirror`);
          continue;
        }
      }
      const held = (facts.vault[spec.key] ?? "").trim();
      const usable = isUsableOwnedValue(spec, held);
      if (!usable && spec.onlyWhereAbsent) {
        const names = facts.envNames ?? null;
        if (names === null) {
          skipped.push({ env: spec.env, store: spec.store, key: spec.key, reason: "env_unreadable" });
          why.push(`${spec.env}: the environment's names could not be read — not minted this pass`);
          continue;
        }
        if (names.has(spec.env)) {
          skipped.push({ env: spec.env, store: spec.store, key: spec.key, reason: "env_unmirrored" });
          why.push(`${spec.env}: the environment holds a value this engine did not mint and cannot read — left as it is`);
          continue;
        }
      }
      const value = usable ? held : mint.random(spec.bytes, spec.encoding);
      if (!usable && !isUsableOwnedValue(spec, value)) {
        throw new Error(
          spec.encoding === "base64url"
            ? `${spec.env}: the generator produced ${value.length} characters; the consumer requires exactly ${spec.bytes} bytes as base64url`
            : `${spec.env}: the generator produced ${value.length} characters; the consumer requires at least ${spec.floor}`,
        );
      }
      writes.push({ env: spec.env, store: spec.store, key: spec.key, value, source: usable ? "mirror" : "minted" });
      why.push(
        usable
          ? `${spec.env}: vault holds a usable value — reused, environment re-asserted`
          : held.length === 0
            ? `${spec.env}: vault holds none — minted, written to vault then environment`
            : `${spec.env}: vault value is ${held.length} characters, below the floor of ${spec.floor} — replaced`,
      );
      continue;
    }

    const pub = facts.vault[spec.publicVault];
    const priv = facts.vault[spec.privateVault];
    const usable = isVapidPublicKey(pub) && isVapidPrivateKey(priv);
    if (usable) {
      writes.push({ env: spec.publicEnv, store: "vault", key: spec.publicVault, value: pub.trim(), source: "mirror" });
      writes.push({ env: spec.privateEnv, store: "vault", key: spec.privateVault, value: priv.trim(), source: "mirror" });
      why.push(`${spec.publicEnv}/${spec.privateEnv}: vault holds a well-formed pair — reused, environment re-asserted`);
      continue;
    }
    const pair = mint.vapid();
    if (!isVapidPublicKey(pair.publicKey) || !isVapidPrivateKey(pair.privateKey)) {
      // web-push rejects a malformed key with a thrown error at setVapidDetails,
      // which would fail EVERY push rather than none.
      throw new Error(`${spec.publicEnv}: the VAPID generator produced a malformed pair`);
    }
    writes.push({ env: spec.publicEnv, store: "vault", key: spec.publicVault, value: pair.publicKey, source: "minted" });
    writes.push({ env: spec.privateEnv, store: "vault", key: spec.privateVault, value: pair.privateKey, source: "minted" });
    const halves = [pub ? "public" : null, priv ? "private" : null].filter(Boolean);
    why.push(
      halves.length === 0
        ? `${spec.publicEnv}/${spec.privateEnv}: vault holds no pair — minted, written to vault then environment`
        : `${spec.publicEnv}/${spec.privateEnv}: vault held only a ${halves.length === 2 ? "malformed" : `${halves[0]}-half`} pair — re-minted whole`,
    );
  }

  return { writes, skipped, why };
}

/** What the reconcile sweep needs to decide whether to touch a clone at all. */
export type OwnedSecretsRepairFacts = {
  projectRef: string | null;
  /** The ledger rows for every owned env name; absent rows are simply not listed. */
  ledger: Array<{ status: string | null; lastError: string | null; updatedAt: string | null }>;
  now: number;
};

export type OwnedSecretsRepairSkip = "no_backend" | "cooling_off";

export type OwnedSecretsRepairVerdict =
  | { act: true; why: string }
  | { act: false; reason: OwnedSecretsRepairSkip };

/** A failed pass is left alone for this long — a standing refusal until somebody changes something. */
export const OWNED_SECRETS_REPAIR_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Like the signing pair's sweep, a ledger reading `set` does NOT settle this:
 * the pass is one read per clone and writes nothing new when the mirror
 * already agrees. Only a recent FAILED row holds it off.
 */
export function decideOwnedSecretsRepair(facts: OwnedSecretsRepairFacts): OwnedSecretsRepairVerdict {
  if (!facts.projectRef) return { act: false, reason: "no_backend" };
  for (const row of facts.ledger) {
    if (row.status !== "failed" || !row.lastError || !row.updatedAt) continue;
    const since = facts.now - Date.parse(row.updatedAt);
    if (Number.isFinite(since) && since >= 0 && since < OWNED_SECRETS_REPAIR_COOLDOWN_MS) {
      return { act: false, reason: "cooling_off" };
    }
  }
  return { act: true, why: "the mirror is verified regardless of what the ledger says" };
}
