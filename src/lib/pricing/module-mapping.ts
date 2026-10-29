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
 * The join runs the other way too. Every library module has a place: the
 * shell, a tier's baseline, a priced module, or — for the pieces detection
 * splits a feature into — the module whose feature it serves
 * (`MODULE_COMPANIONS`). The few that no plan sells say why
 * (`NOT_SOLD_MODULES`), and `unplacedModules` names any module that has no
 * place yet, which is how a feature the library follow brings in from the
 * prime reaches an operator instead of resolving on no plan.
 *
 * Pure and dependency-free so the whole table can be asserted in tests.
 */

import { MODULES, TIERS, moduleBySlug, type PricedModule } from "./aurixa-catalog";
import { sortedUniqueSlugs, unknownExclusionSlugs } from "./contract-exclusions";
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
  // The pricing sheet's "Aurixa Intelligence Hub" IS Report Q&A. The prime's
  // own registries say so and are the authority here: `entitlements/registry.ts`
  // declares `module.intelligence_hub` with `addonSlugs: ["intelligence-hub"]`,
  // and `navigation/registry.ts` renders "Aurixa Intelligence Hub" at
  // `/report-qa` under `moduleKey: 'report_qa'`. Detection names the module
  // `report-qa`, so the two never met and the addon resolved `unmapped` —
  // sellable at $79/month with a live Stripe price and nothing behind it.
  "intelligence-hub": ["report-qa"],
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
 * Priced items delivered by a SEPARATE deployment, not by this clone.
 *
 * Value is the deployment that serves it. These resolve to nothing here and
 * that is the correct answer, not a gap: the Builder / Developer Portal was
 * extracted from the per-clone build to the builders network, and the prime
 * keeps only `BuilderPortalMoved.tsx` where it used to live. Mapping one onto
 * a local module would install something the customer did not buy; leaving it
 * `unmapped` would report a real, settled arrangement as an unanswered
 * question, which is the signal the unmapped index exists to carry.
 */
export const EXTERNAL_DEPLOYMENT_MODULES: Readonly<Record<string, string>> = {
  "builder-developer-portal": "aurixa-builders",
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

export type MappingKind = "installs" | "entitlement" | "external" | "unmapped";
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

  const deployment = EXTERNAL_DEPLOYMENT_MODULES[pm.slug];
  if (deployment) {
    return {
      ...base,
      kind: "external",
      moduleSlugs: [],
      confidence: "exact",
      reason: `Served by the ${deployment} deployment — nothing installs on this clone.`,
    };
  }

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
  // Detection names the Report Requests page's module after its route file's
  // directory, `report`.
  "report-requests": ["report-requests", "report", "reports"],
  branding: ["white-label", "branding"],
  "api-usage": ["api-usage"],
  // The prime's navigation calls the `automation` module's page this.
  "auto-report-generation": ["automation"],
};

// ─── Placement ───────────────────────────────────────────────────────

/**
 * Library modules that are part of another library module's feature, placed
 * wherever that module is: its cron and webhook workers, its operator console,
 * its public share page, its sub-pages. Value is the module it rides with.
 *
 * Detection splits one feature into several modules, and no pricing line will
 * ever name the pieces: each `backend-*` module is the functions no route
 * reaches, grouped by name. So on 29 Oct 2026, measured with this file against
 * the 143 live modules at prime@83a3218, 105 resolved on no plan at all, and a
 * Scale clone's recorded entitlement named 32 of the 143. With this table it
 * names 117, and every plan with every add-on 135: the other eight are the
 * modules `NOT_SOLD_MODULES` accounts for.
 *
 * Each is placed by how the prime gates it — the route's `ModuleGuard`, or the
 * check its functions make on the server — so a place here writes down the
 * prime's decision and never makes a commercial one. A companion goes where its
 * anchor goes: onto a tier, in with an add-on, into the shell, and out with a
 * contract exclusion that withholds its anchor (`libraryModulesOf`).
 */
