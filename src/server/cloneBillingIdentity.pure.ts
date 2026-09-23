/**
 * Which billing identity a clone spends against — and which it may never be
 * given.
 *
 * ## The defect this exists for
 *
 * `clones.billing_user_id` is read in seven places and was written by ONE
 * statement: the provisioning insert, `data.billingUserId ?? null`. The
 * operator wizard offers the field with the help text "Leave blank to assign
 * later", and there is no later — no page in Mission Control ever wrote that
 * column again. Measured 22 Sep 2026: all four live clones hold NULL, and one
 * of ten tenants carries an id at all (the prime's `npc-prime`, seeded by
 * migration `20260714180000`).
 *
 * The same shape as `builder_network_connections` in the property dashboard:
 * read everywhere, written by nothing, and indistinguishable from an operator
 * who simply had not got round to it.
 *
 * What that costs is not cosmetic. A clone with no billing id makes
 * `/api/public/tokens/packs` answer a `topup_url` with no credential on it, so
 * the clone's own banner falls through to the constant its bundle compiles in
 * — `?uid=${VITE_AURIXA_BILLING_UID}`, defaulting to **`npc-prime`**. A
 * customer on a clone clicking "buy more tokens" would have credited the
 * PRIME's tenant: Stripe takes the money, a ledger row lands, and the balance
 * the customer is looking at never moves.
 *
 * ## Why an assessment rather than a column constraint
 *
 * The two partial unique indexes (`clones_billing_user_id_uidx`,
 * `tenants_billing_user_id_uidx`) are PER TABLE. Nothing in the database stops
 * a clone from holding the exact id a tenant already holds — and
 * `startUidCheckout` reads `clones` FIRST and `tenants` only if that misses.
 * So a clone given `npc-prime` does not collide with the prime; it SHADOWS it,
 * silently, for every `?uid=npc-prime` purchase in the fleet including the
 * prime's own. The database cannot express that rule, so this module does.
 *
 * ## The rules
 *
 * 1. **An id is derived, never left blank.** Provisioning defaults it from the
 *    clone's slug, which `clones_slug_key` already keeps unique, so a clone
 *    cannot reach production with no way for its customers to pay.
 * 2. **A clone may never hold an id a foreign row holds.** Another clone's is
 *    a collision the index would refuse anyway; a TENANT's is the shadow above
 *    and the index would not. A tenant belonging to THIS clone is fine — that
 *    is `ensureTenant`'s backfill, and shadowing yourself is a no-op.
 * 3. **`npc-prime` is refused whatever the database says.** It is compiled
 *    into the prime repo's bundle as a literal fallback, which is a fact about
 *    an artefact rather than a row — true even in a database where the prime
 *    tenant has been renamed or removed.
 *
 * Pure so the precedence is pinned by tests rather than by whichever row the
 * database happened to return first.
 */

/**
 * The identity the PRIME repo's bundle compiles in as its last-resort
 * fallback (`src/lib/missionControl.ts`, `?? "npc-prime"`), and the id
 * migration `20260714180000` seeds onto the prime tenant.
 *
 * Named here because rule 3 above is a statement about a BUILD, not about a
 * table: a deployment whose prime tenant row is missing still ships bundles
 * that spend this string.
 */
export const PRIME_BUILT_IN_BILLING_ID = "npc-prime";

/**
 * The variable that carries a clone's own billing identity into its bundle.
 *
 * Vite inlines `VITE_*` at BUILD time, so this is published during
 * `syncing_env` — before `deploying` — or the bundle does not have it. Named
 * once, here, because a literal at each end is how two ends drift.
 */
export const CLONE_BILLING_ID_ENV = "VITE_AURIXA_BILLING_UID";

/** Bounds. The id travels in a query string, in Stripe metadata and in an
 *  `.eq()` filter, so it stays short and unambiguous. */
