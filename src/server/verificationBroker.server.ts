/**
 * The privileged half of the verification broker.
 *
 * Mission Control holds the single Didit key. A clone presents its own Mission
 * Control key, names one of three operations, and this makes the vendor call
 * on its behalf — so no tenant ever holds a credential that can read another
 * tenant's verifications. The policy (which operations, which headers, what
 * ceiling, and why each rule exists) is `verificationBroker.pure.ts`.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  brokerRefusal,
  brokeredPath,
  inboundHeaders,
  outboundHeaders,
  refusalHeaders,
  MAX_BROKERED_BODY_BYTES,
} from "./verificationBroker.pure";

const DEFAULT_BASE = "https://verification.didit.me";

/** The vendor name this call spends, as the usage rating knows it. */
const SECRET_NAME = "DIDIT_API_KEY";

export type BrokerOutcome = {
  response: Response;
  /** Recorded for the audit breadcrumb. Never includes a body or a header. */
  detail: {
    operation: string;
    upstream_status: number | null;
    refused: string | null;
    billed: boolean;
    bytes: number | null;
  };
};

/**
 * A refusal Mission Control is making itself.
 *
 * Every one of them carries the refusal header, so a clone can tell this
 * apart from the vendor's own answer relayed through — see `refusalHeaders`.
 * `error` is repeated in the header rather than only in the body because a
 * caller must not have to parse a body to learn who said no.
 */
const json = (body: { ok: false; error: string; message: string }, status: number) =>
  new Response(JSON.stringify(body), { status, headers: refusalHeaders(body.error) });

/**
 * Read the body with the ceiling enforced on what ARRIVES.
 *
 * `content-length` is a claim by the caller; a chunked upload carries none at
 * all. Checking the declared length first is a cheap early refusal, and this
 * is the one that actually holds.
 */
async function readBounded(request: Request): Promise<ArrayBuffer | null> {
  const buf = await request.arrayBuffer();
  return buf.byteLength > MAX_BROKERED_BODY_BYTES ? null : buf;
}

export async function brokerVerification(input: {
  request: Request;
  operation: string;
  cloneId: string | null;
  /** External reference for the usage tenant. Defaults to the clone itself. */
  tenantRef: string;
}): Promise<BrokerOutcome> {
  const contentType = input.request.headers.get("content-type");
  const declared = Number(input.request.headers.get("content-length") ?? "");

  const refusal = brokerRefusal({
    operation: input.operation,
    contentType,
    declaredBytes: Number.isFinite(declared) ? declared : null,
  });
  if (refusal) {
    return {
      response: json({ ok: false, error: refusal.reason, message: refusal.message }, 400),
      detail: {
        operation: input.operation,
        upstream_status: null,
        refused: refusal.reason,
        billed: false,
        bytes: null,
      },
    };
  }

  const path = brokeredPath(input.operation) as string;

  const apiKey = (process.env.DIDIT_API_KEY ?? "").trim();
  if (!apiKey) {
    /*
     * 503 rather than 500, and named. Mission Control holding no Didit key is
     * an operator state with a remedy — set it here — not a fault in the
     * tenant's request. The tenant is told the broker is unconfigured and
     * never told anything about the credential.
     */
    return {
      response: json(
        { ok: false, error: "broker_not_configured", message: "Verification brokering is not configured on Mission Control." },
        503,
      ),
      detail: {
        operation: input.operation,
        upstream_status: null,
        refused: "broker_not_configured",
        billed: false,
        bytes: null,
      },
    };
  }

  const body = await readBounded(input.request);
  if (!body) {
    return {
      response: json(
        {
          ok: false,
          error: "body_too_large",
          message: `Request body exceeds the broker ceiling of ${MAX_BROKERED_BODY_BYTES} bytes.`,
        },
        413,
      ),
      detail: {
        operation: input.operation,
        upstream_status: null,
        refused: "body_too_large",
        billed: false,
        bytes: null,
      },
    };
  }

  const base = (process.env.DIDIT_API_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, "");

  let upstream: Response;
  try {
    upstream = await fetch(`${base}${path}`, {
      method: "POST",
      headers: outboundHeaders({ contentType: contentType as string, apiKey }),
      body,
    });
  } catch (e) {
    /*
     * The vendor was unreachable. 502 with a category the clone's own error
     * classifier already understands as "provider unavailable" — never as a
     * customer who failed verification, which is the distinction
     * `DiditStandaloneError` exists to preserve end to end.
     */
    return {
      response: json(
        {
          ok: false,
          error: "upstream_unreachable",
          message: e instanceof Error ? e.message.slice(0, 200) : "upstream request failed",
        },
        502,
      ),
      detail: {
        operation: input.operation,
        upstream_status: null,
        refused: "upstream_unreachable",
        billed: false,
        bytes: body.byteLength,
      },
    };
  }

  const text = await upstream.text();

  /*
   * Billed on a 2xx and only a 2xx, because that is what the vendor charges
   * for. A refusal is still RECORDED — quantity 0, status error — so a tenant
   * hammering a failing endpoint is visible rather than invisible.
   */
  const billed = upstream.ok;
  await recordBrokeredUsage({
    cloneId: input.cloneId,
    tenantRef: input.tenantRef,
    operation: input.operation,
    quantity: billed ? 1 : 0,
    status: billed ? "success" : "error",
    upstreamStatus: upstream.status,
  });

  return {
    // Status and body only. Didit's own headers describe the FLEET's standing
    // with the vendor and are not a tenant's to read.
    response: new Response(text, { status: upstream.status, headers: inboundHeaders() }),
    detail: {
      operation: input.operation,
      upstream_status: upstream.status,
      refused: null,
      billed,
      bytes: body.byteLength,
    },
  };
}

/**
 * Attribute the call to the tenant that made it.
 *
 * **This can never fail the verification.** A customer's identity check must
 * not fail because a billing row would not write — the platform's own rule for
 * `complianceReminders`, applied here. A metering fault is logged and the
 * verification stands; the alternative bills nobody AND serves nobody.
 *
 * One event per call, with a fresh idempotency key, because the standalone
 * client deliberately never retries a request whose response it did not see —
 * so two calls are always two billable acts and never a duplicate.
 */
async function recordBrokeredUsage(input: {
  cloneId: string | null;
  tenantRef: string;
  operation: string;
  quantity: number;
  status: "success" | "error";
  upstreamStatus: number;
}): Promise<void> {
  try {
    const { ensureTenant } = await import("./clone-api-keys.server");
    const tenant = await ensureTenant(input.cloneId, input.tenantRef);
    if (!tenant.ok) {
      console.error(`[verification-broker] tenant resolve failed: ${tenant.error}`);
      return;
    }
    const { error } = await supabaseAdmin.rpc("record_api_usage_event", {
      _tenant_id: tenant.tenantId,
      _clone_id: input.cloneId as unknown as string,
      _secret_name: SECRET_NAME,
      _quantity: input.quantity,
      _idempotency_key: `didit-broker:${crypto.randomUUID()}`,
      _feature: input.operation,
      _call_status: input.status,
      _occurred_at: new Date().toISOString(),
      _metadata: { upstream_status: input.upstreamStatus, brokered: true } as never,
    });
    if (error) console.error(`[verification-broker] usage write failed: ${error.message}`);
  } catch (e) {
    console.error(
      `[verification-broker] usage write threw: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