export const MODULE_COMPANIONS: Readonly<Record<string, string>> = {
  // The shell: every clone, on every plan.
  "accept-invite": "auth", // /accept-invite, public
  "backend-custom": "auth", // the staff sign-in, sign-out and session check
  "backend-mission": "billing", // the clone's door to Mission Control: gate, plan change, payment methods
  "token-audit-log": "billing", // superadmin only
  monitoring: "error-logs", // admin only
  support: "user-guide", // `__always__` in the prime's navigation
  feedback: "user-guide", // `__always__`
  sources: "settings",
  "data-import": "settings", // reference data: CSVs into cache tables and directories
  "backend-import": "data-import", // the suburb directory, admin only
  "backend-manage": "white-label", // branding, beside the agent-model and data-import admin
  "builder-portal-moved": "platform-core", // /builder/*: sends a builder to the builders network
  "backend-bootstrap": "platform-core", // the vault pg_cron authenticates with
  "backend-healthcheck": "platform-core",
  "backend-mcp": "platform-core", // generated by Lovable's MCP plugin
  "backend-legal": "platform-core", // immutable document versions and their malware scan

  // Generated Reports, every tier: the engine and the feeds it reads.
  "investment-report-view": "generated-reports",
  "quality-assurance": "generated-reports",
  "backend-abs": "generated-reports",
  "backend-amenity": "generated-reports",
  "backend-archive": "generated-reports",
  "backend-auto": "generated-reports",
  "backend-cotality": "generated-reports",
  "backend-crime": "generated-reports",
  "backend-data": "generated-reports", // which data source wins a conflict
  "backend-fix": "generated-reports",
  "backend-generate": "generated-reports", // chart images
  "backend-prepare": "generated-reports", // report hero images
  "backend-public": "generated-reports", // public transport
  "backend-rba": "generated-reports",
  "backend-report": "generated-reports",
  "backend-resolve": "generated-reports", // report geography and listing coordinates
  "backend-resume": "generated-reports",
  "backend-transport": "generated-reports",
  "backend-update": "generated-reports", // the stamp duty schedules
  "backend-urban": "generated-reports",

  // Reports, every tier.
  charts: "reports",
  "portfolio-reports": "reports",

  // Clients, every tier. A paid page among these is shut by its entitlement
  // key, as the paid client tabs are, so it is installed with Clients.
  "portfolio-analysis-review": "client", // the client Review wizard as a page: `client.review`
  "borrowing-capacity": "client", // `client.borrowing_capacity`: Scale, or the add-on
  "bc-segment-engine-admin": "borrowing-capacity", // superadmin only
  "backend-bc": "borrowing-capacity", // refuses on the server below Scale without the add-on
  lenders: "client", // the Lenders add-on, still in development
  commissions: "client", // the commission ledger
  "reclassify-property-admin": "client", // superadmin only
  "backend-create": "client",
  "backend-clean": "client", // note transcripts
  messages: "client", // the Message Hub
  messaging: "messages",
  "backend-messaging": "messages",
  "backend-message": "messages", // message governance
  conversations: "client",
  "backend-build": "conversations", // the conversations export
  "backend-start": "conversations",

  // Client Portal, every tier.
  "backend-portal": "portal",

  // Templates, every tier.
  "template-builder": "templates",
  template: "templates", // the converter, import quality and the share preview
  "brand-systems": "templates",
  "figma-templates": "templates",
  pdf: "templates", // the PDF golden regression
  "pdf-import": "templates",
  "backend-pdf": "pdf-import",
  "backend-retrieve": "templates",

  // With what the price list sells: a tier above Launch, or an add-on.
  "backend-aml": "aml",
  "backend-didit": "aml", // identity verification
  "backend-solicitor": "solicitor-portal",
  "backend-finance": "finance-portal",
  "agreement-templates": "agreements",
  "partner-referrals": "agreements",
  "loan-writer-undertakings": "agreements",
  "partner-compliance": "agreements",
  partner: "agreements", // a partner's acknowledgement and referral inbox
  "public-partner-consent": "agreements",
  "market-qa": "market-updates",
  qa: "market-updates", // a shared market Q&A answer
  "backend-market": "market-updates",
  "listing-detail": "listings",
  "backend-builder": "listings", // the builders network, inbound
  "backend-cross": "listings", // the builders network, outbound
  property: "commercial", // the classic calculators, under `commercial`
  "backend-estimate": "commercial", // commercial cap rate and NOI
  "backend-vapi": "call-logs",
  "backend-send": "call-logs",
  "backend-cleanup": "call-logs",
  "backend-email": "email",
  "backend-outlook": "email",
  "backend-process": "email", // Email Copilot's scheduled sends
  "backend-agent": "agent",
  workflow: "integrations", // Workflow Playground, under `integrations`
  "backend-ghl": "integrations",
  "backend-request": "marketing", // the lead magnet
  "shared-qa-answer": "report-qa",

  // NPC's own GoHighLevel migration, which no plan sells (`NOT_SOLD_MODULES`).
  "backend-migration": "ghl",
  "backend-one": "ghl",
  "backend-backfill": "ghl",
  "backend-diagnose": "ghl",
  "backend-sync": "ghl",
};

