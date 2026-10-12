/**
 * The Microsoft tenants a campaign can send through, as the console reads
 * them: hints only, never a credential. Shared by the tenants tab and the
 * tenant picker on a campaign's Message tab.
 */
import { useQuery } from "@tanstack/react-query";
import { listMicrosoftTenants } from "@/lib/microsoft-tenants.functions";

export const TENANTS_QUERY_KEY = ["email", "tenants"] as const;

export type TenantListing = Awaited<ReturnType<typeof listMicrosoftTenants>>;
export type TenantSummary = TenantListing["tenants"][number];

/** Every tenant a campaign can choose, and whether the viewer may change them. */
export function useMicrosoftTenants() {
  return useQuery({
    queryKey: TENANTS_QUERY_KEY,
    queryFn: () => listMicrosoftTenants(),
    staleTime: 60_000,
  });
}

/** "Directory …3f9a · App …81c2 · Secret abc…" */
export function hintLine(tenant: Pick<TenantSummary, "hints">): string | null {
  if (!tenant.hints) return null;
  return `Directory ${tenant.hints.directory} · App ${tenant.hints.client} · Secret ${tenant.hints.secret}`;
}
