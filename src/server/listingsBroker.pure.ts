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
 * **4. The query is an allow-list of parameters.** Taken from what the real
 * callers actually send — `airtable-proxy`, `listings-cache`, `listing-images`
 * and `auto-report-sync` — rather than from what Airtable accepts.
 * `filterByFormula` is deliberately NOT among them: it is a query language, and
 * a query language reaching a shared table through a credential the caller does
 * not hold is an exfiltration primitive with a friendly name.
 *
 * `recordIds` is the one read that NEEDS a formula, and it is admitted by
 * inverting who writes it. `listing-images` asks for the photograph columns of
 * the listings it has claimed, which Airtable spells
 * `filterByFormula=OR(RECORD_ID()='rec…',…)`. The caller sends IDS; each is
 * checked against `rec` plus fourteen alphanumerics; and Mission Control
 * composes the formula itself. So what crosses the boundary is a list of
 * opaque row handles — not an expression — and there is no input to this
 * module from which a caller could build one. That is the difference between
 * "the caller may name rows" and "the caller may ask questions", and only the
 * first is safe to broker.
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

/**
 * An Airtable record id: `rec` and fourteen alphanumerics.
 *
 * The whole safety of `recordIds` rests here. An id matching this can contain
 * no quote, no parenthesis, no comma and no operator, so a formula composed
 * from checked ids cannot be anything but the OR of record handles this broker
 * intended to write. The check is an allow-list of characters, never an escape
 * or a blocklist.
 */
export const AIRTABLE_RECORD_ID = /^rec[A-Za-z0-9]{14}$/;

/** How many records one read may name. Airtable's page cap is the same number. */
export const MAX_RECORD_IDS = 100;

export type ListingsQuery = {
  /** Resolved against the allow-list by the caller of `brokeredUrl`, never used raw. */
  readonly table?: string;
  readonly pageSize?: number;
  readonly offset?: string;
  readonly sortField?: string;
  readonly sortDirection?: "asc" | "desc";
  /** Row handles, never an expression. See `AIRTABLE_RECORD_ID`. */
  readonly recordIds?: readonly string[];
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
  if (q.recordIds !== undefined) {
    if (q.recordIds.length === 0) {
      return { error: "invalid_record_ids", message: "recordIds was sent with no ids in it." };
    }
    if (q.recordIds.length > MAX_RECORD_IDS) {
      return {
        error: "invalid_record_ids",
        message: `At most ${MAX_RECORD_IDS} records may be read at once; the caller chunks.`,
      };
    }
    if (q.recordIds.some((id) => !AIRTABLE_RECORD_ID.test(id))) {
      // Deliberately does not echo the offending value: it is caller-supplied
      // text and this message is written into logs an operator reads.
      return {
        error: "invalid_record_ids",
        message: "Every recordId must be an Airtable record id (rec + 14 alphanumerics).",
      };
    }
  }
  return null;
}

/**
 * Parse the wire form of `recordIds` — a comma-separated list — into ids.
 *
 * Splitting only. Nothing here decides whether an id is acceptable; that is
 * `refuseQuery`, so there is exactly one place the rule lives and the endpoint
 * cannot accidentally skip it by parsing leniently.
 */
