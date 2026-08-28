/**
 * Pricing catalogue → technical module mapping.
 *
 * Two vocabularies describe the same product and never met:
 *
 *   commercial — `aurixa-catalog.ts`: 3 tiers and ~23 priced modules, the
 *                things a customer buys on the Aurixa Systems pricing page.
 *   technical  — `modules`: what detection found in the prime repo, carrying
 *                the file globs, edge functions, tables and secrets that have
 *                to physically ship for a feature to work.
 *
 * Nothing joined them, so clone creation was a flat 75-checkbox list an
 * operator ticked from memory, and a tier change on the pricing page moved
 * money without moving code.
 *
 * This module is the join. It resolves, for a given plan plus any purchased
 * add-ons, exactly which technical modules a clone should have installed.
 *
 * Three outcomes per priced item, and the third is the one that matters:
 *
 *   installs   — the item corresponds to a technical module to install
 *                (`market-updates`, `deal-pipeline`, `finance-portal`).
 *   entitlement— the item gates a sub-feature *inside* a module that is
 *                already installed. `Client Forms` and `Client AI` are tabs on
 *                the Clients screen, not separate deployables; installing
 *                anything for them would be wrong. These are already modelled
 *                by SUB_MODULE_MATRIX and only need the entitlement flag.
 *   unmapped   — no confident match; surfaced for an operator rather than
 *                guessed at, because a wrong guess ships or withholds code.
 *
 * Pure and dependency-free so the whole table can be asserted in tests.
 */

import { MODULES, TIERS, type PricedModule } from "./aurixa-catalog";
import { SUB_MODULE_MATRIX, tierEnablesSubModule } from "./sub-module-matrix";
import { TIER_FEATURES } from "./tier-features";

// ─── Normalisation ───────────────────────────────────────────────────

/** Display name → slug, matching how detection slugs are formed. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/\//g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ─── Curated aliases ─────────────────────────────────────────────────

/**
 * Priced slugs whose technical counterpart is not a plain slug match.
 *
 * Everything here is a naming difference between the pricing sheet and the
 * repo, not a judgement call: `aml-ctf` is the sheet's name for what the repo
 * calls `aml`, and `Commercial / Industrial` is sold as one line but built as
 * two directories. Anything genuinely ambiguous is deliberately absent so it
 * lands in `unmapped` for an operator instead of being guessed.
 */
export const PRICED_MODULE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "aml-ctf": ["aml"],
  "commercial-industrial": ["commercial", "industrial"],
  "email-copilot": ["email"],
  "opportunity-marketplace": ["listings"],
  "aurixa-agent": ["agent"],
};

/**
 * Priced items that gate a sub-feature of an already-installed module rather
 * than installing anything. Value is the SUB_MODULE_MATRIX key they map to.
 *
 * These are the entries that make a naive slug match look broken: there is no
 * `borrowing-capacity` module to install because it is a tab inside Clients.
 */
export const ENTITLEMENT_ONLY_MODULES: Readonly<Record<string, string>> = {
  "client-forms": "clients.client-forms",
  "client-ai": "clients.ai",
  "portfolio-analysis": "clients.portfolio-analysis",
  "send-portfolio": "clients.send-portfolio-to-client",
  "borrowing-capacity": "clients.borrowing-capacity",
  "report-comparisons": "generated-reports.comparisons",
  "cashflow-comparisons": "cash-flow-analysis.comparisons",
  lenders: "clients.lenders",
};

/**
 * Technical modules every clone needs regardless of tier: the shell the app
 * cannot boot without. Detection names them, but no pricing line ever will,
 * because a customer does not buy "auth" or "platform-core".
 */
export const ALWAYS_INSTALLED = [
  "platform-core",
  "auth",
  "index",
  "not-found",
  "settings",
  "user-management",
  "billing",
  "user-guide",
  "error-logs",
  "activity-logs",
  "overview",
] as const;

// ─── Mapping ─────────────────────────────────────────────────────────

export type MappingKind = "installs" | "entitlement" | "unmapped";
export type MappingConfidence = "exact" | "alias" | "suggested" | "manual";

