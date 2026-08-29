/**
 * Prime backend architecture snapshot.
 *
 * Reads the prime repo's `supabase/` directory straight from GitHub (via the
 * Aurixa GitHub App) and turns it into a replicable snapshot:
 *
 *   - migrations  → every supabase/migrations/*.sql, in chronological order
 *   - functions   → every supabase/functions/<slug>/ bundle (plus _shared files)
 *   - secretNames → every Deno.env.get("X") referenced by an edge function,
 *                   minus the SUPABASE_* values the platform injects itself
 *
 * The snapshot carries schema + code only — never data and never secret
 * values. Secret names become empty shells on the clone project.
 */
import type { Octokit } from "@octokit/rest";
import type { RepoRef } from "./github-app.server";

// ─── Types ───────────────────────────────────────────────────────────

export type PrimeMigration = {
  /** Leading timestamp of the filename, e.g. "20260419215311" */
  id: string;
  /** Full filename, e.g. "20260419215311_init.sql" */
  name: string;
  /** Repo path, e.g. "supabase/migrations/20260419215311_init.sql" */
  path: string;
  sql: string;
};

export type PrimeMigrationMeta = Omit<PrimeMigration, "sql">;

export type PrimeFunctionFile = {
  /** Path relative to supabase/functions/, e.g. "my-fn/index.ts" or "_shared/cors.ts" */
  path: string;
  /** Raw bytes, base64-encoded (functions may contain non-utf8 assets) */
  contentBase64: string;
};

export type PrimeEdgeFunction = {
  slug: string;
  /** Function's own files plus any _shared/ and root import-map files */
  files: PrimeFunctionFile[];
  /** Entrypoint path relative to supabase/functions/, e.g. "my-fn/index.ts" */
  entrypointPath: string;
  /** Import map path relative to supabase/functions/, if one exists */
  importMapPath: string | null;
  verifyJwt: boolean;
};

export type PrimeAuthConfig = {
  site_url?: string;
  uri_allow_list?: string; // comma-separated (Management API shape)
  jwt_exp?: number; // seconds
  disable_signup?: boolean;
  external_anonymous_users_enabled?: boolean;
  password_min_length?: number;
};

export type PrimeBackendSnapshot = {
  /** "owner/repo" the snapshot was taken from */
  sourceRepo: string;
  /** Branch name */
  sourceRef: string;
  /** Commit SHA the snapshot was taken at */
  sourceSha: string;
  migrations: PrimeMigration[];
  functions: PrimeEdgeFunction[];
  /** Secret names referenced by edge functions — values are never read */
  secretNames: string[];
  /** Auth policy replicated from the prime's supabase/config.toml [auth] block.
   *  Values-only, never secrets — providers/keys are configured per-clone. */
  authConfig: PrimeAuthConfig | null;
};

// ─── Pure helpers (unit-tested) ──────────────────────────────────────

const MIGRATIONS_PREFIX = "supabase/migrations/";
const FUNCTIONS_PREFIX = "supabase/functions/";
const CONFIG_TOML_PATH = "supabase/config.toml";

/** Names Supabase injects into every edge function runtime — never shell these. */
const AUTO_INJECTED_SECRETS = new Set([
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_DB_URL",
]);

/** Files that must never travel with a function bundle. */
const EXCLUDED_FUNCTION_FILES = [/(^|\/)\.env(\..*)?$/, /(^|\/)\.DS_Store$/, /(^|\/)\.gitignore$/];

const TEXT_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|toml|sql|txt|md|html|css)$/i;

export function migrationIdFromFilename(filename: string): string | null {
  const m = /^(\d{8,14})_/.exec(filename) ?? /^(\d{8,14})\.sql$/.exec(filename);
  return m ? m[1] : null;
}

export function isExcludedFunctionFile(relPath: string): boolean {
  return EXCLUDED_FUNCTION_FILES.some((rx) => rx.test(relPath));
}

export function isTextFile(path: string): boolean {
  return TEXT_EXTENSIONS.test(path);
}

/**
 * Group blob paths under supabase/functions/ into per-slug bundles.
 * Returns the function slugs (directories) and the shared/root files that
 * ship with every bundle (`_shared/**`, root import_map.json / deno.json*).
 */
