// Client agreements server functions — the operator surface behind
// /agreements: raise an agreement for a lead or client, send it via
// DocuSign, track it, download the signed document, void.
//
// Two kinds of agreement share one row and one lifecycle (`document_kind`):
// the Service Level Agreement, a fixed PDF with a few prefilled tabs, and the
// Subscription Agreement — the approved Launch, Growth or Scale offer, a Word
// document Mission Control completes from a recorded offer. The subscription
// half of this file prepares that offer; the DocuSign half is shared.
import { createServerFn } from "@tanstack/react-start";
import { asJson } from "@/lib/json-cast";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { requireAdmin, requireOperator } from "@/integrations/supabase/role-middleware";
import {
  agreementColumnsFromOffer,
  issuingDay,
  provisioningSelectionFromOffer,
  selectionMatches,
} from "@/lib/agreements/subscriptionIssue.pure";
import {
  issuingProfileSchema,
  newOfferReference,
  newSubscriptionOffer,
  subscriptionOfferSchema,
  type IssuingProfile,
  type SubscriptionOffer,
} from "@/lib/agreements/subscriptionOffer.pure";
import { SUBSCRIPTION_TEMPLATES } from "@/lib/agreements/subscriptionTemplates";

const uuid = z.string().uuid();

export type AgreementRow = Database["public"]["Tables"]["client_agreements"]["Row"];

/**
 * A row as the list carries it: everything but the working offer and the
 * issued snapshot, which only the offer's own page reads — a hundred of each
 * would be megabytes of JSON behind a table of names.
 */
export type AgreementListRow = Omit<AgreementRow, "offer" | "issued_snapshot">;

const LIST_COLUMNS = [
  "id",
  "document_kind",
  "offer_reference",
  "lead_id",
  "contact_id",
  "account_id",
  "client_name",
  "client_email",
  "client_org",
  "service_tier",
  "commencement_date",
  "notes",
  "status",
  "docusign_envelope_id",
  "docusign_status",
  "docusign_sent_at",
  "docusign_signed_at",
  "docusign_voided_at",
  "void_reason",
  "issued_at",
  "signed_record_path",
  "signed_record_sha256",
  "signed_record_retained_at",
  "plan_slug",
  "module_ids",
  "addon_slugs",
  "excluded_module_ids",
  "admin_email",
  "provision_region",
  "provision_on_signature",
  "provision_status",
  "provision_error",
  "provisioned_clone_id",
  "created_by",
  "metadata",
  "created_at",
  "updated_at",
].join(", ");

export const AGREEMENT_KINDS = ["sla", "subscription"] as const;

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
        kind: z.enum(["all", ...AGREEMENT_KINDS]).default("all"),
        search: z.string().max(120).default(""),
        limit: z.number().int().min(1).max(200).default(100),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("client_agreements")
      .select(LIST_COLUMNS)
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.status !== "all") q = q.eq("status", data.status);
    if (data.kind !== "all") q = q.eq("document_kind", data.kind);
    const s = searchTerm(data.search);
    if (s) {
      q = q.or(
        `client_name.ilike.%${s}%,client_email.ilike.%${s}%,client_org.ilike.%${s}%,offer_reference.ilike.%${s}%`,
      );
    }
    const { data: rows, error } = await q;
    if (error) throw error;
    return { agreements: (rows ?? []) as unknown as AgreementListRow[] };
  });

/**
 * A search box's text, reduced to what can sit inside a PostgREST `or()`
 * filter: letters, digits, spaces and the punctuation names and addresses
 * carry. Commas, parentheses and quotes would end the filter early; `%`, `_`
 * and `*` are wildcards.
 */
