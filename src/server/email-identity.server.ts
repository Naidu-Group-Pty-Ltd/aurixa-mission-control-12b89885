/**
 * Per-clone email identity — orchestration.
 *
 * Drives one clone from "inherits the prime's Resend key" to "sends with its
 * own domain-scoped key": register the clone's sending domain at Resend,
 * install the DNS records (into the clone's own Cloudflare zone when Mission
 * Control manages one, otherwise hand them to the operator), poll
 * verification, then mint a `sending_access` key scoped to that domain and
 * write it to the clone's Supabase project as `RESEND_API_KEY`.
 *
 * Design rules, in the order they bite:
 *
 * - **Re-entrant, never resumed by memory.** `advanceEmailIdentity` reads the
 *   stored row, advances every step whose preconditions hold, and stops where
 *   they don't. Clicking it twice is safe at every stage: the domain is
 *   adopted rather than re-created, DNS writes check for the record first,
 *   and the key is minted only once.
 *
 * - **The key token exists in memory for one flow.** Resend returns it
 *   exactly once; it is written to the clone in the same call that minted it,
 *   and only its id and last four characters are stored. A mint whose write
 *   FAILS deletes the minted key at Resend — an undelivered token nobody
 *   holds is an orphan credential, not a retry opportunity.
 *
 * - **Every clone-project write goes through `resolveCloneSecretTarget`.**
 *   The Management API token can reach every project in the organisation;
 *   the target decision is the only thing standing between "set the clone's
 *   key" and "overwrite the prime's".
 *
 * - **Dormant without `RESEND_MASTER_API_KEY`.** Every entry point answers a
 *   named refusal instead of throwing halfway — the capability ships before
 *   the credential arrives.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import {
  isResendConfigured,
  resendApi,
  ResendError,
  type ResendDnsRecord,
  type ResendDomain,
} from "./resend-client";
import {
  withAbsoluteRecordNames,
  canMintKey,
  deriveFromAddress,
  deriveSendingDomain,
  identityReadiness,
  isValidSendingDomain,
  keyLast4,
  mayAlignSenderAddress,
  decideEmailIdentitySweep,
  expectedDnsProbes,
  planDnsInstallation,
  resolveEmailDnsZone,
  type EmailIdentityReadiness,
  type EmailIdentityRow,
  type EmailSweepFacts,
} from "./cloneEmailIdentity.pure";
import { resolveCloneSecretTarget, CloneSecretTargetError } from "./cloneAllowedOrigins.server";

type Db = SupabaseClient<Database>;

export const CLONE_RESEND_SECRET = "RESEND_API_KEY";

const RESEND_REGIONS = new Set(["us-east-1", "eu-west-1", "sa-east-1", "ap-northeast-1"]);

export type EmailIdentityState = {
  ok: true;
  resendConfigured: boolean;
  row: EmailIdentityRow | null;
  readiness: EmailIdentityReadiness;
  /** Derived default when no row exists yet; null = the operator must supply one. */
  suggestedDomain: string | null;
  suggestedFromAddress: string | null;
};

type Fail = { ok: false; error: string };

