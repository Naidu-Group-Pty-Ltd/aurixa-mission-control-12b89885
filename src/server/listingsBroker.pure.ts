/**
 * Brokering the Listings & Overview Airtable read, instead of handing every
 * tenant the token.
 *
 * ## Why this exists
 *
 * The Listings and Overview pages are built from one Airtable table —
 * `Property Intake Master` in the `NPC Emails` base — and every clone shows
 * the SAME marketplace, so every clone needs the same token and the same base
 * id. The fleet-wide answer to "same credential everywhere" was to forward it,
 * and `prime_secret_forwards` still carries all six names with `inherit: true`.
 *
 * Forwarding is the wrong answer here for three measured reasons, and only the
 * first is about secrecy:
 *
 * **1. An Airtable personal access token carries its whole scope, not one
 * table.** A PAT is minted against a set of bases and a set of scopes; nothing
 * in the credential narrows it to `Property Intake Master`. A token on a
 * tenant's Supabase project can therefore reach every base and every table its
 * scope admits — and if that scope includes `data.records:write`, it can
 * REWRITE the shared intake table that every other clone reads. This broker
 * makes the question moot rather than answering it: the token never leaves
 * Mission Control, so its scope stops being a fleet risk and becomes an
 * account detail.
 *
 * **2. One base has one rate limit, and it is 5 requests a second.** A cold
 * Listings read is `ceil(N/100)` SEQUENTIAL pages. Forwarded, every clone
 * walks independently against a budget none of them can see, and one clone
 * refreshing its cache starves the others — a failure that presents as "the
 * Listings page is empty" on a deployment that did nothing wrong. Brokered,
 * every fleet request passes through one place, which is the only place a
 * shared budget can actually be respected.
 *
 * **3. Rotation.** A forwarded token is rotated by re-forwarding to every
 * clone and hoping each one took it. A brokered one is rotated in Mission
 * Control's environment, once, and the fleet is correct on the next request.
 *
 * ## The rules, in the order they matter
 *
 * **1. The BASE is Mission Control's, and the caller never names one.** This
 * is the same rule the verification broker states first, inverted for a read
 * API. There, "nothing readable is brokered" was the protection; here every
 * operation is a read, so that protection is unavailable and the base id has
 * to carry it instead. A broker that accepted a caller's base would let any
 * tenant read every base the token can reach — the identical leak, reached
 * through the thing built to close it, and it would look like a fix.
 *
 * **2. The TABLE is resolved against an allow-list held here.** The same rule
 * one level down. `AIRTABLE_TABLE_ALLOWLIST` used to be a guard inside the
 * prime's `airtable-proxy`, where it constrained a deployment that already
 * held the token and could ignore it. Held here it constrains a caller that
 * holds nothing.
 *
 * **3. Read-only by construction.** This module can only ever describe a GET.
 * There is no code path that issues any other verb, so a token that happens to
 * carry `data.records:write` still cannot be used to mutate the shared table
 * from a clone. The guarantee is structural rather than a check somebody can
 * forget.
 *
 * **4. The query is an allow-list of five parameters.** Taken from what the
 * two real callers actually send — `airtable-proxy` and `listings-cache` —
 * rather than from what Airtable accepts. `filterByFormula` is deliberately
 * NOT among them: it is a query language, and a query language reaching a
 * shared table through a credential the caller does not hold is an exfiltration
 * primitive with a friendly name.
 *
 * **5. No caller header reaches Airtable and no Airtable header returns.** A
 * proxy that passes headers through is a confused deputy, and Airtable's own
 * response headers carry rate-limit facts about the FLEET that no single
 * tenant is entitled to read.
 */

/** The base and table are never the caller's. This is what the caller may name. */
export type ListingsOperation = "tables" | "records" | "selftest";

export const LISTINGS_OPERATIONS: readonly ListingsOperation[] = [
  "tables",
  "records",
  /*
   * `selftest` is a `records` read of ONE row whose records are discarded.
   *
   * Configuration is not reachability — the rule the verification self-test
   * was built for, after every readiness reading on three tenants came back
   * green on deployments that had never completed a verification. The only
   * way to know the token, the base id and the table name resolve TOGETHER is
   * to ask Airtable, so this asks.
   *
   * It differs from the Didit self-test in what counts as a pass. There, the
   * call was deliberately incomplete so the vendor would reject it for free,
   * and being REJECTED was the pass. Airtable charges nothing per request
   * (flat subscription, and the rate row records a real cost of zero), so a
   * bounded read costs nothing to make and being ACCEPTED is the pass.
   *
   * It returns a verdict and never a record: an operator checking wiring is
   * not asking to see a customer's listing.
   */
  "selftest",
] as const;

export function isListingsOperation(v: string): v is ListingsOperation {
  return (LISTINGS_OPERATIONS as readonly string[]).includes(v);
}

/**
 * Airtable's own ceiling, and the reason `pageSize` is bounded rather than
 * relayed: a caller asking for more gets a 422 from the vendor, which reads to
 * an operator as a broker fault rather than a caller one.
 */
