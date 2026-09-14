/**
 * Mission Control's half of the network operator plane (extraction plan §5).
 *
 * The console at /builders-network/* drives the NETWORK's admin API
 * (`builder-network-admin`) — approval, suspension, the workspace
 * directory, connection minting. Two rules shape how the call travels:
 *
 *  * **MC never holds the network's service-role key.** Authority is the
 *    federation assertion: RS256 over the platform signing key, `aud`
 *    bound to the network's origin, scopes exactly `['builders:operate']`.
 *    The network verifies offline against our published JWKS.
 *
 *  * **The switch is a key row, and revoking it is the rollback.** The plan
 *    names "a NULL-clone key scoped builders:operate": a `clone_api_keys`
 *    row with `clone_id IS NULL` carrying that scope. Nobody types the
 *    plaintext anywhere — the ROW's live existence is the policy that
 *    permits minting, so the existing key-revocation surface is the off
 *    switch for this entire console, with an audit trail it already owns.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { signCloneAssertion, signingKeyPresent } from "./anthropicOidc.server";
import { BUILDERS_AUDIENCE } from "./buildersFederation.pure";

export const OPERATE_SCOPE = "builders:operate";

export type OperateSwitch =
  | { enabled: true; keyId: string; label: string | null }
  | { enabled: false; reason: "no_live_operate_key" | "read_failed" };

/** The revocable switch: a live NULL-clone key carrying builders:operate. */
export async function operateSwitch(): Promise<OperateSwitch> {
  const { data, error } = await supabaseAdmin
    .from("clone_api_keys")
    .select("id, label, scopes, revoked_at")
    .is("clone_id", null)
    .is("revoked_at", null)
    .contains("scopes", [OPERATE_SCOPE])
    .limit(1)
    .maybeSingle();
  if (error) return { enabled: false, reason: "read_failed" };
  if (!data) return { enabled: false, reason: "no_live_operate_key" };
  return { enabled: true, keyId: data.id, label: data.label ?? null };
}

/** Where the network's admin function answers. Refused by NAME when unset. */
export function networkAdminUrl(): string | null {
  const url = (process.env.BUILDERS_NETWORK_ADMIN_URL || "").trim().replace(/\/+$/, "");
  return url.startsWith("https://") ? url : null;
}

export type NetworkAdminResult =
  | { ok: true; status: number; body: Record<string, unknown> }
  | {
      ok: false;
      status: number;
      error:
        | "operate_switch_off"
        | "signing_key_missing"
        | "network_url_unconfigured"
        | "network_unreachable"
        | string;
    };

/**
 * Call one operation on the network's admin API.
 *
 * The assertion is minted fresh per call (five-minute registered expiry from
 * the signer) with the profile claims carrying ONLY the operate scope — the
 * narrowest true statement of what this caller is.
 */
export async function callBuilderNetworkAdmin(
  operation: string,
  payload: Record<string, unknown> = {},
): Promise<NetworkAdminResult> {
  const gate = await operateSwitch();
  if (!gate.enabled) return { ok: false, status: 403, error: "operate_switch_off" };
  if (!signingKeyPresent()) return { ok: false, status: 503, error: "signing_key_missing" };
  const url = networkAdminUrl();
  if (!url) return { ok: false, status: 503, error: "network_url_unconfigured" };

  const assertion = await signCloneAssertion({
    subject: "mission-control:operator",
    audience: BUILDERS_AUDIENCE,
    claims: { scopes: [OPERATE_SCOPE] },
  });

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${assertion}`,
      },
      body: JSON.stringify({ operation, ...payload }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    console.error("[builders-network-admin] network unreachable", error);
    return { ok: false, status: 502, error: "network_unreachable" };
  }

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: typeof body.error === "string" ? body.error : `http_${response.status}`,
    };
  }
  return { ok: true, status: response.status, body };
}
