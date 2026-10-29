// Gather what Mission Control holds about a cloning project's target - the
// lead's application and questionnaire, the agreement's plan, the clone's
// entitlements, the latest fit analysis - into the "ctx:target" source.
//
// Reads fail loudly: a context read that FAILED is not a client we know
// nothing about, and planning without it would quietly produce a plan built
// on less than the operator thinks.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { buildLeadSubject } from "@/lib/fit-analysis.functions";
import { renderTargetContext, type TargetContext } from "@/lib/voice-studio/targetContext.pure";

type Project = {
  target_kind: string;
  clone_id: string | null;
  lead_id: string | null;
  agreement_id: string | null;
  notes: string | null;
  name: string;
};

export async function gatherTargetContext(project: Project): Promise<string | null> {
  const kind = (
    ["clone", "lead", "agreement", "prospect"].includes(project.target_kind)
      ? project.target_kind
      : "prospect"
  ) as TargetContext["kind"];
  const sections: Record<string, unknown> = {};
  if (project.notes) sections["Operator notes on this cloning project"] = project.notes;

  let leadId = project.lead_id;
  let accountId: string | null = null;

  if (project.agreement_id) {
    const { data: agreement, error } = await supabaseAdmin
      .from("client_agreements")
      .select(
        "client_name, client_org, plan_slug, addon_slugs, module_ids, service_tier, notes, account_id, commencement_date",
      )
      .eq("id", project.agreement_id)
      .maybeSingle();
    if (error) throw new Error(`the agreement could not be read: ${error.message}`);
    if (agreement) {
      accountId = agreement.account_id;
      sections["Signed agreement"] = {
        client_organisation: agreement.client_org ?? agreement.client_name,
        plan: agreement.plan_slug,
        service_tier: agreement.service_tier,
        add_ons: agreement.addon_slugs,
        modules: agreement.module_ids,
        commencement_date: agreement.commencement_date,
        notes: agreement.notes,
      };
    }
  }

  if (project.clone_id) {
    const { data: clone, error } = await supabaseAdmin
      .from("clones")
      .select("name, entitled_plan_slug, entitled_module_slugs, purchased_addon_slugs, tags, notes")
      .eq("id", project.clone_id)
      .maybeSingle();
    if (error) throw new Error(`the clone could not be read: ${error.message}`);
    if (clone) {
      sections["Existing workspace"] = {
        workspace_name: clone.name,
        plan: clone.entitled_plan_slug,
        modules: clone.entitled_module_slugs,
        add_ons: clone.purchased_addon_slugs,
        tags: clone.tags,
        notes: clone.notes,
      };
    }
  }

  if (!leadId && accountId) {
    const { data: origin, error } = await supabaseAdmin
      .from("waitlist_leads")
      .select("id")
      .eq("account_id", accountId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`the originating application could not be read: ${error.message}`);
    leadId = origin?.id ?? null;
  }

  if (leadId) {
    const { data: lead, error } = await supabaseAdmin
      .from("waitlist_leads")
      .select("*")
      .eq("id", leadId)
      .maybeSingle();
    if (error) throw new Error(`the lead could not be read: ${error.message}`);
    if (lead) sections["Priority access application and questionnaire"] = buildLeadSubject(lead);
  }

  if (leadId || accountId) {
    let q = supabaseAdmin
      .from("crm_fit_analyses")
      .select("headline, research_summary, grade, recommended_plan, risks, open_questions")
      .eq("status", "complete")
      .order("created_at", { ascending: false })
      .limit(1);
    q = leadId ? q.eq("lead_id", leadId) : q.eq("account_id", accountId as string);
    const { data: fit, error } = await q.maybeSingle();
    if (error) throw new Error(`the fit analysis could not be read: ${error.message}`);
    if (fit) sections["Our fit analysis of the client"] = fit;
  }

  return renderTargetContext({ kind, sections });
}