export const MAX_PAGE_SIZE = 100;

/** Airtable's pagination cursor is opaque and base64url-ish; bound it, never parse it. */
export const MAX_OFFSET_LENGTH = 512;

/** A field name long enough for any real column and short enough to bound a URL. */
export const MAX_SORT_FIELD_LENGTH = 200;

export type ListingsQuery = {
  /** Resolved against the allow-list by the caller of `brokeredUrl`, never used raw. */
  readonly table?: string;
  readonly pageSize?: number;
  readonly offset?: string;
  readonly sortField?: string;
  readonly sortDirection?: "asc" | "desc";
};

export type QueryRefusal = { readonly error: string; readonly message: string };

/**
 * Validate what the caller sent, and say which parameter is wrong.
 *
 * Returns null when the query is acceptable. A refusal names the parameter
 * because "bad request" on a five-parameter contract sends an operator to read
 * code, and every one of these is a caller mistake rather than a vendor one.
 */
export function refuseQuery(q: ListingsQuery): QueryRefusal | null {
  if (q.pageSize !== undefined) {
    if (!Number.isInteger(q.pageSize) || q.pageSize < 1 || q.pageSize > MAX_PAGE_SIZE) {
      return {
        error: "invalid_page_size",
        message: `pageSize must be an integer between 1 and ${MAX_PAGE_SIZE}.`,
      };
    }
  }
  if (q.offset !== undefined && q.offset.length > MAX_OFFSET_LENGTH) {
    return { error: "invalid_offset", message: "offset is longer than Airtable ever issues." };
  }
  if (q.sortField !== undefined && q.sortField.length > MAX_SORT_FIELD_LENGTH) {
    return { error: "invalid_sort_field", message: "sortField is longer than any real column." };
  }
  if (q.sortDirection !== undefined && q.sortDirection !== "asc" && q.sortDirection !== "desc") {
    return { error: "invalid_sort_direction", message: "sortDirection must be asc or desc." };
  }
  return null;
}

/**
 * Parse `AIRTABLE_TABLE_ALLOWLIST` into a set.
 *
 * Comma-separated, trimmed, empties dropped. An EMPTY allow-list means "the
 * default table only" and never "everything": a broker whose allow-list failed
 * to load must narrow, not widen — the opposite default is how a
 * misconfiguration becomes an open proxy.
 */
export function parseAllowlist(raw: string | undefined | null): ReadonlySet<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Which table this request is for, or a refusal.
 *
 * The default table is always permitted — it is the one the pipeline exists to
 * read, and requiring it to appear in its own allow-list is a configuration
 * trap. Anything else must be named explicitly.
 */
export function resolveTable(
  requested: string | undefined,
  defaultTable: string,
  allowlist: ReadonlySet<string>,
): { table: string } | QueryRefusal {
  const want = (requested ?? "").trim();
  if (!want) return { table: defaultTable };
  if (want === defaultTable) return { table: defaultTable };
  if (allowlist.has(want)) return { table: want };
  return {
    error: "table_not_allowed",
    message:
      "That table is not on this deployment's Airtable allow-list. The allow-list is held in " +
      "Mission Control and a clone cannot widen it.",
  };
}

export const AIRTABLE_API_BASE = "https://api.airtable.com/v0";

/**
 * The URL this operation reads, built from Mission Control's base id.
 *
 * `baseId` is a parameter of this function and never of the request. Every
 * call site passes Mission Control's own, and there is no overload that takes
 * one from a caller — which is rule 1 expressed as a type rather than as a
 * comment.
 */
export function brokeredUrl(
  operation: ListingsOperation,
  baseId: string,
  table: string,
  q: ListingsQuery,
): string {
  if (operation === "tables") {
    return `${AIRTABLE_API_BASE}/meta/bases/${encodeURIComponent(baseId)}/tables`;
  }
  const url = new URL(
    `${AIRTABLE_API_BASE}/${encodeURIComponent(baseId)}/${encodeURIComponent(table)}`,
  );
  url.searchParams.set("pageSize", String(q.pageSize ?? MAX_PAGE_SIZE));
  if (q.offset) url.searchParams.set("offset", q.offset);
  if (q.sortField) {
    url.searchParams.set("sort[0][field]", q.sortField);
    url.searchParams.set("sort[0][direction]", q.sortDirection ?? "desc");
  }
  return url.toString();
}

/**
 * The only headers that go to Airtable.
 *
 * Built here rather than derived from the request, so no caller header can
 * reach the vendor and the credential appears in exactly one place.
 */
export function outboundHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

/**
 * Mark a refusal as Mission Control's own.
 *
 * The same header the verification broker uses, for the same reason: a clone
 * has to tell "Mission Control would not serve me" from "Airtable answered",
 * because they share status codes and send an operator to opposite remedies.
 * Only this side ever sets it, so its ABSENCE identifies a relayed answer.
 */
export function refusalHeaders(error: string): HeadersInit {
  return { "Content-Type": "application/json", "x-mission-control-refusal": error };
}
