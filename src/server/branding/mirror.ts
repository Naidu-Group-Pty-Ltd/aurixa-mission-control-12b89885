// Asset mirroring: download from Mission Control's brand-assets bucket
// (service-role auth) then upload into the clone's own Storage bucket so
// the clone is self-sufficient. Best-effort — failures don't block cascades.
import type { BrandAsset } from "./types";

/**
 * The bucket a workspace keeps its brand marks in.
 *
 * Named here rather than at the call site because it was a literal there, it
 * was wrong (`branding`), and nothing could tell: Storage answers
 * `404 Bucket not found`, mirroring is best-effort, and the cascade reported a
 * successful apply with every asset dropped. Both the prime and every clone
 * built from its schema hold `branding-assets`, public.
 */
export const CLONE_BRAND_BUCKET = "branding-assets";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

export async function mirrorAssetsToClone(args: {
  cloneSupabaseUrl: string;
  cloneServiceRoleKey: string;
  cloneBucket: string;
  assets: BrandAsset[];
}): Promise<{
  uploaded: Array<{ asset: BrandAsset; public_url: string }>;
  failed: Array<{ asset: BrandAsset; error: string }>;
}> {
  const uploaded: Array<{ asset: BrandAsset; public_url: string }> = [];
  const failed: Array<{ asset: BrandAsset; error: string }> = [];

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    for (const a of args.assets) {
      failed.push({ asset: a, error: "Mission Control storage credentials missing" });
    }
    return { uploaded, failed };
  }

  for (const asset of args.assets) {
    try {
      const dlRes = await fetch(
        `${SUPABASE_URL}/storage/v1/object/brand-assets/${encodeURI(asset.source_path)}`,
        {
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
        },
      );
      if (!dlRes.ok) {
        failed.push({
          asset,
          error: `Source download failed: ${dlRes.status} ${dlRes.statusText}`,
        });
        continue;
      }
      const blob = await dlRes.arrayBuffer();

      const upRes = await fetch(
        `${args.cloneSupabaseUrl}/storage/v1/object/${args.cloneBucket}/${encodeURI(asset.target_path)}`,
        {
          method: "POST",
          headers: {
            apikey: args.cloneServiceRoleKey,
            Authorization: `Bearer ${args.cloneServiceRoleKey}`,
            "Content-Type": asset.content_type,
            "x-upsert": "true",
          },
          body: blob,
        },
      );
      if (!upRes.ok) {
        const txt = await upRes.text();
        // A missing bucket is not one failure among many — it is every asset
        // failing for one reason an operator can actually fix, and it is how
        // this shipped for months reporting success. Say so in those words.
        const missingBucket = upRes.status === 404 && /bucket not found/i.test(txt);
        failed.push({
          asset,
          error: missingBucket
            ? `Clone upload failed: the workspace has no "${args.cloneBucket}" storage bucket. ` +
              `Create it (public) on the clone's Supabase project, then re-apply the brand.`
            : `Clone upload failed: ${upRes.status} — ${txt.slice(0, 200)}`,
        });
        continue;
      }

      const publicUrl = `${args.cloneSupabaseUrl}/storage/v1/object/public/${args.cloneBucket}/${encodeURI(asset.target_path)}`;
      uploaded.push({ asset, public_url: publicUrl });
    } catch (err) {
      failed.push({
        asset,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { uploaded, failed };
}
