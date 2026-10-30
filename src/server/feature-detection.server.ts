/**
 * Feature-first module detection.
 *
 * The route-first strategy gives one module per route file. On the prime that
 * produced 187 modules whose import closures overlapped ~4x — every page
 * dragged in most of `src/`, so the same file was claimed by four modules on
 * average and only 73% of files had a single owner. Installing two modules on a
 * clone meant pushing the same files twice, and no module described a coherent
 * product area.
 *
 * This strategy partitions the repo instead of slicing it:
 *
 *   1. Derive a domain vocabulary from the repo's own directory names and
 *      edge-function slug prefixes — so frontend and backend agree on what a
 *      "finance-portal" is.
 *   2. Assign each route to a domain, preferring the page's *name* over its
 *      directory (`src/pages/admin/FinancePortalAdmin.tsx` is finance-portal
 *      work filed under an admin route bucket, not an "admin" feature).
 *   3. Give every file exactly one owner. Files reachable from a single domain
 *      belong to it; files shared across domains form `platform-core`.
 *   4. Compact each owner's file list back into directory globs, so a module
 *      reads like something a person would have written by hand.
 *
 * The result is a disjoint cover: overlap factor 1.00, every file owned once.
 *
 * Pure and synchronous — the caller supplies import resolution, so this is
 * unit-testable without network or database access.
 */

// ─── Vocabulary ──────────────────────────────────────────────────────

/** Directory names that are shared infrastructure, never a product domain. */
export const INFRA_DIRS = new Set([
  "ui",
  "shared",
  "common",
  "layout",
  "charts",
  "debug",
  "__tests__",
  "hooks",
  "utils",
  "types",
]);

/**
 * Directories that group by *route*, not by feature. Pages inside them belong
 * to whatever domain their filename names.
 */
export const ROUTING_BUCKET_DIRS = new Set(["admin", "pages", "routes"]);

/**
 * Whether a file is a test, which is never a route and never a domain.
 *
 * The prime keeps specs beside its pages (`src/pages/__tests__/…`,
 * `src/pages/admin/BcSegmentEngineAdmin.security.test.ts`), and route
 * discovery read them as routes. Measured on 29 Oct 2026 at prime@8312990:
 * they became two modules (`-tests-` and
 * `bc-segment-engine-admin.security.test`), and every page a spec imports was
 * reached from two domains, so it was filed as shared, in platform-core. The
 * Builder Portal, Cloudflare Management and the public Compliance Passport
 * were, and the library follow archived `builder-portal` and
 * `cloudflare-management` as though they had left the prime.
 */
