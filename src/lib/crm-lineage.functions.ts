// Which clone heads each CRM line — the provisioning wizard's read.
//
// The wizard asks which CRM a new clone runs, and the answer is a choice of
// PARENT: the new repository is copied from that line's parent clone and
// recorded as its child (see `src/server/crmLineage.pure.ts`). This reads both
// lines through the same judge provisioning refuses with, so a line the page
// offers is one provisioning will accept, and a line it disables carries the
// words provisioning would have refused it with.
//
// Read through the caller's own client, as provisioning reads it, so the page
// and the provision cannot see two different configurations.
import { createServerFn } from "@tanstack/react-start";
import { requireAdmin } from "@/integrations/supabase/role-middleware";

export const getCrmLineageRoots = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .handler(async ({ context }) => {
    const { readCrmLineageRoots } = await import(
      /* @vite-ignore */ "@/lib/_server-shims/crmLineage.server"
    );
    return readCrmLineageRoots(context.supabase);
  });