function fail(error: string): Fail {
  return { ok: false, error };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Resend's domain status vocabulary → this table's. */
function mapDomainStatus(resendStatus: string): EmailIdentityRow["domain_status"] {
  if (resendStatus === "verified") return "verified";
  if (resendStatus === "failure") return "failed";
  // not_started | pending | temporary_failure — all "the DNS answer is not in yet".
  return "pending_dns";
}

function rowFromDb(data: Record<string, unknown> | null): EmailIdentityRow | null {
  if (!data) return null;
  return {
    ...(data as unknown as EmailIdentityRow),
    dns_records: ((data.dns_records as Json) ?? []) as unknown as ResendDnsRecord[],
  };
}

async function readIdentity(supabase: Db, cloneId: string): Promise<EmailIdentityRow | null> {
  const { data, error } = await supabase
    .from("clone_email_identities")
    .select("*")
    .eq("clone_id", cloneId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the clone's email identity: ${error.message}`);
  return rowFromDb(data as Record<string, unknown> | null);
}

async function readCloneHostFacts(supabase: Db, cloneId: string) {
  const { data, error } = await supabase
    .from("clones")
    .select("slug, subdomain_fqdn, deploy_url, cloudflare_enabled, cloudflare_zone_id")
    .eq("id", cloneId)
    .maybeSingle();
  if (error) throw new Error(`Could not read clone ${cloneId}: ${error.message}`);
  if (!data) throw new Error(`Clone ${cloneId} not found`);
  return data;
}

/**
 * The fleet's own Cloudflare zone — the one every clone subdomain lives in,
 * and therefore the one that carries `send.<clone-fqdn>`'s records. Read as a
 * best effort: a deployment with no hosting config simply has no fleet zone to
 * fall back to, which is a manual-DNS flow rather than a failure.
 *
 * This reads through the CALLER's client, and `platform_hosting_config` grants
 * SELECT to admins only (`is_admin(auth.uid())`). Both callers can see the
 * row: the operator's paths are behind `requireAdmin`, and the scheduled drain
 * passes the service-role client, which RLS does not apply to. Hand this a
 * user-scoped client for anyone else and RLS would FILTER rather than error —
 * null row, null error, and auto-DNS would silently stop happening with
 * nothing anywhere to see.
 */
async function readFleetZone(
  supabase: Db,
): Promise<{ cloudflare_zone_id: string | null; cloudflare_zone_name: string | null } | null> {
  const { data, error } = await supabase
    .from("platform_hosting_config")
    .select("cloudflare_zone_id, cloudflare_zone_name")
    .eq("singleton", true)
    .maybeSingle();
  if (error) return null;
  return (
    (data as { cloudflare_zone_id: string | null; cloudflare_zone_name: string | null }) ?? null
  );
}

/** Current state for the operator UI — reads only, no vendor calls. */
export async function getEmailIdentityState(
  supabase: Db,
  cloneId: string,
): Promise<EmailIdentityState | Fail> {
  try {
    const [row, clone] = await Promise.all([
      readIdentity(supabase, cloneId),
      readCloneHostFacts(supabase, cloneId),
    ]);
    const suggestedDomain = row?.sending_domain ?? deriveSendingDomain(clone);
    return {
      ok: true,
      resendConfigured: isResendConfigured(),
      row,
      readiness: identityReadiness(row, { resendConfigured: isResendConfigured() }),
      suggestedDomain,
      suggestedFromAddress: suggestedDomain ? deriveFromAddress(suggestedDomain) : null,
    };
  } catch (e) {
    return fail(msg(e));
  }
}

async function persistIdentity(
  supabase: Db,
  cloneId: string,
  patch: Partial<Record<string, unknown>> & { sending_domain?: string },
): Promise<void> {
  const { error } = await supabase
    .from("clone_email_identities")
    .upsert({ clone_id: cloneId, ...patch } as never, { onConflict: "clone_id" });
  if (error) throw new Error(`Could not store the email identity: ${error.message}`);
}

/**
 * Find-or-create the domain at Resend. Creation losing a race (or repeating
 * after a partial run) is adopted via the list — the name is the identity.
 */
async function ensureResendDomain(
  sendingDomain: string,
  region: string,
  existingId: string | null,
): Promise<ResendDomain> {
  if (existingId) return resendApi.getDomain(existingId);
  try {
    return await resendApi.createDomain({ name: sendingDomain, region });
  } catch (e) {
    if (e instanceof ResendError && e.status >= 400 && e.status < 500) {
      const { data } = await resendApi.listDomains();
      const hit = data.find((d) => d.name.toLowerCase() === sendingDomain);
      if (hit) return resendApi.getDomain(hit.id);
    }
    throw e;
  }
}

/**
 * Write Resend's records into the clone's own Cloudflare zone. Returns true
 * only when EVERY record is in place — a partial installation is reported as
 * not-installed so the operator sees records to check rather than a tick over
 * a domain that can never verify.
 */
async function installDnsViaCloudflare(
  zoneId: string,
  records: ResendDnsRecord[],
): Promise<{ installed: boolean; detail: string }> {
  const { cloudflareApi } = await import("./cloudflare/client");
  let written = 0;
  for (const r of records) {
    const type = r.type.toUpperCase();
    if (type !== "TXT" && type !== "MX" && type !== "CNAME") {
      return { installed: false, detail: `Unsupported record type ${r.type} for ${r.name}` };
    }
    const existing = await cloudflareApi.listDnsRecords(zoneId, { name: r.name, type });
    const already = existing.some((x) => x.content.replace(/^"|"$/g, "") === r.value);
    if (already) {
      written += 1;
      continue;
    }
    await cloudflareApi.createDnsRecord(zoneId, {
      type: type as "TXT" | "MX" | "CNAME",
      name: r.name,
      content: r.value,
      ...(type === "MX" ? { priority: r.priority ?? 10 } : {}),
      comment: "Resend sending domain (Aurixa Mission Control email identity)",
    });
    written += 1;
  }
  return {
    installed: written === records.length,
    detail: `${written}/${records.length} records in place`,
  };
}

export type AdvanceResult = (EmailIdentityState & { advanced: string[] }) | Fail;

/**
 * Advance the clone's email identity as far as its preconditions allow.
 *
 * `mode: "refresh"` re-reads Resend (records + verification) and updates the
 * row but creates nothing and mints nothing — the shape of a status poll.
 * `mode: "provision"` also creates what is missing and, once the domain is
 * verified, mints the clone's key and writes it.
 */
export async function advanceEmailIdentity(
  supabase: Db,
  cloneId: string,
  opts: {
    mode: "provision" | "refresh";
    sendingDomain?: string;
    region?: string;
    actorUserId?: string | null;
  },
): Promise<AdvanceResult> {
  if (!isResendConfigured()) {
    return fail(
      "RESEND_MASTER_API_KEY is not configured on Mission Control. Add it in the project's " +
        "environment (Settings → Secrets) — a full-access key on the platform's Resend team — " +
        "then run this again. Clone keys minted from it are sending-only and domain-scoped.",
    );
  }

  const advanced: string[] = [];
  try {
    const [clone, fleet] = await Promise.all([
      readCloneHostFacts(supabase, cloneId),
      readFleetZone(supabase),
    ]);
    let row = await readIdentity(supabase, cloneId);

    // ── Domain choice ────────────────────────────────────────────────
    const requested = opts.sendingDomain?.trim().toLowerCase();
    if (requested && !isValidSendingDomain(requested)) {
      return fail(`"${requested}" is not a valid hostname`);
    }
    if (requested && row && row.sending_domain !== requested && row.resend_domain_id) {
      return fail(
        `This clone's identity is already registered for ${row.sending_domain}. ` +
          "Revoke it first to start over on a different domain.",
      );
    }
    const sendingDomain = requested ?? row?.sending_domain ?? deriveSendingDomain(clone);
    if (!sendingDomain) {
      return fail(
        "This clone has no resolvable hostname to derive a sending domain from — " +
          "supply one explicitly (e.g. send.your-clone-domain.com.au).",
      );
    }
    const region = opts.region ?? row?.region ?? "us-east-1";
    if (!RESEND_REGIONS.has(region)) return fail(`"${region}" is not a Resend region`);

    if (!row) {
      if (opts.mode === "refresh") {
        return fail("Nothing to refresh — this clone has no email identity yet.");
      }
      await persistIdentity(supabase, cloneId, {
        sending_domain: sendingDomain,
        region,
        default_from_address: deriveFromAddress(sendingDomain),
        created_by: opts.actorUserId ?? null,
      });
      row = await readIdentity(supabase, cloneId);
      if (!row) return fail("The identity row vanished between write and read");
      advanced.push("row_created");
    }

    // ── Resend domain ────────────────────────────────────────────────
    let domain: ResendDomain | null = null;
    if (row.resend_domain_id || opts.mode === "provision") {
      domain = await ensureResendDomain(row.sending_domain, row.region, row.resend_domain_id);
      const status = mapDomainStatus(domain.status);
      await persistIdentity(supabase, cloneId, {
        sending_domain: row.sending_domain,
        resend_domain_id: domain.id,
        domain_status: status,
        // Resend answers with names relative to the registrable domain;
        // everything downstream — the planner, the Cloudflare writer, the
        // table an operator copies from — expects FQDNs.
        dns_records: withAbsoluteRecordNames(
          domain.records ?? [],
          row.sending_domain,
        ) as unknown as Json,
        last_error: null,
      });
      if (!row.resend_domain_id) advanced.push("domain_registered");
      row = {
        ...row,
        resend_domain_id: domain.id,
        domain_status: status,
        dns_records: withAbsoluteRecordNames(domain.records ?? [], row.sending_domain),
      };
    }

    // ── DNS installation ─────────────────────────────────────────────
    if (domain && !row.dns_installed_via && row.dns_records.length > 0) {
      const zone = resolveEmailDnsZone({
        cloneCloudflareEnabled: clone.cloudflare_enabled,
        cloneZoneId: clone.cloudflare_zone_id,
        fleetZoneId: fleet?.cloudflare_zone_id ?? null,
        fleetZoneName: fleet?.cloudflare_zone_name ?? null,
      });
      // null = UNDETERMINED: this attempt neither installed nor established
      // that it never can, so the step stays open and the next advance retries.
      // Anything else is an outcome and settles.
      let via: "cloudflare" | "manual" | null = null;
      if (!zone) {
        // No zone at all to write into — determined, and the operator's to do.
        via = "manual";
      } else {
        try {
          // The fleet zone's name is stored beside its id, so the common case
          // costs no vendor call. A clone's own zone has no local name.
          let zoneName = zone.zoneName;
          if (!zoneName) {
            const { cloudflareApi } = await import("./cloudflare/client");
            zoneName = (await cloudflareApi.getZone(zone.zoneId)).name;
          }
          const plan = planDnsInstallation(row.dns_records, zoneName);
          if (plan.manual.length > 0) {
            // Records outside the resolved zone — a tenant-owned sending
            // domain. Retrying cannot change this: Resend's required records
            // for a given domain do not move. Determined.
            via = "manual";
          } else {
            const res = await installDnsViaCloudflare(zone.zoneId, plan.auto);
            if (res.installed) via = "cloudflare";
            else
              // A PARTIAL write is worth retrying — leave it undetermined.
              await persistIdentity(supabase, cloneId, {
                sending_domain: row.sending_domain,
                last_error: `DNS partially installed: ${res.detail}`,
              });
          }
        } catch (e) {
          // Cloudflare being unreachable must not strand the flow, and must
          // not permanently downgrade this clone to manual DNS either: it is
          // transient, so the step stays open and the next advance tries again.
          // The records are shown meanwhile.
          await persistIdentity(supabase, cloneId, {
            sending_domain: row.sending_domain,
            last_error: `Cloudflare DNS installation failed: ${msg(e)}`,
          });
        }
      }
      // Settling used to require `via === "cloudflare" || !zoneId`, which left
      // the step UNRECORDED whenever a zone existed but could not carry every
      // record. `dns_installed_via` stayed null, the path reported DNS as the
      // open step forever, and each advance re-ran the whole attempt. Handing
      // the records over IS an outcome; a transient failure is not.
      if (via) {
        await persistIdentity(supabase, cloneId, {
          sending_domain: row.sending_domain,
          dns_installed_via: via,
        });
        row = { ...row, dns_installed_via: via };
        advanced.push(via === "cloudflare" ? "dns_installed_cloudflare" : "dns_handed_to_operator");
      }
    }

    // ── Verification poll ────────────────────────────────────────────
    //
    // Never ask Resend to verify a record that is not there yet. Its verifier
    // resolves through a caching resolver, and a miss is cached for the zone's
    // SOA negative TTL — 1800s on ours. Measured on the first clone: the
    // domain was registered at 11:15 and the records were installed at 12:32,
    // and the drain asked for verification every five minutes throughout, so
    // roughly seventeen lookups returned NXDOMAIN and the last of them held
    // "this does not exist" until half an hour after the records were already
    // correct. The delay was entirely self-inflicted.
    //
    // One DoH lookup per distinct name is far cheaper than a wrong answer
    // cached for thirty minutes, and "not visible yet" is reported rather than
    // being indistinguishable from "Resend says no".
    if (row.resend_domain_id && row.domain_status !== "verified") {
      const visibility = await dnsRecordsVisible(row.dns_records);
      if (!visibility.allPresent) {
        advanced.push(`verification_deferred_dns_missing:${visibility.missing.join(",")}`);
      } else {
        await resendApi.verifyDomain(row.resend_domain_id);
        const fresh = await resendApi.getDomain(row.resend_domain_id);
        const status = mapDomainStatus(fresh.status);
        if (status !== row.domain_status) {
          await persistIdentity(supabase, cloneId, {
            sending_domain: row.sending_domain,
            domain_status: status,
            dns_records: withAbsoluteRecordNames(
              fresh.records ?? [],
              row.sending_domain,
            ) as unknown as Json,
          });
          row = {
            ...row,
            domain_status: status,
            dns_records: withAbsoluteRecordNames(fresh.records ?? [], row.sending_domain),
          };
          advanced.push(`verification_${status}`);
        }
      }
    }

    // ── Key mint + write ─────────────────────────────────────────────
    if (opts.mode === "provision" && !row.resend_key_id) {
      const gate = canMintKey(row);
      if (gate.ok) {
        const minted = await mintAndWriteKey(
          supabase,
          cloneId,
          row,
          clone.slug,
          opts.actorUserId ?? null,
        );
        if (!minted.ok) return minted;
        row = minted.row;
        advanced.push("key_minted_and_written");
      }
    }

    return {
      ok: true,
      resendConfigured: true,
      row,
      readiness: identityReadiness(row, { resendConfigured: true }),
      suggestedDomain: row.sending_domain,
      suggestedFromAddress: row.default_from_address ?? deriveFromAddress(row.sending_domain),
      advanced,
    };
  } catch (e) {
    const error = msg(e);
    // Best-effort breadcrumb; the returned error is the authoritative signal.
    await supabase
      .from("clone_email_identities")
      .update({ last_error: error })
      .eq("clone_id", cloneId);
    return fail(error);
  }
}

export type EmailSweepReport = {
  resendConfigured: boolean;
  considered: number;
  advanced: number;
  failed: number;
  skipped: Record<string, number>;
  detail: Array<{ cloneId: string; outcome: string; note?: string }>;
};

/**
 * Carry every started email identity forward, on a schedule.
 *
 * Every other provisioning pipeline here has a drain; this one did not, so an
 * identity waiting on DNS propagation sat still until a person reopened the
 * page and pressed a button. That is how a clone ends up registered, with its
 * records installed and its domain verified, and still no key — the outage
 * this whole feature exists to end, one click short of fixed.
 *
 * It advances and never starts: see `decideEmailIdentitySweep`. The batch is
 * small because each advance is several Resend calls and possibly a Cloudflare
 * write, and a drain is a background repair rather than a backfill.
 */
export async function sweepEmailIdentities(
  supabase: Db,
  opts: { limit?: number; now?: number } = {},
): Promise<EmailSweepReport> {
  const report: EmailSweepReport = {
    resendConfigured: isResendConfigured(),
    considered: 0,
    advanced: 0,
    failed: 0,
    skipped: {},
    detail: [],
  };
  // Dormant, not broken. Without the master key every advance would refuse by
  // name anyway; refusing once here keeps the log readable and says why.
  if (!report.resendConfigured) return report;

  const now = opts.now ?? Date.now();
  const { data, error } = await supabase
    .from("clone_email_identities")
    .select("clone_id, resend_domain_id, domain_status, key_written_at, last_error, updated_at")
    // Finished identities are the overwhelming majority once a fleet settles;
    // excluding them here keeps the sweep's cost proportional to the work.
    .is("key_written_at", null)
    .order("updated_at", { ascending: true })
    .limit(opts.limit ?? 10);
  if (error) throw new Error(`Could not list email identities: ${error.message}`);

  const bump = (reason: string) => {
    report.skipped[reason] = (report.skipped[reason] ?? 0) + 1;
  };

  for (const raw of data ?? []) {
    const rowFacts = raw as unknown as EmailSweepFacts["identity"] & { clone_id: string };
    report.considered += 1;
    const verdict = decideEmailIdentitySweep({ identity: rowFacts, now });
    if (!verdict.act) {
      bump(verdict.reason);
      report.detail.push({ cloneId: rowFacts.clone_id, outcome: verdict.reason });
      continue;
    }
    try {
      // `provision` is the mode that mints; it cannot register a domain here
      // because this row already has one. The decision above is what holds
      // that invariant.
      const res = await advanceEmailIdentity(supabase, rowFacts.clone_id, { mode: "provision" });
      if (res.ok) {
        report.advanced += 1;
        report.detail.push({
          cloneId: rowFacts.clone_id,
          outcome: "advanced",
          note: res.advanced.join(",") || verdict.why,
        });
      } else {
        report.failed += 1;
        report.detail.push({ cloneId: rowFacts.clone_id, outcome: "failed", note: res.error });
      }
    } catch (e) {
      // One stuck identity must not stop the sweep for the others.
      report.failed += 1;
      report.detail.push({ cloneId: rowFacts.clone_id, outcome: "failed", note: msg(e) });
    }
  }
  return report;
}

/**
 * Are Resend's records visible in public DNS yet?
 *
 * Resolved over DNS-over-HTTPS because the runtime is a Worker with no
 * resolver of its own. Presence only — see `expectedDnsProbes` for why values
 * are Resend's business rather than ours.
 *
 * Fails OPEN: a probe that errors or times out reports the record as present,
 * so a hiccup reaching the resolver delays nothing. The cost of a false
 * "present" is one wasted verify call; the cost of a false "missing" is a
 * domain that never verifies because we stopped asking.
 */
async function dnsRecordsVisible(
  records: ResendDnsRecord[],
): Promise<{ allPresent: boolean; missing: string[] }> {
  const probes = expectedDnsProbes(records);
  if (probes.length === 0) return { allPresent: false, missing: ["no records published yet"] };

  const missing: string[] = [];
  await Promise.all(
    probes.map(async (probe) => {
      try {
        const res = await fetch(
          `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(probe.name)}&type=${encodeURIComponent(probe.type)}`,
          { headers: { accept: "application/dns-json" } },
        );
        if (!res.ok) return; // fail open
        const body = (await res.json()) as { Answer?: unknown[] };
        if (!Array.isArray(body.Answer) || body.Answer.length === 0) {
          missing.push(`${probe.type} ${probe.name}`);
        }
      } catch {
        // fail open
      }
    }),
  );
  return { allPresent: missing.length === 0, missing };
}

/**
 * Mint the domain-scoped key and deliver it to the clone in one motion.
 * Store identifiers only. A failed delivery deletes the minted key.
 */
async function mintAndWriteKey(
  supabase: Db,
  cloneId: string,
  row: EmailIdentityRow,
  cloneSlug: string,
  actorUserId: string | null,
): Promise<{ ok: true; row: EmailIdentityRow } | Fail> {
  let target;
  try {
    target = await resolveCloneSecretTarget(supabase, cloneId);
  } catch (e) {
    const reason = e instanceof CloneSecretTargetError ? ` (${e.reason})` : "";
    return fail(`Refusing to write the clone's key${reason}: ${msg(e)}`);
  }

  const minted = await resendApi.createApiKey({
    name: `aurixa-clone-${cloneSlug}-sending`,
    permission: "sending_access",
    domain_id: row.resend_domain_id!,
  });

  const { setCloneSecretValue } = await import("./backend-provisioning.server");
  const res = await setCloneSecretValue(target.projectRef, CLONE_RESEND_SECRET, minted.token);
  if (!res.ok) {
    // The token was never delivered anywhere — destroy it rather than hold it.
    await resendApi.deleteApiKey(minted.id).catch(() => {});
    return fail(`Minted the key but could not write it to the clone: ${res.error}`);
  }

  const now = new Date().toISOString();
  await persistIdentity(supabase, cloneId, {
    sending_domain: row.sending_domain,
    resend_key_id: minted.id,
    key_last4: keyLast4(minted.token),
    key_written_at: now,
    last_error: null,
  });
  const { error: trackErr } = await supabase.from("clone_backend_secrets").upsert(
    {
      clone_id: cloneId,
      name: CLONE_RESEND_SECRET,
      status: "set",
      last_set_at: now,
      last_error: null,
      set_by: actorUserId,
    },
    { onConflict: "clone_id,name" },
  );
  if (trackErr) console.error("[email-identity] secret ledger upsert failed:", trackErr.message);

  return {
    ok: true,
    row: {
      ...row,
      resend_key_id: minted.id,
      key_last4: keyLast4(minted.token),
      key_written_at: now,
      last_error: null,
    },
  };
}

/**
 * Replace the clone's key: mint new → write to the clone → only then delete
 * the old key at Resend. Delivery failure keeps the OLD key working — mail
 * never stops because a rotation half-ran. The step every re-provisioned
 * backend needs, because the original token cannot be read back.
 */
export async function rotateEmailIdentityKey(
  supabase: Db,
  cloneId: string,
  actorUserId: string | null,
): Promise<{ ok: true; keyLast4: string } | Fail> {
  if (!isResendConfigured())
    return fail("RESEND_MASTER_API_KEY is not configured on Mission Control.");
  try {
    const row = await readIdentity(supabase, cloneId);
    if (!row) return fail("This clone has no email identity to rotate.");
    const gate = canMintKey(row);
    if (!gate.ok) return fail(gate.reason!);
    const clone = await readCloneHostFacts(supabase, cloneId);
    const previousKeyId = row.resend_key_id;

    const minted = await mintAndWriteKey(supabase, cloneId, row, clone.slug, actorUserId);
    if (!minted.ok) return minted;

    if (previousKeyId && previousKeyId !== minted.row.resend_key_id) {
      await resendApi.deleteApiKey(previousKeyId).catch((e) => {
        console.error(`[email-identity] old key ${previousKeyId} not deleted:`, msg(e));
      });
    }
    return { ok: true, keyLast4: minted.row.key_last4 ?? "" };
  } catch (e) {
    return fail(msg(e));
  }
}

/**
 * Tear the identity down: delete the clone's key at Resend (dead keys are the
 * point of per-clone scoping), optionally the domain, and mark the row. The
 * value already on the clone's project is left in place — it stops working
 * the moment the key dies, and the secrets page shows RESEND_API_KEY as
 * missing so the operator knows mail needs a new plan.
 */
export async function revokeEmailIdentity(
  supabase: Db,
  cloneId: string,
  opts: { deleteDomain?: boolean; actorUserId?: string | null },
): Promise<{ ok: true } | Fail> {
  if (!isResendConfigured())
    return fail("RESEND_MASTER_API_KEY is not configured on Mission Control.");
  try {
    const row = await readIdentity(supabase, cloneId);
    if (!row) return fail("This clone has no email identity to revoke.");

    if (row.resend_key_id) await resendApi.deleteApiKey(row.resend_key_id).catch(() => {});
    if (opts.deleteDomain && row.resend_domain_id) {
      await resendApi.deleteDomain(row.resend_domain_id).catch(() => {});
    }

    await persistIdentity(supabase, cloneId, {
      sending_domain: row.sending_domain,
      resend_key_id: null,
      key_last4: null,
      key_written_at: null,
      domain_status: opts.deleteDomain ? "revoked" : row.domain_status,
      ...(opts.deleteDomain ? { resend_domain_id: null, dns_installed_via: null } : {}),
      last_error: null,
    });
    const { error: trackErr } = await supabase.from("clone_backend_secrets").upsert(
      {
        clone_id: cloneId,
        name: CLONE_RESEND_SECRET,
        status: "missing",
        last_set_at: null,
        last_error: "Dedicated key revoked — the value on the clone is dead",
        set_by: opts.actorUserId ?? null,
      },
      { onConflict: "clone_id,name" },
    );
    if (trackErr) console.error("[email-identity] revoke ledger upsert failed:", trackErr.message);
    return { ok: true };
  } catch (e) {
    return fail(msg(e));
  }
}

// Address shape for the alignment write: strict enough that interpolating it
// into SQL cannot carry structure. (The value also round-trips through
// mayAlignSenderAddress and deriveFromAddress, both of which normalise.)
const SAFE_ADDRESS = /^[a-z0-9._+-]+@[a-z0-9.-]+$/;

/**
 * Point the clone's brand-config sender at the verified sending domain.
 *
 * The clone's edge functions build every from-header from
 * `global_report_settings.contact_details.email`; while that still carries
 * the prime's legacy address the dedicated key answers
 * `403 from address not authorized` on every send. Repairs a default, never
 * overrides a tenant's own configured domain (`mayAlignSenderAddress`).
 */
export async function alignCloneSenderAddress(
  supabase: Db,
  cloneId: string,
): Promise<{ ok: true; address: string } | Fail> {
  try {
    const row = await readIdentity(supabase, cloneId);
    if (!row) return fail("This clone has no email identity yet.");
    if (row.domain_status !== "verified") {
      return fail(
        "Align the sender only once the domain is verified — earlier it would break mail that still works.",
      );
    }
    const address = row.default_from_address ?? deriveFromAddress(row.sending_domain);
    if (!SAFE_ADDRESS.test(address)) return fail(`Derived address "${address}" failed validation`);

    let target;
    try {
      target = await resolveCloneSecretTarget(supabase, cloneId);
    } catch (e) {
      return fail(`Refusing to touch the clone's settings: ${msg(e)}`);
    }

    const { runSqlOnProject } = await import("./backend-provisioning.server");
    const current = (await runSqlOnProject(
      target.projectRef,
      `select setting_value->>'email' as email from public.global_report_settings where setting_key = 'contact_details' limit 1`,
    )) as Array<{ email: string | null }>;
    const currentEmail = Array.isArray(current) ? (current[0]?.email ?? null) : null;

    if (!mayAlignSenderAddress(currentEmail)) {
      return fail(
        `The clone's sender is already the tenant's own choice (${currentEmail}) — not overriding it. ` +
          "Change it in the clone's admin settings if that is intended.",
      );
    }

    await runSqlOnProject(
      target.projectRef,
      `update public.global_report_settings
          set setting_value = jsonb_set(coalesce(setting_value, '{}'::jsonb), '{email}', to_jsonb('${address}'::text), true),
              updated_at = now()
        where setting_key = 'contact_details'`,
    );
    return { ok: true, address };
  } catch (e) {
    return fail(msg(e));
  }
}
