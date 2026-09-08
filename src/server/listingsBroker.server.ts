/**
 * The privileged half of the Listings Airtable broker.
 *
 * Mission Control holds the one Property Intake Master token and base id. A
 * clone presents its own Mission Control key, names an OPERATION, and this
 * makes the read on its behalf — so no tenant ever holds a credential whose
 * scope reaches beyond the one table the marketplace is built from.
 *
 * The policy — which operations, which query parameters, which headers, and
 * why each rule is there — is `listingsBroker.pure.ts`.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { ensureTenant } from "./clone-api-keys.server";
import {
  brokeredUrl,
  outboundHeaders,
  parseAllowlist,
  refusalHeaders,
  refuseQuery,
  resolveTable,
  type ListingsOperation,
  type ListingsQuery,
} from "./listingsBroker.pure";

/** The vendor name this call spends, as `api_provider_rates` knows it. */
const SECRET_NAME = "AIRTABLE_TOKEN";

/**
 * Airtable answers a page in well under a second. Twenty seconds is the same
 * ceiling `listings-cache` already uses for its own direct walk, so a brokered
 * page cannot be slower to fail than an unbrokered one was.
 */
const UPSTREAM_TIMEOUT_MS = 20_000;

export type ListingsBrokerOutcome = {
  response: Response;
  detail: {
    operation: string;
    table: string | null;
    upstream_status: number | null;
    refused: string | null;
    billed: boolean;
  };
};

const json = (body: { ok: false; error: string; message: string }, status: number) =>
  new Response(JSON.stringify(body), { status, headers: refusalHeaders(body.error) });

/**
 * Mission Control's own Airtable configuration for the Listings pipeline.
 *
 * Read here and nowhere else. `AIRTABLE_API_KEY` is deliberately NOT consulted:
 * that name is already taken in this application for the Aurixa Waitlist base
 * (`airtable-sync.server.ts`, base `apptyShYE0yzL4IGB`, through the Lovable
 * connector gateway) and it is a different credential against a different base.
 * Two meanings on one name is how a token that works for one job silently does
 * the wrong thing for another.
 */
function config() {
  return {
    token: (process.env.AIRTABLE_TOKEN ?? "").trim(),
    baseId: (process.env.AIRTABLE_BASE_ID ?? "").trim(),
    defaultTable: (process.env.AIRTABLE_TABLE_NAME ?? "").trim(),
    allowlist: parseAllowlist(process.env.AIRTABLE_TABLE_ALLOWLIST),
  };
}

/**
 * Which half of the configuration is missing, in the operator's terms.
 *
 * Named rather than collapsed into "not configured", because the two halves
 * are set in different places for different reasons and an operator handed the
 * generic message has to go and read code to find out which one to fix.
 */
function unconfigured(c: ReturnType<typeof config>): string | null {
  if (!c.token && !c.baseId)
    return "AIRTABLE_TOKEN and AIRTABLE_BASE_ID are not set on Mission Control.";
  if (!c.token) return "AIRTABLE_TOKEN is not set on Mission Control.";
  if (!c.baseId) return "AIRTABLE_BASE_ID is not set on Mission Control.";
  if (!c.defaultTable) return "AIRTABLE_TABLE_NAME is not set on Mission Control.";
  return null;
}

