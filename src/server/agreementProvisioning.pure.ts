/**
 * Signed agreement → provisioned clone: the decisions, with no network in
 * them.
 *
 * A DocuSign envelope completing is an EXTERNAL event that can create a paid
 * Supabase project, a GitHub repository and a deployment. Every rule that
 * stands between the webhook body and that spend lives here, pure, so each
 * refusal can be asserted by name:
 *
 *  - the payload parse never guesses (an unrecognisable body is `null`, not
 *    a best effort);
 *  - provisioning fires only for an agreement that ARMED it, exactly once
 *    (the caller claims via compare-and-set on `provision_status`);
 *  - the effective module set is the selection minus the named exclusions —
 *    exclusions are recorded facts of the negotiation, never re-derived.
 */

/** The Connect payload facts the pipeline acts on. */
export type ConnectEventFacts = {
  envelopeId: string;
  /** Connect's event name, e.g. `envelope-completed`. */
  event: string;
  /** The envelope status word, when the payload carried one. */
  status: string | null;
  completedAt: string | null;
  voidedAt: string | null;
  accountId: string | null;
};

/**
 * Parse a DocuSign Connect JSON delivery (REST v2.1 format:
 * `{event, data: {accountId, envelopeId, envelopeSummary?}}`).
 *
 * Returns null for anything that does not carry an envelope id — an
 * unrecognisable body is recorded and ignored, never guessed at. Legacy XML
 * Connect configurations are out of scope on purpose; the setup doc pins the
 * JSON ("REST v2.1") format.
 */
export function parseConnectPayload(body: unknown): ConnectEventFacts | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const data = (typeof b.data === "object" && b.data !== null ? b.data : {}) as Record<
    string,
    unknown
  >;
  const summary = (
    typeof data.envelopeSummary === "object" && data.envelopeSummary !== null
      ? data.envelopeSummary
      : {}
  ) as Record<string, unknown>;

  const envelopeId =
    (typeof data.envelopeId === "string" && data.envelopeId) ||
    (typeof b.envelopeId === "string" && b.envelopeId) ||
    null;
  if (!envelopeId) return null;

  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  return {
    envelopeId,
    event: str(b.event) ?? "unknown",
    status: str(summary.status) ?? null,
    completedAt: str(summary.completedDateTime),
    voidedAt: str(summary.voidedDateTime),
    accountId: str(data.accountId),
  };
}

/**
 * The envelope status word to fold into the lifecycle: the summary's own
 * status when the payload carried one, else derived from Connect's event
 * name (`envelope-completed` → `completed`). Both spellings reach
 * `mapEnvelopeStatus`, which ignores anything it does not know.
 */
export function statusFromConnect(facts: ConnectEventFacts): string {
  return facts.status ?? facts.event.replace(/^envelope-/, "");
}

/**
 * The safe subset of a Connect delivery that the ledger stores. Never the
 * raw payload: Connect bodies carry recipient PII, and with
 * `includeDocuments` misconfigured, entire signed PDFs.
 */
export function summarizeConnectPayload(facts: ConnectEventFacts): Record<string, unknown> {
  return {
    event: facts.event,
    status: facts.status,
    completed_at: facts.completedAt,
    voided_at: facts.voidedAt,
    account_id: facts.accountId,
  };
}

/* ─────────────────────────── provisioning intent ─────────────────────────── */

export type AgreementProvisionFacts = {
  id: string;
  status: string;
  provision_on_signature: boolean;
  provision_status: string;
  plan_slug: string | null;
  module_ids: string[];
  addon_slugs: string[];
  excluded_module_ids: string[];
  admin_email: string | null;
  client_email: string;
  client_name: string;
  client_org: string | null;
  created_by: string | null;
};

export type ProvisionDecision =
  | { action: "provision" }
  | { action: "skip"; reason: ProvisionSkipReason; detail: string };

export type ProvisionSkipReason =
  | "not_armed"
  | "not_signed"
  | "already_done"
  | "in_flight"
  | "failed_needs_operator"
  | "no_plan"
  | "no_actor";

/**
 * Whether a signature may start provisioning. Every refusal is named — a
 * skipped agreement must be explainable from its row alone.
 *
 * `failed` does NOT retry automatically: a provisioning failure needs a
 * person to look before external resources are attempted again. The operator
 * retriggers from the agreement row once the cause is fixed.
 */
export function decideProvisionOnSignature(a: AgreementProvisionFacts): ProvisionDecision {
  if (!a.provision_on_signature) {
    return {
      action: "skip",
      reason: "not_armed",
      detail: "Agreement was not armed to provision on signature",
    };
  }
  if (a.status !== "signed") {
    return {
      action: "skip",
      reason: "not_signed",
      detail: `Agreement status is ${a.status}, not signed`,
    };
  }
  if (a.provision_status === "provisioned") {
    return { action: "skip", reason: "already_done", detail: "Already provisioned" };
  }
  if (a.provision_status === "provisioning") {
    return { action: "skip", reason: "in_flight", detail: "Provisioning already in flight" };
  }
  if (a.provision_status === "failed") {
    return {
      action: "skip",
      reason: "failed_needs_operator",
      detail: "A previous attempt failed — retrigger from the agreement once the cause is fixed",
    };
  }
  if (!a.plan_slug) {
    return { action: "skip", reason: "no_plan", detail: "No tier plan recorded on the agreement" };
  }
  if (!a.created_by) {
    return {
      action: "skip",
      reason: "no_actor",
      detail: "Agreement has no recorded creator to attribute the clone to",
    };
  }
  return { action: "provision" };
}

/**
 * The module set actually installed: the selection minus the named
 * exclusions. Order of the selection is preserved; an exclusion that names a
 * module outside the selection is inert (it documents the negotiation, and
 * guards against a later reconciliation re-adding it).
 */
export function effectiveModuleIds(moduleIds: string[], excludedIds: string[]): string[] {
  const excluded = new Set(excludedIds);
  return moduleIds.filter((id) => !excluded.has(id));
}

/* ───────────────────────────── clone identity ───────────────────────────── */

const RESERVED_SLUG = /^(admin|api|www|mail|prime|mission-control)$/;

export function slugifyCloneName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  if (!slug || RESERVED_SLUG.test(slug)) return slug ? `${slug}-clone` : "";
  return slug;
}

/**
 * The clone's name and slug from the agreement: the organisation when one
 * was recorded, the client's own name otherwise. Returns null when nothing
 * usable exists — a clone named "" is not a fallback.
 */
export function deriveCloneIdentity(a: {
  client_org: string | null;
  client_name: string;
}): { name: string; slug: string } | null {
  const name = (a.client_org ?? "").trim() || a.client_name.trim();
  if (!name) return null;
  const slug = slugifyCloneName(name);
  if (!slug) return null;
  return { name, slug };
}

/** First free slug: base, base-2, base-3 … against the taken set. */
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  // 98 collisions on one name is not a naming problem any more.
  return `${base}-${Date.now().toString(36)}`;
}
