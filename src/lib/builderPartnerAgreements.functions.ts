// Builder Partner Agreement server functions — the surface behind the terms
// registry page, the agreement's own page and the Builders Network console.
//
// A Builder Partner Agreement decides who the Builder Portal admits, which only
// an admin decides: every write here is admin-only, and operators read. The
// engine is `src/server/builder-partner-agreements.server.ts`; the rules it
// applies are in `src/lib/agreements/builderPartner.pure.ts`.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin, requireOperator } from "@/integrations/supabase/role-middleware";

const uuid = z.string().uuid();
const engine = () => import("@/server/builder-partner-agreements.server");

/* ─────────────────────────── the terms registry ─────────────────────────── */

export const listBuilderPartnerTerms = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .handler(async () => {
    const { listRegisteredTerms, readTermsInForce } = await engine();
    const { docusignConfig } = await import("@/server/agreements.server");
    const config = docusignConfig();
    const [registry, inForce] = await Promise.all([listRegisteredTerms(), readTermsInForce()]);
    return {
      ...registry,
      inForceId: inForce.state === "in_force" ? inForce.terms.id : null,
      docusign: {
        ready: config.ready,
        missing: config.missing,
        countersigner: Boolean(config.countersignerEmail),
      },
    };
  });

const detailsInput = z.object({
  name: z.string(),
  versionLabel: z.string(),
  countersignatureRequired: z.boolean(),
  executionStatement: z.string(),
  notes: z.string().default(""),
});

export const installBuilderPartnerTerms = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        fileName: z.string().min(1).max(255),
        // A 15 MB file is ~20 MB of base64; the file check refuses anything larger.
        base64: z.string().min(1).max(21_000_000),
        details: detailsInput,
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { registerTermsFile } = await engine();
    return await registerTermsFile({ actorUserId: context.userId, ...data });
  });

export const editBuilderPartnerTerms = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        id: uuid,
        details: detailsInput,
        expectedUpdatedAt: z.string().nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { updateRegisteredTerms } = await engine();
    return await updateRegisteredTerms({
      actorUserId: context.userId,
      templateId: data.id,
      details: data.details,
      expectedUpdatedAt: data.expectedUpdatedAt ?? null,
    });
  });

export const activateBuilderPartnerTerms = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { putTermsInForce } = await engine();
    return await putTermsInForce({ actorUserId: context.userId, templateId: data.id });
  });

export const retireBuilderPartnerTerms = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ id: uuid, reason: z.string().max(2000) }).parse(input))
  .handler(async ({ data, context }) => {
    const { retireTermsInForce } = await engine();
    await retireTermsInForce({
      actorUserId: context.userId,
      templateId: data.id,
      reason: data.reason,
    });
    return { ok: true as const };
  });

export const deleteBuilderPartnerTerms = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { deleteStagedTerms } = await engine();
    await deleteStagedTerms({ actorUserId: context.userId, templateId: data.id });
    return { ok: true as const };
  });

export const downloadBuilderPartnerTerms = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data }) => {
    const { readRegisteredTermsFile } = await engine();
    return await readRegisteredTermsFile(data.id);
  });

/* ─────────────────────────── agreements ─────────────────────────── */

export const createBuilderPartnerAgreement = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ organisationId: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { prepareBuilderPartnerAgreement } = await engine();
    return await prepareBuilderPartnerAgreement({
      actorUserId: context.userId,
      organisationId: data.organisationId,
    });
  });

export const getBuilderPartnerAgreement = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data }) => {
    const { describeBuilderPartnerAgreement } = await engine();
    return await describeBuilderPartnerAgreement(data.id);
  });

export const saveBuilderPartnerParticulars = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        id: uuid,
        particulars: z.unknown(),
        expectedUpdatedAt: z.string().nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { recordBuilderPartnerParticulars } = await engine();
    return await recordBuilderPartnerParticulars({
      actorUserId: context.userId,
      agreementId: data.id,
      particulars: data.particulars,
      expectedUpdatedAt: data.expectedUpdatedAt ?? null,
    });
  });

export const setBuilderPartnerGrantOnSignature = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ id: uuid, armed: z.boolean() }).parse(input))
  .handler(async ({ data, context }) => {
    const { armGrantOnSignature } = await engine();
    await armGrantOnSignature({
      actorUserId: context.userId,
      agreementId: data.id,
      armed: data.armed,
    });
    return { ok: true as const };
  });

export const grantBuilderPartnerPortalAccess = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { grantBuilderPortalAccess } = await engine();
    return await grantBuilderPortalAccess(data.id, {
      trigger: "manual",
      actorUserId: context.userId,
    });
  });

/**
 * Email the signatory the Portal subscription link now — the first time for an
 * agreement signed before links went automatically, or again after a send that
 * failed or was never confirmed. The page confirms before calling this.
 */
export const sendBuilderPartnerPaymentLink = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { sendBuilderPortalPaymentLink } = await import("@/server/builder-portal-payment.server");
    return await sendBuilderPortalPaymentLink(data.id, {
      trigger: "manual",
      actorUserId: context.userId,
    });
  });

/**
 * Switch a builder on or off the Portal subscription link. Off is for a
 * negotiated monthly fee the link's one price cannot charge: that builder is
 * invoiced in Stripe, and neither the signature, the sweep nor the button
 * sends them the link.
 */
export const setBuilderPartnerPaymentLinkEnabled = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ id: uuid, enabled: z.boolean() }).parse(input))
  .handler(async ({ data, context }) => {
    const { setBuilderPortalPaymentLinkEnabled } =
      await import("@/server/builder-portal-payment.server");
    await setBuilderPortalPaymentLinkEnabled({
      actorUserId: context.userId,
      agreementId: data.id,
      enabled: data.enabled,
    });
    return { ok: true as const };
  });

export const downloadBuilderPartnerSchedule = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data }) => {
    const { readBuilderPartnerSchedule } = await engine();
    return await readBuilderPartnerSchedule(data.id);
  });

export const downloadBuilderPartnerAgreementTerms = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data }) => {
    const { readBuilderPartnerAgreementTerms } = await engine();
    return await readBuilderPartnerAgreementTerms(data.id);
  });

/* ─────────────────────────── the Builders Network console ─────────────────────────── */

export const listBuilderAgreementStates = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .handler(async () => {
    const { readOrganisationAgreementStates } = await engine();
    return await readOrganisationAgreementStates();
  });
