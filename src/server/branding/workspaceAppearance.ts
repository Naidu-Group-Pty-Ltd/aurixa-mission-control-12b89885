// A new workspace's first appearance: the `whitelabel_settings` row a clone is
// created with.
//
// ── Why provisioning writes this row at all ──────────────────────────────────
//
// A clone is built from the prime's catalogue and holds none of its rows, so
// its `whitelabel_settings` starts EMPTY and the workspace draws its built-in
// defaults, which are light. The owner decided on 31 Oct 2026 that a new clone
// is created in dark mode. The workspace reads its theme default from this row
// and nowhere else: `theme_config.darkModeDefault` once the workspace has saved
// its own branding, otherwise the flat `dark_mode_default` column. That is the
// derivation the prime's `validate_whitelabel_settings_payload` trigger and its
// BrandProvider both use. So a build establishes the row, in dark.
//
// Measured 31 Oct 2026, read-only: NPC Test, Preflight Property Group and NPC
// CRM Independent still hold no row at all, and draw the built-in light.
//
// ── What it writes, and what it never does ───────────────────────────────────
//
// The theme default and nothing else. Every other column takes its catalogue
// default. `company_name` in particular stays empty: the prime made that its
// default on 1 Sep 2026 (`20260901001200_agreement_white_label_defaults.sql`)
// because the column was printing the founding tenant's name as the masthead of
// another agency's agreements, and an empty name prints as a blank to fill in.
// A workspace's name is the cascade's to write, or the workspace's own.
//
// It never touches a row that exists. A workspace that has saved its own
// branding, or that the brand cascade has already dressed, keeps what it holds,
// and its theme default is its own decision, made on its White Label page.
// Provisioning runs this on a build only: a repair converges infrastructure and
// never re-seeds a tenant's own settings, as it never re-seeds their admin.

/** The three theme defaults the workspace's own trigger accepts. */
export const WORKSPACE_THEME_MODES = ["light", "dark", "system"] as const;
export type WorkspaceThemeMode = (typeof WORKSPACE_THEME_MODES)[number];

/**
 * The theme default of a workspace Mission Control establishes. Owner's
 * decision, 31 Oct 2026. Both writers of a new row read it from here, the build
 * (below) and the brand cascade (`sql.ts`), so they cannot disagree.
 */
export const CLONE_DEFAULT_THEME: WorkspaceThemeMode = "dark";

/**
 * The SQL that establishes the row when the table is empty, and reads back
 * what the workspace holds either way: one statement, one row.
 *
 * The two branches cannot both answer. Every part of one statement reads the
 * same snapshot, so `existing` sees the table as it stood before the insert:
 * empty when `seeded` wrote the row, holding the row when `seeded` wrote
 * nothing.
 *
 * The theme is the only value in the statement, and it is one of the three
 * the trigger accepts or the builder refuses it: nothing a tenant typed is in
 * here to quote.
 */
export function buildWorkspaceAppearanceSeedSql(
  theme: WorkspaceThemeMode = CLONE_DEFAULT_THEME,
): string {
  if (!(WORKSPACE_THEME_MODES as readonly string[]).includes(theme)) {
    throw new Error(`Not a workspace theme: ${String(theme)}`);
  }
  return `
-- Aurixa: a new workspace's first appearance (theme default: ${theme})
WITH seeded AS (
  INSERT INTO public.whitelabel_settings (dark_mode_default)
  SELECT '${theme}'
  WHERE NOT EXISTS (SELECT 1 FROM public.whitelabel_settings)
  RETURNING COALESCE(theme_config->>'darkModeDefault', dark_mode_default) AS theme
), existing AS (
  SELECT COALESCE(theme_config->>'darkModeDefault', dark_mode_default) AS theme
    FROM public.whitelabel_settings
   ORDER BY updated_at DESC NULLS LAST
   LIMIT 1
)
SELECT 'created' AS outcome, theme FROM seeded
UNION ALL
SELECT 'kept' AS outcome, theme FROM existing;
`;
}

/** What the build did to the workspace's appearance, read back from the clone. */
export type WorkspaceAppearanceSeed =
  | { outcome: "created" | "kept"; theme: string | null }
  | { outcome: "failed"; error: string };

/**
 * The read-back, as the clone answered it. An answer that is not exactly one
 * row of the expected shape is a failure, never a success: a write nobody can
 * see is not one.
 */
export function readWorkspaceAppearanceSeed(rows: unknown): WorkspaceAppearanceSeed {
  const row =
    Array.isArray(rows) && rows.length === 1 ? (rows[0] as Record<string, unknown>) : null;
  if (!row || (row.outcome !== "created" && row.outcome !== "kept")) {
    return {
      outcome: "failed",
      error: `the clone answered ${Array.isArray(rows) ? `${rows.length} rows` : "no rows"} where one was expected`,
    };
  }
  return { outcome: row.outcome, theme: typeof row.theme === "string" ? row.theme : null };
}

/** The status line an operator reads while the build runs. */
export function describeWorkspaceAppearanceSeed(seed: WorkspaceAppearanceSeed): string {
  if (seed.outcome === "failed") {
    return `The workspace's appearance was not set (${seed.error}). It opens in light until its White Label page sets a theme default.`;
  }
  if (seed.outcome === "kept") {
    return `The workspace already holds its own appearance settings, left as they are (theme default: ${seed.theme ?? "unreadable"}).`;
  }
  if (seed.theme !== CLONE_DEFAULT_THEME) {
    return `The workspace's appearance was created, but reads back with theme default ${seed.theme ?? "unreadable"} where ${CLONE_DEFAULT_THEME} was written.`;
  }
  return `The workspace's appearance was created with theme default ${CLONE_DEFAULT_THEME}.`;
}