function searchTerm(raw: string): string {
  return raw
    .trim()
    .replace(/[^\p{L}\p{N}\s@.'+-]/gu, "")
    .replace(/\s+/g, " ")
    .slice(0, 80);
}

/** Contacts with an email address — the sendable population, with journey stage. */
export const searchAgreementClients = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ search: z.string().max(120) }).parse(input))
  .handler(async ({ data, context }) => {
    const s = searchTerm(data.search);
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
  .handler(async ({ data, context }) => {
    const { sendAgreementEnvelope } = await import("@/server/agreements.server");
    return await sendAgreementEnvelope(data.id, { actorUserId: context.userId });
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
    // A draft is a status; an offer being sent is a draft with a claim, and a
    // sent offer is a record. Only a draft that was never issued may go.
    const { data: deleted, error } = await context.supabase
      .from("client_agreements")
      .delete()
      .eq("id", data.id)
      .eq("status", "draft")
      .is("docusign_envelope_id", null)
      .is("issued_at", null)
      .select("id");
    if (error) throw error;
    if (!deleted?.length) {
      throw new Error("Only an unsent draft can be deleted. A sent agreement is voided instead.");
    }
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
        .select("id, slug, name, description")
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
      .select("id, client_email, provision_status, document_kind, offer")
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
    if (agreement.document_kind === "subscription") {
      // What a signature provisions is what the offer sold. The plan and the
      // add-ons follow the offer on every save; here they may only be
      // confirmed, never changed, or the customer would sign for one thing
      // and receive another.
      const offer = subscriptionOfferSchema.safeParse(agreement.offer);
      if (!offer.success) throw new Error("The agreement's offer could not be read.");
      const sold = provisioningSelectionFromOffer(offer.data);
      if (!selectionMatches({ plan_slug: data.planSlug, addon_slugs: data.addonSlugs }, sold)) {
        const names = [sold.planSlug, ...sold.addonSlugs].join(" + ");
        throw new Error(
          `This agreement's offer sells ${names}. Provisioning follows the offer — change the offer to change what a signature provisions.`,
        );
      }
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

/* ─────────────────── subscription agreements ─────────────────── */

const TIER = z.enum(["launch", "growth", "scale"]);

/** The standing facts as stored; an empty profile when none is stored yet. */
async function readIssuingProfile(
  supabase: SupabaseClient<Database>,
): Promise<{ profile: IssuingProfile; stored: boolean; valid: boolean; updatedAt: string | null }> {
  const { data, error } = await supabase
    .from("agreement_issuing_profile")
    .select("facts, updated_at")
    .eq("singleton", true)
    .maybeSingle();
  if (error) throw error;
  const parsed = issuingProfileSchema.safeParse(data?.facts ?? {});
  return {
    profile: parsed.success ? parsed.data : issuingProfileSchema.parse({}),
    stored: Boolean(data),
    valid: parsed.success,
    updatedAt: data?.updated_at ?? null,
  };
}

/**
 * What the offer editor needs besides the offer: Aurixa's standing facts, the
 * live report rate card Schedule A4 quotes, and today in Sydney (an offer
 * cannot be backdated, and the composer warns against it).
 */
export const getSubscriptionContext = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .handler(async ({ context }) => {
    const { readRateCard } = await import("@/server/subscription-agreements.server");
    const [profile, rateCard] = await Promise.all([
      readIssuingProfile(context.supabase),
      readRateCard(),
    ]);
    return {
      profile: profile.profile,
      profileStored: profile.stored,
      profileValid: profile.valid,
      profileUpdatedAt: profile.updatedAt,
      rateCard,
      today: issuingDay(new Date()),
    };
  });

/**
 * Replace the issuing profile. Admin only — the database enforces the same —
 * because it is printed into every offer Aurixa issues. Existing offers keep
 * the facts they were prepared with; an operator applies the new profile to a
 * draft deliberately.
 */
export const saveIssuingProfile = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ profile: issuingProfileSchema }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: saved, error } = await context.supabase
      .from("agreement_issuing_profile")
      .upsert(
        { singleton: true, facts: asJson(data.profile), updated_by: context.userId },
        { onConflict: "singleton" },
      )
      .select("updated_at")
      .single();
    if (error) throw error;
    const { writeAuditLog } = await import(/* @vite-ignore */ "@/lib/_server-shims/audit.server");
    await writeAuditLog({
      action: "agreement.issuing_profile_saved",
      entityType: "agreement_issuing_profile",
      actorUserId: context.userId,
      metadata: { profile: asJson(data.profile) },
    });
    return { ok: true, updatedAt: saved.updated_at };
  });

/** Waitlist leads by name, email or organisation — the people an offer is raised for. */
export const searchAgreementLeads = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ search: z.string().max(120) }).parse(input))
  .handler(async ({ data, context }) => {
    const s = searchTerm(data.search);
    if (!s) return { leads: [] };
    const words = s.split(" ");
    const clauses = [
      `first_name.ilike.%${s}%`,
      `last_name.ilike.%${s}%`,
      `email.ilike.%${s}%`,
      `entity_name.ilike.%${s}%`,
    ];
    // "Alex Example" is a first name and a last name, not one field's text.
    if (words.length >= 2) {
      clauses.push(
        `and(first_name.ilike.%${words[0]}%,last_name.ilike.%${words[words.length - 1]}%)`,
      );
    }
    const { data: rows, error } = await context.supabase
      .from("waitlist_leads")
      .select("id, first_name, last_name, email, entity_name, role, status, account_id, created_at")
      .or(clauses.join(","))
      .order("created_at", { ascending: false })
      .limit(8);
    if (error) throw error;
    return {
      leads: (rows ?? []).map((r) => ({
        id: r.id,
        name: [r.first_name, r.last_name].filter(Boolean).join(" "),
        email: r.email,
        org: r.entity_name,
        role: r.role,
        status: r.status,
        accountId: r.account_id,
        createdAt: r.created_at,
      })),
    };
  });

