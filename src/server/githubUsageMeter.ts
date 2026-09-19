/**
 * What this installation's hourly window was spent ON.
 *
 * ## The gap this closes
 *
 * Measured 19 Sep 2026: `api_usage_events` held 209 rows for the previous six
 * hours and every one of them was Airtable. Thirty providers had a rate row
 * and GitHub had none, so not one App-installation call had ever been
 * recorded — while that same installation's window was the scarcest resource
 * in the system and had already been exhausted twice, on 16 Sep and again
 * that night.
 *
 * The cost of that absence is not the billing; it is the diagnosis. When
 * three clones were ejected from the fleet at 02:14 the question "what spent
 * the window?" could only be answered by reading cron schedules and grepping
 * for call sites, and the answer that audit produced was WRONG — it missed
 * `deployment-drain`, the second-busiest lane in the system. A ledger answers
 * it in one query.
 *
 * ## Absorbed, never billed
 *
 * These calls spend MISSION CONTROL's own App installation, not a credential
 * forwarded to a tenant. So the rate row is `absorbed` — cost recorded,
 * charge zero — and the events are written against the `prime` tenant, which
 * is `billing_exempt` and carries no clone.
 *
 * That is deliberate and load-bearing. `API_USAGE_METERING.md` states the
 * rule this answers to: guessing which credential a call spent bills the
 * wrong tenant, so an unmapped service is metered and never billed. A cascade
 * runs FOR a clone but is not paid for BY one, and attributing it to that
 * clone would invent a charge out of a diagnosis.
 *
 * ## What it counts, and what it cannot promise
 *
 * Calls are counted in the isolate by the one hook every request already
 * passes through (`getAppOctokit`'s retry wrapper), and written as ONE
 * aggregate row per lane rather than a row per call — a few hundred rows a
 * day instead of tens of thousands, which is the grain the question is asked
 * at.
 *
 * The buffer is per isolate, so this is a measurement and not an audit: a
 * worker terminated mid-invocation loses whatever it had not flushed. That is
 * why `FLUSH_AT` exists — a long lane writes as it goes rather than betting
 * the whole invocation on reaching its own end — and why the count is
 * reported as calls observed rather than as calls made. A metering system
 * that cannot be dropped would have to be synchronous per call, and paying a
 * database round trip to record a database round trip is a worse trade than
 * losing a tail.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/** The credential these calls spend. Matches the `api_provider_rates` row. */
export const GITHUB_SECRET_NAME = "GITHUB_APP_PRIVATE_KEY";

/**
 * Flush once the buffer reaches this many calls, without waiting for the lane
 * to finish. A cascade pass can spend hundreds, and a Worker reclaimed
 * mid-pass would otherwise take the whole reading with it.
 */
const FLUSH_AT = 50;

let pending = 0;
let lane = "unattributed";

/** The prime tenant, resolved once per isolate. */
let prime: { id: string; periodStart: string } | null = null;

async function resolvePrimeTenant(): Promise<typeof prime> {
  if (prime) return prime;
  // By `external_ref` prefix rather than by a pinned uuid: the row is created
  // by provisioning rather than by a migration, so its id differs per
  // deployment and a literal here would meter nothing on every clone but this
  // one.
  //
  // `current_period_start` is read with it because `period_start` is NOT NULL
  // with NO DEFAULT — an insert that omits it is rejected by the column, which
  // from inside this module is indistinguishable from a write nobody
  // attempted.
  const { data, error } = await supabaseAdmin
    .from("tenants")
    .select("id, current_period_start")
    .like("external_ref", "prime:%")
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as { id: string; current_period_start: string | null };
  prime = {
    id: row.id,
    // A tenant with no period yet still gets metered: today opens one rather
    // than dropping the reading.
    periodStart: (row.current_period_start ?? new Date().toISOString()).slice(0, 10),
  };
  return prime;
}

/**
 * Name the lane whose calls are being counted.
 *
 * Called at the top of a cron handler. An un-named lane still counts — its
 * calls land under `unattributed`, which is a reading worth having rather
 * than a reason to drop them.
 */
export function beginGithubLane(name: string): void {
  // Flush whatever the previous lane left, so its calls are never attributed
  // to this one. Fire-and-forget: the count is already captured.
  if (pending > 0) void flushGithubUsage();
  lane = name;
}

/** Count one App-installation call. Cheap by construction: an integer. */
export function countGithubCall(): void {
  pending += 1;
  if (pending >= FLUSH_AT) void flushGithubUsage();
}

/**
 * Write what has been counted so far, as one row.
 *
 * Never throws and never blocks the lane on its own bookkeeping: a ledger
 * that can fail a cascade is worse than a gap in the ledger.
 */
export async function flushGithubUsage(): Promise<void> {
  const quantity = pending;
  if (quantity <= 0) return;
  pending = 0; // taken before the await, so a concurrent call cannot double-count
  const laneAtFlush = lane;
  try {
    const tenant = await resolvePrimeTenant();
    if (!tenant) {
      // Put the count back rather than dropping it: the next flush carries it.
      pending += quantity;
      return;
    }
    const { error } = await supabaseAdmin.from("api_usage_events").insert({
      tenant_id: tenant.id,
      clone_id: null,
      secret_name: GITHUB_SECRET_NAME,
      provider: "github",
      unit: "request",
      quantity,
      feature: `lane:${laneAtFlush}`,
      call_status: "success",
      // Mission Control's own installation. See the header.
      //
      // `absorbed` rather than a word of this lane's own: `billing_reason` is
      // CHECK-constrained to nine values, and a tenth is rejected by the
      // column while looking, from here, exactly like a write nobody
      // attempted — the shape `reminder_type` already cost this platform
      // once. `absorbed` is the constraint's own word for what this is: cost
      // recorded, charge zero, which is how DIDIT_API_KEY is already filed.
      billable: false,
      billing_reason: "absorbed",
      period_start: tenant.periodStart,
      occurred_at: new Date().toISOString(),
      idempotency_key: `github-lane:${laneAtFlush}:${crypto.randomUUID()}`,
      metadata: { lane: laneAtFlush, absorbed: true } as never,
    } as never);
    if (error) console.error(`[github-meter] usage write failed: ${error.message}`);
  } catch (e) {
    console.error(
      `[github-meter] usage write threw: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
