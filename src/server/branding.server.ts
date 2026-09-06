// White-label branding engine — apply pipeline.
//
// Re-exports the focused submodules under @/server/branding/* so existing
// imports of `@/server/branding.server` keep working.
//
// Apply pipeline = mirror assets → rewrite URLs → run merge SQL → audit.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { runSqlOnProject } from "./backend-provisioning.server";
import { decryptSecret } from "./crypto.server";

import { hashBrandBundle } from "./branding/hash";
import { buildApplySql } from "./branding/sql";
import { CLONE_BRAND_BUCKET, mirrorAssetsToClone } from "./branding/mirror";
import { runBrandDriftScan } from "./branding/drift";
import { mergeOverrides, sanitizeOverrides } from "./branding/overrides";
import { registerAssetVariants } from "./branding/variants";
import type { ApplyBrandResult, BrandAsset, BrandConfig, ReportContact } from "./branding/types";

type SupabaseLike = SupabaseClient<Database>;

// ─── Re-exports (back-compat) ────────────────────────────────────────
export { hashBrandBundle } from "./branding/hash";
export { buildApplySql } from "./branding/sql";
export { mirrorAssetsToClone } from "./branding/mirror";
export { runBrandDriftScan } from "./branding/drift";
export { mergeOverrides, sanitizeOverrides } from "./branding/overrides";
export type { CloneOverrides, MergedBundle } from "./branding/overrides";
export {
  registerAssetVariants,
  clearAssetVariants,
  variantsForAsset,
  buildTransformUrl,
} from "./branding/variants";
export type { VariantSpec } from "./branding/variants";
export { listVersionsForProfile, rollbackProfileToVersion } from "./branding/versions";
export type { BrandVersion } from "./branding/versions";
export type {
  ApplyBrandResult,
  BrandAsset,
  BrandConfig,
  ReportContact,
  BrandDriftScanResult,
} from "./branding/types";

// ─── Apply pipeline ───────────────────────────────────────────────────

/**
 * Apply a brand profile to a single clone end-to-end:
 *  1. Resolve the clone's backend (must be `ready`).
 *  2. Mirror assets to the clone's brand-assets bucket.
 *  3. Rewrite asset URLs in the brand config to clone-side URLs.
 *  4. Run the merge SQL against the clone's database.
 *  5. Update the assignment row + append a history entry.
 *
 * Re-usable: cron, cascade engine, schedules, and the UI all call into this.
 */