export async function brokerListingsRead(input: {
  operation: string;
  query: ListingsQuery;
  cloneId: string | null;
  tenantRef: string;
}): Promise<ListingsBrokerOutcome> {
  const fail = (error: string, message: string, status: number): ListingsBrokerOutcome => ({
    response: json({ ok: false, error, message }, status),
    detail: {
      operation: input.operation,
      table: null,
      upstream_status: null,
      refused: error,
      billed: false,
    },
  });

  const operation = input.operation as ListingsOperation;
  if (operation !== "tables" && operation !== "records" && operation !== "selftest") {
    return fail(
      "unknown_operation",
      "Only `tables`, `records` and `selftest` are brokered. The base and table are Mission Control's; a caller names neither.",
      404,
    );
  }

  const c = config();
  const missing = unconfigured(c);
  if (missing) return fail("not_configured", missing, 503);

  const badQuery = refuseQuery(input.query);
  if (badQuery) return fail(badQuery.error, badQuery.message, 400);

  const resolved = resolveTable(input.query.table, c.defaultTable, c.allowlist);
  if ("error" in resolved) return fail(resolved.error, resolved.message, 403);

  // A self-test is a one-row `records` read. Bounding it here rather than
  // trusting the caller's `pageSize` is what keeps it cheap by construction.
  const effective: ListingsQuery = operation === "selftest" ? { pageSize: 1 } : input.query;
  const url = brokeredUrl(
    operation === "selftest" ? "records" : operation,
    c.baseId,
    resolved.table,
    effective,
  );

  let upstream: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    // GET, always. There is no branch here that issues another verb — which is
    // what makes "read-only" a property of the code rather than a promise.
    upstream = await fetch(url, {
      method: "GET",
      headers: outboundHeaders(c.token),
      signal: controller.signal,
    });
  } catch {
    // Deliberately no error detail: a fetch failure message can carry the URL,
    // and the URL carries the base id a caller is not entitled to learn.
    return fail("upstream_unreachable", "Airtable could not be reached from Mission Control.", 502);
  } finally {
    clearTimeout(timer);
  }

  const text = await upstream.text();

  /*
   * Billed on a 2xx and only a 2xx. A refusal is still RECORDED at quantity 0
   * so a clone walking a failing table is visible rather than invisible.
   */
  const billed = upstream.ok;
  await recordBrokeredUsage({
    cloneId: input.cloneId,
    tenantRef: input.tenantRef,
    operation,
    table: resolved.table,
    quantity: billed ? 1 : 0,
    status: billed ? "success" : "error",
    upstreamStatus: upstream.status,
  });

  /*
   * Airtable's 429 is about the BASE, which is a fleet resource shared by every
   * clone and the prime. It is relayed as our own refusal with our own hint,
   * because the vendor's `Retry-After` describes the fleet's standing and the
   * clone that receives it did not necessarily cause it.
   */
  if (upstream.status === 429) {
    const res = json(
      {
        ok: false,
        error: "airtable_rate_limited",
        message:
          "The Property Intake Master base is at its rate limit. This base is shared by the whole fleet; retry shortly.",
      },
      429,
    );
    res.headers.set("Retry-After", "2");
    return {
      response: res,
      detail: {
        operation,
        table: resolved.table,
        upstream_status: 429,
        refused: "airtable_rate_limited",
        billed: false,
      },
    };
  }

  if (operation === "selftest") {
    // A verdict, never a record. `reachable` is the whole answer; the table it
    // resolved is named because "which table did it actually read" is the
    // question an operator asks next, and the base id is deliberately absent
    // because a caller is not entitled to learn it from a health check.
    let rows: number | null = null;
    try {
      rows = Array.isArray(JSON.parse(text)?.records) ? JSON.parse(text).records.length : null;
    } catch {
      rows = null;
    }
    return {
      response: new Response(
        JSON.stringify({
          ok: upstream.ok,
          reachable: upstream.ok,
          table: resolved.table,
          records_visible: rows,
          upstream_status: upstream.status,
        }),
        { status: upstream.ok ? 200 : 502, headers: { "Content-Type": "application/json" } },
      ),
      detail: {
        operation,
        table: resolved.table,
        upstream_status: upstream.status,
        refused: upstream.ok ? null : "selftest_failed",
        billed,
      },
    };
  }

  return {
    // Status and body only. Airtable's own headers describe the FLEET's
    // standing with the vendor and are not a tenant's to read.
    response: new Response(text, {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    }),
    detail: {
      operation,
      table: resolved.table,
      upstream_status: upstream.status,
      refused: null,
      billed,
    },
  };
}

/**
 * Attribute the read to the tenant that made it.
 *
 * **This can never fail the read.** A blank Listings page because a billing row
 * would not write is the same trade this platform already refused for
 * verification and for compliance reminders. A metering fault is logged and the
 * page is served.
 */
async function recordBrokeredUsage(input: {
  cloneId: string | null;
  tenantRef: string;
  operation: string;
  table: string;
  quantity: number;
  status: "success" | "error";
  upstreamStatus: number;
}): Promise<void> {
  try {
    // `clones` has no `tenant_id` column — the tenant is resolved (and created
    // on first use) by the same helper every other metered path here uses, so
    // a brokered Airtable read attributes exactly like a brokered verification.
    const tenant = await ensureTenant(input.cloneId, input.tenantRef);
    if (!tenant.ok) {
      console.error(`[listings-broker] tenant resolve failed: ${tenant.error}`);
      return;
    }

    const { error } = await supabaseAdmin.rpc("record_api_usage_event", {
      _tenant_id: tenant.tenantId,
      _clone_id: input.cloneId as unknown as string,
      _secret_name: SECRET_NAME,
      _quantity: input.quantity,
      _idempotency_key: `airtable-broker:${crypto.randomUUID()}`,
      _feature: `listings:${input.operation}`,
      _call_status: input.status,
      _occurred_at: new Date().toISOString(),
      _metadata: {
        upstream_status: input.upstreamStatus,
        brokered: true,
        table: input.table,
      } as never,
    });
    if (error) console.error(`[listings-broker] usage write failed: ${error.message}`);
  } catch (e) {
    console.error(
      `[listings-broker] usage write threw: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
