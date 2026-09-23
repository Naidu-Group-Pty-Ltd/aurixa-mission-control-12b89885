// A signed agreement that buys voice agents opens a Cloning Studio project.
//
// Only a DRAFT project - nothing is planned, spent or deployed until an admin
// adds the client's documents and asks for a plan. Two rules:
//
// - **It never fails provisioning.** The clone is the product the client paid
//   for; a Studio project is the start of an add-on's delivery. Every error
//   here is logged and swallowed.
// - **It is idempotent.** One project per agreement (the migration's unique
//   index on agreement_id), so a retried provisioning run finds the project it
//   already made instead of opening a second.
//
// The add-on is recognised by slug. The catalog row itself - name and price -
// is the owner's to publish (the catalog syncs to Stripe), and until it exists
// no agreement can carry the slug, so this does nothing.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const VOICE_AGENTS_ADDON_SLUG = "voice-agents";

export async function openStudioProjectForAgreement(args: {
  agreementId: string;
  cloneId: string | null;
  clientName: string;
  addonSlugs: string[] | null;
}): Promise<{ opened: boolean; projectId: string | null }> {
  if (!(args.addonSlugs ?? []).includes(VOICE_AGENTS_ADDON_SLUG))
    return { opened: false, projectId: null };
  try {
    const { data: existing, error: readError } = await supabaseAdmin
      .from("voice_studio_projects")
      .select("id, clone_id")
      .eq("agreement_id", args.agreementId)
      .maybeSingle();
    if (readError) throw readError;
    if (existing) {
      // A retry that has since produced the clone links it; nothing else moves.
      if (!existing.clone_id && args.cloneId) {
        const { error } = await supabaseAdmin
          .from("voice_studio_projects")
          .update({ clone_id: args.cloneId })
          .eq("id", existing.id);
        if (error) throw error;
      }
      return { opened: false, projectId: existing.id };
    }
    const { data, error } = await supabaseAdmin
      .from("voice_studio_projects")
      .insert({
        name: `${args.clientName} voice agents`,
        target_kind: "agreement",
        agreement_id: args.agreementId,
        clone_id: args.cloneId,
        notes:
          "Opened automatically when the signed agreement provisioned. Add the client's documents to plan the fleet.",
      })
      .select("id")
      .single();
    if (error) throw error;
    return { opened: true, projectId: data.id };
  } catch (err) {
    console.error(
      "[voice-studio] could not open a project for agreement",
      args.agreementId,
      err instanceof Error ? err.message : err,
    );
    return { opened: false, projectId: null };
  }
}