export async function applyBrandToClone(
  supabase: SupabaseLike,
  args: {
    cloneId: string;
    profileId: string;
    actorUserId: string | null;
    cascadeEventId?: string | null;
  },
): Promise<ApplyBrandResult> {
  const startedAt = Date.now();

  // 1. Load profile, clone backend, AND existing assignment overrides in parallel
  const [profileRes, backendRes, assignmentRes] = await Promise.all([
    supabase
      .from("clone_brand_profiles")
      .select("id, version, brand_config, report_contact, asset_manifest, status")
      .eq("id", args.profileId)
      .maybeSingle(),
    supabase
      .from("clone_backends")
      .select("supabase_project_ref, supabase_url, service_role_key, status")
      .eq("clone_id", args.cloneId)
      .maybeSingle(),
    supabase
      .from("clone_brand_assignments")
      .select("overrides, override_keys")
      .eq("clone_id", args.cloneId)
      .maybeSingle(),
  ]);

  const profile = profileRes.data;
  const backend = backendRes.data;
  const existingAssignment = assignmentRes.data;

  const fail = async (error: string): Promise<ApplyBrandResult> => {
    const durationMs = Date.now() - startedAt;
    await supabase.from("clone_brand_assignments").upsert(
      {
        clone_id: args.cloneId,
        profile_id: args.profileId,
        status: "failed",
        error_message: error,
        last_drift_check_at: new Date().toISOString(),
      },
      { onConflict: "clone_id" },
    );
    await supabase.from("clone_brand_history").insert({
      clone_id: args.cloneId,
      profile_id: args.profileId,
      profile_version: profile?.version ?? null,
      config_snapshot: {},
      status: "failed",
      pushed_by: args.actorUserId,
      cascade_event_id: args.cascadeEventId ?? null,
      error_message: error,
      duration_ms: durationMs,
    });
    return {
      ok: false,
      cloneId: args.cloneId,
      profileId: args.profileId,
      error,
      durationMs,
    };
  };

  if (profileRes.error || !profile)
    return fail(profileRes.error?.message ?? "Brand profile not found");
  if (profile.status !== "published")
    return fail(`Profile is not published (status: ${profile.status})`);
  if (backendRes.error || !backend) return fail("Clone backend not found");
  if (backend.status !== "ready")
    return fail(`Clone backend not ready (status: ${backend.status})`);
  if (!backend.supabase_url || !backend.service_role_key || !backend.supabase_project_ref)
    return fail("Clone backend credentials incomplete");

  // 2. Mirror assets into the bucket the workspace actually has.
  //
  // This said `"branding"`, and no deployment of this platform has ever had a
  // bucket by that name — the prime's is `branding-assets`, public, and so is
  // every clone's, because the clone is built from the prime's schema. Storage
  // answers `404 Bucket not found`, mirroring is best-effort by design, so the
  // brand applied with the assets silently dropped and the cascade reported
  // success. Verified on the live prime and the live clone: both hold
  // `branding-assets`, neither holds `branding`.
  const assets = (profile.asset_manifest as unknown as BrandAsset[]) ?? [];
  const mirror = await mirrorAssetsToClone({
    cloneSupabaseUrl: backend.supabase_url,
    cloneServiceRoleKey: decryptSecret(backend.service_role_key),
    cloneBucket: CLONE_BRAND_BUCKET,
    assets,
  });

  // 3. Rewrite asset URLs, then layer per-clone overrides on top.
  const baseBrandConfig: BrandConfig = { ...((profile.brand_config as BrandConfig) ?? {}) };
  for (const u of mirror.uploaded) {
    if (u.asset.config_field) {
      baseBrandConfig[u.asset.config_field] = u.public_url;
    }
  }
  const baseReportContact: ReportContact = (profile.report_contact as ReportContact) ?? {};
  const overrides = sanitizeOverrides(existingAssignment?.overrides ?? null);
  const merged = mergeOverrides({
    brand_config: baseBrandConfig,
    report_contact: baseReportContact,
    overrides,
  });
  const brandConfig = merged.brand_config;
  const reportContact = merged.report_contact;
  const finalHash = hashBrandBundle({
    brand_config: brandConfig,
    report_contact: reportContact,
    asset_manifest: assets,
  });

  // 4. Run merge SQL on the clone backend
  try {
    const sql = buildApplySql({
      brand_config: brandConfig,
      report_contact: reportContact,
      config_hash: finalHash,
    });
    await runSqlOnProject(backend.supabase_project_ref, sql);
  } catch (err) {
    return fail(`SQL apply failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 5. Update assignment + append history
  const durationMs = Date.now() - startedAt;
  const nowIso = new Date().toISOString();
  await supabase.from("clone_brand_assignments").upsert(
    {
      clone_id: args.cloneId,
      profile_id: args.profileId,
      status: "applied",
      applied_at: nowIso,
      applied_by: args.actorUserId,
      applied_config_hash: finalHash,
      last_drift_check_at: nowIso,
      drift_summary: null,
      error_message: null,
      override_keys: merged.overrideKeys,
    },
    { onConflict: "clone_id" },
  );
  await supabase.from("clone_brand_history").insert({
    clone_id: args.cloneId,
    profile_id: args.profileId,
    profile_version: profile.version,
    config_snapshot: {
      brand_config: brandConfig,
      report_contact: reportContact,
    } as unknown as Database["public"]["Tables"]["clone_brand_history"]["Insert"]["config_snapshot"],
    config_hash: finalHash,
    status: "applied",
    pushed_by: args.actorUserId,
    cascade_event_id: args.cascadeEventId ?? null,
    duration_ms: durationMs,
  });

  return {
    ok: true,
    cloneId: args.cloneId,
    profileId: args.profileId,
    profileVersion: profile.version,
    configHash: finalHash,
    assetsUploaded: mirror.uploaded.length,
    assetsFailed: mirror.failed.length,
    durationMs,
  };
}

// Silence unused-import warning if a downstream file ever stops using these.
void runBrandDriftScan;
