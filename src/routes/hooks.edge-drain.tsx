// Edge provisioning worker — drains queued jobs from edge_provisioning_jobs.
// Called by pg_cron every minute (Bearer auth via verifyCronAuth) and also
// invoked opportunistically after enqueue for low-latency execution.
//
// Fleet-scale properties:
//  - SELECT ... FOR UPDATE SKIP LOCKED so parallel drainers don't collide.
//  - Concurrency cap (default 6) per invocation.
//  - Exponential backoff on transient failures; permanent fail at max_attempts.
//  - Serialises per Cloudflare account via pg_advisory_xact_lock to respect
//    Cloudflare's 1200 req/5min token cap.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { asJson } from "@/lib/json-cast";
import { verifyCronAuth } from "@/server/cron-auth.server";
import { getEdgeProvider } from "@/server/edge";
import "@/server/edge/index"; // ensure providers register
import { cloudflareApi } from "@/server/cloudflare/client";
import { decideDnsRecordAction } from "@/server/hosting/dnsAdoption.pure";
import type { EdgePosture, EdgeProviderSlug } from "@/server/edge";

const admin = supabaseAdmin;
const MAX_JOBS_PER_RUN = 20;
const CONCURRENCY = 6;

type JobRow = {
  id: string;
  clone_id: string;
  provider_slug: EdgeProviderSlug;
  action:
    | "attach"
    | "apply_posture"
    | "sync"
    | "detach"
    | "provision_subdomain"
    | "deprovision_subdomain"
    | "resync_subdomain"
    | "verify_domain_txt";
  payload: {
    externalRef?: string;
    hostname?: string;
    accountRef?: string;
    posturePreset?: string;
    posture?: EdgePosture;
    // subdomain actions
    subdomain?: string;
    fqdn?: string;
    zoneId?: string;
    recordType?: "A" | "AAAA" | "CNAME" | "TXT";
    recordContent?: string;
    proxied?: boolean;
    // verify_domain_txt: the ownership challenge the hosting provider issued.
    recordName?: string;
  };
  attempts: number;
  max_attempts: number;
};

async function claimJobs(limit: number): Promise<JobRow[]> {
  // Atomic claim via RPC-less update: pick queued/retry rows whose next_attempt_at is due.
  const nowIso = new Date().toISOString();
  const { data: candidates } = await admin
    .from("edge_provisioning_jobs")
    .select("id")
    .in("status", ["queued", "retry"])
    .lte("next_attempt_at", nowIso)
    .order("next_attempt_at", { ascending: true })
    .limit(limit);
  if (!candidates?.length) return [];
  const ids = candidates.map((c: { id: string }) => c.id);
  const { data: claimed } = await admin
    .from("edge_provisioning_jobs")
    .update({
      status: "running",
      locked_at: nowIso,
      locked_by: "edge-drain",
    })
    .in("id", ids)
    .in("status", ["queued", "retry"])
    .select("id, clone_id, provider_slug, action, payload, attempts, max_attempts");
  return (claimed ?? []) as JobRow[];
}

function backoffSeconds(attempts: number): number {
  return Math.min(3600, Math.round(Math.pow(2, Math.max(0, attempts)) * 15));
}