export type ModuleMapping = {
  /** "tier" for a tier's baseline feature, "module" for a priced add-on. */
  sourceKind: "tier" | "module";
  /** Tier slug, or priced module slug. */
  sourceSlug: string;
  /** Human label from the pricing sheet. */
  sourceName: string;
  kind: MappingKind;
  /** Technical module slugs to install. Empty for entitlement/unmapped. */
  moduleSlugs: string[];
  /** SUB_MODULE_MATRIX key, when kind is "entitlement". */
  entitlementKey?: string;
  confidence: MappingConfidence;
  reason: string;
};

/**
 * Map one priced module onto technical modules.
 *
 * `knownModules` is the live detected slug set — a mapping is only claimed
 * when the target actually exists, so a stale alias degrades to `unmapped`
 * (visible) rather than to a silent no-op install.
 */
export function mapPricedModule(
  pm: PricedModule,
  knownModules: ReadonlySet<string>,
): ModuleMapping {
  const base = {
    sourceKind: "module" as const,
    sourceSlug: pm.slug,
    sourceName: pm.name,
  };

  const entitlementKey = ENTITLEMENT_ONLY_MODULES[pm.slug];
  if (entitlementKey) {
    return {
      ...base,
      kind: "entitlement",
      moduleSlugs: [],
      entitlementKey,
      confidence: "exact",
      reason: `Sub-feature of an installed module — gated by entitlement "${entitlementKey}", nothing to install.`,
    };
  }

  if (knownModules.has(pm.slug)) {
    return {
      ...base,
      kind: "installs",
      moduleSlugs: [pm.slug],
      confidence: "exact",
      reason: "Priced slug matches a detected module slug exactly.",
    };
  }

  const aliases = PRICED_MODULE_ALIASES[pm.slug];
  if (aliases) {
    const present = aliases.filter((a) => knownModules.has(a));
    if (present.length > 0) {
      return {
        ...base,
        kind: "installs",
        moduleSlugs: present,
        confidence: "alias",
        reason:
          present.length === aliases.length
            ? `Curated alias: the pricing sheet calls this "${pm.slug}", the repo builds it as ${present.join(" + ")}.`
            : `Curated alias, partially resolved — ${aliases.filter((a) => !knownModules.has(a)).join(", ")} not found in the catalogue.`,
      };
    }
  }

  const suggestions = suggestModules(pm.slug, knownModules);
  if (suggestions.length > 0) {
    return {
      ...base,
      kind: "unmapped",
      moduleSlugs: [],
      confidence: "suggested",
      reason: `No confident match. Candidates by name overlap: ${suggestions.join(", ")}.`,
    };
  }

  return {
    ...base,
    kind: "unmapped",
    moduleSlugs: [],
    confidence: "suggested",
    reason: "No detected module resembles this priced item.",
  };
}

/**
 * Candidate technical modules for a priced slug, by shared name token.
 * Suggestions are never auto-applied — they exist so an operator resolving an
 * unmapped row has somewhere to start.
 */
export function suggestModules(
  pricedSlug: string,
  knownModules: ReadonlySet<string>,
  limit = 5,
): string[] {
  const tokens = pricedSlug.split("-").filter((t) => t.length > 2);
  if (tokens.length === 0) return [];

  const scored: Array<{ slug: string; score: number }> = [];
  for (const slug of knownModules) {
    const slugTokens = new Set(slug.split("-"));
    let score = 0;
    for (const t of tokens) {
      if (slugTokens.has(t)) score += 2;
      else if (slug.includes(t)) score += 1;
    }
    if (score > 0) scored.push({ slug, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug))
    .slice(0, limit)
    .map((s) => s.slug);
}

/**
 * Map a tier's baseline features (the things it includes that are not sold as
 * separate add-ons) onto technical modules, by slugifying the sheet's own
 * feature names.
 */
export function mapTierBaseline(
  tierSlug: string,
  knownModules: ReadonlySet<string>,
): ModuleMapping[] {
  const features = TIER_FEATURES[tierSlug];
  if (!features) return [];

  const pricedSlugs = new Set(MODULES.map((m) => m.slug));
  const out: ModuleMapping[] = [];
  const seen = new Set<string>();

  for (const group of features.groups) {
    for (const item of group.items) {
      const slug = slugify(item.name);
      if (seen.has(slug)) continue;
      seen.add(slug);

      // Sold separately — handled by the priced-module mapping, not here.
      if (pricedSlugs.has(slug)) continue;

      const base = {
        sourceKind: "tier" as const,
        sourceSlug: tierSlug,
        sourceName: item.name,
      };

      if (knownModules.has(slug)) {
        out.push({
          ...base,
          kind: "installs",
          moduleSlugs: [slug],
          confidence: "exact",
          reason: `Tier baseline feature "${item.name}" matches detected module "${slug}".`,
        });
        continue;
      }

      const aliases = TIER_FEATURE_ALIASES[slug];
      const present = (aliases ?? []).filter((a) => knownModules.has(a));
      if (present.length > 0) {
        out.push({
          ...base,
          kind: "installs",
          moduleSlugs: present,
          confidence: "alias",
          reason: `Tier baseline "${item.name}" maps to ${present.join(" + ")}.`,
        });
        continue;
      }

      out.push({
        ...base,
        kind: "unmapped",
        moduleSlugs: [],
        confidence: "suggested",
        reason: `Tier baseline "${item.name}" has no detected module. Candidates: ${
          suggestModules(slug, knownModules).join(", ") || "none"
        }.`,
      });
    }
  }

  return out;
}

/**
 * Tier baseline names whose slug does not equal the repo's module slug.
 * Same rule as the priced aliases: naming differences only.
 */
export const TIER_FEATURE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "aml-ctf-compliance": ["aml"],
  "generated-reports": ["generated-reports", "reports"],
  "cash-flow-analysis": ["cash-flow"],
  "client-tracker": ["client"],
  clients: ["client"],
  checklist: ["checklists"],
  "game-plan": ["game-plan"],
  "billing-usage": ["billing"],
  "client-portal": ["portal"],
  "report-requests": ["report-requests", "reports"],
  branding: ["white-label", "branding"],
  "api-usage": ["api-usage"],
};

