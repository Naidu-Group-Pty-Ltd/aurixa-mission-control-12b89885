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
 * Two more are PAIRS with a database half the prime's own cron reads:
 * `FINANCE_PORTAL_CRON_SECRET` against the vault's `finance_portal_cron_secret`,
 * and `MARKET_INGESTION_CRON_SECRET` against the database setting
 * `app.market_ingestion_cron_secret`, which two scheduled jobs put in an
 * `x-cron-secret` header that ten functions compare byte for byte. The prime
 * held neither half of either, so those jobs answered 401 on the prime and,
 * faithfully, on every clone.
 *
 * ## The rules
 *
 * **Minted once, mirrored in the database, re-asserted from there.** The
 * function environment cannot be read back, so a pass that minted anew would
 * ROTATE: outstanding reset tokens stop verifying and every push subscription —
 * bound to the VAPID public key it subscribed with — goes dead. The project's
 * own vault (or, for a setting the cron reads with `current_setting`, the
 * database-level setting itself) holds the readable half, exactly as the
 * signing pair's does; a pass reuses what it finds there and mints only what is
 * missing, database first, then environment, so a failed environment write
 * converges on the next pass.
 *
 * **A key pair is one thing.** A VAPID public key without its private half
 * signs nothing, and a private key whose public half nobody holds delivers to
 * nobody. If either half is missing or malformed the PAIR is re-minted.
 *
 * **A clone mirrors the prime's shape; it never invents a pair the prime does
 * not hold.** A clone gets its own finance or market pair only where the
 * prime's vault (or settings) carries the same name, read for NAMES and never
 * for a value. When the prime cannot be read the answer is "unknown", never
 * "none" — a probe that fails closed rather than into a fabricated pair. The
 * prime itself is paired by `PRIME_PAIR_SPECS`, which carry no gate, because
 * on the prime the question is not "what does the prime hold" but "what do
 * the prime's own jobs read".
 *
 * Pure: no I/O. The server module supplies the reads and the mints.
 */

/** `resetTokens.ts`, the finance batch and the market functions all refuse a value shorter than this. */
export const MIN_OWNED_SECRET_LENGTH = 16;

/** Where the readable half lives: a vault secret, or a database-level setting. */
export type OwnedSecretStore = "vault" | "guc";

export type OwnedSecretSpec =
  | {
      kind: "random";
      env: string;
      /** The vault secret or database setting that mirrors `env`. */
      store: OwnedSecretStore;
      key: string;
      /** Bytes of entropy to mint; the value is hex, so twice this in characters. */
      bytes: number;
      /** The consumer's floor: a mirrored value at or above it is reused, below it replaced. */
      floor: number;
      /** Only paired where the PRIME holds the same key in the same store. */
      requiresPrime?: true;
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
 * `market-qa-subscriptions-run-due`) send `current_setting('app.market_ingestion_cron_secret')`
 * as `x-cron-secret`, and ten market functions compare it against the
 * environment. The setting is database-level so that every new cron session
 * sees it.
 */
const MARKET_CRON_PAIR: Omit<Extract<OwnedSecretSpec, { kind: "random" }>, "requiresPrime"> = {
  kind: "random",
  env: "MARKET_INGESTION_CRON_SECRET",
  store: "guc",
  key: "app.market_ingestion_cron_secret",
  bytes: 32,
  floor: MIN_OWNED_SECRET_LENGTH,
  why: "two scheduled jobs send the database setting as x-cron-secret and ten market functions compare it against the environment",
};

/** What a CLONE owns. The two pairs are gated on the prime holding the same half. */
export const OWNED_SECRET_SPECS: readonly OwnedSecretSpec[] = [
  RESET_PEPPER,
  CSRF_PEPPER,
  VAPID_PAIR,
  { ...FINANCE_CRON_PAIR, requiresPrime: true },
  { ...MARKET_CRON_PAIR, requiresPrime: true },
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
  return specs.flatMap((s) =>
    s.kind === "vapid" ? [s.publicVault, s.privateVault] : s.store === "vault" ? [s.key] : [],
  );
}

/** The database settings a spec list mirrors into. */
export function ownedSecretGucNames(specs: readonly OwnedSecretSpec[] = OWNED_SECRET_SPECS): string[] {
  return specs.flatMap((s) => (s.kind === "random" && s.store === "guc" ? [s.key] : []));
}

/** The NAMES the prime holds, by store. Never a value. */
export type PrimeShape = {
  vaultNames: ReadonlySet<string>;
  gucNames: ReadonlySet<string>;
};

export type OwnedSecretFacts = {
  /** Vault name → decrypted value on the target project, null where absent. */
  vault: Record<string, string | null>;
  /** Database setting → value on the target project, null where absent. */
  guc: Record<string, string | null>;
  /** What the prime holds; null when the prime could not be read. Ignored by an ungated spec. */
  primeShape: PrimeShape | null;
};

export type OwnedSecretMint = {
  random: (bytes: number) => string;
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

export type OwnedSecretSkipReason = "prime_holds_none" | "prime_unreadable";

export type OwnedSecretSkip = { env: string; store: OwnedSecretStore; key: string; reason: OwnedSecretSkipReason };

export type OwnedSecretsPlan = {
  /** Every environment name this pass asserts, with the value both sides get. */
  writes: OwnedSecretWrite[];
  skipped: OwnedSecretSkip[];
  /** One line per spec, for the status trail. Carries no secret material. */
  why: string[];
};

function primeHolds(shape: PrimeShape, store: OwnedSecretStore, key: string): boolean {
  return store === "vault" ? shape.vaultNames.has(key) : shape.gucNames.has(key);
}

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
        if (!primeHolds(facts.primeShape, spec.store, spec.key)) {
          skipped.push({ env: spec.env, store: spec.store, key: spec.key, reason: "prime_holds_none" });
          why.push(`${spec.env}: the prime holds no ${spec.store === "vault" ? "vault secret" : "database setting"} ${spec.key} — nothing to mirror`);
          continue;
        }
      }
      const held = ((spec.store === "vault" ? facts.vault[spec.key] : facts.guc[spec.key]) ?? "").trim();
      const usable = held.length >= spec.floor;
      const value = usable ? held : mint.random(spec.bytes);
      if (!usable && value.length < spec.floor) {
        throw new Error(
          `${spec.env}: the generator produced ${value.length} characters; the consumer requires at least ${spec.floor}`,
        );
      }
      writes.push({ env: spec.env, store: spec.store, key: spec.key, value, source: usable ? "mirror" : "minted" });
      const where = spec.store === "vault" ? "vault" : "database setting";
      why.push(
        usable
          ? `${spec.env}: ${where} holds a usable value — reused, environment re-asserted`
          : held.length === 0
            ? `${spec.env}: ${where} holds none — minted, written to ${where} then environment`
            : `${spec.env}: ${where} value is ${held.length} characters, below the floor of ${spec.floor} — replaced`,
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
