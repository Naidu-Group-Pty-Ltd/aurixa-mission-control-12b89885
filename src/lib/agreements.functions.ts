// Client agreements server functions — the operator surface behind
// /agreements: create for a converted lead, send via DocuSign, track,
// download the signed document, void.
import { createServerFn } from "@tanstack/react-start";
import { asJson } from "@/lib/json-cast";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import { requireAdmin, requireOperator } from "@/integrations/supabase/role-middleware";

const uuid = z.string().uuid();

export type AgreementRow = Database["public"]["Tables"]["client_agreements"]["Row"];

export const AGREEMENT_STATUSES = [
  "draft",
  "sent",
  "delivered",
  "signed",
  "declined",
  "voided",
] as const;

export const SERVICE_TIERS = ["Launch", "Growth", "Scale", "Enterprise"] as const;

/** DocuSign configuration state — which env secrets are still missing. */
export const getAgreementsConfig = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .handler(async () => {
    const { docusignConfig } = await import("@/server/agreements.server");
    const config = docusignConfig();
    return {
      configured: config.ready,
      missing: config.missing,
      baseUrl: config.ready ? config.baseUrl : null,
      countersigner: config.countersignerEmail
        ? { name: config.countersignerName, email: config.countersignerEmail }
        : null,
    };
  });

export const listAgreements = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        status: z.enum(["all", ...AGREEMENT_STATUSES]).default("all"),
        search: z.string().max(120).default(""),
        limit: z.number().int().min(1).max(200).default(100),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("client_agreements")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.status !== "all") q = q.eq("status", data.status);
    if (data.search.trim()) {
      const s = data.search.trim().replace(/[%_]/g, "");
      q = q.or(`client_name.ilike.%${s}%,client_email.ilike.%${s}%,client_org.ilike.%${s}%`);
    }
    const { data: rows, error } = await q;
    if (error) throw error;
    return { agreements: (rows ?? []) as AgreementRow[] };
  });

/** Contacts with an email address — the sendable population, with journey stage. */
export const searchAgreementClients = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ search: z.string().max(120) }).parse(input))
  .handler(async ({ data, context }) => {
    const s = data.search.trim().replace(/[%_]/g, "");
    if (!s) return { contacts: [] };
    const { data: rows, error } = await context.supabase
      .from("crm_contacts")
      .select(
        "id, account_id, first_name, last_name, email, crm_accounts(name), crm_client_journeys(stage_key)",
      )
      .not("email", "is", null)
      .or(`first_name.ilike.%${s}%,last_name.ilike.%${s}%,email.ilike.%${s}%`)
      .limit(8);
    if (error) throw error;
    return {
      contacts: (rows ?? []).map((r) => {
        const account = r.crm_accounts as unknown as { name: string } | null;
        const journeys = r.crm_client_journeys as unknown as Array<{ stage_key: string }> | null;
        return {
          id: r.id,
          accountId: r.account_id,
          name: [r.first_name, r.last_name].filter(Boolean).join(" "),
          email: r.email as string,
          org: account?.name ?? null,
          stage: journeys?.[0]?.stage_key ?? null,
        };
      }),
    };
  });

export const createAgreement = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        contactId: uuid.optional(),
        clientName: z.string().min(1).max(200),
        clientEmail: z.string().email().max(200),
        clientOrg: z.string().max(200).optional(),
        serviceTier: z.enum(SERVICE_TIERS).optional(),
        commencementDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        notes: z.string().max(4000).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    let accountId: string | null = null;
    if (data.contactId) {
      const { data: contact, error } = await context.supabase
        .from("crm_contacts")
        .select("account_id")
        .eq("id", data.contactId)
        .maybeSingle();
      if (error) throw error;
      accountId = contact?.account_id ?? null;
    }
    const { data: row, error: insertError } = await context.supabase
      .from("client_agreements")
      .insert({
        contact_id: data.contactId ?? null,
        account_id: accountId,
        client_name: data.clientName,
        client_email: data.clientEmail,
        client_org: data.clientOrg ?? null,
        service_tier: data.serviceTier ?? null,
        commencement_date: data.commencementDate ?? null,
        notes: data.notes ?? null,
        created_by: context.userId,
      })
      .select("id")
      .single();
    if (insertError) throw insertError;
    return { id: row.id };
  });

export const sendAgreement = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data }) => {
    const { sendAgreementEnvelope } = await import("@/server/agreements.server");
    return await sendAgreementEnvelope(data.id);
  });

export const refreshAgreementStatus = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data }) => {
    const { refreshEnvelopeStatus } = await import("@/server/agreements.server");
    return await refreshEnvelopeStatus(data.id);
  });

export const downloadSignedAgreement = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data }) => {
    const { downloadSignedPdf } = await import("@/server/agreements.server");
    return await downloadSignedPdf(data.id);
  });

export const voidAgreement = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z.object({ id: uuid, reason: z.string().max(500).default("") }).parse(input),
  )
  .handler(async ({ data }) => {
    const { voidEnvelope } = await import("@/server/agreements.server");
    await voidEnvelope(data.id, data.reason);
    return { ok: true };
  });