// ─── Resolution ──────────────────────────────────────────────────────

export type EntitlementResolution = {
  planSlug: string;
  /** Technical module slugs the clone should have installed. */
  moduleSlugs: string[];
  /** SUB_MODULE_MATRIX keys the plan enables. */
  entitlementKeys: string[];
  /** Priced items included by the tier itself. */
  includedModules: string[];
  /** Priced items bought on top of the tier. */
  addonModules: string[];
  /** Priced items that could not be mapped — surfaced, never silently dropped. */
  unmapped: Array<{ sourceSlug: string; sourceName: string; reason: string }>;
};

/**
 * The full set of technical modules a clone on `planSlug` should have,
 * including any separately purchased add-ons.
 *
 * Add-ons are unioned with the tier's own inclusions, so buying a module the
 * tier already covers is a no-op rather than a duplicate.
 */
export function resolveEntitledModules(args: {
  planSlug: string;
  /** Priced module slugs purchased on top of the tier. */
  purchasedAddons?: readonly string[];
  /** Live detected module slugs. */
  knownModules: ReadonlySet<string>;
  /** Operator overrides: priced/tier slug → technical slugs. */
  overrides?: Readonly<Record<string, readonly string[]>>;
}): EntitlementResolution {
  const { planSlug, purchasedAddons = [], knownModules, overrides = {} } = args;

  const modules = new Set<string>();
  const unmapped: EntitlementResolution["unmapped"] = [];
  const includedModules: string[] = [];
  const addonModules: string[] = [];

  // Every clone needs the shell.
  for (const slug of ALWAYS_INSTALLED) {
    if (knownModules.has(slug)) modules.add(slug);
  }

  const applyOverride = (sourceSlug: string): boolean => {
    const ov = overrides[sourceSlug];
    if (!ov) return false;
    for (const s of ov) if (knownModules.has(s)) modules.add(s);
    return true;
  };

  // ── Tier baselines, walking the inheritance chain ──
  for (const tierSlug of tierChain(planSlug)) {
    for (const m of mapTierBaseline(tierSlug, knownModules)) {
      const key = `tier:${tierSlug}:${slugify(m.sourceName)}`;
      if (applyOverride(key)) continue;
      if (m.kind === "installs") for (const s of m.moduleSlugs) modules.add(s);
      else if (m.kind === "unmapped")
        unmapped.push({ sourceSlug: m.sourceSlug, sourceName: m.sourceName, reason: m.reason });
    }
  }

  // ── Priced modules: included by tier, or explicitly purchased ──
  const purchased = new Set(purchasedAddons);
  for (const pm of MODULES) {
    const includedByTier = pm.includedIn.includes(planSlug);
    const boughtSeparately = purchased.has(pm.slug);
    if (!includedByTier && !boughtSeparately) continue;

    if (includedByTier) includedModules.push(pm.slug);
    else addonModules.push(pm.slug);

    if (applyOverride(`module:${pm.slug}`)) continue;

    const mapping = mapPricedModule(pm, knownModules);
    if (mapping.kind === "installs") {
      for (const s of mapping.moduleSlugs) modules.add(s);
    } else if (mapping.kind === "unmapped") {
      unmapped.push({
        sourceSlug: mapping.sourceSlug,
        sourceName: mapping.sourceName,
        reason: mapping.reason,
      });
    }
    // "entitlement" installs nothing by design.
  }

  const entitlementKeys = SUB_MODULE_MATRIX.filter((r) =>
    tierEnablesSubModule(planSlug, r.key),
  ).map((r) => r.key);

  // Add-on purchases also unlock their sub-module key even when the tier does not.
  for (const slug of purchased) {
    const key = ENTITLEMENT_ONLY_MODULES[slug];
    if (key && !entitlementKeys.includes(key)) entitlementKeys.push(key);
  }

  return {
    planSlug,
    moduleSlugs: [...modules].sort(),
    entitlementKeys: entitlementKeys.sort(),
    includedModules: includedModules.sort(),
    addonModules: addonModules.sort(),
    unmapped,
  };
}

