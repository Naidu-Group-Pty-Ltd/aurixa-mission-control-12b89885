/**
 * Ask a clone whether identity verification can actually reach the provider.
 *
 * ## Why the question has to be asked THERE
 *
 * Mission Control can prove its own half — it holds the Didit key and can
 * call the vendor directly — and that is not the question. On the brokered
 * route four things stand between a clone's edge function and an answer: the
 * clone's own Mission Control key, that key's scopes, Mission Control's Didit
 * credential, and the vendor. Only a call made from inside the clone crosses
 * all four.
 *
 * Every readiness reading either end holds was green on three tenants that
 * had never completed a single verification, which is the whole reason this
 * is a call rather than a flag.
 *
 * ## Why the webhook channel rather than a new one
 *
 * `mission-control-webhook` is the door Mission Control already has into a
 * clone: HMAC-signed with a secret this side stores, already carrying a
 * diagnostic event (`tokens.test`), and reachable without a human's session.
 * The alternative was to admit a service credential to `aml-verification`,
 * which deliberately refuses `service_role` outright — that function serves
 * people, and punching one hole in it for a diagnostic is how such a boundary
 * stops meaning anything.
 *
 * The probe itself is the clone's, and it is the SAME implementation a
 * reviewer runs from the Command Centre. Two doors, one answer.
 *
 * ## What it costs
 *
 * Nothing. The clone sends a deliberately incomplete request, so the vendor
 * rejects it at validation — which is the pass, because it proves the call
 * authenticated, arrived and was answered. No verification is created, no
 * record is written, and neither end meters it.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createHmac, randomUUID } from "node:crypto";

/** What the clone reported. Mirrors `StandaloneProbe` on the prime. */
export type CloneVerificationProbe = {
  route: "direct" | "broker" | "unconfigured";
  endpoint: string | null;
  status: number | null;
  answered_by: "vendor" | "mission_control" | "none";
  verdict: string;
  detail: string;
};

export type SelftestResult =
  | { ok: true; cloneId: string; cloneName: string | null; probe: CloneVerificationProbe }
  | { ok: false; cloneId: string; cloneName: string | null; reason: string; error: string };

/** The webhook signature scheme the clone verifies against. */
function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export async function runCloneVerificationSelftest(
  cloneId: string,
): Promise<SelftestResult> {
  const { data: clone, error: cloneErr } = await supabaseAdmin
    .from("clones")
    .select("id, name")
    .eq("id", cloneId)
    .maybeSingle();
  // A failed read is not an absent clone: answering "unknown clone" on a
  // transport fault sends somebody to check a registration that is fine.
  if (cloneErr) {
    return { ok: false, cloneId, cloneName: null, reason: "unreadable", error: cloneErr.message };
  }
  if (!clone) {
    return { ok: false, cloneId, cloneName: null, reason: "unknown_clone", error: "no such clone" };
  }
  const cloneName = clone.name ?? null;

  const { data: endpoint, error: epErr } = await supabaseAdmin
    .from("token_webhook_endpoints")
    .select("url, secret, is_active")
    .eq("clone_id", cloneId)
    .eq("is_active", true)
    .maybeSingle();
  if (epErr) {
    return { ok: false, cloneId, cloneName, reason: "unreadable", error: epErr.message };
  }
  if (!endpoint?.url || !endpoint?.secret) {
    /*
     * The clone has no Mission Control link. Named rather than reported as a
     * verification fault: nothing is wrong with the provider, this side
     * simply has no door — and the remedy is the link reconcile, not
     * anything to do with Didit.
     */
    return {
      ok: false,
      cloneId,
      cloneName,
      reason: "no_link",
      error: "This clone has no active Mission Control webhook endpoint to ask through.",
    };
  }

  const body = JSON.stringify({
    event: "verification.selftest",
    occurred_at: new Date().toISOString(),
    data: {},
  });

  let res: Response;
  try {
    res = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mc-signature": sign(endpoint.secret, body),
        "x-mc-event": "verification.selftest",
        // Fresh every time. The clone answers a probe BEFORE its de-dupe, so
        // this is belt and braces — but a stable key here would be a request
        // to be told what the last answer was, which is not the question.
        "x-mc-idempotency-key": randomUUID(),
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return {
      ok: false,
      cloneId,
      cloneName,
      reason: "unreachable",
      error: e instanceof Error ? e.message.slice(0, 300) : "request failed",
    };
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    return {
      ok: false,
      cloneId,
      cloneName,
      reason: `http_${res.status}`,
      error: text.slice(0, 300),
    };
  }

  let parsed: { probe?: CloneVerificationProbe };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    /*
     * A 200 with a body this side cannot read means the clone is running a
     * build that predates the probe — `mission-control-webhook` answers a
     * plain "ok" to an event it does not know. Reported as its own state,
     * because "no probe" and "a probe that failed" are opposite readings and
     * only one of them is about Didit.
     */
    return {
      ok: false,
      cloneId,
      cloneName,
      reason: "no_probe_in_answer",
      error:
        "The clone accepted the event and returned no probe — its backend predates " +
        "the self-test. Deploy the current functions to it first.",
    };
  }
  if (!parsed.probe) {
    return {
      ok: false,
      cloneId,
      cloneName,
      reason: "no_probe_in_answer",
      error: text.slice(0, 300),
    };
  }

  return { ok: true, cloneId, cloneName, probe: parsed.probe };
}

/** Every clone with a backend, asked in turn. */
export async function runFleetVerificationSelftest(): Promise<SelftestResult[]> {
  const { data: clones } = await supabaseAdmin
    .from("clones")
    .select("id, name")
    .order("name", { ascending: true });
  const out: SelftestResult[] = [];
  for (const c of clones ?? []) {
    out.push(await runCloneVerificationSelftest(c.id));
  }
  return out;
}
