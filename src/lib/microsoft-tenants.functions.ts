/**
 * The console's API for Microsoft tenants.
 *
 * Any operator may see the list — a campaign's sender is chosen from it — but
 * only an admin may add, change, re-verify or remove one, because doing so
 * decides which organisation's mail system Mission Control speaks for.
 *
 * Credentials come IN through these functions and never go back out: every
 * response carries hints (`…3f9a`, `abc…`), never a value. All of them use
 * the service role, behind the role checks above, because the credentials
 * live in Supabase Vault where no browser session can reach them.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin, requireOperator } from "@/integrations/supabase/role-middleware";
import { ADMIN_ROLES, hasAnyRole } from "@/integrations/supabase/roles";
import { LABEL_MAX, SECRET_MAX } from "@/lib/email/microsoftTenants.pure";

const uuid = z.string().uuid();
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable();
const mailbox = z.string().trim().max(320).nullable();

const credentialFields = {
  directoryTenantId: z.string().trim().max(253),
  clientId: z.string().trim().max(64),
  clientSecret: z.string().max(SECRET_MAX),
};

export const listMicrosoftTenants = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .handler(async ({ context }) => {
    const { listTenants } = await import("@/server/microsoft-tenants.server");
    const { data: roles } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    return {
      canManage: hasAnyRole(
        (roles ?? []).map((row) => row.role as string),
        ADMIN_ROLES,
      ),
      tenants: await listTenants(),
    };
  });

export const addMicrosoftTenant = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        label: z.string().trim().min(1).max(LABEL_MAX),
        ...credentialFields,
        defaultMailbox: mailbox,
        secretExpiresOn: date,
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { addTenant } = await import("@/server/microsoft-tenants.server");
    const { id, verification } = await addTenant(data, context.userId);
    return { id, roles: verification.roles, capabilities: verification.capabilities };
  });

export const updateMicrosoftTenant = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        tenantId: uuid,
        label: z.string().trim().min(1).max(LABEL_MAX).optional(),
        directoryTenantId: credentialFields.directoryTenantId.optional(),
        clientId: credentialFields.clientId.optional(),
        // Blank keeps the stored secret, as a deployment secret left alone does.
        clientSecret: credentialFields.clientSecret.optional(),
        defaultMailbox: mailbox.optional(),
        secretExpiresOn: date.optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { updateTenant } = await import("@/server/microsoft-tenants.server");
    const { tenantId, ...change } = data;
    const { verification } = await updateTenant(tenantId, change, context.userId);
    return {
      credentialsReplaced: verification !== null,
      roles: verification?.roles ?? null,
    };
  });

export const verifyMicrosoftTenant = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ tenantId: uuid.nullable() }).parse(input))
  .handler(async ({ data }) => {
    const { verifyTenant } = await import("@/server/microsoft-tenants.server");
    const verification = await verifyTenant(data.tenantId);
    if (!data.tenantId) {
      // The deployment's tenant has no row to record the answer on; the
      // capability cache the campaign pages read is what has to move.
      const { forgetGraphCapabilities } = await import("@/server/email-mailboxes.server");
      forgetGraphCapabilities(null);
    }
    return {
      ok: verification.ok,
      error: verification.error,
      roles: verification.roles,
      capabilities: verification.capabilities,
    };
  });

export const removeMicrosoftTenant = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ tenantId: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { removeTenant } = await import("@/server/microsoft-tenants.server");
    await removeTenant(data.tenantId, context.userId);
    return { ok: true };
  });
