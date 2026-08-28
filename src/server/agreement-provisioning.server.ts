/**
 * Signed agreement → provisioned clone: orchestration.
 *
 * When a Service Level Agreement that was ARMED for provisioning comes back
 * signed (Connect webhook or the agreements-refresh poll — both funnel
 * through `applyDocusignStatus`), this module turns its recorded commercial
 * selection — tier plan, modules, add-ons, exclusions — into a clone: the
 * repository, the clone row with entitlements, the module install set, the
 * add-on purchase rows, the dedicated backend queued for the drain worker,
 * the subdomain reservation and the deployment enqueue. It does that by
 * calling the SAME pipeline the operator wizard uses (`provisionCloneCore`,
 * `enqueueCloneBackendProvisioning`) — never a parallel implementation.
 *
 * Safety model, in order:
 *  - every skip is a named refusal (`decideProvisionOnSignature`, pure);
 *  - the agreement is CLAIMED by compare-and-set on `provision_status`
 *    (`armed → provisioning`), so the webhook, the cron poll and an
 *    operator's button land on ONE clone however they race;
 *  - under the claim, `provisionCloneCore`'s own idempotency key
 *    (`agreement:<id>`) makes even a crashed-and-retried attempt reuse the
 *    repo it already created;
 *  - a FAILED attempt stays failed until a person retriggers it — external
 *    resources are never retried into on a timer.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { notifyOperators } from "@/server/audit.server";
import {
  decideProvisionOnSignature,
  deriveCloneIdentity,
  effectiveModuleIds,
  uniqueSlug,
  type AgreementProvisionFacts,
} from "./agreementProvisioning.pure";

export type ProvisionFromAgreementResult =
  | { ok: true; cloneId: string; skipped?: false }
  | { ok: true; skipped: true; reason: string; detail: string }
  | { ok: false; error: string };

const AGREEMENT_SELECT =
  "id, status, client_name, client_email, client_org, provision_on_signature, provision_status, " +
  "plan_slug, module_ids, addon_slugs, excluded_module_ids, admin_email, provision_region, created_by";

/**
 * Provision the clone an agreement describes. `trigger: "signature"` is the
 * automatic path and honours every guard; `trigger: "operator"` is the
 * explicit button, which additionally may retry a `failed` attempt (that is
 * the person the failure was waiting for).
 */
export async function provisionCloneFromAgreement(
  agreementId: string,
  opts: { trigger: "signature" | "operator"; actorUserId?: string | null },
): Promise<ProvisionFromAgreementResult> {
  const { data, error } = await supabaseAdmin
    .from("client_agreements")
    .select(AGREEMENT_SELECT)
    .eq("id", agreementId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "agreement_not_found" };
  const agreement = data as unknown as AgreementProvisionFacts;

  // The operator button may resurrect a failed attempt; the automatic path
  // never does. Model that by letting the operator's retry re-arm first.
  if (opts.trigger === "operator" && agreement.provision_status === "failed") {
    agreement.provision_status = "armed";
  }
  // The operator button also works on an un-armed but signed agreement —
  // pressing it IS the arming.
  if (opts.trigger === "operator" && !agreement.provision_on_signature) {
    agreement.provision_on_signature = true;
  }

  const decision = decideProvisionOnSignature(agreement);
  if (decision.action === "skip") {
    return { ok: true, skipped: true, reason: decision.reason, detail: decision.detail };
  }

  // ── Claim: armed|none|failed → provisioning, exactly one winner ──────
  const claimFrom = opts.trigger === "operator" ? ["armed", "none", "failed"] : ["armed", "none"];
  const { data: claimed, error: claimErr } = await supabaseAdmin
    .from("client_agreements")
    .update({ provision_status: "provisioning", provision_error: null })
    .eq("id", agreementId)
    .in("provision_status", claimFrom)
    .select("id");
  if (claimErr) return { ok: false, error: `claim failed: ${claimErr.message}` };
  if (!claimed || claimed.length === 0) {
    return {
      ok: true,
      skipped: true,
      reason: "in_flight",
      detail: "Another caller claimed this agreement first",
    };
  }

  try {
    const cloneId = await runProvisioning(agreement, opts.actorUserId ?? null);
    const { error: doneErr } = await supabaseAdmin
      .from("client_agreements")
      .update({
        provision_status: "provisioned",
        provisioned_clone_id: cloneId,
        provision_error: null,
      })
      .eq("id", agreementId);
    // The clone exists whatever this row says; an unrecorded success would
    // read as stuck-provisioning and invite a second attempt, so say so.
    if (doneErr) console.error("[agreement-provisioning] success record failed:", doneErr.message);
    await notifyOperators({
      kind: "agreement_provisioned",
      severity: "success",
      title: "Clone provisioned from signed agreement",
      body: `${agreement.client_name}'s signed agreement provisioned a clone on plan ${agreement.plan_slug}.`,
      url: `/clones/${cloneId}`,
      metadata: { agreement_id: agreementId, clone_id: cloneId, trigger: opts.trigger },
    }).catch((e) => console.error("[agreement-provisioning] notify failed:", (e as Error).message));
    return { ok: true, cloneId };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const { error: failErr } = await supabaseAdmin
      .from("client_agreements")
      .update({ provision_status: "failed", provision_error: message })
      .eq("id", agreementId);
    if (failErr) console.error("[agreement-provisioning] failure record failed:", failErr.message);
    await notifyOperators({
      kind: "agreement_provisioned",
      severity: "error",
      title: "Agreement provisioning failed",
      body: `${agreement.client_name}'s signed agreement could not provision its clone: ${message}`,
      url: "/agreements",
      metadata: { agreement_id: agreementId, error: message, trigger: opts.trigger },
    }).catch(() => {});
    return { ok: false, error: message };
  }
}