export const MIN_BILLING_ID_LENGTH = 2;
export const MAX_BILLING_ID_LENGTH = 64;

/** Lowercase alphanumerics and internal hyphens, starting and ending on an
 *  alphanumeric. The shape every live clone slug already has. */
const BILLING_ID_SHAPE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Canonicalise an identifier a person typed.
 *
 * Trims and lowercases and does NOTHING else. Case and surrounding whitespace
 * are the same identifier written carelessly; a `_` for a `-` is a DIFFERENT
 * identifier, and silently rewriting it is how an operator ends up looking at
 * a clone that holds an id they did not choose. Anything but case and space is
 * refused by `assessCloneBillingId` rather than repaired here.
 */
export function canonicaliseBillingId(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * The identity a clone gets when nobody names one.
 *
 * The slug, because `clones_slug_key` is unique so this is unique across
 * clones for free, and because it is the string an operator and a support
 * conversation already use for that workspace. Returns null when the slug
 * cannot produce a usable id — a clone with no derivable identity records
 * NULL, exactly as it does today, rather than one that means something else.
 *
 * Non-conforming characters are dropped rather than substituted, and the
 * result still goes through `assessCloneBillingId`, which is what actually
 * refuses a collision. Every live slug is already in shape, so this is a
 * no-op on real input and a conservative fallback on hypothetical input.
 */
export function deriveCloneBillingId(slug: string | null | undefined): string | null {
  const collapsed = canonicaliseBillingId(slug)
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_BILLING_ID_LENGTH)
    .replace(/-+$/g, "");
  if (collapsed.length < MIN_BILLING_ID_LENGTH) return null;
  return BILLING_ID_SHAPE.test(collapsed) ? collapsed : null;
}

/**
 * A row in the control plane that carries a billing id.
 *
 * Each one states the id it holds, and the assessment MATCHES on it rather
 * than trusting the caller to have filtered. That is not defensiveness for
 * its own sake: this module's first fixture passed the prime's tenant row
 * while asking about a clone's derived id, and got back a refusal naming a
 * collision that does not exist. A caller may hand over everything it read.
 */
export type BillingIdHolder =
  | {
      kind: "clone";
      /** The id this row actually holds. */
      billingId: string | null | undefined;
      cloneId: string;
      /** For the operator-facing message. */
      label?: string | null;
    }
  | {
      kind: "tenant";
      billingId: string | null | undefined;
      tenantId: string;
      /** The clone this tenant bills for, or null for a tenant with no clone
       *  — the prime, a builders-network organisation. */
      cloneId: string | null;
      label?: string | null;
    };

export type CloneBillingIdRefusal =
  | "empty"
  | "malformed"
  | "too_long"
  | "reserved"
  | "taken_by_clone"
  | "shadows_tenant";

export type CloneBillingIdVerdict =
  | { ok: true; billingId: string; reason?: undefined; message?: undefined }
  | { ok: false; reason: CloneBillingIdRefusal; message: string; billingId?: undefined };

export type AssessCloneBillingIdContext = {
  /**
   * The clone the id is for. Null while the clone row does not exist yet —
   * the provisioning wizard — in which case every holder is foreign.
   */
  forCloneId?: string | null;
  /**
   * Rows in the control plane that carry a billing id. Only those carrying
   * the id under assessment are considered; the rest are ignored, so a caller
   * may pass whatever it read.
   */
  holders?: readonly BillingIdHolder[];
};

/**
 * May this clone hold this billing identity?
 *
 * Refuses rather than repairs, and names which refusal it is: an operator who
 * typed a taken id and an operator who typed a malformed one need different
 * sentences, and "invalid" sends both to the wrong place.
 */
