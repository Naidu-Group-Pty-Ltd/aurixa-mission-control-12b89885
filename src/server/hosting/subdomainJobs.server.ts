/**
 * Enqueueing DNS work for a clone — one implementation.
 *
 * `subdomain-hosting.functions.ts` carried this block three times (request,
 * detach, reconcile), each building the payload by hand. Three copies of a
 * payload shape is how two of them come to disagree about `proxied`, and the
 * disagreement is invisible: both write a record, one of them just writes the
 * wrong one.
 *
 * The important part is `resolveDnsTarget` — the record content is now a
 * property of the clone's DEPLOYMENT, falling back to the fleet default, rather
 * than one static value for everybody (see dnsTarget.pure.ts).
 */
import crypto from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { resolveDnsTarget, type DeploymentTarget, type FleetDefault } from "./dnsTarget.pure";

const admin = supabaseAdmin;

export function payloadHash(p: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(p ?? {}))
    .digest("hex");
}

export type SubdomainEnqueueResult =
  | { ok: true; jobId: string | null; source: "deployment" | "fleet_default" }
  | { ok: false; reason: "no_target" | "no_zone" | "db_error"; error?: string };

/**
 * Queue the DNS record for one clone's subdomain.
 *
 * Idempotent by `(clone_id, provider_slug, action, payload_hash)` — the upsert
 * the queue was designed around, so a double-click or a retry collapses to one
 * job. Note the payload hash CHANGES when the target changes, which is exactly
 * what we want: migrating a clone from the fleet default to its own deployment
 * target enqueues a fresh job rather than colliding with the satisfied one.
 */
export async function enqueueSubdomainJob(input: {
  cloneId: string;
  slug: string;
  fqdn: string;
  zoneId: string | null | undefined;
  fleet: FleetDefault | null | undefined;
  deployment: DeploymentTarget | null | undefined;
  createdBy?: string | null;
  action?: "provision_subdomain" | "resync_subdomain";
}): Promise<SubdomainEnqueueResult> {
  if (!input.zoneId) return { ok: false, reason: "no_zone" };

  const target = resolveDnsTarget(input.deployment, input.fleet);
  if (!target) return { ok: false, reason: "no_target" };

  const payload = {
    subdomain: input.slug,
    fqdn: input.fqdn,
    zoneId: input.zoneId,
    recordType: target.recordType,
    recordContent: target.recordContent,
    proxied: target.proxied,
  };

  const { data, error } = await admin
    .from("edge_provisioning_jobs")
    .upsert(
      {
        clone_id: input.cloneId,
        provider_slug: "cloudflare",
        action: input.action ?? "provision_subdomain",
        payload,
        payload_hash: payloadHash(payload),
        status: "queued",
        created_by: input.createdBy ?? null,
      },
      { onConflict: "clone_id,provider_slug,action,payload_hash" },
    )
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, reason: "db_error", error: error.message };
  return { ok: true, jobId: data?.id ?? null, source: target.source };
}

/**
 * Queue the ownership-challenge records a hosting provider demands.
 *
 * Vercel answers `addDomain` with zero or more `verification` entries — usually
 * one TXT on `_vercel.<domain>`. Writing them is the difference between a domain
 * that verifies in a minute and one that sits in `verifying_domain` until
 * somebody reads the provider's dashboard.
 *
 * One job per challenge, keyed on the challenge's own value, so re-running is
 * free and a re-issued challenge enqueues a new job rather than being mistaken
 * for the old one.
 */
export async function enqueueDomainVerificationJobs(input: {
  cloneId: string;
  zoneId: string | null | undefined;
  challenges: Array<{ type: string; domain: string; value: string }>;
  createdBy?: string | null;
}): Promise<{ enqueued: number; skipped: number; errors: string[] }> {
  if (!input.zoneId || input.challenges.length === 0) {
    return { enqueued: 0, skipped: input.challenges.length, errors: [] };
  }
  let enqueued = 0;
  let skipped = 0;
  // WHY the reason travels rather than only the count: `verify_domain_txt` was
  // refused by this table's own `action` CHECK constraint for four days, and
  // the caller could not tell that from "the provider asked for nothing". A
  // count of skips is not a diagnosis — 23514 from the column looks exactly
  // like an empty challenge list from the provider, and the drain reported
  // "Waiting for DNS to propagate" either way.
  const errors: string[] = [];
  for (const challenge of input.challenges) {
    // Only DNS challenges are ours to satisfy. An HTTP challenge is served by
    // the deployment itself, and writing a DNS record for one would be a record
    // that means nothing pointing at a value nobody reads.
    if (challenge.type.toUpperCase() !== "TXT") {
      skipped++;
      continue;
    }
    const payload = {
      zoneId: input.zoneId,
      recordType: "TXT" as const,
      recordName: challenge.domain,
      recordContent: challenge.value,
    };
    const { error } = await admin.from("edge_provisioning_jobs").upsert(
      {
        clone_id: input.cloneId,
        provider_slug: "cloudflare",
        action: "verify_domain_txt",
        payload,
        payload_hash: payloadHash(payload),
        status: "queued",
        created_by: input.createdBy ?? null,
      },
      { onConflict: "clone_id,provider_slug,action,payload_hash" },
    );
    if (error) {
      skipped++;
      errors.push(`${challenge.domain}: ${error.message}`);
    } else enqueued++;
  }
  return { enqueued, skipped, errors };
}