type OfferParty = Pick<SubscriptionOffer, "customer" | "signatory">;

/**
 * Who an offer is for, as far as Mission Control already knows: the lead's
 * organisation and the lead as its representative, then anything a CRM
 * contact adds. Every value is a starting point the operator confirms — the
 * composer will not issue an offer without a verified signatory, an
 * identifier that passes its check digits and a confirmed address.
 */
async function seedOfferParty(
  supabase: SupabaseClient<Database>,
  input: { leadId?: string; contactId?: string },
): Promise<{
  party: OfferParty;
  leadId: string | null;
  contactId: string | null;
  accountId: string | null;
}> {
  const party: OfferParty = {
    customer: { legalName: "", identifier: "", address: "", noticeEmail: "", billingContact: "" },
    signatory: { name: "", role: "", email: "" },
  };
  let leadId: string | null = null;
  let contactId: string | null = null;
  let accountId: string | null = null;

  if (input.leadId) {
    const { data: lead, error } = await supabase
      .from("waitlist_leads")
      .select("id, first_name, last_name, email, entity_name, role, account_id")
      .eq("id", input.leadId)
      .maybeSingle();
    if (error) throw error;
    if (!lead) throw new Error("lead_not_found");
    leadId = lead.id;
    accountId = lead.account_id;
    party.customer.legalName = lead.entity_name?.trim() ?? "";
    party.customer.noticeEmail = lead.email.trim();
    party.signatory.name = [lead.first_name, lead.last_name]
      .map((n) => n?.trim())
      .filter(Boolean)
      .join(" ");
    party.signatory.role = lead.role?.trim() ?? "";
    party.signatory.email = lead.email.trim();
    // A converted lead's CRM contact carries the same address; linking it puts
    // the offer on the client's timeline beside their calls and journey.
    if (lead.account_id && !input.contactId) {
      const { data: contact, error: contactError } = await supabase
        .from("crm_contacts")
        .select("id")
        .eq("account_id", lead.account_id)
        .eq("email", lead.email)
        .limit(1)
        .maybeSingle();
      if (contactError) throw contactError;
      contactId = contact?.id ?? null;
    }
  }

  if (input.contactId) {
    const { data: contact, error } = await supabase
      .from("crm_contacts")
      .select("id, account_id, first_name, last_name, email, job_title, crm_accounts(name)")
      .eq("id", input.contactId)
      .maybeSingle();
    if (error) throw error;
    if (!contact) throw new Error("contact_not_found");
    contactId = contact.id;
    accountId = accountId ?? contact.account_id;
    const accountName = (contact.crm_accounts as unknown as { name: string } | null)?.name ?? "";
    const name = [contact.first_name, contact.last_name]
      .map((n) => n?.trim())
      .filter(Boolean)
      .join(" ");
    // The lead's own words win; the contact fills what they left blank.
    party.customer.legalName ||= accountName.trim();
    party.customer.noticeEmail ||= contact.email?.trim() ?? "";
    party.signatory.name ||= name;
    party.signatory.role ||= contact.job_title?.trim() ?? "";
    party.signatory.email ||= contact.email?.trim() ?? "";
  }

  return { party, leadId, contactId, accountId };
}