async function runProvisioning(
  agreement: AgreementProvisionFacts,
  operatorUserId: string | null,
): Promise<string> {
  const identity = deriveCloneIdentity(agreement);
  if (!identity) throw new Error("No usable client/organisation name to derive the clone from");

  // Attribution: the operator pressing the button, else whoever raised the
  // agreement. decideProvisionOnSignature already refused a null creator.
  const userId = operatorUserId ?? agreement.created_by!;

  // Unique slug against the fleet.
  const { data: existing, error: slugErr } = await supabaseAdmin
    .from("clones")
    .select("slug")
    .like("slug", `${identity.slug}%`);
  if (slugErr) throw new Error(`Could not check existing slugs: ${slugErr.message}`);
  const slug = uniqueSlug(
    identity.slug,
    new Set((existing ?? []).map((r: { slug: string }) => r.slug)),
  );

  // The prime's org owns the new repo, same as the wizard's default.
  const { data: prime, error: primeErr } = await supabaseAdmin
    .from("prime_config")
    .select("github_owner")
    .limit(1)
    .maybeSingle();
  if (primeErr) throw new Error(`Could not read prime config: ${primeErr.message}`);
  if (!prime?.github_owner) throw new Error("Prime not configured — set it up in Settings first");

  const moduleIds = effectiveModuleIds(
    agreement.module_ids ?? [],
    agreement.excluded_module_ids ?? [],
  );

  const { provisionCloneCore } = await import("./clone-provisioning.server");
  const created = await provisionCloneCore(supabaseAdmin, userId, {
    name: identity.name,
    slug,
    method: "template",
    targetOwner: prime.github_owner,
    tags: ["agreement"],
    cloudflareEnabled: false,
    notes: `Provisioned automatically from signed agreement ${agreement.id} (${agreement.client_name}).`,
    moduleIds,
    planSlug: agreement.plan_slug,
    addonSlugs: agreement.addon_slugs ?? [],
    // The signature is precisely the moment the tenant becomes real — a
    // dedicated backend is the point of the agreement.
    isolatedTenant: true,
    idempotencyKey: `agreement:${agreement.id}`,
  });
  if (!created.ok) throw new Error(created.error);

  // Queue the dedicated backend. The seed admin is the client's own address
  // (or the override recorded at arm time); the password is generated and
  // reaches the row only encrypted, for the drain worker. Nobody is ever
  // shown it — the platform's own password-reset flow is the front door.
  const { enqueueCloneBackendProvisioning, generateSecurePassword } =
    await import("./backend-provisioning.server");
  const enqueue = await enqueueCloneBackendProvisioning(supabaseAdmin, userId, {
    cloneId: created.cloneId,
    cloneName: identity.name,
    region:
      (agreement as unknown as { provision_region?: string }).provision_region || "ap-southeast-2",
    adminEmail: agreement.admin_email || agreement.client_email,
    adminPassword: generateSecurePassword(),
    moduleIds,
  });
  if (!enqueue.ok) {
    // The clone exists; only the backend queue failed. Surface it rather
    // than unwinding a created repository.
    throw new Error(
      `Clone ${created.cloneId} created, but backend enqueue failed: ${enqueue.error}`,
    );
  }

  return created.cloneId;
}