export function groupFunctionPaths(relPaths: string[]): {
  slugs: Map<string, string[]>;
  sharedFiles: string[];
  importMapPath: string | null;
} {
  const slugs = new Map<string, string[]>();
  const sharedFiles: string[] = [];
  let importMapPath: string | null = null;

  for (const rel of relPaths) {
    if (isExcludedFunctionFile(rel)) continue;
    const slash = rel.indexOf("/");
    if (slash === -1) {
      // Root-level file next to the function dirs
      if (/^(import_map\.json|deno\.jsonc?)$/.test(rel)) {
        sharedFiles.push(rel);
        if (rel === "import_map.json") importMapPath = rel;
      }
      continue;
    }
    const top = rel.slice(0, slash);
    if (top === "_shared") {
      sharedFiles.push(rel);
      continue;
    }
    const list = slugs.get(top) ?? [];
    list.push(rel);
    slugs.set(top, list);
  }

  return { slugs, sharedFiles, importMapPath };
}

/** Pick the entrypoint for a function bundle (paths relative to supabase/functions/). */
export function pickEntrypoint(slug: string, files: string[]): string | null {
  const candidates = [
    `${slug}/index.ts`,
    `${slug}/index.tsx`,
    `${slug}/index.js`,
    `${slug}/main.ts`,
  ];
  for (const c of candidates) {
    if (files.includes(c)) return c;
  }
  // Fall back to the first top-level .ts/.js file in the function dir
  const fallback = files.find(
    (f) =>
      f.startsWith(`${slug}/`) &&
      /\.(ts|tsx|js|mjs)$/.test(f) &&
      !f.slice(slug.length + 1).includes("/"),
  );
  return fallback ?? null;
}

/**
 * Minimal config.toml reader: per-function `verify_jwt` flags from
 * `[functions.<slug>]` sections. Anything unspecified defaults to true,
 * matching the Supabase CLI default.
 */
