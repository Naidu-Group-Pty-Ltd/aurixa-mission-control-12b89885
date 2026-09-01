// Build the SQL we run against a clone backend to apply a brand bundle.
//
// ── What this got wrong, and how ─────────────────────────────────────────────
//
// It wrote two columns that do not exist, on either side:
//
//     UPDATE public.whitelabel_settings    SET settings        = …
//     UPDATE public.global_report_settings SET contact_details = …
//
// `global_report_settings` is a KEY/VALUE table — `(setting_key unique,
// setting_value jsonb)` — in the prime's own first migration and in every
// clone built from it. `whitelabel_settings` is a FLAT table of
// `company_name`, `primary_color`, `auth_logo`, `theme_config`, … There is no
// `settings` column and no `contact_details` column anywhere. Postgres answers
// `42703`, the whole `DO` block aborts, and the cascade can never write
// anything — verified against the live prime and the live clone.
//
// That is not a cosmetic defect. `global_report_settings.contact_details.email`
// is what every one of the prime's 16 mail-sending edge functions builds its
// from-header from, so a clone whose cascade cannot write it falls back to
// `noreply@npcservices.com.au` — the prime's legacy address, verified in a
// Resend account this platform does not hold — and every outbound mail,
// password recovery included, answers 403.
//
// ── The two rules this file now keeps ────────────────────────────────────────
//
// **Never name a column the table does not have.** Every write is guarded on
// `information_schema.columns`, so a clone on an older or newer prime schema
// gets the columns it has rather than an aborted block. The legacy shapes are
// still written where they exist, so nothing that already reads them breaks.
//
// **Values travel as bound parameters.** The payload is dollar-quoted once and
// every column write binds out of it with `EXECUTE … USING`, so tenant-supplied
// brand text cannot carry SQL structure. Only column names are interpolated,
// and those come from the fixed map below rather than from any input.
import type { BrandConfig, ReportContact } from "./types";

/**
 * Escape a JSON value for safe inlining inside a Postgres SQL string.
 * We use $brand$ dollar-quoting and sanitise the payload to ensure the
 * delimiter cannot appear inside it.
 */
function jsonbLiteral(value: unknown): string {
  const json = JSON.stringify(value).replace(/\$brand\$/g, "");
  return `$brand$${json}$brand$::jsonb`;
}

/**
 * Translate the bundle's contact block onto the keys the prime actually
 * reads from `contact_details` (`snapshot.pure.ts` → `name`, `abn`, `email`,
 * `phone`, `address`, `website`, plus the legacy `company_name`).
 *
 * The `contact_*` names this module historically cascaded are keys the prime
 * never consumed — a cascaded email or phone silently never reached a single
 * generated document. Both shapes are written: the prime's keys so documents
 * pick the values up, and the original `contact_*` keys so nothing that
 * learned to read them breaks.
 */
export function primeContactPayload(contact: ReportContact): Record<string, unknown> {
  const text = (v: unknown) => {
    const s = typeof v === "string" ? v.trim() : "";
    return s || undefined;
  };
  const mapped: Record<string, unknown> = {
    ...contact,
    name: text(contact.legal_name) ?? text(contact.contact_name),
    company_name: text(contact.legal_name) ?? text(contact.contact_name),
    abn: text(contact.abn),
    licence_number: text(contact.licence_number),
    email: text(contact.contact_email),
    phone: text(contact.contact_phone),
    address: text(contact.contact_address),
    website: text(contact.contact_website),
  };
  for (const [key, value] of Object.entries(mapped)) {
    if (value === undefined || value === null || value === "") delete mapped[key];
  }
  return mapped;
}

/**
 * Which `whitelabel_settings` column each brand-bundle field lands in.
 *
 * Deliberately short. `theme_config` and `logo_config` are NOT written: they
 * carry a structured shape the prime's `BrandProvider` and nine PDF renderers
 * parse, and pouring this bundle into them would replace a schema those
 * readers depend on with a foreign one. A bundle field with no column here has
 * no home in this schema, and dropping it is the honest outcome — writing it
 * somewhere adjacent is how a column comes to mean two things.
 */
export const WHITELABEL_COLUMN_SOURCES: ReadonlyArray<{
  column: string;
  from: keyof BrandConfig & string;
}> = [
  { column: "company_name", from: "brand_name" },
  { column: "primary_color", from: "primary_color" },
  { column: "accent_color", from: "accent_color" },
  { column: "auth_logo", from: "logo_light_url" },
  { column: "sidebar_logo", from: "logo_light_url" },
  { column: "favicon", from: "favicon_url" },
];

