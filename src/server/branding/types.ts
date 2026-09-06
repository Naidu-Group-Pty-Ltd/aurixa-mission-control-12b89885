// Shared types for the white-label branding engine. Kept narrow on purpose:
// the prime owns the canonical schema; we just cascade the bundle.
import type { Database } from "@/integrations/supabase/types";

export type BrandConfig = {
  brand_name?: string | null;
  tagline?: string | null;
  primary_color?: string | null;
  secondary_color?: string | null;
  accent_color?: string | null;
  background_color?: string | null;
  foreground_color?: string | null;
  font_family?: string | null;
  logo_light_url?: string | null;
  logo_dark_url?: string | null;
  favicon_url?: string | null;
  // The square mark, and the two lockups a generated document prints. The
  // workspace has read all three out of `whitelabel_settings.logo_config`
  // since the report design system shipped; the bundle had no field for any of
  // them, so no upload could ever reach a page. See `marks.ts`.
  icon_url?: string | null;
  report_logo_url?: string | null;
  report_logo_mono_url?: string | null;
  email_signature_html?: string | null;
  email_signature_text?: string | null;
  support_url?: string | null;
  privacy_url?: string | null;
  terms_url?: string | null;
  [key: string]: unknown;
};

export type ReportContact = {
  contact_name?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  contact_address?: string | null;
  contact_website?: string | null;
  // Legal identity — what a workspace prints on generated legal documents
  // (agreements, reports): the registered entity, its ABN/ACN and licence
  // details. The colour-and-logo fields above make a document *branded*;
  // these are what make it *theirs*. Cascaded into the workspace's
  // `global_report_settings.contact_details` like everything else here.
  legal_name?: string | null;
  abn?: string | null;
  licence_number?: string | null;
  [key: string]: unknown;
};

export type BrandAsset = {
  source_path: string;
  target_path: string;
  content_type: string;
  config_field: keyof BrandConfig | null;
};

export type ApplyBrandResult =
  | {
      ok: true;
      cloneId: string;
      profileId: string;
      profileVersion: number;
      configHash: string;
      assetsUploaded: number;
      assetsFailed: number;
      durationMs: number;
    }
  | {
      ok: false;
      cloneId: string;
      profileId: string;
      error: string;
      durationMs: number;
    };

export type BrandDriftScanResult = {
  scanned: number;
  drifted: number;
  reapplied: number;
  failures: number;
  details: Array<{
    cloneId: string;
    profileId: string;
    reason: string;
    reapplied: boolean;
    error?: string;
  }>;
};

export type BrandAssignmentStatus = Database["public"]["Enums"]["brand_assignment_status"];
export type BrandProfileStatus = Database["public"]["Enums"]["brand_profile_status"];