export function parseRecordIds(raw: string | null | undefined): string[] | undefined {
  if (raw === null || raw === undefined) return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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
 * What KIND of credential Mission Control is holding — never any part of it.
 *
 * Airtable answers 401 with no detail, and from outside that one status covers
 * four completely different operator mistakes: a value that was never updated
 * in the running process, a legacy `key…` API key (Airtable retired those in
 * February 2024 and they now fail exactly like a bad token), a base or table id
 * pasted into the token field, and a genuine expiry or revocation. Measured 8
 * Sep 2026: the fleet's first brokered reads returned 401 five times over half
 * an hour with nothing anywhere able to say which of the four it was.
 *
 * The prefixes are Airtable's own published, public format markers — `pat`,
 * `key`, `app`, `tbl`. Naming the marker is not disclosure; it is the same
 * information a glance at the first three characters of a settings field gives,
 * and it converts an unfalsifiable 401 into a named remedy. Nothing here
 * returns, logs or derives any other part of the value, and there is
 * deliberately no length or checksum in the output — only the kind.
 */
export type CredentialShape =
  | "personal_access_token"
  | "legacy_api_key"
  | "base_id"
  | "table_id"
  | "unrecognised";

export type CredentialVerdict = {
  readonly shape: CredentialShape;
  /** Whether it matches the full published form for its kind, not merely the prefix. */
  readonly wellFormed: boolean;
  /** What an operator should do. Never contains any part of the credential. */
  readonly remedy: string;
};

/** `pat` + 14 alphanumerics + `.` + 64 alphanumerics — Airtable's published PAT form. */
const PAT = /^pat[A-Za-z0-9]{14}\.[A-Za-z0-9]{64}$/;

export function describeCredential(token: string): CredentialVerdict {
  const t = token.trim();
  if (t.length === 0) {
    return {
      shape: "unrecognised",
      wellFormed: false,
      remedy: "AIRTABLE_TOKEN is empty in Mission Control's environment.",
    };
  }
  if (t.startsWith("pat")) {
    return PAT.test(t)
      ? {
          shape: "personal_access_token",
          wellFormed: true,
          remedy:
            "The value is a well-formed Airtable personal access token, so Airtable is refusing " +
            "the token itself rather than its shape. Four causes, in the order they actually " +
            "occur: it belongs to a DIFFERENT Airtable account from the one that owns this base " +
            "— a perfectly valid token fails here if it was minted in the wrong account, and " +
            "this fleet has more than one; Mission Control has not been redeployed since the " +
            "value was changed, so the running process still holds the old one; the token lacks " +
            "data.records:read and schema.bases:read, or does not list this base among its " +
            "bases; or it has been revoked or regenerated. Compare against the account the prime " +
            "reads with — its token works against this same base.",
        }
      : {
          shape: "personal_access_token",
          wellFormed: false,
          remedy:
            "The value begins `pat` but is not a complete Airtable personal access token — a " +
            "truncated paste, or surrounding quotes or whitespace carried in with it.",
        };
  }
  if (t.startsWith("key")) {
    return {
      shape: "legacy_api_key",
      wellFormed: false,
      remedy:
        "That is a legacy Airtable API key (`key…`). Airtable retired those in February 2024 and " +
        "they now fail exactly like an invalid token. Mint a personal access token (`pat…`) with " +
        "data.records:read and schema.bases:read on this base.",
    };
  }
  if (t.startsWith("app")) {
    return {
      shape: "base_id",
      wellFormed: false,
      remedy:
        "That is an Airtable BASE id (`app…`), not a token — it belongs in AIRTABLE_BASE_ID. " +
        "AIRTABLE_TOKEN needs a personal access token (`pat…`).",
    };
  }
  if (t.startsWith("tbl")) {
    return {
      shape: "table_id",
      wellFormed: false,
      remedy:
        "That is an Airtable TABLE id (`tbl…`), not a token — it belongs in AIRTABLE_TABLE_NAME. " +
        "AIRTABLE_TOKEN needs a personal access token (`pat…`).",
    };
  }
  return {
    shape: "unrecognised",
    wellFormed: false,
    remedy:
      "The value does not begin with any Airtable identifier prefix (`pat`, `key`, `app`, `tbl`). " +
      "It may be a different vendor's credential, or the wrong secret entirely.",
  };
}

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
  if (q.recordIds && q.recordIds.length > 0) {
    // Mission Control writes the formula; the caller only named rows. Checked
    // again here rather than trusted from the endpoint, because this function
    // is what actually reaches the vendor and a second reader of the same rule
    // costs nothing.
    if (q.recordIds.some((id) => !AIRTABLE_RECORD_ID.test(id))) {
      throw new Error("brokeredUrl refused a recordId that is not an Airtable record id");
    }
    url.searchParams.set(
      "filterByFormula",
      `OR(${q.recordIds.map((id) => `RECORD_ID()='${id}'`).join(",")})`,
    );
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
 * Names this endpoint on EVERY answer it produces — a refusal and a relay
 * alike.
 *
 * `x-mission-control-refusal` answers "did Mission Control refuse me, or did
 * Airtable?", and it answers it well. It cannot answer the question one step
 * further out: **did the request reach Mission Control at all?** A refusal
 * carries the header, a relayed vendor failure deliberately does not — and
 * neither does a 404 from some other host that `MISSION_CONTROL_URL` happens
 * to name. So a clone pointed at the wrong origin reads its own
 * misconfiguration as "Airtable said 404", which is the shape of a
 * marketplace-wide outage, and it hunts the vendor.
 *
 * Measured 8 Sep 2026: one clone spent a morning at `airtable_404` with zero
 * requests arriving here, while the two beside it were served normally. There
 * was nothing in its record that could distinguish the two cases.
 *
 * So this header is a POSITIVE marker of arrival, and it is on everything —
 * which is exactly what makes its absence mean something. The rule it adds:
 * **no `x-mission-control-endpoint` on a brokered answer means the answer is
 * not Mission Control's**, whatever it says inside.
 *
 * It does not weaken the refusal header's rule; the two answer different
 * questions and both are needed. Ordering matters on the way out: this side
 * must be serving the header before a clone starts believing its absence,
 * which it will be, because Mission Control deploys on merge and the fleet
 * cascade takes hours.
 */
export const ENDPOINT_HEADER = "x-mission-control-endpoint";

/** The value that names this particular endpoint. */
export const LISTINGS_ENDPOINT = "listings";

/**
 * Headers for an answer Mission Control RELAYS from the vendor.
 *
 * No refusal header — that one stays reserved for our own no. Airtable's own
 * headers are not relayed either: they describe the FLEET's standing with the
 * vendor and are not a tenant's to read.
 */
export function relayHeaders(): HeadersInit {
  return { "Content-Type": "application/json", [ENDPOINT_HEADER]: LISTINGS_ENDPOINT };
}

/**
 * Mark a refusal as Mission Control's own.
 *
 * The same header the verification broker uses, for the same reason: a clone
 * has to tell "Mission Control would not serve me" from "Airtable answered",
 * because they share status codes and send an operator to opposite remedies.
 * Only this side ever sets the REFUSAL header, so its absence still identifies
 * a relayed answer — while the endpoint header above says the answer is ours
 * to relay in the first place.
 */
export function refusalHeaders(error: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    "x-mission-control-refusal": error,
    [ENDPOINT_HEADER]: LISTINGS_ENDPOINT,
  };
}
