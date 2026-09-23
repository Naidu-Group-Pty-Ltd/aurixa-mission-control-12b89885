/**
 * WHAT IS CROSSING — the species of a code chunk at a cascade boundary.
 *
 * The cascade's unit of decision has always been a PATH. `partitionCascadePaths`
 * asks "may this path be written", `REPOSITORY_INVARIANTS` asks "does a module
 * own this path", and both answer before a single byte has been read. That is
 * the right shape for most of the tree and the wrong shape for everything this
 * fleet has actually been broken by, because the defects were never about
 * where a file sits. They were about what it SAYS.
 *
 * Two content-level judgements already exist and prove the shape:
 * `backendIdentityHold` refuses a shipped file naming a foreign Supabase
 * project, and `securityInventoryHold` refuses a baseline that describes a
 * different function set. Both return an ordinary `HeldPath` with a
 * `(content: …)` pattern. This module is the vocabulary those two were
 * written without: a NAME for the kind of thing that is crossing, so a
 * boundary can hold an opinion about a species rather than about a path.
 *
 * ## Every species here was measured, none was imagined
 *
 * A species earns its place by having broken something. The evidence is on
 * each one. Where a species is already policed by an existing organ, it is
 * still named — `foreign_backend_ref` is `backendIdentityHold`'s — because a
 * membrane an operator cannot see the whole of is one they cannot trust, and
 * naming it costs nothing while re-implementing it would cost correctness.
 *
 * ## Classification is evidence, never a verdict
 *
 * Nothing here decides whether a chunk may cross. `classify` reports what it
 * found and where it found it; `permeate` in `membrane.pure.ts` is the only
 * place that turns that into a decision, because one module that both
 * observes and judges is one that cannot be asked "what is in this file"
 * without also being asked "should it be here".
 */

import { globToRegex } from "@/lib/module-globs";

/** The kinds of thing this fleet has been broken by, at a boundary. */
export type IonSpeciesName =
  /**
   * A quoted name from the CRM routing table, or the switch it reads.
   * Both columns — a `crm-*` name outside `crmFunction()` bypasses the switch
   * exactly as a `ghl-*` one does.
   */
  | "routed_crm_name"
  /** `docs/security/SECURITY_INVENTORY.json` — a static analysis of one tree. */
  | "security_baseline"
  /** A `[functions.X]` block or a registry entry: a declaration about a function. */
  | "function_declaration"
  /** A spec/test file: it asserts things about a subject that may not be crossing. */
  | "spec"
  /** A Supabase project reference. */
  | "backend_ref"
  /**
   * A file of the CRM routing layer itself: the provider switch, its adapters,
   * the native `crm-*` edge functions and the layer's own documentation.
   *
   * A property of the PATH, because the layer is a place rather than a word:
   * `crmProvider.ts` spells every routed name by design and `routed_crm_name`
   * exempts it for exactly that reason, so the one species that could have
   * named the layer is the one that must stay blind to it. Measured 23 Sep
   * 2026 on `npc-crm-independent-6505dc`: 16 of the 21 files that repository
   * holds and no other deployment does sit under these four roots.
   */
  | "crm_routing_layer"
  /**
   * A file inside one edge function's own directory.
   *
   * A deployment DECLARES its functions (`supabase/config.toml`, the security
   * registry) and deploys each against its own project, so a function's source
   * travelling without its declaration is a function that exists in the tree
   * and nowhere else. `_shared/` is not a function and is not this species.
   */
  | "edge_function"
  /** A schema migration: applied by each deployment's own pipeline to its own database. */
  | "migration"
  /**
   * A hosting project or team identifier — Vercel's `prj_…` / `team_…`.
   *
   * `backend_ref`'s sibling one layer out: a Supabase ref names the database a
   * deployment talks to, and one of these names the project that builds and
   * serves it. A workflow that prunes or promotes deployments by id does it to
   * whichever project it names, so a copy of it acts on the original's.
   */
  | "hosting_ref";

/** One reading: a species was found, and this is where. */
export type IonReading = {
  species: IonSpeciesName;
  /**
   * The literal tokens found, de-duplicated and sorted. Empty where the
   * species is a property of the PATH rather than of any token in the text.
   */
  tokens: string[];
  /** One clause naming what was seen, for an operator reading a held row. */
  evidence: string;
};

