/**
 * The brand marks a workspace can be given, named once.
 *
 * ## Why this module exists
 *
 * A mark had three separate lists and they did not agree:
 *
 *   * the brand-profile editor offered **three** uploads — logo light, logo
 *     dark, favicon;
 *   * the cascade wrote **three** flat columns — `auth_logo`, `sidebar_logo`,
 *     `favicon`;
 *   * and the workspace's nine PDF renderers read **six** keys out of
 *     `whitelabel_settings.logo_config` (`assets.pure.ts`: `report`,
 *     `reportMono`, `sidebar`, `auth`, `sidebarIcon`, `cover`), a column the
 *     cascade deliberately never wrote.
 *
 * So a workspace could be fully branded — its sign-in page and sidebar carrying
 * the right logo — and every document it generated came out with no mark at
 * all, because the letterhead reads the map and the cascade only ever filled
 * the columns beside it.
 *
 * This is the one list. The editor draws its uploads from it, the cascade
 * derives both its column writes and its `logo_config` keys from it, and a slot
 * that reaches neither is visible here as `columns: []` and `logoKeys: []`
 * rather than being quietly dropped.
 *
 * ## Why `logo_config` is written now, when the cascade refused to before
 *
 * `sql.ts` refused for a good reason: the bundle carries a shape of its own,
 * and pouring it into a column nine renderers parse would replace their schema
 * with a foreign one. That rule still holds. What is written is a merge of the
 * NAMED keys below and nothing else — the same discipline as the column map
 * beside it — so a key the workspace already holds, and any key this platform
 * has never heard of, both survive untouched.
 *
 * ## Why `logo_dark_url` maps to nothing
 *
 * "Logo (dark)" is ambiguous in every brand kit that ships one: it means either
 * the dark-coloured lockup for a light ground, or the knockout lockup for a
 * dark one. `reportMono` is specifically the second — it prints on the cover's
 * obsidian ground, where guessing wrong renders an invisible mark on a client's
 * document, and nothing about the file says which it is. So the knockout mark
 * has a slot of its own that says what it is for, and `logo_dark_url` keeps its
 * place in the bundle without being cascaded anywhere.
 */
/**
 * ## Why it lives under `lib/` and not beside the cascade
 *
 * The brand-profile editor is a client route, and `src/server/**` is denied to
 * client code by the build's import protection. This is a list of names — no
 * database, no credentials, nothing to keep on a server — and the whole point
 * of it is that the editor, the cascade and the clone page read the SAME one.
 * It carries no import of its own so the boundary cannot be crossed by
 * accident in either direction.
 */

/** The shape this reads out of: a brand bundle is a loose record of URLs. */
type BrandConfigLike = Record<string, unknown>;

export type BrandMarkSlot = {
  /** The brand-bundle field holding this mark's URL. */
  field: string;
  /** What an operator sees. */
  label: string;
  /** One line on what it is for, shown under the label. */
  purpose: string;
  /** Where the bytes land in the workspace's own bucket. */
  target: string;
  /** `whitelabel_settings` columns this fills. May be empty. */
  columns: readonly string[];
  /** `whitelabel_settings.logo_config` keys this fills. May be empty. */
  logoKeys: readonly string[];
};

export const BRAND_MARK_SLOTS: readonly BrandMarkSlot[] = [
  {
    field: "logo_light_url",
    label: "Logo",
    purpose: "The wordmark on the sign-in page and the sidebar.",
    target: "branding/logo-light.png",
    columns: ["auth_logo", "sidebar_logo"],
    logoKeys: ["auth", "sidebar"],
  },
  {
    field: "logo_dark_url",
    label: "Logo (dark variant)",
    purpose:
      "Kept with the bundle. Not cascaded — use the knockout report mark below for anything printed on a dark ground.",
    target: "branding/logo-dark.png",
    columns: [],
    logoKeys: [],
  },
  {
    field: "icon_url",
    label: "Icon",
    purpose: "The square mark beside a collapsed sidebar.",
    target: "branding/icon.png",
    columns: ["sidebar_icon"],
    logoKeys: ["sidebarIcon"],
  },
  {
    field: "favicon_url",
    label: "Favicon",
    purpose: "The browser tab.",
    target: "branding/favicon.png",
    columns: ["favicon"],
    logoKeys: ["favicon"],
  },
  {
    field: "report_logo_url",
    label: "Report mark",
    purpose: "The lockup on ivory paper — running head, contents, closing page.",
    target: "branding/report-mark.png",
    columns: [],
    logoKeys: ["report"],
  },
  {
    field: "report_logo_mono_url",
    label: "Report mark — knockout",
    purpose: "The lockup on the cover's dark ground. Usually the white version.",
    target: "branding/report-mark-mono.png",
    columns: [],
    logoKeys: ["reportMono"],
  },
] as const;

/** Every `(column, bundle field)` pair the marks contribute. */
export function markColumnSources(): Array<{ column: string; from: string }> {
  return BRAND_MARK_SLOTS.flatMap((slot) =>
    slot.columns.map((column) => ({ column, from: slot.field })),
  );
}

/** Every `(logo_config key, bundle field)` pair the marks contribute. */
export function markLogoConfigSources(): Array<{ key: string; from: string }> {
  return BRAND_MARK_SLOTS.flatMap((slot) =>
    slot.logoKeys.map((key) => ({ key, from: slot.field })),
  );
}

/**
 * Which marks a workspace is still missing, in the order they matter.
 *
 * A workspace with no report mark still gets a branded document — the renderer
 * walks `report → sidebar → auth → sidebarIcon` — so this reports what is
 * ABSENT rather than what is broken, and nothing here blocks anything.
 */
export function missingMarks(config: BrandConfigLike | null | undefined): BrandMarkSlot[] {
  const cfg = config ?? {};
  return BRAND_MARK_SLOTS.filter((slot) => {
    const value = cfg[slot.field];
    return typeof value !== "string" || value.trim() === "";
  });
}