export function isTestFile(path: string): boolean {
  if (/(^|\/)(__tests__|__mocks__)\//.test(path)) return true;
  const name = path.slice(path.lastIndexOf("/") + 1);
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(name);
}

/**
 * Paths that always belong to `platform-core`, whatever the reachability graph
 * says. A design-system button used by exactly one page today is still shared
 * infrastructure, and handing it to that page's module would make the next
 * consumer's install silently depend on an unrelated module.
 */
export const FORCED_CORE_PREFIXES = [
  "src/components/ui/",
  "src/components/shared/",
  "src/components/common/",
  "src/components/layout/",
  "src/integrations/",
  "src/lib/utils",
  "src/lib/security/",
];

export const PLATFORM_CORE_SLUG = "platform-core";

/**
 * Domain names that are acronyms. Module names are operator-facing catalogue
 * entries, and "Aml Case Management" reads like a typo where "AML" does not.
 */
const ACRONYMS = new Set([
  "aml",
  "kyc",
  "ctf",
  "pdf",
  "qa",
  "api",
  "crm",
  "ghl",
  "abs",
  "cdr",
  "ai",
  "url",
  "sql",
  "seo",
  "bc",
  "id",
]);

/** camelCase / PascalCase / snake → kebab, extension stripped. */
export function toKebab(name: string): string {
  return name
    .replace(/\.(tsx|ts|jsx|js)$/, "")
    .replace(/[_\s]+/g, "-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

export type DomainVocabulary = {
  /** Terms, longest first, so compound domains beat their own prefixes. */
  terms: string[];
  match: (text: string) => string | null;
};

/**
 * Build the domain vocabulary from the repository itself rather than a
 * hardcoded list, so it tracks the repo as it grows.
 *
 * Sources:
 *   - `src/components/<d>/`, `src/lib/<d>/`, `src/pages/<d>/` directory names
 *   - edge-function slug prefixes shared by `minPrefixCount`+ functions, which
 *     is what surfaces compound domains like `finance-portal` / `client-portal`
 */
export function buildDomainVocabulary(args: {
  files: string[];
  edgeFunctionSlugs?: string[];
  minPrefixCount?: number;
}): DomainVocabulary {
  const { files, edgeFunctionSlugs = [], minPrefixCount = 3 } = args;
  const vocab = new Set<string>();

  const dirRx = [
    /^src\/components\/([A-Za-z0-9_-]+)\//,
    /^src\/lib\/([A-Za-z0-9_-]+)\//,
    /^src\/pages\/([A-Za-z0-9_-]+)\//,
    /^src\/features\/([A-Za-z0-9_-]+)\//,
  ];
  for (const f of files) {
    for (const rx of dirRx) {
      const m = rx.exec(f);
      if (!m) continue;
      if (INFRA_DIRS.has(m[1]) || ROUTING_BUCKET_DIRS.has(m[1])) continue;
      vocab.add(toKebab(m[1]));
    }
  }

  const prefixCount = new Map<string, number>();
  for (const slug of edgeFunctionSlugs) {
    const parts = slug.split("-");
    // Only prefixes, never the whole slug — `aml-cases` must not become a domain.
    for (let n = 1; n <= Math.min(2, parts.length - 1); n++) {
      const p = parts.slice(0, n).join("-");
      prefixCount.set(p, (prefixCount.get(p) ?? 0) + 1);
    }
  }
  for (const [p, n] of prefixCount) {
    if (n >= minPrefixCount && !INFRA_DIRS.has(p)) vocab.add(p);
  }

  const terms = [...vocab].sort((a, b) => b.length - a.length || a.localeCompare(b));

  return {
    terms,
    match(text: string): string | null {
      for (const v of terms) {
        if (text === v || text.startsWith(v + "-")) return v;
      }
      return null;
    },
  };
}

/**
 * Collapse `x` and `x-portal` onto the portal spelling when both appear. The
 * prime has `src/pages/solicitor/` alongside `src/components/solicitor-portal/`
 * for one product area; without this they become two half-modules.
 */
export function canonicalDomain(domain: string, known: ReadonlySet<string>): string {
  if (!domain.endsWith("-portal") && known.has(domain + "-portal")) return domain + "-portal";
  return domain;
}

// ─── Route → domain ──────────────────────────────────────────────────

export function routeDomainOf(routeFile: string, vocab: DomainVocabulary): string {
  const base = routeFile.split("/").pop() ?? "";
  const name = toKebab(base);

  // 1. The filename usually names the feature.
  const byName = vocab.match(name);
  if (byName) return byName;

  // 2. Otherwise a genuine (non-routing) parent directory.
  const sub = /^src\/(?:pages|routes|features)\/([A-Za-z0-9_-]+)\//.exec(routeFile);
  if (sub && !ROUTING_BUCKET_DIRS.has(sub[1])) return toKebab(sub[1]);

  // 3. Failing both, the page stands alone as its own small module.
  return name || "page";
}

// ─── Glob compaction ─────────────────────────────────────────────────

/**
 * Turn an owned file list back into the smallest readable glob set: any
 * directory whose entire contents are owned collapses to `dir/**`, and only
 * leftovers stay as literal paths.
 *
 * `allFiles` must be the full repo file list — a directory only collapses when
 * *every* file in it is owned, otherwise the glob would over-claim.
 */
export function compactToGlobs(ownedPaths: string[], allFiles: string[]): string[] {
  const owned = new Set(ownedPaths);
  if (owned.size === 0) return [];

  const byDir = new Map<string, string[]>();
  for (const f of allFiles) {
    let idx = f.lastIndexOf("/");
    while (idx > 0) {
      const d = f.slice(0, idx);
      const l = byDir.get(d) ?? [];
      l.push(f);
      byDir.set(d, l);
      idx = d.lastIndexOf("/");
    }
  }

  // Shortest (shallowest) first, so a parent collapses before its children.
  const dirs = [...byDir.keys()].sort((a, b) => a.length - b.length || a.localeCompare(b));

  const globs: string[] = [];
  const claimedDirs: string[] = [];
  const covered = new Set<string>();

  for (const d of dirs) {
    const contents = byDir.get(d)!;
    if (contents.length < 2) continue;
    if (!contents.every((f) => owned.has(f))) continue;
    // Skip if an ancestor already collapsed.
    if (claimedDirs.some((c) => d === c || d.startsWith(c + "/"))) continue;
    globs.push(`${d}/**`);
    claimedDirs.push(d);
    for (const f of contents) covered.add(f);
  }

  for (const p of ownedPaths) if (!covered.has(p)) globs.push(p);

  return globs.sort();
}

// ─── Partition ───────────────────────────────────────────────────────

export type FeatureModule = {
  slug: string;
  name: string;
  description: string;
  /** Route files that anchor this domain (empty for platform-core). */
  routes: string[];
  routePaths: string[];
  entryFile: string;
  /** Every file this module exclusively owns. */
  resolvedFiles: string[];
  /** Compacted globs covering exactly those files. */
  fileGlobs: string[];
  layer: "frontend" | "shared";
};

export type PartitionStats = {
  domains: number;
  filesPartitioned: number;
  /** Total claims / distinct files. 1.00 means a perfect disjoint cover. */
  overlapFactor: number;
  platformCoreFiles: number;
  globCount: number;
  pathCount: number;
};

/**
 * Partition the frontend into disjoint feature modules.
 *
 * `importsOf` must return resolved repo-relative paths for a file's imports;
 * the caller owns extension/alias resolution because the detection engine
 * already does that work while tracing routes.
 */
export function buildFeatureModules(args: {
  files: string[];
  routeFiles: string[];
  edgeFunctionSlugs?: string[];
  importsOf: (file: string) => string[];
  /** Prefix that marks application source. Defaults to `src/`. */
  sourcePrefix?: string;
  routePathOf?: (file: string) => string;
  nameOf?: (slug: string) => string;
}): { modules: FeatureModule[]; stats: PartitionStats; vocabulary: string[] } {
  const {
    files,
    routeFiles,
    edgeFunctionSlugs = [],
    importsOf,
    sourcePrefix = "src/",
    routePathOf,
    nameOf,
  } = args;

  // Domains are anchored on routes. With none there is nothing to partition —
  // emitting a lone platform-core holding the design system would be noise.
  if (routeFiles.length === 0) {
    return {
      modules: [],
      stats: {
        domains: 0,
        filesPartitioned: 0,
        overlapFactor: 0,
        platformCoreFiles: 0,
        globCount: 0,
        pathCount: 0,
      },
      vocabulary: [],
    };
  }

  const vocab = buildDomainVocabulary({ files, edgeFunctionSlugs });

  // ── Route → domain, then canonicalise aliases ──
  const rawDomains = new Set(routeFiles.map((rf) => routeDomainOf(rf, vocab)));
  const byDomain = new Map<string, string[]>();
  for (const rf of routeFiles) {
    const d = canonicalDomain(routeDomainOf(rf, vocab), rawDomains);
    const l = byDomain.get(d) ?? [];
    l.push(rf);
    byDomain.set(d, l);
  }

  // ── Directories a domain owns by name ──
  const dirs = new Set<string>();
  for (const f of files) {
    if (!f.startsWith(sourcePrefix)) continue;
    const i = f.lastIndexOf("/");
    if (i > 0) dirs.add(f.slice(0, i));
  }
  const dirOwner = new Map<string, string>();
  for (const d of dirs) {
    // Join the path below `src/<top>/` so `src/components/finance-portal`
    // and `src/lib/finance-portal` both resolve to finance-portal.
    const seg = d.split("/").slice(2).join("-");
    if (!seg) continue;
    const raw = vocab.match(toKebab(seg));
    if (!raw) continue;
    const owner = canonicalDomain(raw, rawDomains);
    if (byDomain.has(owner)) dirOwner.set(d, owner);
  }

  // ── Reachability closure per domain ──
  const closureOf = (roots: string[]): Set<string> => {
    const seen = new Set<string>();
    const queue = [...roots];
    while (queue.length > 0) {
      const f = queue.shift()!;
      if (seen.has(f)) continue;
      seen.add(f);
      for (const t of importsOf(f)) if (!seen.has(t)) queue.push(t);
    }
    return seen;
  };

  const reachedBy = new Map<string, Set<string>>();
  for (const [d, roots] of byDomain) {
    for (const f of closureOf(roots)) {
      const s = reachedBy.get(f) ?? new Set<string>();
      s.add(d);
      reachedBy.set(f, s);
    }
  }

  // ── Exactly one owner per file ──
  //
  // Iterate the whole source tree, not just files the import walk reached. A
  // directory that belongs to a domain owns *all* of its contents, including
  // files nothing currently imports (tests, dead code, lazily-wired screens).
  // Skipping those would leave holes that stop the directory collapsing to a
  // single `dir/**` glob, and would file them as orphans instead.
  const owner = new Map<string, string>();
  for (const f of files) {
    if (!f.startsWith(sourcePrefix)) continue;
    const slash = f.lastIndexOf("/");
    if (slash < 0) continue;

    if (FORCED_CORE_PREFIXES.some((p) => f.startsWith(p))) {
      owner.set(f, PLATFORM_CORE_SLUG);
      continue;
    }

    const byDir = dirOwner.get(f.slice(0, slash));
    if (byDir) {
      owner.set(f, byDir);
      continue;
    }

    const ds = reachedBy.get(f);
    if (!ds) continue; // unreachable and in no domain directory — a true orphan
    owner.set(f, ds.size === 1 ? [...ds][0] : PLATFORM_CORE_SLUG);
  }

  const ownedBy = new Map<string, string[]>();
  for (const [f, d] of owner) {
    const l = ownedBy.get(d) ?? [];
    l.push(f);
    ownedBy.set(d, l);
  }

  // ── Emit modules ──
  const titleCase = (slug: string) =>
    slug
      .split("-")
      .map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
      .join(" ");

  const modules: FeatureModule[] = [];
  let pathCount = 0;
  let globCount = 0;

  for (const [slug, ownedFiles] of [...ownedBy.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const routes = (byDomain.get(slug) ?? []).sort();
    const sortedFiles = [...ownedFiles].sort();
    const globs = compactToGlobs(sortedFiles, files);
    pathCount += sortedFiles.length;
    globCount += globs.length;

    const isCore = slug === PLATFORM_CORE_SLUG;
    const routePaths = routePathOf ? routes.map(routePathOf) : [];

    modules.push({
      slug,
      name: nameOf ? nameOf(slug) : isCore ? "Platform Core" : titleCase(slug),
      description: isCore
        ? `Shared infrastructure used by more than one feature — design system, integrations, and cross-cutting utilities. ${sortedFiles.length} files.`
        : `${titleCase(slug)} feature module — ${routes.length} route(s) and the ${sortedFiles.length} files it exclusively owns.`,
      routes,
      routePaths,
      entryFile: routes[0] ?? sortedFiles[0] ?? sourcePrefix,
      resolvedFiles: sortedFiles,
      fileGlobs: globs,
      layer: isCore ? "shared" : "frontend",
    });
  }

  const claims = pathCount;
  const distinct = owner.size;

  return {
    modules,
    stats: {
      domains: byDomain.size,
      filesPartitioned: distinct,
      overlapFactor: distinct === 0 ? 0 : Math.round((claims / distinct) * 100) / 100,
      platformCoreFiles: ownedBy.get(PLATFORM_CORE_SLUG)?.length ?? 0,
      globCount,
      pathCount,
    },
    vocabulary: vocab.terms,
  };
}