/**
 * THE ROUTED CRM FUNCTION NAMES — the clone's own list, not a wider one.
 *
 * This is not a catalogue of GoHighLevel functions. It is a mirror of
 * `src/lib/crm/__tests__/crmIndependence.spec.ts` on
 * `npc-crm-independent-6505dc`, which is the AUTHORITY: that spec is what
 * actually turns the clone's CI red, and a membrane that refuses on a
 * different standard is a second standard.
 *
 * The prime invokes 24 distinct `ghl-*` names under `src/`. The authority
 * names SIX, and the difference is the whole point of the rule: what it
 * guards is the ROUTING TABLE, so it lists both columns —
 *
 *   ghl-calendar              ↔  crm-calendar
 *   send-ghl-message          ↔  crm-send-message
 *   sync-ghl-conversations        (vendor step, no native counterpart)
 *   update-ghl-opportunity-stage  (vendor step, no native counterpart)
 *
 * — because spelling `crm-send-message` outside `crmFunction()` bypasses the
 * switch exactly as spelling `send-ghl-message` does. A list of GoHighLevel
 * names alone would have been wide on one side and blind on the other.
 *
 * **Divergence has a direction, and only one direction is cheap.** A channel
 * NARROWER than the authority lets a file cross that turns the clone's CI
 * red — loudly, on the clone, with the offending path named. A channel WIDER
 * than the authority holds a file the clone would have accepted, on a fleet
 * whose signature failure is stalling for reasons nobody stated. So this
 * mirrors the authority exactly rather than erring "safe", and
 * `membrane.test.ts` pins the list, the two exemptions and the quoting.
 */
export const ROUTED_CRM_FUNCTION_NAMES: readonly string[] = [
  "crm-calendar",
  "crm-send-message",
  "ghl-calendar",
  "send-ghl-message",
  "sync-ghl-conversations",
  "update-ghl-opportunity-stage",
];

/**
 * The environment variable the routing table reads.
 *
 * The authority guards this by the same rule and for the same reason: a
 * surface that reads `VITE_CRM_PROVIDER` itself has bypassed the one module
 * that decides, so it is the same species.
 */
export const CRM_PROVIDER_ENV = "VITE_CRM_PROVIDER";

/**
 * The one module allowed to spell any of them.
 *
 * It is the routing table. Holding it would hold the very file a provider
 * change has to deliver — a membrane that can never pass the fix for the
 * thing it is filtering.
 */
export const CRM_ROUTER_PATH = "src/lib/crm/crmProvider.ts";

/** `docs/security/SECURITY_INVENTORY.json` and nothing else. */
export const SECURITY_BASELINE_PATH = "docs/security/SECURITY_INVENTORY.json";

/** Where function declarations live. */
export const DECLARATION_PATHS: readonly string[] = [
  "supabase/config.toml",
  "supabase/functions-registry/SECURITY_REGISTRY.json",
];

/**
 * The CRM routing layer's four roots, as globs.
 *
 * Read off `npc-crm-independent-6505dc` on 23 Sep 2026 rather than composed:
 * the router and its tests (`src/lib/crm/**`), the provider adapters the
 * native functions share (`supabase/functions/_shared/crm/**`), the three
 * native functions themselves (`crm-calendar`, `crm-inbound-message`,
 * `crm-send-message`) and `docs/crm/CRM_INDEPENDENCE.md`. A function named
 * `crm-*` is the layer's by construction — the naming is the routing table's
 * own column — so the glob takes the prefix rather than the three names.
 */
export const CRM_ROUTING_LAYER_GLOBS: readonly string[] = [
  "src/lib/crm/**",
  "supabase/functions/_shared/crm/**",
  "supabase/functions/crm-*/**",
  "docs/crm/**",
];

/** Compiled once, by the one glob implementation every cascade path decision uses. */
const CRM_ROUTING_LAYER_MATCHERS: readonly RegExp[] = CRM_ROUTING_LAYER_GLOBS.map(globToRegex);

/** Whether a path belongs to the CRM routing layer. */
export function isCrmRoutingLayerPath(path: string): boolean {
  return CRM_ROUTING_LAYER_MATCHERS.some((rx) => rx.test(path));
}

/**
 * The edge function a path belongs to, or null.
 *
 * `supabase/functions/<name>/…` where `<name>` does not begin with `_` — the
 * Supabase CLI's own rule for a shared directory, which is how `_shared/` and
 * any `_template/` stay out of the deploy list. A file directly under
 * `supabase/functions/` (an import map, a deno.json) belongs to no function.
 */
export function edgeFunctionOf(path: string): string | null {
  const m = /^supabase\/functions\/([^/]+)\/.+/.exec(path);
  if (!m) return null;
  return m[1].startsWith("_") ? null : m[1];
}