/**
 * Library modules no plan sells, on purpose, and why.
 *
 * They resolve to nothing on every plan, as a module another deployment serves
 * does, and `unplacedModules` does not name them: each is a settled answer, not
 * an open question. A companion of one is not sold either.
 */
export const NOT_SOLD_MODULES: Readonly<Record<string, string>> = {
  "-tests-": "Specs under src/pages/__tests__ that detection read as routes, not a feature.",
  "bc-segment-engine-admin.security.test":
    "A test file that detection read as a route, not a feature.",
  ghl: "NPC's own GoHighLevel migration tooling. `InternalToolingGuard` refuses it on every deployment but the prime.",
};

/** Each anchor's companions, from `MODULE_COMPANIONS`. */
const COMPANIONS_OF: ReadonlyMap<string, readonly string[]> = (() => {
  const out = new Map<string, string[]>();
  for (const [companion, anchor] of Object.entries(MODULE_COMPANIONS)) {
    out.set(anchor, [...(out.get(anchor) ?? []), companion]);
  }
  return out;
})();

/**
 * `slugs` with every companion that rides with one of them, transitively, among
 * the modules the catalogue holds. A companion whose anchor is not in the set
 * stays out, so this can never install what no plan places.
 */
export function withCompanions(
  slugs: Iterable<string>,
  knownModules: ReadonlySet<string>,
): string[] {
  const out = new Set<string>();
  const pending = [...slugs];
  while (pending.length > 0) {
    const slug = pending.pop()!;
    if (out.has(slug)) continue;
    out.add(slug);
    for (const companion of COMPANIONS_OF.get(slug) ?? []) {
      if (knownModules.has(companion)) pending.push(companion);
    }
  }
  return [...out].sort();
}

/** Whether a module is not sold, itself or as a companion of one that is not. */
function isNotSold(slug: string): boolean {
  const seen = new Set<string>();
  for (let s: string | undefined = slug; s && !seen.has(s); s = MODULE_COMPANIONS[s]) {
    if (NOT_SOLD_MODULES[s]) return true;
    seen.add(s);
  }
  return false;
}

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
    // Each module brings its companions, so the pieces of a feature are placed
    // exactly where the feature is.
    moduleSlugs: withCompanions(modules, knownModules),
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
 * The library modules one priced module puts on a clone: the operator's
 * override (`module:<slug>`) when there is one, else the derived mapping, and
 * the companions of either.
 *
 * It is the translation `resolveEntitledModules` installs by, so an exclusion
 * withholds exactly what buying the module would have installed, its
 * companions included. Empty for an entitlement-only item, for one another
 * deployment serves, and for one nothing maps.
 */
export function libraryModulesOf(
  pm: PricedModule,
  knownModules: ReadonlySet<string>,
  overrides: Readonly<Record<string, readonly string[]>> = {},
): string[] {
  const override = overrides[`module:${pm.slug}`];
  const own = override
    ? override.filter((s) => knownModules.has(s))
    : mapPricedModule(pm, knownModules).moduleSlugs;
  return withCompanions(own, knownModules);
}

/**
 * Library modules nothing places: not the shell, not reached by any tier or
 * priced module — the top tier, with every priced module bought — not a
 * companion of one that is, and not deliberately unsold.
 *
 * The library follows the prime by itself (D19), so a feature merged there
 * arrives here with no place on any plan. This is the list a person works: each
 * entry is code every clone runs that no clone is recorded as holding, until it
 * is placed in `MODULE_COMPANIONS`, a tier's features or the price list.
 */
export function unplacedModules(
  knownModules: ReadonlySet<string>,
  overrides: Readonly<Record<string, readonly string[]>> = {},
): string[] {
  const everything = resolveEntitledModules({
    planSlug: TIERS[TIERS.length - 1].slug,
    purchasedAddons: MODULES.map((m) => m.slug),
    knownModules,
    overrides,
  });
  const placed = new Set(everything.moduleSlugs);
  return [...knownModules].filter((s) => !placed.has(s) && !isNotSold(s)).sort();
}

/**
 * Every library module the excluded price-list slugs map to, through
 * `libraryModulesOf`. A slug the price list does not know maps to nothing.
 *
 * Provisioning drops these from the modules picked for a new clone
 * (`effectiveModuleIds`). Whether one of them stays because another priced
 * module needs it is the reconcile's decision (`applyContractExclusions`), and
 * the reconcile reinstalls what it keeps.
 */
export function libraryModulesExcludedBy(
  excludedSlugs: readonly string[],
  knownModules: ReadonlySet<string>,
  overrides: Readonly<Record<string, readonly string[]>> = {},
): string[] {
  const out = new Set<string>();
  for (const slug of new Set(excludedSlugs)) {
    const pm = moduleBySlug(slug);
    if (!pm) continue;
    for (const s of libraryModulesOf(pm, knownModules, overrides)) out.add(s);
  }
  return [...out].sort();
}

