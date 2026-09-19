/**
 * Reserving a clone's name in the Aurixa zone.
 *
 * The decision is in `subdomainAllocation.pure.ts`; this is the I/O around it,
 * and the only interesting part is the retry.
 *
 * `clones_subdomain_uidx` is a unique partial index, so allocation is a
 * read-then-write with a gap in the middle. Two clones provisioned in the same
 * second can both read a taken-set that lacks the other's name, both pick it,
 * and the second UPDATE fails with 23505. That is not a fault to log — it is the
 * database doing exactly its job — so it is caught and re-allocated against a
 * freshly read set.
 *
 * One retry, not a loop: a second collision on a re-read set means something
 * other than a race, and spinning would turn a bug into an outage.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { allocateSubdomain } from "./subdomainAllocation.pure";
import { cloneFqdn } from "./dnsTarget.pure";

const admin = supabaseAdmin;

/** Postgres unique-violation. Anything else is a real error and is rethrown. */
const UNIQUE_VIOLATION = "23505";

export type ReserveResult =
  | { ok: true; subdomain: string; fqdn: string | null; suffixed: boolean; status: string }
  | { ok: false; reason: string };

async function takenSubdomains(excludeCloneId: string): Promise<string[]> {
  const { data } = await admin.from("clones").select("id, subdomain").not("subdomain", "is", null);
  return (data ?? [])
    .filter((r: { id: string }) => r.id !== excludeCloneId)
    .map((r: { subdomain: string }) => r.subdomain);
}

/**
 * Pick a name for a clone and write it onto the row.
 *
 * `subdomain_status` is set to `awaiting_deployment` rather than `queued`: the
 * name is reserved but nothing can be written into DNS until the clone's Vercel
 * project reports the CNAME it wants. Marking it `queued` here would promise a
 * job that does not exist, which is the state nobody can diagnose from the UI.
 */
export async function reserveCloneSubdomain(input: {
  cloneId: string;
  slug: string;
  preferred?: string | null;
}): Promise<ReserveResult> {
  const { data: cfg } = await admin
    .from("platform_hosting_config")
    .select("primary_domain, reserved_slugs")
    .eq("singleton", true)
    .maybeSingle();

  const reserved: string[] = cfg?.reserved_slugs ?? [];

  for (let attempt = 0; attempt < 2; attempt++) {
    const taken = await takenSubdomains(input.cloneId);
    const allocation = allocateSubdomain({
      slug: input.slug,
      preferred: input.preferred,
      taken,
      reserved,
    });
    if (!allocation.ok) return { ok: false, reason: allocation.reason };

    const fqdn = cloneFqdn(allocation.subdomain, cfg?.primary_domain);
    const { error } = await admin
      .from("clones")
      .update({
        subdomain: allocation.subdomain,
        subdomain_fqdn: fqdn,
        subdomain_status: "awaiting_deployment",
      })
      .eq("id", input.cloneId);

    if (!error) {
      return {
        ok: true,
        subdomain: allocation.subdomain,
        fqdn,
        suffixed: allocation.suffixed,
        status: "awaiting_deployment",
      };
    }
    // Lost the race. Re-read and pick again; anything else is a real failure.
    if (error.code !== UNIQUE_VIOLATION) return { ok: false, reason: error.message };
  }

  return { ok: false, reason: "collision_after_retry" };
}

/**
 * Reserve a clone's name AND ask for the DNS record, in that order, once.
 *
 * ## Why this exists
 *
 * There were two writers of `clones.subdomain` on the creation path and they
 * disagreed. `provisionCloneCore` reserved through the allocator above;
 * `requestCloneSubdomain` — which the New Clone wizard called a few lines
 * later, from the browser, after the server function had already returned —
 * wrote a different string straight onto the row. The wizard's write was
 * second, so the wizard's write won.
 *
 * Measured on the live fleet, 19 Sep 2026:
 *
 *   slug                          subdomain
 *   npc-crm-independent-6505dc →  npc-crm-independent
 *   npc-test-76b3b3            →  npc-test
 *
 * Both names are *reasonable*; that is what made it invisible. The wizard sends
 * `slug` with a six-character idempotency suffix on it, and it knew perfectly
 * well the hostname should not carry a retry token — it just expressed that
 * knowledge in a second write instead of in the one input field that exists for
 * it (`ProvisionCloneInput.subdomain`, documented for exactly this and never
 * once populated).
 *
 * Three things went with the second writer, and each was silent:
 *
 *   1. **The taken-set check.** `reserveCloneSubdomain` allocates against every
 *      name already claimed; the wizard's path checked `reserved_slugs` alone
 *      and let a collision reach `clones_subdomain_uidx`, so the operator got a
 *      raw `duplicate key value violates unique constraint` in a toast — on a
 *      clone that had, in fact, been given a perfectly good name a moment
 *      earlier.
 *
 *   2. **`subdomain_status`.** The reservation sets `awaiting_deployment`,
 *      under a comment saying `queued` "would promise a job that does not
 *      exist". The second write set `queued` anyway.
 *
 *   3. **The operator's own choice.** A name typed into the wizard reached the
 *      second writer and never the allocator, so it was never checked against
 *      anything, and the reservation had meanwhile allocated a DIFFERENT name
 *      from the slug.
 *
 * ## The rule
 *
 * One writer. Both surfaces come through here, and the difference between them
 * is `refuseIfSuffixed` — not a second implementation.
 *
 * A name DERIVED from a slug may be suffixed, because nobody chose it and
 * `npc-test-2` is a better outcome than a failed provision. A name a person
 * TYPED may not: silently serving somebody at a name they did not ask for is
 * how an operator ends up looking for a clone that is running fine.
 */