type NewOfferRow = {
  offer: SubscriptionOffer;
  leadId: string | null;
  contactId: string | null;
  accountId: string | null;
  notes?: string | null;
  metadata?: Record<string, unknown>;
  createdBy: string;
};

/**
 * Insert a draft offer under a fresh reference. The reference is printed
 * beside the signature, so it is unique in the database; a collision (32^6
 * per day) is retried rather than trusted to never happen.
 */
async function insertOffer(
  supabase: SupabaseClient<Database>,
  input: NewOfferRow,
): Promise<{ id: string; offerReference: string }> {
  const cols = agreementColumnsFromOffer(input.offer);
  for (let attempt = 0; attempt < 3; attempt++) {
    const reference = newOfferReference(new Date(), (n) =>
      crypto.getRandomValues(new Uint8Array(n)),
    );
    const { data: row, error } = await supabase
      .from("client_agreements")
      .insert({
        ...cols,
        document_kind: "subscription",
        offer: asJson(input.offer),
        offer_reference: reference,
        lead_id: input.leadId,
        contact_id: input.contactId,
        account_id: input.accountId,
        // Both are NOT NULL and are replaced by the offer's own on every save.
        client_name: cols.client_name ?? "New customer",
        client_email: cols.client_email ?? "",
        notes: input.notes ?? null,
        metadata: asJson(input.metadata ?? {}),
        created_by: input.createdBy,
      })
      .select("id")
      .single();
    if (!error) return { id: row.id, offerReference: reference };
    if (error.code !== "23505") throw error;
  }
  throw new Error("An offer reference could not be allocated. Try again.");
}

/**
 * Raise a Subscription Agreement offer for a lead (or a CRM contact, or
 * nobody yet): a draft on the chosen tier, prefilled from the issuing profile
 * and from what Mission Control knows about the lead.
 */
export const createSubscriptionAgreement = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z.object({ tier: TIER, leadId: uuid.optional(), contactId: uuid.optional() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const [{ profile }, seeded] = await Promise.all([
      readIssuingProfile(context.supabase),
      seedOfferParty(context.supabase, data),
    ]);
    const offer = newSubscriptionOffer(data.tier, profile, seeded.party);
    const created = await insertOffer(context.supabase, {
      offer,
      leadId: seeded.leadId,
      contactId: seeded.contactId,
      accountId: seeded.accountId,
      createdBy: context.userId,
    });
    const { writeAuditLog } = await import(/* @vite-ignore */ "@/lib/_server-shims/audit.server");
    await writeAuditLog({
      action: "agreement.subscription_prepared",
      entityType: "client_agreement",
      entityId: created.id,
      actorUserId: context.userId,
      metadata: {
        offer_reference: created.offerReference,
        tier: data.tier,
        lead_id: seeded.leadId,
        contact_id: seeded.contactId,
      },
    });
    return created;
  });