export function parseFunctionConfig(toml: string | null): Map<string, { verifyJwt: boolean }> {
  const out = new Map<string, { verifyJwt: boolean }>();
  if (!toml) return out;
  const sectionRx = /\[functions\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]([^[]*)/g;
  let m: RegExpExecArray | null;
  while ((m = sectionRx.exec(toml)) !== null) {
    const slug = m[1] ?? m[2];
    const body = m[3] ?? "";
    const vj = /(^|\n)\s*verify_jwt\s*=\s*(true|false)/.exec(body);
    out.set(slug, { verifyJwt: vj ? vj[2] === "true" : true });
  }
  return out;
}

/**
 * Extract the `[auth]` block from supabase/config.toml as a Management-API
 * shaped patch. Only whitelisted, non-secret fields are surfaced — provider
 * secrets and OAuth client credentials NEVER travel through the snapshot.
 * Returns null when config.toml is missing or has no [auth] section.
 */
export function parseAuthConfig(toml: string | null): PrimeAuthConfig | null {
  if (!toml) return null;
  // Grab the [auth] section body up to the next top-level [section].
  const m = /(^|\n)\[auth\]\s*\n([\s\S]*?)(?=\n\[[A-Za-z_][^\]]*\]|$)/.exec(toml);
  if (!m) return null;
  const body = m[2];
  const out: PrimeAuthConfig = {};
  const readStr = (key: string): string | undefined => {
    const rx = new RegExp(`(^|\\n)\\s*${key}\\s*=\\s*"([^"]*)"`);
    return rx.exec(body)?.[2];
  };
  const readNum = (key: string): number | undefined => {
    const rx = new RegExp(`(^|\\n)\\s*${key}\\s*=\\s*(\\d+)`);
    const v = rx.exec(body)?.[2];
    return v ? Number(v) : undefined;
  };
  const readBool = (key: string): boolean | undefined => {
    const rx = new RegExp(`(^|\\n)\\s*${key}\\s*=\\s*(true|false)`);
    const v = rx.exec(body)?.[2];
    return v ? v === "true" : undefined;
  };
  const readArr = (key: string): string[] | undefined => {
    const rx = new RegExp(`(^|\\n)\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`);
    const v = rx.exec(body)?.[2];
    if (v === undefined) return undefined;
    return v
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  };

  const siteUrl = readStr("site_url");
  if (siteUrl) out.site_url = siteUrl;
  const redirects = readArr("additional_redirect_urls");
  if (redirects && redirects.length) out.uri_allow_list = redirects.join(",");
  const jwtExpiry = readNum("jwt_expiry");
  if (jwtExpiry !== undefined) out.jwt_exp = jwtExpiry;
  const enableSignup = readBool("enable_signup");
  if (enableSignup !== undefined) out.disable_signup = !enableSignup;
  const enableAnon = readBool("enable_anonymous_sign_ins");
  if (enableAnon !== undefined) out.external_anonymous_users_enabled = enableAnon;
  const minPw = readNum("minimum_password_length");
  if (minPw !== undefined) out.password_min_length = minPw;

  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Secrets whose whole value is that ONE deployment holds them.
 *
 * A vendor API key is shared on purpose — that is the forwarded-key billing
 * model. A signing secret is the opposite: `INTERNAL_EDGE_SECRET` is what the
 * prime's cron jobs sign internal function invocations with, so copying it to
 * a clone makes a request signed for either deployment valid on the other, in
 * both directions. `CSRF_TOKEN_PEPPER` has the same shape — tokens become
 * interchangeable across tenants.
 *
 * These were being shelled and inherited like any other name, because they
 * are ordinary `Deno.env.get()` reads and nothing distinguished them.
 */
export const IDENTITY_SECRETS = new Set([
  "INTERNAL_EDGE_SECRET",
  "INTERNAL_EDGE_SECRET_V2",
  "CSRF_TOKEN_PEPPER",
]);

/**
 * Secrets that are deployment CONFIG rather than credentials. Copying them
 * points the clone's own functions at the prime's domain.
 */
export const DEPLOYMENT_CONFIG_SECRETS = new Set([
  "ALLOWED_ORIGINS",
  "CORS_STRICT_ALLOWED_ORIGINS",
  "APP_URL",
  "APP_BASE_URL",
]);

/**
 * Vendor credentials that are nonetheless PER-TENANT, and must therefore be
 * minted for each clone rather than copied from the prime.
 *
 * `TURNSTILE_SECRET_KEY` is the whole reason this class exists. A Turnstile
 * token is bound to a (site key, secret) PAIR, and `siteverify` reports the
 * hostname it was issued for without any caller here checking it. One widget
 * shared across the fleet therefore means a token farmed from ANY tenant's
 * login page — or from the prime's, which is public — verifies on every other
 * tenant, so the CAPTCHA stops being a per-deployment control at all. Sharing
 * it also gives every tenant the same rotation blast radius that
 * `RESEND_API_KEY` already demonstrated here, and forces the prime's widget to
 * carry every customer's hostname on its allow-list.
 *
 * These names are recorded `missing` on a clone no matter what
 * `prime_secret_forwards` says. Adding a forwarding row must not be able to
 * re-share them, which is why this is a classification and not a default.
 */
export const TENANT_SCOPED_SECRETS = new Set(["TURNSTILE_SECRET_KEY"]);

export type SecretClass =
  | "platform"
  | "identity"
  | "deployment_config"
  | "tenant_scoped"
  | "vendor";

/**
 * How a shelled secret should reach a clone. The three non-vendor classes are
 * the ones a naive copy gets wrong.
 */
export function classifySecret(name: string): SecretClass {
  if (AUTO_INJECTED_SECRETS.has(name) || name.startsWith("SUPABASE_")) return "platform";
  if (IDENTITY_SECRETS.has(name)) return "identity";
  if (DEPLOYMENT_CONFIG_SECRETS.has(name)) return "deployment_config";
  if (TENANT_SCOPED_SECRETS.has(name)) return "tenant_scoped";
  return "vendor";
}

/**
 * Extract secret names referenced by function source code.
 * Matches Deno.env.get("NAME") / .get('NAME') / .get(`NAME`), drops the
 * platform-injected SUPABASE_* values (the secrets API reserves that prefix).
 */
export function extractSecretNames(sources: string[]): string[] {
  const names = new Set<string>();
  const rx = /Deno\s*\.\s*env\s*\.\s*get\s*\(\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\)/g;
  for (const src of sources) {
    let m: RegExpExecArray | null;
    while ((m = rx.exec(src)) !== null) {
      const name = m[1];
      if (AUTO_INJECTED_SECRETS.has(name)) continue;
      if (name.startsWith("SUPABASE_")) continue;
      names.add(name);
    }
  }
  return Array.from(names).sort();
}

export function decodeBase64Utf8(b64: string): string {
  return Buffer.from(b64, "base64").toString("utf8");
}

// ─── GitHub fetching ─────────────────────────────────────────────────

/**
 * `size` is the blob's byte length as GitHub's tree reports it. It is optional
 * because the `getContent` fallback below does not always carry one, and a
 * size we do not know must never be mistaken for a size of zero — the ceiling
 * in `openPrimeMigrationCorpus` treats an unknown size as "fetch and find
 * out" rather than as "safely small".
 */
type TreeBlob = { path: string; sha: string; size?: number };

async function listSupabaseBlobs(
  octokit: Octokit,
  ref: RepoRef,
): Promise<{ blobs: TreeBlob[]; commitSha: string }> {
  const { data: branch } = await octokit.repos.getBranch({
    owner: ref.owner,
    repo: ref.repo,
    branch: ref.branch,
  });
  const commitSha = branch.commit.sha;
  const treeSha = branch.commit.commit.tree.sha;
  const { data: tree } = await octokit.git.getTree({
    owner: ref.owner,
    repo: ref.repo,
    tree_sha: treeSha,
    recursive: "true",
  });

  let blobs = (tree.tree ?? [])
    .filter((n) => n.type === "blob" && typeof n.path === "string" && typeof n.sha === "string")
    .filter((n) => (n.path as string).startsWith("supabase/"))
    .map((n) => ({
      path: n.path as string,
      sha: n.sha as string,
      ...(typeof n.size === "number" ? { size: n.size } : {}),
    }));

  // Very large repos can return a truncated tree; re-list just supabase/ then.
  if (tree.truncated) {
    blobs = await listDirRecursive(octokit, ref, "supabase");
  }

  return { blobs, commitSha };
}

async function listDirRecursive(octokit: Octokit, ref: RepoRef, dir: string): Promise<TreeBlob[]> {
  const out: TreeBlob[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: unknown;
    try {
      const res = await octokit.repos.getContent({
        owner: ref.owner,
        repo: ref.repo,
        path: current,
        ref: ref.branch,
      });
      entries = res.data;
    } catch (e) {
      if ((e as { status?: number })?.status === 404) continue;
      throw e;
    }
    if (!Array.isArray(entries)) continue;
    for (const entry of entries as Array<{
      type: string;
      path: string;
      sha: string;
      size?: number;
    }>) {
      if (entry.type === "dir") stack.push(entry.path);
      else if (entry.type === "file")
        out.push({
          path: entry.path,
          sha: entry.sha,
          ...(typeof entry.size === "number" ? { size: entry.size } : {}),
        });
    }
  }
  return out;
}

async function fetchBlobBase64(octokit: Octokit, ref: RepoRef, sha: string): Promise<string> {
  const { data } = await octokit.git.getBlob({ owner: ref.owner, repo: ref.repo, file_sha: sha });
  // GitHub returns base64 (with newlines) for blobs; normalize.
  return (data.content ?? "").replace(/\n/g, "");
}

/**
 * Minimal shape of the Supabase query builder chain the prime resolvers need.
 *
 * `error` is part of the shape deliberately. PostgREST always returns both
 * halves, and a structural type that names only `data` makes a FAILED read
 * indistinguishable from an ABSENT row at the type level — the caller cannot
 * even see the channel it is supposed to check. That is the same class of
 * defect `scripts/check-discarded-errors.mjs` guards against in call sites.
 */
type PrimeConfigClient = {
  from: (table: string) => {
    select: (cols: string) => {
      limit: (n: number) => {
        maybeSingle: () => PromiseLike<{
          data: Record<string, unknown> | null;
          error?: { message: string } | null;
        }>;
      };
    };
  };
};

/**
 * Resolve the prime repo ref (e.g. npc-property-dashbord) from prime_config.
 * Returns null when the prime hasn't been configured yet.
 *
 * A read that FAILED is not a prime that is ABSENT. Callers turn `null` into
 * "Prime not configured — set the prime repo in Settings first", which sends
 * an operator to a settings page that is already filled in when the real
 * fault was the database being unreachable. The two are separated here: the
 * null contract is unchanged for genuinely-unconfigured, and a failed read
 * throws.
 */
export async function resolvePrimeSource(supabase: PrimeConfigClient): Promise<RepoRef | null> {
  const { data: prime, error } = await supabase
    .from("prime_config")
    .select("*")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Could not read prime_config: ${error.message}`);
  if (!prime?.github_owner || !prime?.github_repo) return null;
  return {
    owner: prime.github_owner as string,
    repo: prime.github_repo as string,
    branch: (prime.default_branch as string) || "main",
  };
}

/**
 * Resolve THIS deployment's own Supabase project ref from `SUPABASE_URL`.
 *
 * Exported so the guards below can name it. This is the ref that must never
 * be used as a replication SOURCE — it is the database holding `clones`,
 * `prime_config` and `cascade_events`.
 */
export function ownProjectRef(): string | null {
  const url = process.env.SUPABASE_URL;
  if (!url) return null;
  const m = /^https?:\/\/([a-z0-9]+)\.supabase\.(co|in|net)/i.exec(url);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Resolve the prime BACKEND's project ref — the Supabase project holding the
 * prime product's live schema.
 *
 * This is a different question from `resolvePrimeSource`, which answers "which
 * GitHub repo". Both were once answered by the same word, and the backend half
 * had no configuration at all: the old `getPrimeProjectRef()` derived a ref
 * from `SUPABASE_URL`, which is THIS deployment's own project. Catalogue
 * introspection is the default clone strategy, so that substitution would
 * replicate Mission Control's admin schema onto a clone instead of the
 * product's, and stamp a ledger of Mission Control migration IDs that no
 * product migration can ever match.
 *
 * Two rules, and both are refusals:
 *
 *   1. **Unset is fatal, never a fallback.** A deployment that has not set
 *      `prime_config.supabase_project_ref` cannot provision a clone backend by
 *      introspection, and must say so. Substituting a ref that happens to be
 *      reachable is how the wrong database got copied in the first place.
 *   2. **Never this deployment's own project.** Even if somebody sets it to
 *      Mission Control's own ref by hand, it is refused here rather than at
 *      the point where 533 tables have already been written.
 */
export async function resolvePrimeBackendRef(supabase: PrimeConfigClient): Promise<string> {
  const { data: prime, error } = await supabase
    .from("prime_config")
    .select("supabase_project_ref")
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not read prime_config to resolve the prime backend: ${error.message}`);
  }
  const ref = (prime as { supabase_project_ref?: string | null } | null)?.supabase_project_ref;
  if (!ref) {
    throw new Error(
      "The prime backend's Supabase project is not configured. Set it in " +
        "Settings → Prime (prime_config.supabase_project_ref) — this is the project " +
        "holding the PRODUCT's schema, not Mission Control's own.",
    );
  }
  const own = ownProjectRef();
  if (own && ref.toLowerCase() === own) {
    throw new Error(
      `prime_config.supabase_project_ref points at this deployment's own project (${ref}). ` +
        "That project holds Mission Control's admin schema — clones, prime_config, " +
        "cascade_events — not the product's. Set it to the prime PRODUCT's project.",
    );
  }
  return ref;
}

