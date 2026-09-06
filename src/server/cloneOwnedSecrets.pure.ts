/**
 * Clone-owned secrets with a vault mirror — minted once, re-asserted for ever.
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
 * ## The rules
 *
 * **Minted once, mirrored in the vault, re-asserted from there.** The function
 * environment cannot be read back, so a pass that minted anew would ROTATE:
 * outstanding reset tokens stop verifying and every push subscription — bound
 * to the VAPID public key it subscribed with — goes dead. The clone's own vault
 * holds the readable half, exactly as the signing pair's does; a pass reuses
 * what it finds there and mints only what is missing, vault first, then
 * environment, so a failed environment write converges on the next pass.
 *
 * **A key pair is one thing.** A VAPID public key without its private half
 * signs nothing, and a private key whose public half nobody holds delivers to
 * nobody. If either half is missing or malformed the PAIR is re-minted.
 *
 * **Mirror the prime's shape; never invent a pair the prime does not hold.**
 * `FINANCE_PORTAL_CRON_SECRET` has a database half the prime's own cron reads
 * from ITS vault (`finance_portal_cron_secret`), and the reminder job is only
 * ever scheduled where that entry exists. A clone whose prime holds it gets its
 * own; one whose prime does not is left alone and told why. And when the prime
 * cannot be read the answer is "unknown", never "none" — a probe that fails
 * closed rather than into a fabricated pair.
 *
 * Pure: no I/O. The server module supplies the vault reading and the mints.
 */

/** `resetTokens.ts` and the finance cron both refuse a value shorter than this. */
export const MIN_OWNED_SECRET_LENGTH = 16;

export type OwnedSecretSpec =
  | {
      kind: "random";
      env: string;
      vault: string;
      /** Bytes of entropy to mint; the value is hex, so twice this in characters. */
      bytes: number;
      /** The consumer's floor: a vault value at or above it is reused, below it replaced. */
      floor: number;
      /** Only paired where the PRIME's vault carries the same name. */
      requiresPrimeVault?: true;
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

export const OWNED_SECRET_SPECS: readonly OwnedSecretSpec[] = [
  {
    kind: "random",
    env: "RESET_TOKEN_PEPPER",
    vault: "reset_token_pepper",
    bytes: 32,
    floor: MIN_OWNED_SECRET_LENGTH,
    why: "hashResetToken() throws without it, so no password reset can be issued",
  },
  {
    kind: "random",
    env: "CSRF_TOKEN_PEPPER",
    vault: "csrf_token_pepper",
    bytes: 32,
    floor: MIN_OWNED_SECRET_LENGTH,
    why: "a fresh random on every repair pass invalidated every CSRF token in flight",
  },
  {
    kind: "vapid",
    publicEnv: "VAPID_PUBLIC_KEY",
    privateEnv: "VAPID_PRIVATE_KEY",
    publicVault: "vapid_public_key",
    privateVault: "vapid_private_key",
    why: "send-web-push answers 503 without the pair, and a subscription is bound to the public key it saw",
  },
  {
    kind: "random",
    env: "FINANCE_PORTAL_CRON_SECRET",
    vault: "finance_portal_cron_secret",
    bytes: 32,
    floor: MIN_OWNED_SECRET_LENGTH,
    requiresPrimeVault: true,
    why: "the finance reminder cron reads the vault half and the function verifies the environment half",
  },
];

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

export function ownedSecretVaultNames(specs: readonly OwnedSecretSpec[] = OWNED_SECRET_SPECS): string[] {
  return specs.flatMap((s) => (s.kind === "vapid" ? [s.publicVault, s.privateVault] : [s.vault]));
}

export type OwnedSecretFacts = {
  /** Vault name → decrypted value, null where the vault holds no such row. */
  vault: Record<string, string | null>;
  /** Names the PRIME's vault holds; null when the prime could not be read. */
  primeVaultNames: ReadonlySet<string> | null;
};

export type OwnedSecretMint = {
  random: (bytes: number) => string;
  vapid: () => { publicKey: string; privateKey: string };
};

export type OwnedSecretWrite = {
  env: string;
  vault: string;
  /** Never log. */
  value: string;
  source: "vault" | "minted";
};

export type OwnedSecretSkipReason = "prime_holds_none" | "prime_unreadable";

export type OwnedSecretSkip = { env: string; vault: string; reason: OwnedSecretSkipReason };

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
      if (spec.requiresPrimeVault) {
        if (facts.primeVaultNames === null) {
          skipped.push({ env: spec.env, vault: spec.vault, reason: "prime_unreadable" });
          why.push(`${spec.env}: the prime's vault could not be read — not paired this pass`);
          continue;
        }
        if (!facts.primeVaultNames.has(spec.vault)) {
          skipped.push({ env: spec.env, vault: spec.vault, reason: "prime_holds_none" });
          why.push(`${spec.env}: the prime's vault holds no ${spec.vault} — nothing to mirror`);
          continue;
        }
      }
      const held = (facts.vault[spec.vault] ?? "").trim();
      const usable = held.length >= spec.floor;
      const value = usable ? held : mint.random(spec.bytes);
      if (!usable && value.length < spec.floor) {
        throw new Error(
          `${spec.env}: the generator produced ${value.length} characters; the consumer requires at least ${spec.floor}`,
        );
      }
      writes.push({ env: spec.env, vault: spec.vault, value, source: usable ? "vault" : "minted" });
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
      writes.push({ env: spec.publicEnv, vault: spec.publicVault, value: pub.trim(), source: "vault" });
      writes.push({ env: spec.privateEnv, vault: spec.privateVault, value: priv.trim(), source: "vault" });
      why.push(`${spec.publicEnv}/${spec.privateEnv}: vault holds a well-formed pair — reused, environment re-asserted`);
      continue;
    }
    const pair = mint.vapid();
    if (!isVapidPublicKey(pair.publicKey) || !isVapidPrivateKey(pair.privateKey)) {
      // web-push rejects a malformed key with a thrown error at setVapidDetails,
      // which would fail EVERY push rather than none.
      throw new Error(`${spec.publicEnv}: the VAPID generator produced a malformed pair`);
    }
    writes.push({ env: spec.publicEnv, vault: spec.publicVault, value: pair.publicKey, source: "minted" });
    writes.push({ env: spec.privateEnv, vault: spec.privateVault, value: pair.privateKey, source: "minted" });
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
 * the pass is one vault read per clone and writes nothing new when the vault
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
  return { act: true, why: "the vault is verified regardless of what the ledger says" };
}
