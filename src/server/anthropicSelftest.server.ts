/**
 * Ask a clone whether it can actually reach Anthropic.
 *
 * ## Why the question has to be asked THERE
 *
 * Mission Control can prove its own half — it holds the signing key and could
 * exchange an assertion itself — and that is not the question. On the
 * federated route five things stand between a clone's edge function and a
 * token: the clone's own Mission Control key, that key's scopes, Mission
 * Control's signing key, whether Anthropic can fetch the published key set,
 * and whether the federation rule still matches this clone's subject. Only a
 * call made from inside the clone crosses all five.
 *
 * The probe itself is the clone's, and it is the SAME resolution that
 * inference runs — `describeAnthropicReach`, over `resolveAnthropicRoute` and
 * the same exchange. A second implementation here would be a second thing to
 * keep in step, and the one that mattered would be the one nobody ran.
 *
 * ## Why `verified_at` exists at all
 *
 * `clone_anthropic_identity` was created with `verified_at` and `last_error`
 * and only the second had a writer. A column declared by a migration and
 * written by nothing is a fault this codebase has already paid for once — the
 * Passport portal's organisation cross-reference columns were exactly that,
 * and the machinery in front of them looked healthy while serving nobody. This
 * is that column's writer.
 *
 * ## What it costs
 *
 * Nothing. A federated exchange is not a billable call and Anthropic's model
 * list is metadata, so no tokens are consumed at either end. Neither side
 * meters it, because neither side spent anything.
 *
 * ## What it records
 *
 * A pass stamps `verified_at` and clears `last_error`. A failure records the
 * error and LEAVES `verified_at` standing: it is the last time this was proved
 * to work, which stays true whatever is broken now. Overwriting it would
 * destroy the only evidence of when the chain last held.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createHmac, randomUUID } from "node:crypto";

/** What the clone reported. Mirrors `AnthropicReach` on the prime. */
export type CloneAnthropicReach = {
  route: "api_key" | "federated" | "unconfigured";
  ok: boolean;
  end: "unconfigured" | "mission_control" | "anthropic" | "workspace" | null;
  why: string | null;
  workspaceId: string | null;
  credentialKind: "api_key" | "access_token" | null;
  modelCount: number | null;
  probedAt: string;
};

export type AnthropicSelftestResult =
  | { ok: true; cloneId: string; cloneName: string | null; reach: CloneAnthropicReach }
  | { ok: false; cloneId: string; cloneName: string | null; reason: string; error: string };

const EVENT = "anthropic.selftest";

/** The webhook signature scheme the clone verifies against. */
function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Record what the probe found.
 *
 * Deliberately cannot fail the probe: an operator who asked "can this clone
 * reach Anthropic" is owed the answer whether or not the ledger took it, and
 * turning a successful probe into an error because a write failed is the
 * worse reading by a distance.
 */
async function recordReach(cloneId: string, reach: CloneAnthropicReach): Promise<void> {
  // A failure never clears the stamp. `verified_at` is the last time this was
  // PROVED, which is a historical fact and stays true while something else is
  // broken now; `last_error` carries the present problem.
  const patch: {
    updated_at: string;
    last_error: string | null;
    verified_at?: string;
  } = {
    updated_at: new Date().toISOString(),
    last_error: reach.ok ? null : (reach.why ?? "the clone could not reach Anthropic"),
    ...(reach.ok ? { verified_at: reach.probedAt } : {}),
  };

  const { error } = await supabaseAdmin
    .from("clone_anthropic_identity")
    .update(patch)
    .eq("clone_id", cloneId);
  if (error) {
    console.warn("[anthropic-selftest] could not record the reading", error.message);
  }
}

