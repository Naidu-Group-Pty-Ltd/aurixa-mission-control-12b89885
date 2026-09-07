/**
 * Brokering identity verification, instead of handing every tenant the key.
 *
 * ## Why this exists
 *
 * A Didit API key is scoped to an APPLICATION, and an application's session
 * list is readable by that key. Measured 7 Sep 2026 against the live account:
 * `GET …/application/{id}/sessions/` returns every session in the application
 * with the customer's full name, document type, country, and **live pre-signed
 * URLs to their passport portrait and their selfie**, valid four hours.
 *
 * Under the fleet-wide key decision that credential sat in the environment of
 * three separate tenant Supabase projects. No tenant's code called those
 * endpoints — but any tenant, or anyone who reached a tenant's project, could
 * have, and would have read every other tenant's customers' identity
 * documents. Didit publishes no API to create an application or mint a key, so
 * per-tenant credentials cannot be provisioned; and creating one by hand per
 * client is the manual step this whole control plane exists to abolish.
 *
 * So the credential stops travelling. Mission Control holds the one key and
 * makes the call on a tenant's behalf, exactly as it already does for token
 * spend and seat reservation. A clone presents the key it already has — its
 * own Mission Control key — and can reach nothing but the three operations
 * below, for itself.
 *
 * ## The rules, in the order they matter
 *
 * **1. The operation is an ALLOW-LIST, never a path the caller supplies.** A
 * broker that forwards a caller-chosen path is an open proxy onto the vendor's
 * entire API — including the session list this exists to make unreachable. Get
 * this wrong and the broker RECREATES the leak with a Mission Control key
 * instead of a Didit one, which is worse, because it would look like a fix.
 * Three operations are brokerable and every one of them is a WRITE that
 * creates a new verification; nothing readable is offered at all.
 *
 * **2. The vendor credential is added here and can never be influenced or
 * observed.** No caller header reaches Didit, no Didit header returns, and the
 * key appears in neither direction. A proxy that passes headers through is a
 * confused deputy — `authorization`, `cookie` and `x-api-key` are the obvious
 * ones, and the reason the rule is an allow-list rather than a block-list.
 *
 * **3. A body has a ceiling.** These are document photographs, a few megabytes
 * each. An unbounded proxy is a memory fault and a billing amplifier reachable
 * by any tenant, and the ceiling is checked before the body is read rather
 * than after.
 *
 * **4. The response is a status and a body, nothing else.** Didit's own
 * headers can carry rate-limit and account-level facts about the FLEET, and a
 * tenant is not entitled to those.
 */

/** The three calls the standalone verification sequence makes, and nothing else. */
export const BROKERED_OPERATIONS = {
  "id-verification": "/v3/id-verification/",
  "passive-liveness": "/v3/passive-liveness/",
  "face-match": "/v3/face-match/",
} as const;

export type BrokeredOperation = keyof typeof BROKERED_OPERATIONS;

/**
 * Resolve a caller-supplied operation name to a vendor path.
 *
 * Returns null for anything not on the list. Deliberately not a
 * transformation, a prefix check or a sanitiser: only a name that IS one of
 * the three resolves, so no input can express a path this module does not
 * already contain.
 */
export function brokeredPath(operation: string): string | null {
  return Object.prototype.hasOwnProperty.call(BROKERED_OPERATIONS, operation)
    ? BROKERED_OPERATIONS[operation as BrokeredOperation]
    : null;
}

/**
 * The largest request body a tenant may push through the broker.
 *
 * Didit's own document endpoints take a front and back image; 12 MB carries a
 * generous pair with room for the multipart envelope. It is a ceiling on the
 * BROKER, not a statement about what Didit accepts — the vendor's own limit
 * still applies behind it.
 */
export const MAX_BROKERED_BODY_BYTES = 12 * 1024 * 1024;

export type BrokerRefusal =
  | { reason: "unknown_operation"; message: string }
  | { reason: "body_too_large"; message: string }
  | { reason: "not_multipart"; message: string };

/**
 * Why this request may not be brokered, or null if it may.
 *
 * `declaredBytes` is `content-length`. A body arriving with no length is NOT
 * refused here — chunked uploads are legitimate — but the reader downstream
 * still enforces the same ceiling as it streams, because a declared length is
 * a claim by the caller and not a measurement.
 */
export function brokerRefusal(input: {
  operation: string;
  contentType: string | null;
  declaredBytes: number | null;
}): BrokerRefusal | null {
  if (!brokeredPath(input.operation)) {
    return {
      reason: "unknown_operation",
      message:
        `"${input.operation}" is not a brokered verification operation. ` +
        `Permitted: ${Object.keys(BROKERED_OPERATIONS).join(", ")}.`,
    };
  }
  const ct = (input.contentType ?? "").toLowerCase();
  if (!ct.startsWith("multipart/form-data")) {
    // The three vendor endpoints take multipart only. Refusing anything else
    // keeps the broker from being a general-purpose relay by accident.
    return {
      reason: "not_multipart",
      message: "A brokered verification request must be multipart/form-data.",
    };
  }
  if (input.declaredBytes != null && input.declaredBytes > MAX_BROKERED_BODY_BYTES) {
    return {
      reason: "body_too_large",
      message:
        `Request body ${input.declaredBytes} bytes exceeds the broker ceiling of ` +
        `${MAX_BROKERED_BODY_BYTES}.`,
    };
  }
  return null;
}

/**
 * The headers that travel TO the vendor, built here rather than forwarded.
 *
 * The multipart boundary lives in the caller's `content-type` and is the one
 * thing that must survive — a body split on a boundary the server does not
 * know is a 400 that reads like a malformed image. Everything else is ours.
 */
export function outboundHeaders(input: {
  contentType: string;
  apiKey: string;
}): Record<string, string> {
  return {
    "content-type": input.contentType,
    "x-api-key": input.apiKey,
    accept: "application/json",
  };
}

/**
 * Headers returned to the tenant. Deliberately just the content type.
 *
 * Didit's responses can carry rate-limit and account headers that describe the
 * FLEET's standing with the vendor, not this tenant's. Passing them through
 * would tell every tenant how much of a shared allowance the others had used.
 */
export function inboundHeaders(): Record<string, string> {
  return { "content-type": "application/json" };
}