export type SubdomainProvisionResult =
  | {
      ok: true;
      subdomain: string;
      fqdn: string | null;
      suffixed: boolean;
      status: string;
      jobId?: string;
    }
  | { ok: false; reason: string };

export async function provisionCloneSubdomain(input: {
  cloneId: string;
  slug: string;
  /** What a person typed, if one did. Falls back to the slug. */
  preferred?: string | null;
  createdBy?: string | null;
  /** Set where the name came from a person: a suffix is then a refusal. */
  refuseIfSuffixed?: boolean;
}): Promise<SubdomainProvisionResult> {
  const reservation = await reserveCloneSubdomain({
    cloneId: input.cloneId,
    slug: input.slug,
    preferred: input.preferred,
  });
  if (!reservation.ok) return reservation;

  if (input.refuseIfSuffixed && reservation.suffixed) {
    // The reservation has already been written, so it is rolled back rather
    // than left standing: an operator who asked for `acme` and was refused must
    // not discover later that the clone answers to `acme-2`. `subdomain_taken`
    // is the same word `checkSubdomainAvailability` uses, so the surface that
    // checks before submitting and the surface that refuses on submit agree.
    const { error: undoErr } = await admin
      .from("clones")
      .update({ subdomain: null, subdomain_fqdn: null, subdomain_status: null })
      .eq("id", input.cloneId);
    if (undoErr) {
      return { ok: false, reason: `subdomain_taken_and_rollback_failed:${undoErr.message}` };
    }
    return { ok: false, reason: "subdomain_taken" };
  }

  const { data: cfg } = await admin
    .from("platform_hosting_config")
    .select("*")
    .eq("singleton", true)
    .maybeSingle();

  const fleet = cfg as Record<string, unknown> | null;
  const zoneId = (fleet?.cloudflare_zone_id as string | null | undefined) ?? null;
  const ready = Boolean(zoneId && process.env.CLOUDFLARE_API_TOKEN);

  // Dormant rather than failed: the name IS reserved, and the settings page's
  // reconcile action fans the backlog out the moment a token and a zone land.
  if (!ready || !reservation.fqdn) {
    const status = "pending_platform";
    await setStatus(input.cloneId, status);
    return { ...reservation, status };
  }

  const { data: deployment } = await admin
    .from("clone_deployments")
    .select("dns_target_type, dns_target_value, status")
    .eq("clone_id", input.cloneId)
    .maybeSingle();

  const { enqueueSubdomainJob } = await import("./subdomainJobs.server");
  const enqueued = await enqueueSubdomainJob({
    cloneId: input.cloneId,
    slug: reservation.subdomain,
    fqdn: reservation.fqdn,
    zoneId,
    fleet: fleet as never,
    deployment,
    createdBy: input.createdBy ?? null,
  });

  if (!enqueued.ok) {
    // `no_target` is the ORDINARY path on a provider-managed fleet, not a
    // failure: the name is reserved, the platform is configured, and the
    // clone's Vercel project simply has not told us its CNAME yet. The
    // deployment drain enqueues the record itself at `attaching_domain`, with
    // the name Vercel issued.
    if (enqueued.reason === "no_target") {
      await setStatus(input.cloneId, "awaiting_deployment");
      return { ...reservation, status: "awaiting_deployment" };
    }
    return { ok: false, reason: `subdomain_enqueue_failed:${enqueued.reason}` };
  }

  await setStatus(input.cloneId, "queued");
  return { ...reservation, status: "queued", jobId: enqueued.jobId ?? undefined };
}

/**
 * Move the status alone, checked.
 *
 * Separate from the reservation's own write because this one runs after the
 * name is already on the row: a failure here leaves a clone with a correct name
 * and a status that understates it, which is recoverable and worth saying out
 * loud rather than worth failing a provision for.
 */
async function setStatus(cloneId: string, status: string): Promise<void> {
  const { error } = await admin
    .from("clones")
    .update({ subdomain_status: status })
    .eq("id", cloneId);
  if (error) {
    console.error(`[subdomain] could not set status ${status} for ${cloneId}: ${error.message}`);
  }
}