export async function runCloneAnthropicSelftest(
  cloneId: string,
): Promise<AnthropicSelftestResult> {
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
     * Named rather than reported as an Anthropic fault: nothing is wrong with
     * the vendor or the federation, this side simply has no door — and the
     * remedy is the Mission Control link reconcile.
     */
    return {
      ok: false,
      cloneId,
      cloneName,
      reason: "no_link",
      error: "This clone has no active Mission Control webhook endpoint to ask through.",
    };
  }

  const body = JSON.stringify({ event: EVENT, occurred_at: new Date().toISOString(), data: {} });

  let res: Response;
  try {
    res = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mc-signature": sign(endpoint.secret, body),
        "x-mc-event": EVENT,
        // Fresh every time. The clone answers a probe BEFORE its de-dupe, so
        // this is belt and braces — but a stable key here would be a request
        // to be told the last answer, which is not the question.
        "x-mc-idempotency-key": randomUUID(),
      },
      body,
      // Two hops with a vendor at the end of each: the identity request back
      // to here, the token exchange, then the model list.
      signal: AbortSignal.timeout(45_000),
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
    return { ok: false, cloneId, cloneName, reason: `http_${res.status}`, error: text.slice(0, 300) };
  }

  let parsed: { reach?: CloneAnthropicReach };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    /*
     * A 200 with an unreadable body means the clone is running a build that
     * predates the probe — `mission-control-webhook` answers a plain "ok" to
     * an event it does not know. Its own state, because "no probe" and "a
     * probe that failed" are opposite readings and only one is about Anthropic.
     */
    return {
      ok: false,
      cloneId,
      cloneName,
      reason: "no_probe_in_answer",
      error:
        "The clone accepted the event and returned no reading — its backend predates " +
        "the self-test. Deploy the current functions to it first.",
    };
  }

  const reach = parsed.reach;
  if (!reach) {
    return { ok: false, cloneId, cloneName, reason: "no_probe_in_answer", error: text.slice(0, 300) };
  }

  await recordReach(cloneId, reach);

  return { ok: true, cloneId, cloneName, reach };
}

/** Every clone that has an Anthropic identity, asked in turn. */
export async function runFleetAnthropicSelftest(): Promise<AnthropicSelftestResult[]> {
  const { data, error } = await supabaseAdmin
    .from("clone_anthropic_identity")
    .select("clone_id");
  // A candidate list that could not be READ is not an empty one.
  if (error) throw new Error(`Could not list Anthropic identities: ${error.message}`);

  const out: AnthropicSelftestResult[] = [];
  for (const row of data ?? []) {
    const id = (row as { clone_id: string | null }).clone_id;
    if (id) out.push(await runCloneAnthropicSelftest(id));
  }
  return out;
}

/** How long a proof stands before the sweep asks again. */
const REACH_PROOF_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * At most this many a tick, so a backlog drains without a burst.
 *
 * The same shape as the identity-portrait backfill, for the same reason: a
 * sweep that took every stale clone at once would make one tick's cost
 * proportional to fleet size, and the failure mode of that is a rate limit at
 * the vendor rather than a slow queue.
 */
const REACH_SWEEP_BUDGET = 2;

/**
 * Keep the reachability reading current without anybody clicking.
 *
 * `verified_at` with only a manual writer is a reading that stays empty until
 * somebody opens a page, which makes a clone's provability depend on whether
 * anybody looked — the defect the identity-portrait backfill was rebuilt to
 * avoid. Asking an operator to click once per clone, for ever, is asking them
 * to maintain this product's own record-keeping by hand.
 *
 * ## The ordering is the whole design
 *
 * Candidates are taken by `updated_at` ASCENDING, and `recordReach` writes
 * `updated_at` on every outcome — pass or fail. Ordering by `verified_at`
 * instead would look more direct and would starve the fleet: a clone that
 * cannot reach Anthropic never gets a stamp, so it would be first in the queue
 * on every tick for ever, spend both slots, and no other clone would be probed
 * again. Round-robin on "least recently attempted" is what makes a permanent
 * failure cost one slot rather than all of them.
 *
 * It costs nothing at the vendor and it never fails the sweep it runs in.
 */
export async function sweepAnthropicReachability(): Promise<{
  considered: number;
  probed: number;
  results: AnthropicSelftestResult[];
}> {
  const { data, error } = await supabaseAdmin
    .from("clone_anthropic_identity")
    .select("clone_id, verified_at, updated_at")
    .order("updated_at", { ascending: true, nullsFirst: true })
    .limit(50);
  if (error) throw new Error(`Could not list Anthropic identities: ${error.message}`);

  const now = Date.now();
  const rows = (data ?? []) as {
    clone_id: string | null;
    verified_at: string | null;
    updated_at: string | null;
  }[];

  const due = rows.filter((r) => {
    if (!r.clone_id) return false;
    // Never proved is always due; a proof older than the window is due again.
    if (!r.verified_at) return true;
    const proved = Date.parse(r.verified_at);
    return !Number.isFinite(proved) || now - proved > REACH_PROOF_TTL_MS;
  });

  const results: AnthropicSelftestResult[] = [];
  for (const row of due.slice(0, REACH_SWEEP_BUDGET)) {
    try {
      results.push(await runCloneAnthropicSelftest(row.clone_id as string));
    } catch (e) {
      // One clone that cannot be probed is not a failed sweep.
      results.push({
        ok: false,
        cloneId: row.clone_id as string,
        cloneName: null,
        reason: "unreachable",
        error: e instanceof Error ? e.message.slice(0, 300) : "probe failed",
      });
    }
  }

  return { considered: due.length, probed: results.length, results };
}
