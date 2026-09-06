/**
 * The allow-list checked against the PRIME'S ACTUAL COLUMN LISTS.
 *
 * `referenceTables.pure.test.ts` checks the rules with invented columns, which
 * proves the rules and proves nothing about this deployment. This file holds a
 * snapshot of `information_schema.columns` taken verbatim from the prime
 * (`dduzbchuswwbefdunfct`) and asserts that every entry in the allow-list
 * actually passes `planColumns` against it — and that the columns nulled are
 * exactly the ones production has.
 *
 * That distinction has bitten this repository before, in the template library:
 * a check run against `SAMPLE_REPORT_DATA` passes while production is empty,
 * because the sample is written in the checker's own vocabulary. The remedy
 * there and here is the same — resolve against a row taken from production.
 *
 * Two ways this file earns its keep. If somebody adds a table to the
 * allow-list and does not add its real columns here, the first test fails. If
 * the prime's schema drifts from this snapshot, the copy will start refusing
 * tables at run time — and this file is where you find out what changed and
 * update the classification, rather than reading it off a failed cron.
 *
 * Refresh it with:
 *   select table_name, string_agg(column_name, ',' order by ordinal_position)
 *     from information_schema.columns
 *    where table_schema='public' and table_name in (…)
 *    group by table_name;
 */
import { describe, it, expect } from "vitest";
import { REFERENCE_TABLES, planColumns, refName } from "@/server/referenceTables.pure";

// Column lists read verbatim from the prime (dduzbchuswwbefdunfct) today.
const LIVE: Record<string, string[]> = {
  checklist_template_items: "id,section_id,label,is_pre_checked,display_order,created_at,updated_at".split(","),
  checklist_template_sections: "id,template_id,title,icon,display_order,created_at,updated_at".split(","),
  checklist_templates: "id,name,description,icon,created_by,is_active,cron_enabled,cron_expression,cron_description,last_generated_at,created_at,updated_at".split(","),
  depreciation_comps: "id,created_at,updated_at,purchase_price,purchase_date_category,build_year,property_type,finish_standard,nearest_city,renovated,fully_furnished,dv_year1,dv_year2,dv_year3,dv_year4,dv_year5,dv_year6,dv_year7,dv_year8,dv_year9,dv_year10,pc_year1,pc_year2,pc_year3,pc_year4,pc_year5,pc_year6,pc_year7,pc_year8,pc_year9,pc_year10,notes,source_schedule_id,created_by".split(","),
  document_requirement_templates: "id,purchase_type,category,label,description,default_owner,is_required,sort_order,is_active,created_at,updated_at".split(","),
  report_structure_templates: "id,name,description,template_type,report_tier,report_category,file_path,file_name,file_size,mime_type,parsed_content,is_active,priority,metadata,created_by,created_at,updated_at".split(","),
  suburb_directory: "id,suburb,state,postcode,created_at".split(","),
  template_library_entries: "id,family_id,slug,version,name,description,long_description,category,report_type,tier,variant,industry,tags,style,orientation,page_size,page_count,schema,config,custom_css,engine,preview_schema,thumbnail_path,preview_image_paths,supported_modules,required_bindings,brand_safe,production_ready,compatibility_version,status,access_tier,visibility,agency_id,source_template_id,created_by_user_id,created_at,updated_at,published_at,deprecated_at,usage_count,last_used_at,design_meta".split(","),
  feature_flags: "key,value,description,updated_by,created_at,updated_at".split(","),
  "aml.plan_tiers": "id,key,label,description,entitlements,monthly_price_cents,sort_order,active,created_at,updated_at".split(","),
  "aml.tenant_settings": "tenant_id,display_name,brand_kit_id,plan_tier_key,terminology_overrides,contact_email,mlro_contact_name,mlro_contact_email,locale,timezone,disposal_grace_days,support_url,metadata,created_at,updated_at,rollout_stage,rollout_stage_since,rollout_notes,risk_program_version,straight_through_config,review_interval_config".split(","),
  "aml.provider_configs": "id,tenant_id,capability,provider_key,display_label,priority,cost_per_unit_cents,currency,active,secret_ref,config,last_health_at,last_health_status,last_health_message,created_by,created_at,updated_at,mode".split(","),
  "aml.risk_factors": "id,key,label,category,weight,active,description,scoring,created_by,created_at,updated_at".split(","),
  "aml.mandatory_triggers": "id,key,label,description,severity,rule,active,created_by,created_at,updated_at".split(","),
  "aml.monitoring_rules": "id,name,description,trigger_kind,criteria,severity,is_enabled,cooldown_minutes,created_by,created_at,updated_at".split(","),
  "aml.tipping_off_rules": "id,surface,pattern,is_regex,suppression_mode,replacement_copy,note,active,created_by,created_at,updated_at".split(","),
  "aml.retention_schedules": "id,entity_type,retention_years,legal_basis,disposal_method,notes,active,created_at,updated_at,created_by,updated_by".split(","),
  "aml.record_class_catalogue": "record_code,family,label,information_classification,default_visibility,storage_zone,access_logging_required,retention_trigger_kind,disposal_rule,partner_exportable,notes,created_at".split(","),
  "aml.partner_event_catalogue": "event_type,aggregate_type,destination_class,emitted_by,description,created_at".split(","),
  "aml.partner_sla_targets": "queue_key,label,warn_hours,escalate_hours,responsible_role,note,active,updated_at,updated_by".split(","),
  "aml.sanctions_list_syncs": "id,list_code,source_url,payload_sha256,entry_count,status,error_detail,started_at,completed_at,created_at".split(","),
  "aml.sanctions_entries": "id,list_code,external_id,entry_type,primary_name,aliases,normalised_names,date_of_birth,place_of_birth,nationalities,listing_reference,listing_detail,sync_id,created_at,updated_at".split(","),
  "aml.pep_officeholder_syncs": "id,source_code,status,started_at,completed_at,source_as_at,entry_count,removed_count,payload_sha256,error_message,detail,created_at".split(","),
  "aml.pep_officeholders": "id,source_code,external_id,full_name,aliases,normalised_names,position_title,pep_type,jurisdiction,position_start,position_end,currently_held,confirm_url,source_detail,sync_id,created_at,updated_at,date_of_birth".split(","),
};

