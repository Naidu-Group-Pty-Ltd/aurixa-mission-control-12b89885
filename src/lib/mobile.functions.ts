// Operator surface over `src/server/mobile/console.server.ts`.
//
// Admin-only. Issuing a provisioned URL returns the link ONCE in the response
// body — it carries a live activation ticket — and the audit row records that
// a link was issued, by whom and for which grant, never the ticket.
import { createServerFn } from "@tanstack/react-start";
import { requireAdmin } from "@/integrations/supabase/role-middleware";

const shim = () => import(/* @vite-ignore */ "@/lib/_server-shims/mobileConsole.server");

function str(v: unknown, name: string): string {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${name} is required`);
  return v.trim();
}

export const getCloneMobile = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((d: { cloneId: string }) => ({ cloneId: str(d?.cloneId, "cloneId") }))
  .handler(async ({ data }) => (await shim()).getCloneMobileOverview(data.cloneId));

export const createMobileGrant = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((d: { cloneId: string; portal: string; email: string }) => ({
    cloneId: str(d?.cloneId, "cloneId"),
    portal: str(d?.portal, "portal"),
    email: str(d?.email, "email"),
  }))
  .handler(async ({ data, context }) =>
    (await shim()).operatorCreateGrant({ ...data, actorUserId: context.userId ?? null }),
  );

export const issueMobileLink = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(
    (d: {
      cloneId: string;
      grantId: string;
      kind: "magic_link" | "provisioned_url";
      deliverTo?: string | null;
    }) => {
      if (d?.kind !== "magic_link" && d?.kind !== "provisioned_url")
        throw new Error("kind must be magic_link or provisioned_url");
      return {
        cloneId: str(d.cloneId, "cloneId"),
        grantId: str(d.grantId, "grantId"),
        kind: d.kind,
        deliverTo:
          typeof d.deliverTo === "string" && d.deliverTo.trim() ? d.deliverTo.trim() : null,
      };
    },
  )
  .handler(async ({ data, context }) =>
    (await shim()).operatorIssueLink({ ...data, actorUserId: context.userId ?? null }),
  );

export const revokeMobileGrant = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((d: { cloneId: string; grantId: string; reason: string }) => ({
    cloneId: str(d?.cloneId, "cloneId"),
    grantId: str(d?.grantId, "grantId"),
    reason: str(d?.reason, "reason"),
  }))
  .handler(async ({ data, context }) =>
    (await shim()).operatorRevokeGrant({ ...data, actorUserId: context.userId ?? null }),
  );

export const repairMobileGateway = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((d: { cloneId: string }) => ({ cloneId: str(d?.cloneId, "cloneId") }))
  .handler(async ({ data, context }) =>
    (await shim()).operatorRepairGateway(data.cloneId, context.userId ?? null),
  );

export const listMobileReleases = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((d: { portal?: string | null }) => ({
    portal: typeof d?.portal === "string" && d.portal ? d.portal : null,
  }))
  .handler(async ({ data }) => (await shim()).operatorListReleases(data.portal));

export const moveMobileRelease = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(
    (d: { releaseId: string; action: string; percentage?: number; reason?: string }) => ({
      releaseId: str(d?.releaseId, "releaseId"),
      action: str(d?.action, "action"),
      percentage: typeof d?.percentage === "number" ? d.percentage : undefined,
      reason: typeof d?.reason === "string" ? d.reason : undefined,
    }),
  )
  .handler(async ({ data, context }) => {
    if (!context.userId) throw new Error("An operator must be signed in.");
    return (await shim()).operatorMoveRelease({ ...data, actorUserId: context.userId });
  });