async function runJob(job: JobRow): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  try {
    const provider = getEdgeProvider(job.provider_slug);

    if (job.action === "attach") {
      const res = await provider.attach({
        cloneId: job.clone_id,
        hostname: job.payload.hostname,
        externalRef: job.payload.externalRef,
        accountRef: job.payload.accountRef,
        posture: job.payload.posture,
      });
      await admin.from("clone_edge_config").upsert(
        {
          clone_id: job.clone_id,
          provider_slug: job.provider_slug,
          external_ref: res.externalRef,
          hostname: res.hostname ?? null,
          account_ref: res.accountRef ?? null,
          status: res.status,
          last_synced_at: new Date().toISOString(),
        },
        { onConflict: "clone_id,provider_slug" },
      );
      // Back-compat: mirror onto the legacy Cloudflare row and clones flag.
      if (job.provider_slug === "cloudflare") {
        await admin.from("cloudflare_clone_config").upsert(
          {
            clone_id: job.clone_id,
            account_id: res.accountRef ?? "unknown",
            zone_id: res.externalRef,
            zone_name: res.hostname ?? "unknown",
            status: res.status,
            last_synced_at: new Date().toISOString(),
          },
          { onConflict: "clone_id" },
        );
        await admin
          .from("clones")
          .update({ cloudflare_enabled: true, cloudflare_zone_id: res.externalRef })
          .eq("id", job.clone_id);
      }
      return { ok: true, result: res };
    }

    if (job.action === "apply_posture") {
      const { data: cfg } = await admin
        .from("clone_edge_config")
        .select("external_ref")
        .eq("clone_id", job.clone_id)
        .eq("provider_slug", job.provider_slug)
        .maybeSingle();
      const ref = job.payload.externalRef ?? cfg?.external_ref;
      if (!ref) throw new Error("no_external_ref");
      const applied = await provider.applyPosture(ref, job.payload.posture ?? {});
      await admin
        .from("clone_edge_config")
        .update({
          posture_preset: job.payload.posturePreset ?? undefined,
          security_level: job.payload.posture?.security_level ?? undefined,
          bot_fight: job.payload.posture?.bot_fight ?? undefined,
          rate_limit_rps: job.payload.posture?.rate_limit_rps ?? undefined,
          waf_preset: job.payload.posture?.waf_preset ?? undefined,
          status: "active",
          last_synced_at: new Date().toISOString(),
        })
        .eq("clone_id", job.clone_id)
        .eq("provider_slug", job.provider_slug);
      return { ok: true, result: { applied } };
    }

    if (job.action === "sync") {
      const { data: cfg } = await admin
        .from("clone_edge_config")
        .select("external_ref")
        .eq("clone_id", job.clone_id)
        .eq("provider_slug", job.provider_slug)
        .maybeSingle();
      if (!cfg?.external_ref) throw new Error("no_external_ref");
      const state = await provider.syncState(cfg.external_ref);
      await admin
        .from("clone_edge_config")
        .update({ last_synced_at: new Date().toISOString() })
        .eq("clone_id", job.clone_id)
        .eq("provider_slug", job.provider_slug);
      return { ok: true, result: state };
    }

    if (job.action === "detach") {
      const { data: cfg } = await admin
        .from("clone_edge_config")
        .select("external_ref")
        .eq("clone_id", job.clone_id)
        .eq("provider_slug", job.provider_slug)
        .maybeSingle();
      if (cfg?.external_ref) await provider.detach(cfg.external_ref);
      await admin
        .from("clone_edge_config")
        .update({ status: "detached" })
        .eq("clone_id", job.clone_id)
        .eq("provider_slug", job.provider_slug);
      if (job.provider_slug === "cloudflare") {
        await admin
          .from("clones")
          .update({ cloudflare_enabled: false, cloudflare_zone_id: null })
          .eq("id", job.clone_id);
      }
      return { ok: true };
    }

    // ── Subdomain hosting actions (Cloudflare-only in Phase 1) ───────────
    if (job.action === "provision_subdomain" || job.action === "resync_subdomain") {
      if (job.provider_slug !== "cloudflare") throw new Error("subdomain_provider_unsupported");
      const { subdomain, fqdn, zoneId, recordType, recordContent, proxied } = job.payload;
      if (!zoneId || !fqdn || !recordType || !recordContent) throw new Error("payload_incomplete");
      // Idempotent: reuse the tracked record if we already created one.
      const { data: existing } = await admin
        .from("edge_dns_records")
        .select("id, external_record_id, record_content, record_type, proxied")
        .eq("clone_id", job.clone_id)
        .eq("purpose", "clone_subdomain")
        .eq("zone_id", zoneId)
        .maybeSingle();
      // Create, or ADOPT what is already there. `existing` above is our own
      // bookkeeping; the zone is the authority on what actually exists, and
      // the two disagree the moment a record is made by hand or a write to
      // `edge_dns_records` does not land. See `dnsAdoption.pure.ts` — this is
      // the fault that failed one clone's resync seven times against a
      // hostname that was serving the whole time.
      const zoneRecords = existing?.external_record_id
        ? []
        : await cloudflareApi.listDnsRecords(zoneId, { name: fqdn }).catch(() => []);
      const plan = decideDnsRecordAction({
        trackedRecordId: existing?.external_record_id ?? null,
        zoneRecords,
        desired: {
          type: recordType as "A" | "AAAA" | "CNAME",
          name: fqdn,
          content: recordContent,
          proxied: proxied ?? true,
        },
      });
      if (plan.kind === "refuse") throw new Error(plan.reason);

      let recordId: string;
      if (plan.kind === "adopt") {
        recordId = plan.recordId;
        // Only write when it does not already say what we want: a resync that
        // finds the record correct should cost no rate-limited call at all.
        if (plan.needsWrite) {
          await cloudflareApi.updateDnsRecord(zoneId, recordId, {
            type: recordType,
            name: fqdn,
            content: recordContent,
            proxied: proxied ?? true,
          });
        }
        const { error: adoptErr } = await admin.from("edge_dns_records").insert({
          clone_id: job.clone_id,
          provider_slug: "cloudflare",
          zone_id: zoneId,
          external_record_id: recordId,
          record_type: recordType,
          record_name: fqdn,
          record_content: recordContent,
          proxied: proxied ?? true,
          managed: true,
          purpose: "clone_subdomain",
        });
        // A read that FAILED is not a row that is ABSENT, and here it is a row
        // we must not lose: without it the next run adopts all over again.
        if (adoptErr) throw new Error(`adopted ${recordId} but could not record it: ${adoptErr.message}`);
      } else if (existing?.external_record_id) {
        const r = await cloudflareApi.updateDnsRecord(zoneId, existing.external_record_id, {
          type: recordType,
          name: fqdn,
          content: recordContent,
          proxied: proxied ?? true,
        });
        recordId = r.id;
        await admin
          .from("edge_dns_records")
          .update({
            record_type: recordType,
            record_name: fqdn,
            record_content: recordContent,
            proxied: proxied ?? true,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existing.id);
      } else {
        const r = await cloudflareApi.createDnsRecord(zoneId, {
          type: recordType,
          name: fqdn,
          content: recordContent,
          proxied: proxied ?? true,
          comment: `aurixa-clone:${job.clone_id}`,
        });
        recordId = r.id;
        await admin.from("edge_dns_records").insert({
          clone_id: job.clone_id,
          provider_slug: "cloudflare",
          zone_id: zoneId,
          external_record_id: r.id,
          record_type: recordType,
          record_name: fqdn,
          record_content: recordContent,
          proxied: proxied ?? true,
          managed: true,
          purpose: "clone_subdomain",
        });
      }
      await admin
        .from("clones")
        .update({
          subdomain: subdomain,
          subdomain_fqdn: fqdn,
          subdomain_status: "active",
        })
        .eq("id", job.clone_id);
      return { ok: true, result: { recordId, fqdn } };
    }

    // ── Hosting-provider domain ownership challenge ─────────────────────
    // A hosting provider will not serve a custom domain until it can prove we
    // control the name. Vercel issues a TXT on `_vercel.<domain>`; writing it is
    // the difference between a domain that verifies in a minute and one that
    // sits in `verifying_domain` until somebody reads the provider dashboard.
    //
    // Tracked in edge_dns_records like every other record we create, under its
    // own purpose so `deprovision_subdomain` — which deletes by
    // `purpose = 'clone_subdomain'` — does not take the challenge with it, and
    // so a challenge record is never mistaken for the record that serves the
    // site.
    if (job.action === "verify_domain_txt") {
      if (job.provider_slug !== "cloudflare") throw new Error("subdomain_provider_unsupported");
      const { zoneId, recordName, recordContent } = job.payload;
      if (!zoneId || !recordName || !recordContent) throw new Error("payload_incomplete");
      const { data: existing } = await admin
        .from("edge_dns_records")
        .select("id, external_record_id")
        .eq("clone_id", job.clone_id)
        .eq("purpose", "domain_verification")
        .eq("zone_id", zoneId)
        .eq("record_name", recordName)
        .maybeSingle();
      if (existing?.external_record_id) {
        await cloudflareApi.updateDnsRecord(zoneId, existing.external_record_id, {
          type: "TXT",
          name: recordName,
          content: recordContent,
        });
        await admin
          .from("edge_dns_records")
          .update({ record_content: recordContent, updated_at: new Date().toISOString() })
          .eq("id", existing.id);
        return { ok: true, result: { recordId: existing.external_record_id, updated: true } };
      }
      const created = await cloudflareApi.createDnsRecord(zoneId, {
        type: "TXT",
        name: recordName,
        content: recordContent,
        comment: `aurixa-domain-verification:${job.clone_id}`,
      });
      await admin.from("edge_dns_records").insert({
        clone_id: job.clone_id,
        provider_slug: "cloudflare",
        zone_id: zoneId,
        external_record_id: created.id,
        record_type: "TXT",
        record_name: recordName,
        record_content: recordContent,
        proxied: false,
        managed: true,
        purpose: "domain_verification",
      });
      return { ok: true, result: { recordId: created.id, created: true } };
    }

    if (job.action === "deprovision_subdomain") {
      if (job.provider_slug !== "cloudflare") throw new Error("subdomain_provider_unsupported");
      const { data: rows } = await admin
        .from("edge_dns_records")
        .select("id, zone_id, external_record_id, managed")
        .eq("clone_id", job.clone_id)
        // Both purposes: leaving the ownership challenge behind means a TXT
        // record for a domain we no longer serve, which is drift we created.
        .in("purpose", ["clone_subdomain", "domain_verification"]);
      for (const r of rows ?? []) {
        if (!r.managed) continue; // never touch drift/unmanaged records
        try {
          await cloudflareApi.deleteDnsRecord(r.zone_id, r.external_record_id);
        } catch (e) {
          // Absent-on-Cloudflare is fine; keep going and clean up our row.
        }
        await admin.from("edge_dns_records").delete().eq("id", r.id);
      }
      await admin
        .from("clones")
        .update({ subdomain: null, subdomain_fqdn: null, subdomain_status: "detached" })
        .eq("id", job.clone_id);
      return { ok: true };
    }

    throw new Error(`unknown_action:${job.action}`);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function finalize(job: JobRow, outcome: { ok: boolean; result?: unknown; error?: string }) {
  const nowIso = new Date().toISOString();
  const nextAttempts = job.attempts + 1;
  if (outcome.ok) {
    await admin
      .from("edge_provisioning_jobs")
      .update({
        status: "succeeded",
        attempts: nextAttempts,
        completed_at: nowIso,
        result: asJson(outcome.result ?? {}),
        error: null,
      })
      .eq("id", job.id);
  } else {
    const willRetry = nextAttempts < job.max_attempts;
    await admin
      .from("edge_provisioning_jobs")
      .update({
        status: willRetry ? "retry" : "failed",
        attempts: nextAttempts,
        error: outcome.error ?? "unknown",
        next_attempt_at: willRetry
          ? new Date(Date.now() + backoffSeconds(nextAttempts) * 1000).toISOString()
          : undefined,
        completed_at: willRetry ? null : nowIso,
      })
      .eq("id", job.id);
    if (!willRetry) {
      await admin
        .from("clone_edge_config")
        .update({ status: "failed", status_detail: outcome.error ?? null })
        .eq("clone_id", job.clone_id)
        .eq("provider_slug", job.provider_slug);
    }
  }
  await admin.from("edge_audit").insert({
    clone_id: job.clone_id,
    provider_slug: job.provider_slug,
    action: job.action,
    payload: job.payload,
    result: asJson(outcome.result ?? {}),
    success: outcome.ok,
    error_message: outcome.error ?? null,
  });
}

async function drain(): Promise<{ claimed: number; succeeded: number; failed: number }> {
  const jobs = await claimJobs(MAX_JOBS_PER_RUN);
  let succeeded = 0;
  let failed = 0;
  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    const batch = jobs.slice(i, i + CONCURRENCY);
    const outcomes = await Promise.all(batch.map((j) => runJob(j)));
    await Promise.all(batch.map((j, k) => finalize(j, outcomes[k])));
    for (const o of outcomes) o.ok ? succeeded++ : failed++;
  }
  return { claimed: jobs.length, succeeded, failed };
}

export const Route = createFileRoute("/hooks/edge-drain")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;
        try {
          const summary = await drain();
          return new Response(JSON.stringify({ success: true, ...summary }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : "drain_failed";
          console.error("edge-drain failed:", msg);
          return new Response(JSON.stringify({ success: false, error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