describe("the allow-list against the LIVE prime schema", () => {
  it("covers exactly the tables the allow-list names", () => {
    expect(REFERENCE_TABLES.map((t) => refName(t)).sort()).toEqual(Object.keys(LIVE).sort());
  });

  for (const entry of REFERENCE_TABLES) {
    it(`${refName(entry)} passes planColumns against production`, () => {
      const plan = planColumns(entry, LIVE[refName(entry)]);
      if (!plan.ok) throw new Error(plan.refusal);
      expect(plan.ok).toBe(true);
    });
  }

  it("nulls exactly the identity columns production actually has", () => {
    const nulled: Record<string, string[]> = {};
    for (const entry of REFERENCE_TABLES) {
      const plan = planColumns(entry, LIVE[refName(entry)]);
      if (plan.ok && plan.nulled.length) nulled[refName(entry)] = plan.nulled;
    }
    expect(nulled).toEqual({
      depreciation_comps: ["created_by"],
      checklist_templates: ["created_by"],
      report_structure_templates: ["created_by"],
      template_library_entries: ["agency_id", "source_template_id", "created_by_user_id"],
      feature_flags: ["updated_by"],
      "aml.tenant_settings": [
        "brand_kit_id",
        "contact_email",
        "mlro_contact_name",
        "mlro_contact_email",
        "support_url",
        "rollout_notes",
      ],
      "aml.provider_configs": [
        "last_health_at",
        "last_health_status",
        "last_health_message",
        "created_by",
      ],
      "aml.risk_factors": ["created_by"],
      "aml.mandatory_triggers": ["created_by"],
      "aml.monitoring_rules": ["created_by"],
      "aml.tipping_off_rules": ["created_by"],
      "aml.retention_schedules": ["created_by", "updated_by"],
      "aml.partner_sla_targets": ["updated_by"],
    });
  });
});