export function assessCloneBillingId(
  value: string | null | undefined,
  ctx: AssessCloneBillingIdContext = {},
): CloneBillingIdVerdict {
  const raw = typeof value === "string" ? value.trim() : "";
  const id = canonicaliseBillingId(value);

  if (!id) {
    return { ok: false, reason: "empty", message: "A billing identity cannot be blank." };
  }
  if (id.length > MAX_BILLING_ID_LENGTH) {
    return {
      ok: false,
      reason: "too_long",
      message: `A billing identity is at most ${MAX_BILLING_ID_LENGTH} characters; "${raw}" is ${raw.length}.`,
    };
  }
  if (id.length < MIN_BILLING_ID_LENGTH || !BILLING_ID_SHAPE.test(id)) {
    return {
      ok: false,
      reason: "malformed",
      message: `"${raw}" is not a usable billing identity. Use lowercase letters, digits and hyphens, starting and ending on a letter or digit.`,
    };
  }

  // Rule 3, before the database is consulted at all: this one is true of an
  // artefact rather than of a row.
  if (id === PRIME_BUILT_IN_BILLING_ID) {
    return {
      ok: false,
      reason: "reserved",
      message: `"${PRIME_BUILT_IN_BILLING_ID}" is the prime install's own identity and is compiled into its bundle. A clone holding it would take every purchase the prime's customers make, because a uid resolves against clones before tenants.`,
    };
  }

  const forCloneId = ctx.forCloneId ?? null;
  for (const holder of ctx.holders ?? []) {
    if (canonicaliseBillingId(holder.billingId) !== id) continue;
    if (holder.kind === "clone") {
      if (holder.cloneId === forCloneId) continue; // re-asserting its own id
      return {
        ok: false,
        reason: "taken_by_clone",
        message: `"${id}" already belongs to ${holder.label ?? `clone ${holder.cloneId}`}.`,
      };
    }
    // A tenant of THIS clone is the `ensureTenant` backfill; shadowing
    // yourself changes nothing.
    if (holder.cloneId !== null && holder.cloneId === forCloneId) continue;
    return {
      ok: false,
      reason: "shadows_tenant",
      message: `"${id}" is already the billing identity of ${holder.label ?? `tenant ${holder.tenantId}`}. Giving it to a clone would shadow that workspace, because a uid resolves against clones before tenants — every purchase made with it would credit the clone instead.`,
    };
  }

  return { ok: true, billingId: id };
}

/**
 * One sentence for a provisioning status line or an audit note.
 *
 * `derived` is deliberately worded as a fact about the record rather than as a
 * promise about the clone: an id that was derived can still be changed, and
 * one the operator typed is not more correct for having been typed.
 */
export function describeBillingIdentity(
  verdict: CloneBillingIdVerdict,
  source: "operator" | "derived",
): string {
  if (verdict.ok) {
    return source === "operator"
      ? `Billing identity "${verdict.billingId}" recorded as given.`
      : `Billing identity "${verdict.billingId}" derived from the clone's slug.`;
  }
  return `No billing identity recorded: ${verdict.message}`;
}

/**
 * The identity the most recent environment publish carried, from the
 * deployment worker's own records of its `syncing_env` step, newest first.
 *
 * The worker writes `billing_uid` on every publish — on a write and on a
 * digest it found unchanged — and a record from before that field existed
 * belongs to a publish that never carried the variable at all, so the first
 * record naming one is the answer and a record naming none is skipped.
 *
 * `"none — …"` is what the worker writes when it published NO identity; it is
 * returned as null rather than as a string that merely looks like an id,
 * because comparing it to a column holding a real id must never succeed and
 * displaying it as an identity would be a lie in the other direction.
 */
export function lastPublishedBillingUid(results: readonly unknown[]): string | null {
  for (const result of results) {
    if (!result || typeof result !== "object") continue;
    const value = (result as Record<string, unknown>).billing_uid;
    if (typeof value !== "string") continue;
    const id = canonicaliseBillingId(value);
    return BILLING_ID_SHAPE.test(id) && id.length >= MIN_BILLING_ID_LENGTH ? id : null;
  }
  return null;
}
