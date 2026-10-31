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
import { markColumnSources, markLogoConfigSources } from "@/lib/brand/marks";
import type { BrandConfig, ReportContact } from "./types";
import { CLONE_DEFAULT_THEME, WORKSPACE_THEME_MODES } from "./workspaceAppearance";

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
 * Deliberately short. `theme_config` is still NOT written: it carries a
 * structured shape the prime's `BrandProvider` parses, and pouring this bundle
 * into it would replace a schema that reader depends on with a foreign one. A
 * bundle field with no column here has no home in this schema, and dropping it
 * is the honest outcome — writing it somewhere adjacent is how a column comes
 * to mean two things.
 *
 * `logo_config` is the one that changed, and only in the narrow way the same
 * rule allows: the NAMED keys in `marks.ts` are merged in, one at a time, and
 * nothing else is. It had to, because the columns below serve the interface
 * while every generated document reads the map — so a fully branded workspace
 * was printing documents with no mark on them at all.
 *
 * The mark rows come from `marks.ts` so the editor's uploads, the columns and
 * the map keys cannot drift apart again.
 */
export const WHITELABEL_COLUMN_SOURCES: ReadonlyArray<{
  column: string;
  from: keyof BrandConfig & string;
}> = [
  { column: "company_name", from: "brand_name" },
  { column: "primary_color", from: "primary_color" },
  { column: "accent_color", from: "accent_color" },
  ...markColumnSources(),
];

/**
 * A colour in the form the workspace reads: `"H S% L%"`.
 *
 * Brand profiles hold colours as hex, because that is what a colour picker
 * gives, and this cascade wrote them into `whitelabel_settings` as it found
 * them. The table's trigger accepts hex, so nothing refused the write. But the
 * workspace's token resolver (`normalizeHslString`) reads only `"H S% L%"` and
 * falls back on anything else, and a clone's line palette
 * (`src/branding/linePalette.ts`) then fills the gap with the prime's palette.
 * Measured on `tutorial-demo-orrimere-c158c7`, 31 Oct 2026: the row held
 * `#2F6B4F`, and every screen drew the prime's royal blue (`228 94% 45%`) and
 * magenta under Orrimere's name. The workspace's own editor writes
 * `"152 39% 30%"` for the same green.
 *
 * So the cascade converts here, the one place it writes a colour, with the
 * editor's arithmetic (`hexToHsl` in the prime's `reportDesign/color.pure.ts`)
 * and its rounding, so a colour reads back exactly as if it had been saved on
 * the Branding page. `#RGB` is expanded first. A value already in `"H S% L%"`
 * form is passed through, and so is anything else: the trigger stays the judge
 * of what may be stored.
 */
export function workspaceColour(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return value;
  const digits =
    match[1].length === 3
      ? match[1]
          .split("")
          .map((c) => c + c)
          .join("")
      : match[1];
  const r = parseInt(digits.slice(0, 2), 16) / 255;
  const g = parseInt(digits.slice(2, 4), 16) / 255;
  const b = parseInt(digits.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        break;
      case g:
        h = ((b - r) / d + 2) / 6;
        break;
      case b:
        h = ((r - g) / d + 4) / 6;
        break;
    }
  }
  return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

/**
 * The bundle fields that land in a colour column, read off the column map so a
 * colour column added there is converted without a second list to forget.
 */
const COLOUR_FIELDS: ReadonlyArray<keyof BrandConfig & string> = WHITELABEL_COLUMN_SOURCES.filter(
  ({ column }) => column.endsWith("_color"),
).map(({ from }) => from);

/** The bundle with every colour-column field in the workspace's form. */
function withWorkspaceColours(config: BrandConfig): BrandConfig {
  const out: BrandConfig = { ...config };
  for (const field of COLOUR_FIELDS) {
    if (field in out) out[field] = workspaceColour(out[field]);
  }
  return out;
}

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

  // The one value in this block that is not bound: a constant of this module's
  // own, one of the three the workspace's trigger accepts, checked here so a
  // change to it can never put anything else into the SQL.
  if (!(WORKSPACE_THEME_MODES as readonly string[]).includes(CLONE_DEFAULT_THEME)) {
    throw new Error(`Not a workspace theme: ${String(CLONE_DEFAULT_THEME)}`);
  }

  // Colours travel in the form the workspace reads (`workspaceColour`); every
  // other field travels as the bundle holds it.
  const wlPayload = jsonbLiteral({
    ...withWorkspaceColours(brand_config),
    _aurixa_hash: config_hash,
  });
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

  // The `logo_config` map, one named key at a time. The key literals come from
  // `marks.ts`; the values are read out of the bound payload inside the block,
  // so nothing a tenant typed is ever interpolated into SQL. A key with no
  // value contributes nothing rather than blanking what the workspace holds.
  const logoConfigAssignments = markLogoConfigSources()
    .map(
      ({ key, from }) => `
    IF _wl ? '${from}' AND nullif(trim(_wl->>'${from}'), '') IS NOT NULL THEN
      _marks := _marks || jsonb_build_object('${key}', trim(_wl->>'${from}'));
    END IF;`,
    )
    .join("");

  return `
-- Aurixa branding cascade — hash:${config_hash}
DO $$
DECLARE
  _wl jsonb := ${wlPayload};
  _rc jsonb := ${rcPayload};
  _wl_id uuid;
  _rs_id uuid;
  _marks jsonb := '{}'::jsonb;
BEGIN
  -- ── whitelabel_settings ──────────────────────────────────────────────────
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='whitelabel_settings') THEN
    -- A clone is provisioned with this table EMPTY, so "update the newest row"
    -- updated nothing at all. Establish the singleton row first; every column
    -- it needs is NOT NULL with a default. It is established as a build
    -- establishes it (workspaceAppearance.ts), with the platform's theme
    -- default, so the two writers of a new row cannot disagree. A row that
    -- exists keeps its own.
    IF NOT EXISTS (SELECT 1 FROM public.whitelabel_settings) THEN
      ${ifColumn("whitelabel_settings", "dark_mode_default")} THEN
        INSERT INTO public.whitelabel_settings (dark_mode_default) VALUES ('${CLONE_DEFAULT_THEME}');
      ELSE
        INSERT INTO public.whitelabel_settings DEFAULT VALUES;
      END IF;
    END IF;
    SELECT id INTO _wl_id FROM public.whitelabel_settings
      ORDER BY updated_at DESC NULLS LAST LIMIT 1;
${whitelabelColumnWrites}
${logoConfigAssignments}

    -- The map every generated document reads. MERGED, never replaced: a key
    -- this platform has never heard of, and one the workspace set for itself,
    -- both survive. Skipped entirely when the bundle carries no mark, so an
    -- unbranded workspace is left exactly as it was.
    IF _marks <> '{}'::jsonb THEN
      ${ifColumn("whitelabel_settings", "logo_config")} THEN
        EXECUTE 'UPDATE public.whitelabel_settings
                    SET logo_config = COALESCE(logo_config, ''{}''::jsonb) || $1
                  WHERE id = $2'
          USING _marks, _wl_id;
      END IF;
    END IF;

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