export type ContractExclusionOutcome = {
  /** The price-list slugs in effect: every recorded exclusion the price list knows, sorted. */
  contractExcluded: string[];
  /**
   * Recorded exclusions the price list does not know. Reported, never dropped
   * silently, and never subtracted: nothing says what they would remove.
   */
  unknownExclusions: string[];
  /**
   * Library modules an excluded priced module maps to that stay, because a
   * priced module this resolution still includes or sells maps to them too.
   */
  sharedModulesKept: Array<{ moduleSlug: string; excludedBy: string[]; keptFor: string[] }>;
};

/**
 * Subtract what a signed agreement contractually excluded.
 *
 * Applied to every resolution — initial provisioning, upgrades, downgrades,
 * manual reconciles — because the failure mode this prevents is the quiet
 * one: a plan change re-resolving the tier's full set and re-installing
 * exactly what the client bargained away.
 *
 * An exclusion is a price-list slug (`contract-exclusions.ts`). For each one
 * the price list knows:
 *
 *  - it leaves `includedModules` and `addonModules`;
 *  - the library modules it maps to (`libraryModulesOf`) leave `moduleSlugs`,
 *    except one that a priced module still in effect also maps to. That one
 *    stays and is reported in `sharedModulesKept`. A tier's baseline features
 *    keep nothing: the AML/CTF baseline maps to `aml` as well, and excluding
 *    `aml-ctf` has to remove it;
 *  - its `ENTITLEMENT_ONLY_MODULES` key leaves `entitlementKeys`. For an
 *    entitlement-only item such as `client-ai` that key is the only gate there
 *    is, since nothing installs for it. The keys of a module that installs are
 *    left alone, because the module gate already wins: an excluded module's
 *    tabs cannot render whatever its keys say.
 *
 * An exclusion of a priced module the plan does not include changes nothing
 * and stays in `contractExcluded`: it documents the negotiation, and it holds
 * if the plan later changes to one that includes the module.
 */
export function applyContractExclusions(
  resolution: EntitlementResolution,
  excludedSlugs: readonly string[],
  library: {
    /** Live detected module slugs, as `resolveEntitledModules` was given them. */
    knownModules: ReadonlySet<string>;
    /** Operator overrides, as `resolveEntitledModules` was given them. */
    overrides?: Readonly<Record<string, readonly string[]>>;
  },
): EntitlementResolution & ContractExclusionOutcome {
  const { knownModules, overrides = {} } = library;
  const unknownExclusions = unknownExclusionSlugs(excludedSlugs);
  const contractExcluded = sortedUniqueSlugs(excludedSlugs.filter((s) => moduleBySlug(s)));
  const excluded = new Set(contractExcluded);

  const includedModules = resolution.includedModules.filter((s) => !excluded.has(s));
  const addonModules = resolution.addonModules.filter((s) => !excluded.has(s));

  // Library module → the priced modules mapping to it, on each side.
  const mappedBy = (slugs: readonly string[]): Map<string, string[]> => {
    const out = new Map<string, string[]>();
    for (const slug of slugs) {
      const pm = moduleBySlug(slug);
      if (!pm) continue;
      for (const lib of libraryModulesOf(pm, knownModules, overrides)) {
        out.set(lib, [...(out.get(lib) ?? []), slug]);
      }
    }
    return out;
  };
  const withheld = mappedBy(contractExcluded);
  const stillNeeded = mappedBy([...includedModules, ...addonModules]);

  const sharedModulesKept: ContractExclusionOutcome["sharedModulesKept"] = [];
  const moduleSlugs = resolution.moduleSlugs.filter((lib) => {
    const excludedBy = withheld.get(lib);
    if (!excludedBy) return true;
    const keptFor = stillNeeded.get(lib);
    if (!keptFor) return false;
    sharedModulesKept.push({
      moduleSlug: lib,
      excludedBy: sortedUniqueSlugs(excludedBy),
      keptFor: sortedUniqueSlugs(keptFor),
    });
    return true;
  });

  const withheldKeys = new Set(
    contractExcluded.map((s) => ENTITLEMENT_ONLY_MODULES[s]).filter((k): k is string => !!k),
  );

  return {
    ...resolution,
    moduleSlugs,
    entitlementKeys: resolution.entitlementKeys.filter((k) => !withheldKeys.has(k)),
    includedModules,
    addonModules,
    contractExcluded,
    unknownExclusions,
    sharedModulesKept,
  };
}