function migrationMetasFromBlobs(
  blobs: TreeBlob[],
): Array<PrimeMigrationMeta & { sha: string; size?: number }> {
  return blobs
    .filter((b) => b.path.startsWith(MIGRATIONS_PREFIX) && b.path.endsWith(".sql"))
    .map((b) => {
      const name = b.path.slice(MIGRATIONS_PREFIX.length);
      const id = migrationIdFromFilename(name);
      return id
        ? { id, name, path: b.path, sha: b.sha, ...(b.size === undefined ? {} : { size: b.size }) }
        : null;
    })
    .filter((m): m is PrimeMigrationMeta & { sha: string; size?: number } => m !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Lightweight listing of the prime's migrations — names only, no SQL bodies.
 * Used for pending-migration status displays without pulling file contents.
 */
export async function fetchPrimeMigrationList(
  octokit: Octokit,
  ref: RepoRef,
): Promise<{ migrations: PrimeMigrationMeta[]; sourceSha: string }> {
  const { blobs, commitSha } = await listSupabaseBlobs(octokit, ref);
  const migrations = migrationMetasFromBlobs(blobs).map(({ id, name, path }) => ({
    id,
    name,
    path,
  }));
  return { migrations, sourceSha: commitSha };
}

/**
 * The prime's migrations as METADATA, with bodies fetched on demand.
 *
 * ## Why this exists
 *
 * This replaces `fetchPrimeMigrations`, which materialised every migration
 * body before its caller could look at a single clone. On this prime that is
 * 962 files and 158 MB, four of which are generated template-library seeds of
 * 36-41 MB each — so the fleet sync spent 59.8 s in GitHub round trips and was
 * cut off by pg_net's 60 s timeout having claimed nothing, written nothing,
 * and recorded no audit row. It failed that way on every run, and on the admin
 * button before it: `clone_backends.migration_version` was still null and no
 * `fleet.migrations_synced` row had ever been written.
 *
 * That function is DELETED rather than left for callers that "only need a few"
 * — every one of its three callers believed that, and every one of them
 * downloaded all 158 MB. A dormant eager reader is one import away from
 * putting the 60 s wall back.
 *
 * The corpus is not the expensive part — the BODIES are, and a clone in step
 * with the prime needs none of them. Listing is two API calls (a branch read
 * and one recursive tree); a body costs a round trip only when a clone is
 * actually missing that version. That is what makes the "cheap when the fleet
 * is level" claim true rather than aspirational: a level clone now costs one
 * ledger query and zero blob fetches.
 *
 * ## The ceiling is a refusal, not a truncation
 *
 * A 41 MB migration cannot be applied through the Management API's query
 * endpoint, and decoding four of them at once would exhaust the isolate before
 * the request that carries them is ever built. So an oversized body is refused
 * BY NAME, with its size, rather than being silently skipped — a migration
 * that cannot be delivered has to surface as a blocked clone an operator can
 * see, not as a sync that reports success while the schema drifts.
 *
 * An UNKNOWN size is not a small one. GitHub's `getContent` fallback does not
 * always report one, so a blob with no size is fetched and measured after the
 * fact rather than waved through.
 */
export const MAX_MIGRATION_BYTES = 8 * 1024 * 1024;

export type PrimeMigrationCorpus = {
  /** Every migration the prime declares, ordered by filename. No bodies. */
  metas: ReadonlyArray<PrimeMigrationMeta>;
  /** Commit the listing was taken at. */
  sourceSha: string;
  /**
   * Fetch one migration's SQL. Memoised, so a batch of clones missing the same
   * version pays for it once. Throws — naming the migration and its size — when
   * the body is past `MAX_MIGRATION_BYTES`.
   */
  loadSql: (id: string) => Promise<string>;
};

export async function openPrimeMigrationCorpus(
  octokit: Octokit,
  ref: RepoRef,
  opts?: { maxBytes?: number },
): Promise<PrimeMigrationCorpus> {
  const maxBytes = opts?.maxBytes ?? MAX_MIGRATION_BYTES;
  const { blobs, commitSha } = await listSupabaseBlobs(octokit, ref);
  const entries = migrationMetasFromBlobs(blobs);
  const byId = new Map(entries.map((m) => [m.id, m]));
  const cache = new Map<string, Promise<string>>();

  const loadSql = (id: string): Promise<string> => {
    const hit = cache.get(id);
    if (hit) return hit;
    const meta = byId.get(id);
    if (!meta) {
      return Promise.reject(new Error(`Migration ${id} is not in the prime corpus at ${commitSha}`));
    }
    const pending = (async () => {
      // Refuse before the round trip when the tree already told us the size.
      if (typeof meta.size === "number" && meta.size > maxBytes) {
        throw oversized(meta.name, meta.size, maxBytes);
      }
      const sql = decodeBase64Utf8(await fetchBlobBase64(octokit, ref, meta.sha));
      // And after it when the tree did not.
      const bytes = new TextEncoder().encode(sql).length;
      if (bytes > maxBytes) throw oversized(meta.name, bytes, maxBytes);
      return sql;
    })();
    // A rejected fetch must not be cached as the answer: the next clone in the
    // batch would inherit a failure that may have been transient, and every
    // later run would too.
    pending.catch(() => cache.delete(id));
    cache.set(id, pending);
    return pending;
  };

  return {
    metas: entries.map(({ id, name, path }) => ({ id, name, path })),
    sourceSha: commitSha,
    loadSql,
  };
}

function oversized(name: string, bytes: number, maxBytes: number): Error {
  return new Error(
    `Migration ${name} is ${(bytes / 1_048_576).toFixed(1)} MB, past the ` +
      `${(maxBytes / 1_048_576).toFixed(0)} MB ceiling for a single Management API statement. ` +
      "Apply it to this clone by hand (psql or the SQL editor), record its version in " +
      "supabase_migrations.schema_migrations, then re-run the sync.",
  );
}

/**
 * Full snapshot of the prime repo's Supabase architecture: migration SQL,
 * edge function bundles, and the secret names those functions reference.
 */
export async function fetchPrimeBackendSnapshot(
  octokit: Octokit,
  ref: RepoRef,
): Promise<PrimeBackendSnapshot> {
  const { blobs, commitSha } = await listSupabaseBlobs(octokit, ref);

  // ── Migrations ──
  const migrations: PrimeMigration[] = [];
  for (const meta of migrationMetasFromBlobs(blobs)) {
    const sql = decodeBase64Utf8(await fetchBlobBase64(octokit, ref, meta.sha));
    migrations.push({ id: meta.id, name: meta.name, path: meta.path, sql });
  }

  // ── Edge functions ──
  const functionBlobs = blobs.filter((b) => b.path.startsWith(FUNCTIONS_PREFIX));
  const relPaths = functionBlobs.map((b) => b.path.slice(FUNCTIONS_PREFIX.length));
  const shaByRel = new Map(
    functionBlobs.map((b) => [b.path.slice(FUNCTIONS_PREFIX.length), b.sha]),
  );
  const { slugs, sharedFiles, importMapPath } = groupFunctionPaths(relPaths);

  const configBlob = blobs.find((b) => b.path === CONFIG_TOML_PATH);
  const configToml = configBlob
    ? decodeBase64Utf8(await fetchBlobBase64(octokit, ref, configBlob.sha))
    : null;
  const fnConfig = parseFunctionConfig(configToml);

  // Fetch each needed blob once, keyed by relative path.
  const contentCache = new Map<string, string>();
  const getContent = async (rel: string): Promise<string> => {
    const hit = contentCache.get(rel);
    if (hit !== undefined) return hit;
    const sha = shaByRel.get(rel);
    if (!sha) throw new Error(`Blob not found for ${rel}`);
    const b64 = await fetchBlobBase64(octokit, ref, sha);
    contentCache.set(rel, b64);
    return b64;
  };

  const functions: PrimeEdgeFunction[] = [];
  for (const [slug, ownPaths] of Array.from(slugs.entries()).sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const bundlePaths = [...ownPaths, ...sharedFiles];
    const entrypointPath = pickEntrypoint(slug, bundlePaths);
    if (!entrypointPath) continue; // no runnable entrypoint — not a deployable function
    const files: PrimeFunctionFile[] = [];
    for (const rel of bundlePaths) {
      files.push({ path: rel, contentBase64: await getContent(rel) });
    }
    functions.push({
      slug,
      files,
      entrypointPath,
      importMapPath,
      verifyJwt: fnConfig.get(slug)?.verifyJwt ?? true,
    });
  }

  // ── Secret shells ──
  const textSources: string[] = [];
  for (const fn of functions) {
    for (const f of fn.files) {
      if (isTextFile(f.path)) textSources.push(decodeBase64Utf8(f.contentBase64));
    }
  }
  const secretNames = extractSecretNames(textSources);

  return {
    sourceRepo: `${ref.owner}/${ref.repo}`,
    sourceRef: ref.branch,
    sourceSha: commitSha,
    migrations,
    functions,
    secretNames,
    authConfig: parseAuthConfig(configToml),
  };
}