/** Whether a path is a schema migration. */
export function isMigrationPath(path: string): boolean {
  return path.startsWith("supabase/migrations/");
}

/**
 * Vercel's project and team identifiers.
 *
 * Anchored on the prefix and a bounded run of the alphabet Vercel issues,
 * for the reason `PROJECT_REF_SHAPES` gives about its own first version: a
 * detector that matched any long word under a comment claiming otherwise is
 * worse than none. `prj_` ids measured on this fleet are 28 characters after
 * the prefix and team ids 24; the bounds leave room either side without
 * reaching prose.
 */
const HOSTING_REF_SHAPES: readonly RegExp[] = [
  /\b(prj_[A-Za-z0-9]{20,40})\b/g,
  /\b(team_[A-Za-z0-9]{20,40})\b/g,
];

/**
 * A Supabase project ref, in the two shapes that carry one into a shipped file.
 *
 * Transcribed from `backendRefsIn` in `syncExclusions.pure.ts`, which is the
 * shipped rule: the project URL, and the `ref` claim inside an anon key. A URL
 * from one project with a key from another authenticates to nothing, so the
 * pair travels together and both halves have to be seen.
 *
 * ANCHORED, and the first version of this was not — it read `\b[a-z]{20}\b`,
 * which is any twenty-letter lowercase word, under a comment claiming it was
 * the same shape as the rule above. It was not, and the claim is the part
 * that would have done the damage: the species is inert today because no
 * membrane in this fleet declares a channel on it, so the day somebody added
 * one they would have inherited a detector that fires on prose while its own
 * header promised otherwise.
 *
 * This module does not decide whether a ref is FOREIGN — that needs the
 * clone's own ref, which is a fact about the membrane rather than the text.
 */
const PROJECT_REF_SHAPES: readonly RegExp[] = [
  /\b([a-z]{20})\.supabase\.co\b/g,
  /"ref"\s*:\s*"([a-z]{20})"/g,
];

/**
 * A quoted occurrence of a routed CRM name, or of the switch itself.
 *
 * Single and double quotes only, matching the authority character for
 * character. Backticks are deliberately NOT matched: the clone's guard does
 * not match them, so matching them here would hold a file its own CI passes —
 * and the one place this fleet writes a function name in a template literal,
 * it writes the NAME as a variable
 * (`${SUPABASE_URL}/functions/v1/${functionName}`), which no literal rule can
 * or should see.
 */
function routedCrmTokensIn(text: string): string[] {
  const found = new Set<string>();
  for (const name of [...ROUTED_CRM_FUNCTION_NAMES, CRM_PROVIDER_ENV]) {
    if (text.includes(`'${name}'`) || text.includes(`"${name}"`)) found.add(name);
  }
  return [...found].sort();
}

/**
 * Whether the routing rule reaches this path at all.
 *
 * Two exemptions, both the authority's own and both stated as RULES rather
 * than as a list of paths — which is how that spec puts it, because a
 * per-file exemption list grows every time a test is renamed and each entry
 * then looks like a decision somebody made about that file.
 *
 * The ROUTER is exempt because it IS the routing table. A TEST is exempt
 * because a test that NAMES a function is not a surface that CALLS one: the
 * rule is about runtime, and a spec asserting something about
 * `send-ghl-message` reaches no provider at all.
 */
export function routingRuleReaches(path: string): boolean {
  if (!path.startsWith("src/")) return false;
  if (path === CRM_ROUTER_PATH) return false;
  if (isSpecPath(path)) return false;
  return true;
}

/**
 * Whether a path is a spec or test.
 *
 * Both spellings this fleet uses: `*.spec.ts(x)` / `*.test.ts(x)` anywhere,
 * and anything under a `__tests__` directory — which is where all 21 of the
 * orphaned specs measured on 21 Sep 2026 sit.
 */
export function isSpecPath(path: string): boolean {
  return /(^|\/)__tests__\//.test(path) || /\.(spec|test)\.[cm]?tsx?$/.test(path);
}

/**
 * Every KNOWN project ref this text names, in any form.
 *
 * The two anchored shapes above are what a SHIPPED file carries a project in,
 * and they are the right test for a detector that knows nothing about the
 * fleet. They are the wrong test for a script. Measured 23 Sep 2026 on
 * `npc-client-dashboard`: `scripts/clone-backend/02-deploy-functions.py`
 * names its own project and the prime's as bare strings handed to the
 * Management API — neither shape matches, and run from any other repository
 * that script deploys that repository's functions into this one's database.
 *
 * A bare twenty-letter word cannot be matched in general (the first version
 * of `PROJECT_REF_SHAPES` did exactly that and fired on prose). A ref this
 * fleet is KNOWN to own can: it is an exact token, so a word of ordinary
 * English is never one. The caller supplies the list, because which refs
 * exist is a fact about the fleet rather than about the text.
 */
