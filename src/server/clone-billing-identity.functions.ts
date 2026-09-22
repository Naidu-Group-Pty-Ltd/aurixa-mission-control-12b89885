/**
 * Operator RPCs for a clone's billing identity.
 *
 * Server-side rather than a direct table write from the browser, because the
 * rule that matters cannot be expressed as a column constraint: the two
 * partial unique indexes are per table, and what must be refused is a clone
 * holding an id a TENANT holds. A dialog that wrote `clones` through the
 * browser client would be applying that rule as advice.
 *
 * `requireAdmin` on the write. Which workspace a purchase credits is not an
 * operator-level act — getting it wrong takes a customer's money into somebody
 * else's balance, silently.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireAdmin, requireOperator } from "@/integrations/supabase/role-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  billingIdHolders,
  checkCloneBillingId,
  setCloneBillingId,
} from "./clone-billing-identity.server";
import { deriveCloneBillingId } from "./cloneBillingIdentity.pure";
import { writeAuditLog } from "./audit.server";

export type CloneBillingIdentity = {
  cloneId: string;
  slug: string;
  /** What the clone holds today. Null is the state this whole module exists
   *  for, so it is reported rather than rendered as an empty box. */
  billingUserId: string | null;
  /** What it would be given if nobody named one. Shown so an operator can
   *  accept the derivation without retyping it. */
  suggested: string | null;
  /** The tenant this clone's spending is metered against, when it has one. */
  tenantBillingUserId: string | null;
  /** True when the clone's own bundle would carry this id — i.e. the
   *  environment has been synced since it was set. A claim about what was
   *  PUSHED, which is not a claim about what the artefact holds. */
  publishedToHosting: boolean;
  /**
   * What the SERVED bundle was measured to carry, from
   * `deployedBundleIdentity`. This is the one that decides where a purchase
   * goes, and the reason `publishedToHosting` is not enough: a value published
   * to a hosting project reaches the artefact only through a build.
   *
   * `null` is never probed, which is not a pass.
   */
  bundleCarries: "own" | "fallback" | "not_scanned" | "none" | null;
  /** When that measurement was taken, so a stale reading is not read as current. */
  bundleCheckedAt: string | null;
};

export const getCloneBillingIdentity = createServerFn({ method: "GET" })
  .middleware([requireOperator])
  .inputValidator((data: { cloneId: string }) => {
    if (!data?.cloneId) throw new Error("cloneId required");
    return data;
  })
  .handler(async ({ data }): Promise<CloneBillingIdentity> => {
    const { data: clone, error } = await supabaseAdmin
      .from("clones")
      .select("id, slug, billing_user_id")
      .eq("id", data.cloneId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!clone) throw new Error("Clone not found");

    const [{ data: tenants }, { data: deployment }] = await Promise.all([
      supabaseAdmin.from("tenants").select("billing_user_id").eq("clone_id", clone.id),
      supabaseAdmin
        .from("clone_deployments")
        .select("env_digest, bundle_billing_uid, bundle_checked_at")
        .eq("clone_id", clone.id)
        .maybeSingle(),
    ]);

    return {
      cloneId: clone.id,
      slug: clone.slug,
      billingUserId: clone.billing_user_id ?? null,
      suggested: deriveCloneBillingId(clone.slug),
      tenantBillingUserId:
        (tenants ?? []).map((t) => t.billing_user_id).find((v): v is string => Boolean(v)) ?? null,
      // A null digest means the next sync will push; a digest means one has
      // been pushed. Neither proves what the live bundle holds, which is why
      // the field is named for what was pushed.
      publishedToHosting: Boolean(clone.billing_user_id) && Boolean(deployment?.env_digest),
      bundleCarries:
        (deployment?.bundle_billing_uid as CloneBillingIdentity["bundleCarries"]) ?? null,
      bundleCheckedAt: deployment?.bundle_checked_at ?? null,
    };
  });

/** Judge a candidate without writing it, so the dialog can say why before the
 *  operator commits. The same call the write makes, so the two cannot disagree. */
export const checkCloneBillingIdentity = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((data: { cloneId: string; billingUserId: string }) => {
    if (!data?.cloneId) throw new Error("cloneId required");
    return { cloneId: data.cloneId, billingUserId: String(data.billingUserId ?? "") };
  })
  .handler(async ({ data }) => {
    const verdict = await checkCloneBillingId(data.billingUserId, data.cloneId);
    return verdict.ok
      ? { ok: true as const, billingId: verdict.billingId }
      : { ok: false as const, reason: verdict.reason, message: verdict.message };
  });

export const setCloneBillingIdentity = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((data: { cloneId: string; billingUserId: string }) => {
    if (!data?.cloneId) throw new Error("cloneId required");
    return { cloneId: data.cloneId, billingUserId: String(data.billingUserId ?? "") };
  })
  .handler(async ({ data, context }) => {
    const { data: before } = await supabaseAdmin
      .from("clones")
      .select("billing_user_id")
      .eq("id", data.cloneId)
      .maybeSingle();

    const result = await setCloneBillingId(data.cloneId, data.billingUserId);
    if (!result.ok) throw new Error(result.error);

    await writeAuditLog({
      action: "clone.billing_identity_set",
      entityType: "clone",
      entityId: data.cloneId,
      actorUserId: context.userId,
      metadata: {
        from: before?.billing_user_id ?? null,
        to: result.billingId,
        rebuild: result.rebuild,
      },
    });

    return result;
  });

/** Who else already carries an id, for the refusal's detail line. */
export const whoHoldsBillingIdentity = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((data: { billingUserId: string }) => ({
    billingUserId: String(data?.billingUserId ?? ""),
  }))
  .handler(async ({ data }) => {
    const id = data.billingUserId.trim().toLowerCase();
    if (!id) return { holders: [] };
    return { holders: await billingIdHolders(id) };
  });