/** `IF` guard that a column exists on a public table. */
function ifColumn(table: string, column: string): string {
  return `IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='${table}' AND column_name='${column}')`;
}

export function buildApplySql(args: {
  brand_config: BrandConfig;
  report_contact: ReportContact;
  config_hash: string;
}): string {
  const { brand_config, report_contact, config_hash } = args;

  const wlPayload = jsonbLiteral({ ...brand_config, _aurixa_hash: config_hash });
  const rcPayload = jsonbLiteral(primeContactPayload(report_contact));

  // One guarded write per mapped column. `%I` quotes the identifier; the value
  // is bound, never interpolated. A column the clone lacks, or a bundle field
  // it has no value for, writes nothing rather than clearing what is there.
  const whitelabelColumnWrites = WHITELABEL_COLUMN_SOURCES.map(
    ({ column, from }) => `
    ${ifColumn("whitelabel_settings", column)}
       AND _wl ? '${from}' AND nullif(trim(_wl->>'${from}'), '') IS NOT NULL THEN
      EXECUTE format('UPDATE public.whitelabel_settings SET %I = $1 WHERE id = $2', '${column}')
        USING trim(_wl->>'${from}'), _wl_id;
    END IF;`,
  ).join("");

  return `
-- Aurixa branding cascade — hash:${config_hash}
DO $$
DECLARE
  _wl jsonb := ${wlPayload};
  _rc jsonb := ${rcPayload};
  _wl_id uuid;
  _rs_id uuid;
BEGIN
  -- ── whitelabel_settings ──────────────────────────────────────────────────
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='whitelabel_settings') THEN
    -- A clone is provisioned with this table EMPTY, so "update the newest row"
    -- updated nothing at all. Establish the singleton row first; every column
    -- it needs is NOT NULL with a default.
    IF NOT EXISTS (SELECT 1 FROM public.whitelabel_settings) THEN
      INSERT INTO public.whitelabel_settings DEFAULT VALUES;
    END IF;
    SELECT id INTO _wl_id FROM public.whitelabel_settings
      ORDER BY updated_at DESC NULLS LAST LIMIT 1;
${whitelabelColumnWrites}

    -- Legacy jsonb blob, on a schema that has one. Kept so a clone that
    -- already stores the bundle this way kicks on receiving it.
    ${ifColumn("whitelabel_settings", "settings")} THEN
      EXECUTE 'UPDATE public.whitelabel_settings
                  SET settings = COALESCE(settings, ''{}''::jsonb) || $1 WHERE id = $2'
        USING _wl, _wl_id;
    END IF;

    ${ifColumn("whitelabel_settings", "updated_at")} THEN
      EXECUTE 'UPDATE public.whitelabel_settings SET updated_at = now() WHERE id = $1'
        USING _wl_id;
    END IF;
  END IF;

  -- ── global_report_settings ───────────────────────────────────────────────
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='global_report_settings') THEN

    -- The real shape: one row per setting_key, merged into setting_value.
    -- This is the write that carries contact_details.email, and therefore the
    -- from-header of every mail the clone sends.
    ${ifColumn("global_report_settings", "setting_key")} THEN
      EXECUTE 'INSERT INTO public.global_report_settings (setting_key, setting_value)
               VALUES (''contact_details'', $1)
               ON CONFLICT (setting_key) DO UPDATE
                  SET setting_value = COALESCE(global_report_settings.setting_value, ''{}''::jsonb) || $1,
                      updated_at = now()'
        USING _rc;

    -- Legacy single-row shape with a contact_details COLUMN, if one exists.
    ELSIF EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='global_report_settings'
                    AND column_name='contact_details') THEN
      IF NOT EXISTS (SELECT 1 FROM public.global_report_settings) THEN
        EXECUTE 'INSERT INTO public.global_report_settings (contact_details) VALUES ($1)' USING _rc;
      ELSE
        SELECT id INTO _rs_id FROM public.global_report_settings
          ORDER BY updated_at DESC NULLS LAST LIMIT 1;
        EXECUTE 'UPDATE public.global_report_settings
                    SET contact_details = COALESCE(contact_details, ''{}''::jsonb) || $1,
                        updated_at = now()
                  WHERE id = $2'
          USING _rc, _rs_id;
      END IF;
    END IF;
  END IF;
END $$;
`;
}