function knownRefsIn(text: string, knownRefs: readonly string[]): string[] {
  const found: string[] = [];
  for (const ref of knownRefs) {
    if (!/^[a-z]{20}$/.test(ref)) continue;
    if (new RegExp(`(?<![A-Za-z0-9])${ref}(?![A-Za-z0-9])`).test(text)) found.push(ref);
  }
  return found;
}

/**
 * Read a crossing chunk and report every species in it.
 *
 * `text` is null for a binary file. Nothing here reads bytes that are not
 * text: a species is a statement about source, and asking a PNG whether it
 * names an edge function is asking a question of characters that were never
 * there — the rule `backendIdentityHold`'s own call site already records.
 *
 * `knownRefs` widens `backend_ref` to the fleet's own project refs written
 * bare — see `knownRefsIn`. Omitted, the reading is exactly the anchored one.
 */
export function classify(args: {
  path: string;
  text: string | null;
  knownRefs?: readonly string[];
}): IonReading[] {
  const { path, text } = args;
  const readings: IonReading[] = [];

  if (path === SECURITY_BASELINE_PATH) {
    readings.push({
      species: "security_baseline",
      tokens: [],
      evidence: "the generated static analysis of one repository's edge functions",
    });
  }

  if (DECLARATION_PATHS.includes(path)) {
    readings.push({
      species: "function_declaration",
      tokens: [],
      evidence: "declares which edge functions exist and how the gateway treats them",
    });
  }

  if (isSpecPath(path)) {
    readings.push({
      species: "spec",
      tokens: [],
      evidence: "asserts properties of a subject that may not be crossing with it",
    });
  }

  if (isCrmRoutingLayerPath(path)) {
    readings.push({
      species: "crm_routing_layer",
      tokens: [],
      evidence:
        "belongs to the CRM routing layer: the provider switch, its adapters or its native functions",
    });
  }

  const fn = edgeFunctionOf(path);
  if (fn !== null) {
    // The function's name is evidence, not a token: tokens are what the TEXT
    // says, and this is a fact about where the file sits.
    readings.push({
      species: "edge_function",
      tokens: [],
      evidence: `is source of the edge function ${fn}, which each deployment declares and deploys for itself`,
    });
  }

  if (isMigrationPath(path)) {
    readings.push({
      species: "migration",
      tokens: [],
      evidence:
        "is a schema migration, applied by each deployment's own pipeline to its own database",
    });
  }

  if (text !== null) {
    // Gated on the authority's own reach: the router and every test are
    // outside the rule, so they are not this species at all rather than a
    // species some membrane happens to admit. A channel cannot re-open what
    // was never closed, so stating it here is what keeps the two in step.
    const routed = routingRuleReaches(path) ? routedCrmTokensIn(text) : [];
    if (routed.length > 0) {
      readings.push({
        species: "routed_crm_name",
        tokens: routed,
        evidence: `spells ${routed.length} routed CRM name(s) outside the routing table: ${routed.join(", ")}`,
      });
    }

    const seen = new Set<string>();
    for (const rx of PROJECT_REF_SHAPES) {
      rx.lastIndex = 0;
      for (const m of text.matchAll(rx)) seen.add(m[1]);
    }
    for (const ref of knownRefsIn(text, args.knownRefs ?? [])) seen.add(ref);
    const refs = [...seen].sort();
    if (refs.length > 0) {
      readings.push({
        species: "backend_ref",
        tokens: refs,
        evidence: `names ${refs.length} Supabase project ref(s)`,
      });
    }

    const hosting = new Set<string>();
    for (const rx of HOSTING_REF_SHAPES) {
      rx.lastIndex = 0;
      for (const m of text.matchAll(rx)) hosting.add(m[1]);
    }
    const hostingIds = [...hosting].sort();
    if (hostingIds.length > 0) {
      readings.push({
        species: "hosting_ref",
        tokens: hostingIds,
        evidence: `names ${hostingIds.length} hosting project/team id(s)`,
      });
    }
  }

  return readings;
}

/** Convenience: did `classify` find this species? */
export function readingFor(
  readings: readonly IonReading[],
  species: IonSpeciesName,
): IonReading | null {
  return readings.find((r) => r.species === species) ?? null;
}