/** One agreement in full — the offer page's read. */
export const getAgreement = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("client_agreements")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw error;
    if (!row) throw new Error("agreement_not_found");
    const [lead, account] = await Promise.all([
      row.lead_id
        ? context.supabase
            .from("waitlist_leads")
            .select("id, first_name, last_name, email, entity_name, status")
            .eq("id", row.lead_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      row.account_id
        ? context.supabase
            .from("crm_accounts")
            .select("id, name")
            .eq("id", row.account_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    if (lead.error) throw lead.error;
    if (account.error) throw account.error;
    return {
      agreement: row as AgreementRow,
      lead: lead.data
        ? {
            id: lead.data.id,
            name: [lead.data.first_name, lead.data.last_name].filter(Boolean).join(" "),
            email: lead.data.email,
            org: lead.data.entity_name,
            status: lead.data.status,
          }
        : null,
      account: account.data ? { id: account.data.id, name: account.data.name } : null,
    };
  });

/**
 * Save the working offer. Only an offer that has never been issued changes:
 * the write is conditional on the row still being an unclaimed draft, so a
 * save racing a send loses rather than editing the offer being sent.
 *
 * The row's own columns — the name, the organisation, the tier, and the plan
 * and add-ons a signature provisions — follow the offer. When the plan or
 * add-ons change, the module selection made for the old ones is cleared and
 * armed provisioning is disarmed: it was armed for something the offer no
 * longer sells.
 */
export const saveSubscriptionOffer = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid, offer: subscriptionOfferSchema }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("client_agreements")
      .select(
        "id, document_kind, status, docusign_envelope_id, issued_at, plan_slug, addon_slugs, provision_on_signature",
      )
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw error;
    if (!row) throw new Error("agreement_not_found");
    if (row.document_kind !== "subscription") throw new Error("not_a_subscription_agreement");
    if (row.docusign_envelope_id || row.status !== "draft") {
      throw new Error(
        "This offer has been issued and is now a record. Duplicate it to prepare a revised offer.",
      );
    }
    if (row.issued_at) {
      throw new Error("This offer is being sent, so it cannot change. Refresh in a moment.");
    }

    const selectionChanged = !selectionMatches(row, provisioningSelectionFromOffer(data.offer));
    const disarm = selectionChanged && row.provision_on_signature;
    const { data: saved, error: saveError } = await context.supabase
      .from("client_agreements")
      .update({
        ...agreementColumnsFromOffer(data.offer),
        offer: asJson(data.offer),
        ...(selectionChanged ? { module_ids: [] } : {}),
        ...(disarm
          ? { provision_on_signature: false, provision_status: "none", provision_error: null }
          : {}),
      })
      .eq("id", data.id)
      .eq("document_kind", "subscription")
      .eq("status", "draft")
      .is("docusign_envelope_id", null)
      .is("issued_at", null)
      .select("id, updated_at");
    if (saveError) throw saveError;
    if (!saved?.length) {
      throw new Error(
        "The offer started sending while you were editing it, so nothing was saved. Refresh to see it.",
      );
    }
    return { ok: true, updatedAt: saved[0].updated_at, disarmed: disarm };
  });

/**
 * The offer as a Word document: a PREVIEW before it is sent (marked, in its
 * name, title and acceptance field, as not an offer), the ISSUED document
 * after — reproduced from its record and served only if it matches what was
 * sent.
 */
export const downloadSubscriptionAgreementDocument = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data }) => {
    const { downloadSubscriptionDocument } =
      await import("@/server/subscription-agreements.server");
    return await downloadSubscriptionDocument(data.id);
  });

/**
 * A new draft carrying another offer's terms, under a new reference. This is
 * how an issued offer is corrected — clause 1.2 makes the offer the complete
 * document that was issued, so a revision is a new offer, never an edit.
 */
export const duplicateSubscriptionOffer = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("client_agreements")
      .select("id, document_kind, offer, offer_reference, lead_id, contact_id, account_id, notes")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw error;
    if (!row) throw new Error("agreement_not_found");
    if (row.document_kind !== "subscription") throw new Error("not_a_subscription_agreement");
    const offer = subscriptionOfferSchema.safeParse(row.offer);
    if (!offer.success) throw new Error("The offer could not be read, so it cannot be duplicated.");
    const created = await insertOffer(context.supabase, {
      offer: offer.data,
      leadId: row.lead_id,
      contactId: row.contact_id,
      accountId: row.account_id,
      notes: row.notes,
      metadata: { duplicated_from: row.id, duplicated_from_reference: row.offer_reference },
      createdBy: context.userId,
    });
    const { writeAuditLog } = await import(/* @vite-ignore */ "@/lib/_server-shims/audit.server");
    await writeAuditLog({
      action: "agreement.subscription_duplicated",
      entityType: "client_agreement",
      entityId: created.id,
      actorUserId: context.userId,
      metadata: {
        offer_reference: created.offerReference,
        from_agreement_id: row.id,
        from_offer_reference: row.offer_reference,
        tier: offer.data.tier,
      },
    });
    return created;
  });

/** The tier names, for labels outside the offer editor. */
export const SUBSCRIPTION_TIER_NAMES = Object.fromEntries(
  Object.values(SUBSCRIPTION_TEMPLATES).map((t) => [t.tier, t.tierName]),
) as Record<SubscriptionOffer["tier"], string>;