/**
 * A tier and everything it inherits, oldest first.
 *
 * The sheet writes higher tiers as deltas ("Everything in Growth, plus…"), so
 * resolving Scale without walking the chain would install only the six things
 * Scale adds and none of the app.
 */
export function tierChain(tierSlug: string): string[] {
  const order = TIERS.map((t) => t.slug);
  const idx = order.indexOf(tierSlug);
  if (idx === -1) return TIER_FEATURES[tierSlug] ? [tierSlug] : [];
  return order.slice(0, idx + 1);
}

/** Every mapping row, for the operator-facing editor and for seeding. */
export function buildFullMapping(knownModules: ReadonlySet<string>): ModuleMapping[] {
  const out: ModuleMapping[] = [];
  for (const t of TIERS) out.push(...mapTierBaseline(t.slug, knownModules));
  for (const pm of MODULES) out.push(mapPricedModule(pm, knownModules));
  return out;
}

// ─── Diffing ─────────────────────────────────────────────────────────

export type ModuleDiff = {
  /** Entitled but not installed — an upgrade must add these. */
  toInstall: string[];
  /** Installed but no longer entitled. */
  toRevoke: string[];
  /** Entitled and already installed. */
  unchanged: string[];
};

/**
 * Compare what a clone has against what its plan entitles it to.
 *
 * `toRevoke` is deliberately named revoke rather than uninstall: a downgrade
 * turns entitlements off and leaves the code in place, so a customer who
 * re-upgrades is instantly whole and nobody's in-flight work breaks on a
 * billing event.
 */
export function diffModules(installed: readonly string[], entitled: readonly string[]): ModuleDiff {
  const have = new Set(installed);
  const want = new Set(entitled);
  return {
    toInstall: [...want].filter((s) => !have.has(s)).sort(),
    toRevoke: [...have].filter((s) => !want.has(s)).sort(),
    unchanged: [...want].filter((s) => have.has(s)).sort(),
  };
}

// ─── Contractual exclusions ──────────────────────────────────────────

/**
 * Subtract the modules a signed agreement contractually excluded.
 *
 * Applied to every resolution — initial provisioning, upgrades, downgrades,
 * manual reconciles — because the failure mode this prevents is the quiet
 * one: a plan change re-resolving the tier's full set and re-installing
 * exactly what the client bargained away. An exclusion naming a module the
 * plan does not include anyway is inert (it documents the negotiation).
 *
 * Entitlement KEYS are left alone on purpose: a key gates a sub-feature
 * inside a module, and the module gate itself already wins — an excluded
 * module's tabs cannot render whatever its keys say.
 */
export function applyContractExclusions(
  resolution: EntitlementResolution,
  excludedSlugs: readonly string[],
): EntitlementResolution & { contractExcluded: string[] } {
  const excluded = new Set(excludedSlugs);
  const contractExcluded = resolution.moduleSlugs.filter((s) => excluded.has(s)).sort();
  return {
    ...resolution,
    moduleSlugs: resolution.moduleSlugs.filter((s) => !excluded.has(s)),
    contractExcluded,
  };
}
