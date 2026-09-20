import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getFleetBackendIdentity, type FleetIdentity } from "./backend-identity.server";

export type { FleetIdentity, FleetIdentityRow } from "./backend-identity.server";

export const fetchFleetBackendIdentity = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<FleetIdentity> => {
    return getFleetBackendIdentity(context.supabase);
  });