export const deleteDraftAgreement = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("client_agreements")
      .delete()
      .eq("id", data.id)
      .eq("status", "draft");
    if (error) throw error;
    return { ok: true };
  });

/* ─────────────────── provisioning on signature ─────────────────── */

/**
 * The pickers' catalog: active tier plans, active add-ons, approved modules.
 * Minimal columns — this feeds three multi-selects, not a report.
 */
export const getProvisioningCatalog = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .handler(async ({ context }) => {
    const [plans, addons, modules] = await Promise.all([
      context.supabase
        .from("billing_plans")
        .select("slug, name, price_cents, currency")
        .eq("is_active", true)
        .order("price_cents", { ascending: true }),
      context.supabase
        .from("addon_modules")
        .select("slug, name, category")
        .eq("is_active", true)
        .order("sort_order", { ascending: true }),
      context.supabase
        .from("modules")
        .select("id, name, description")
        .order("name", { ascending: true }),
    ]);
    return {
      plans: plans.data ?? [],
      addons: addons.data ?? [],
      modules: modules.data ?? [],
    };
  });

/**
 * Record (or update) the commercial selection on an agreement and arm — or
 * disarm — provision-on-signature. Refused once provisioning has started:
 * what a signature provisions must be what the signature saw.
 */
export const configureAgreementProvisioning = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        id: uuid,
        planSlug: z.string().min(1).max(100),
        moduleIds: z.array(uuid).max(200).default([]),
        addonSlugs: z.array(z.string().min(1).max(100)).max(100).default([]),
        excludedModuleIds: z.array(uuid).max(200).default([]),
        adminEmail: z.string().email().max(200).optional(),
        region: z.string().min(1).max(50).optional(),
        armed: z.boolean(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: agreement, error } = await context.supabase
      .from("client_agreements")
      .select("id, client_email, provision_status")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw error;
    if (!agreement) throw new Error("agreement_not_found");
    if (
      agreement.provision_status === "provisioning" ||
      agreement.provision_status === "provisioned"
    ) {
      throw new Error(
        "Provisioning has already started for this agreement — the selection is locked.",
      );
    }

    // Validate against the catalog rather than trusting spellings: an
    // unknown slug held until signature would fail provisioning at the
    // worst moment, with the client watching.
    const [plan, addons, modules] = await Promise.all([
      context.supabase
        .from("billing_plans")
        .select("slug")
        .eq("slug", data.planSlug)
        .eq("is_active", true)
        .maybeSingle(),
      data.addonSlugs.length
        ? context.supabase
            .from("addon_modules")
            .select("slug")
            .in("slug", data.addonSlugs)
            .eq("is_active", true)
        : Promise.resolve({ data: [] as Array<{ slug: string }>, error: null }),
      data.moduleIds.length || data.excludedModuleIds.length
        ? context.supabase
            .from("modules")
            .select("id")
            .in("id", [...new Set([...data.moduleIds, ...data.excludedModuleIds])])
        : Promise.resolve({ data: [] as Array<{ id: string }>, error: null }),
    ]);
    if (!plan.data) throw new Error(`Unknown or inactive plan: ${data.planSlug}`);
    const knownAddons = new Set((addons.data ?? []).map((a) => a.slug));
    const missingAddons = data.addonSlugs.filter((s) => !knownAddons.has(s));
    if (missingAddons.length)
      throw new Error(`Unknown or inactive add-on(s): ${missingAddons.join(", ")}`);
    const knownModules = new Set((modules.data ?? []).map((m) => m.id));
    const missingModules = [...data.moduleIds, ...data.excludedModuleIds].filter(
      (m) => !knownModules.has(m),
    );
    if (missingModules.length)
      throw new Error(`Unknown module id(s): ${missingModules.join(", ")}`);

    const { error: updateError } = await context.supabase
      .from("client_agreements")
      .update({
        plan_slug: data.planSlug,
        module_ids: data.moduleIds,
        addon_slugs: data.addonSlugs,
        excluded_module_ids: data.excludedModuleIds,
        admin_email: data.adminEmail ?? agreement.client_email,
        ...(data.region ? { provision_region: data.region } : {}),
        provision_on_signature: data.armed,
        provision_status: data.armed ? "armed" : "none",
        provision_error: null,
      })
      .eq("id", data.id);
    if (updateError) throw updateError;
    return { ok: true };
  });

/**
 * The explicit button: provision a signed agreement now. Also the recovery
 * path — it may retry a failed attempt and may provision a signed agreement
 * that was never armed (pressing it IS the arming). Admin-level, because it
 * spends real resources on purpose.
 */
export const provisionAgreementNow = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { provisionCloneFromAgreement } = await import(
      /* @vite-ignore */ "@/lib/_server-shims/agreement-provisioning.server"
    );
    const result = await provisionCloneFromAgreement(data.id, {
      trigger: "operator",
      actorUserId: context.userId,
    });
    await context.supabase.from("audit_log").insert({
      action: "agreement.provision_now",
      entity_type: "client_agreement",
      entity_id: data.id,
      actor_user_id: context.userId,
      metadata: asJson(result),
    });
    return result;
  });
