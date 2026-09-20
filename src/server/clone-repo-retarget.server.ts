/**
 * Take the prime out of a freshly created clone repository.
 *
 * A clone repo is a `createFork` / `createUsingTemplate` byte copy, so three
 * artefacts arrive still naming the PRIME's Supabase project:
 *
 *   - `supabase/config.toml`'s `project_id`, which `rotate-internal-edge-secret`
 *     and the daily `aml-sanctions-refresh` both read to resolve their target;
 *   - `${{ vars.SUPABASE_PROJECT_REF || '<prime ref>' }}` in the deploy and
 *     apply-migration workflows — and the deploy workflow runs on every push
 *     to `main`;
 *   - `supabase/.temp/linked-project.json`, checked in, from which any bare
 *     `supabase …` command resolves whatever `config.toml` says.
 *
 * Nothing rewrote any of them. What stopped a clone acting on the prime was
 * that `SUPABASE_ACCESS_TOKEN` is never pushed to a clone repo — protection by
 * absent credential, not by correct configuration. Adding that token, which is
 * the obvious step to let a clone deploy its own functions, was by itself
 * enough to point its deploys and migrations at the prime's production.
 *
 * There is no safe default for "which project": an unset variable is a
 * question, not a licence to guess. So the workflows are rewritten to fail
 * closed and the ref is supplied as a repository VARIABLE instead.
 *
 * ## A fourth artefact, on a different axis (20 Sep 2026)
 *
 * `.github/dependabot.yml` arrives the same way and is wrong for the same
 * shape of reason — not because it names the prime's PROJECT, but because it
 * describes the prime's DEPENDENCY GRAPH, which a clone does not own.
 *
 * `package.json` and `package-lock.json` are `REPOSITORY_INVARIANTS`: the
 * cascade delivers the prime's copies to every clone. Measured on `origin/main`
 * that day, all five deployments carried the byte-identical pair — package.json
 * `4d399496`, package-lock.json `f3d3bd4c`. So a clone cannot act on a
 * dependency finding at all: merging a bump there puts its lockfile ahead of
 * the prime's and the next cascade delivers the prime's back over it. The
 * upgrade appears to land and then silently un-lands.
 *
 * The config was nonetheless running on every clone, on the prime's own weekly
 * schedule and `open-pull-requests-limit: 5` — measured that day at **18 open
 * PRs across four clones**, none of which could ever merge. It is not even
 * written for them: its `ignore` list is a set of judgements about this
 * repository's evidence ("both this repository and its client-facing mirror had
 * `main` broken by exactly this").
 *
 * It arrives in the clone's "Initial commit" — `createUsingTemplate` is a whole
 * -tree copy, so provisioning is the only place that can decline it. Deleted
 * rather than emptied: a config that exists says somebody decided what it
 * should contain, and the decision here is that this repository has no say in
 * its own dependencies.
 */

import { getAppOctokit } from "./github-app.server";

export const CONFIG_TOML_PATH = "supabase/config.toml";
export const LINKED_PROJECT_PATH = "supabase/.temp/linked-project.json";
/**
 * The prime's Dependabot config. Removed from a clone rather than rewritten —
 * see the note in this module's header.
 */
export const DEPENDABOT_CONFIG_PATH = ".github/dependabot.yml";
/**
 * The files that carry this deployment's Supabase PAIR — a project URL and the
 * anon key whose `ref` claim names the same project.
 *
 * A fifth artefact, and the one that reaches a customer. Measured 20 Sep 2026
 * across three clones: all three shipped the PRIME's URL and anon key here,
 * byte-identical, from their first commit.
 *
 *   - `public/lead-magnet-embed.html` is served verbatim from the clone's own
 *     domain and posts to `/functions/v1/request-lead-magnet`. Every name,
 *     email and phone number it captured went into the PRIME's database.
 *   - `src/integrations/supabase/env.ts` holds the built-in fallback the app
 *     uses when `VITE_SUPABASE_URL` is unset — the ordinary state of a new
 *     deployment — so an unconfigured build serves the prime's production.
 *   - `.env.example` documents both as though they were the clone's own.
 *
 * There is no safe default for whose database this is, which is the same rule
 * the workflows above answer to.
 *
 * The pair moves TOGETHER and is never half-written. A URL from one project
 * with a key from another authenticates to nothing, so a rewrite carrying only
 * one of them would replace a wrong-but-working deployment with a broken one.
 */
export const SHIPPED_BACKEND_PAIR_PATHS = [
  "public/lead-magnet-embed.html",
  ".env.example",
] as const;

/**
 * The module that declares the built-in fallback pair — DISCOVERED, never named.
 *
 * `src/integrations/supabase/env.ts` used to sit in the list above, as a
 * literal. It is not where the pair lives everywhere: `npc-crm-independent`
 * has already split the reads out into `supabaseTarget.pure.ts`, because a
 * Vite config cannot import `env.ts`. On that layout the named path is simply
 * ABSENT — and `absent` does not fail a retarget, so provisioning would have
 * reported `ok` over a clone whose app still booted against the prime.
 *
 * That is this programme's own defect committed inside its fixer: a check
 * that names one file passes by finding nothing when the file moves. The
 * guard shipped to the clones answers to the same rule and searches both
 * layouts; so does this.
 *
 * Ordered newest-first, and the module that actually DECLARES the pair is the
 * one rewritten — a repository mid-split can hold both, and the one to correct
 * is the one the app reads rather than the one that still exists.
 */
export const RESOLVER_MODULE_CANDIDATES = [
  "src/integrations/supabase/supabaseTarget.pure.ts",
  "src/integrations/supabase/env.ts",
] as const;

/** Whether a module declares the built-in fallback pair at all. */
export function declaresFallbackPair(text: string): boolean {
  return /FALLBACK_URL\s*=\s*['"`]/.test(text);
}

/**
 * The guard that keeps this step honest after provisioning has finished.
 *
 * Retargeting sets the values once. Nothing re-checks them: a later cascade,
 * a hand edit or a template refresh can put another deployment's project back
 * into any of these files, and every surface would look healthy — which is
 * exactly the state all three clones were in on 20 Sep 2026, shipping the
 * prime's pair from their own domains since their first commit.
 *
 * So a correctly retargeted clone is not finished; a correctly retargeted
 * clone that CHECKS ITSELF is. The spec arrives in the byte copy because the
 * prime carries it, and it is deployment-agnostic by construction (it reads
 * its own ref out of `supabase/config.toml`), so it needs no rewrite here —
 * only confirmation that it arrived and that something runs it.
 *
 * Both halves are asked, because either alone is worthless: the spec was
 * present and wired to nothing on all three clones for the first hour of its
 * life, and a workflow naming a spec that does not exist fails loudly rather
 * than quietly only because `passWithNoTests` is unset.
 */
export const IDENTITY_GUARD_SPEC_PATH = "src/lib/__tests__/shippedBackendIdentity.spec.ts";
export const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";

/** Whether CI actually invokes the guard, by the path it would have to name. */
export function ciRunsIdentityGuard(yaml: string): boolean {
  return yaml.includes(IDENTITY_GUARD_SPEC_PATH);
}

/**
 * The secret scan's config, which has to learn the clone's key in the same pass.
 *
 * `.gitleaks.toml` allows the anon key as ONE LITERAL — deliberately, so that a
 * rotated key, another project's key or a `service_role` key all still fail.
 * The literal it arrives carrying is the PRIME's, under a header calling it
 * "THIS project".
 *
 * So retargeting the pair above WITHOUT this one hands every new clone a
 * repository whose first pull request fails its own secret scan: the embed now
 * carries a key the allowlist does not name. Measured — that is exactly what
 * happened when these files were fixed by hand on 20 Sep 2026.
 *
 * The clone's key is APPENDED rather than written over the prime's, because
 * the prime's literal is still load-bearing: it appears in the applied
 * migrations a clone inherits, which cannot be edited without breaking replay.
 */
export const GITLEAKS_CONFIG_PATH = ".gitleaks.toml";

export const RETARGET_WORKFLOWS = [
  ".github/workflows/deploy-supabase-functions.yml",
  ".github/workflows/apply-migration.yml",
] as const;

// ─── Pure rewrites (unit-tested) ─────────────────────────────────────

/**
 * Point `project_id` at the clone. Only the first assignment is touched —
 * `config.toml` also carries a `[functions.*]` block per edge function, and a
 * blanket replace would corrupt them.
 */
export function rewriteConfigTomlProjectId(toml: string, cloneRef: string): string {
  return toml.replace(/^(\s*project_id\s*=\s*)"[^"]*"/m, `$1"${cloneRef}"`);
}

/** Whether the file still names a project other than the clone's. */
export function configTomlNamesForeignProject(toml: string, cloneRef: string): boolean {
  const m = /^\s*project_id\s*=\s*"([^"]*)"/m.exec(toml);
  return !!m && m[1] !== cloneRef;
}

/**
 * Strip the hard-coded fallback so an unset variable stops the job.
 *
 * Matches `${{ vars.SUPABASE_PROJECT_REF || 'anything' }}` and leaves
 * `${{ vars.SUPABASE_PROJECT_REF }}`. Deliberately does NOT substitute the
 * clone's ref: the ref belongs in a repository variable, where it can be
 * changed without a commit, and a second hard-coded default is the same bug
 * with a different value.
 */
export function stripWorkflowProjectRefDefault(yaml: string): string {
  return yaml.replace(
    /\$\{\{\s*vars\.SUPABASE_PROJECT_REF\s*\|\|\s*'[^']*'\s*\}\}/g,
    "${{ vars.SUPABASE_PROJECT_REF }}",
  );
}

/** True when a workflow would still fall back to a hard-coded project. */
export function workflowHasProjectRefDefault(yaml: string): boolean {
  return /\$\{\{\s*vars\.SUPABASE_PROJECT_REF\s*\|\|\s*'[^']*'\s*\}\}/.test(yaml);
}

/**
 * A Supabase JWT's `ref` claim, or null when the string is not one.
 *
 * This is what decides WHICH tokens to rewrite. A blanket "replace anything
 * JWT-shaped" would rewrite an unrelated token that happens to share the file;
 * only a token naming a Supabase project is backend identity.
 */
export function supabaseRefOfJwt(token: string): string | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8",
    );
    const ref = (JSON.parse(json) as { ref?: unknown }).ref;
    return typeof ref === "string" ? ref : null;
  } catch {
    return null;
  }
}

const SUPABASE_URL_RE = /https:\/\/([a-z0-9]{16,})\.supabase\.(co|in|net)/g;
const SUPABASE_JWT_RE = /\bey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

/**
 * Point a shipped file's Supabase pair at the clone.
 *
 * Every project URL becomes the clone's, and every token that decodes to a
 * Supabase `ref` becomes the clone's anon key. A token that is not a Supabase
 * JWT is left exactly as it is.
 */
export function rewriteBackendPair(text: string, cloneRef: string, cloneAnonKey: string): string {
  return text
    .replace(SUPABASE_URL_RE, (whole, ref: string) =>
      ref === cloneRef ? whole : `https://${cloneRef}.supabase.co`,
    )
    .replace(SUPABASE_JWT_RE, (token) => {
      const ref = supabaseRefOfJwt(token);
      return ref === null || ref === cloneRef ? token : cloneAnonKey;
    });
}

/** Whether a shipped file still names a project other than the clone's. */
export function backendPairNamesForeignProject(text: string, cloneRef: string): boolean {
  for (const [, ref] of text.matchAll(SUPABASE_URL_RE)) if (ref !== cloneRef) return true;
  for (const [token] of text.matchAll(SUPABASE_JWT_RE)) {
    const ref = supabaseRefOfJwt(token);
    if (ref !== null && ref !== cloneRef) return true;
  }
  return false;
}

/** Whether the scan config already names this key as allowed. */
export function gitleaksAllowsKey(toml: string, cloneAnonKey: string): boolean {
  return toml.includes(cloneAnonKey);
}

/**
 * Teach the secret scan this deployment's own anon key.
 *
 * Appended rather than substituted: appending cannot corrupt the blocks
 * already there, where an in-place rewrite of a TOML array can, and the
 * prime's literal has to stay for the inherited migrations.
 *
 * Idempotent — a config that already names the key is returned unchanged, so
 * re-running provisioning does not stack duplicate blocks.
 */
export function appendOwnKeyAllowlist(
  toml: string,
  cloneRef: string,
  cloneAnonKey: string,
): string {
  if (gitleaksAllowsKey(toml, cloneAnonKey)) return toml;
  const description =
    `This deployment's own Supabase anon (publishable) key, for project ${cloneRef}. ` +
    "Written by provisioning: the config arrives from the prime naming the PRIME's key as " +
    "this project's own, which would fail this repository's first pull request the moment a " +
    "shipped file carried its own. An anon key is publishable and every row it reaches is " +
    "decided by RLS; it is allowed as ONE literal, so a rotated key, another project's key " +
    "or a service_role key all still fail.";
  const q = "'''";
  const block = [
    "",
    "[[allowlists]]",
    `description = ${JSON.stringify(description)}`,
    "regexes = [",
    `  ${q}${cloneAnonKey}${q},`,
    "]",
    "",
  ].join("\n");
  return `${toml.replace(/\s*$/, "")}\n${block}`;
}

// ─── Applying it ─────────────────────────────────────────────────────

export type RetargetAction = {
  target: string;
  status: "rewritten" | "deleted" | "unchanged" | "absent" | "failed";
  detail?: string;
};

export type RetargetResult = {
  ok: boolean;
  actions: RetargetAction[];
};

type RepoRef = { owner: string; repo: string; branch?: string };

/**
 * Re-point a clone repository at its own backend.
 *
 * Every step is independent and non-fatal: a repository that lacks one of
 * these files is not broken, and a partial result is more useful than an
 * abort. The caller decides what an incomplete retarget means.
 */
export async function retargetCloneRepo(
  ref: RepoRef,
  cloneProjectRef: string,
  /**
   * The clone's own anon (publishable) key. Optional only so that a caller
   * which genuinely has not minted one yet still retargets the four artefacts
   * that need no key — the shipped pair is then reported as `failed` rather
   * than silently skipped, because a clone shipping another tenant's key is
   * not a partial success.
   */
  cloneAnonKey?: string,
): Promise<RetargetResult> {
  const octokit = getAppOctokit();
  const actions: RetargetAction[] = [];
  const branch = ref.branch;

  const readFile = async (path: string): Promise<{ text: string; sha: string } | null> => {
    try {
      const res = await octokit.repos.getContent({
        owner: ref.owner,
        repo: ref.repo,
        path,
        ...(branch ? { ref: branch } : {}),
      });
      const data = res.data as { type?: string; sha?: string; content?: string };
      if (data.type !== "file" || !data.sha || typeof data.content !== "string") return null;
      return { text: Buffer.from(data.content, "base64").toString("utf8"), sha: data.sha };
    } catch (e) {
      if ((e as { status?: number })?.status === 404) return null;
      throw e;
    }
  };

  const writeFile = async (path: string, text: string, sha: string, message: string) => {
    await octokit.repos.createOrUpdateFileContents({
      owner: ref.owner,
      repo: ref.repo,
      path,
      ...(branch ? { branch } : {}),
      message,
      content: Buffer.from(text, "utf8").toString("base64"),
      sha,
    });
  };

  // 1. The repository variable. Done FIRST: with the fallbacks stripped and no
  //    variable set, the workflows would fail — correct, but noisier than
  //    necessary if the variable arrives moments later.
  try {
    await octokit.request("POST /repos/{owner}/{repo}/actions/variables", {
      owner: ref.owner,
      repo: ref.repo,
      name: "SUPABASE_PROJECT_REF",
      value: cloneProjectRef,
    });
    actions.push({
      target: "vars.SUPABASE_PROJECT_REF",
      status: "rewritten",
      detail: cloneProjectRef,
    });
  } catch (e) {
    // 409 = already exists; update it instead.
    if ((e as { status?: number })?.status === 409) {
      try {
        await octokit.request("PATCH /repos/{owner}/{repo}/actions/variables/{name}", {
          owner: ref.owner,
          repo: ref.repo,
          name: "SUPABASE_PROJECT_REF",
          value: cloneProjectRef,
        });
        actions.push({
          target: "vars.SUPABASE_PROJECT_REF",
          status: "rewritten",
          detail: cloneProjectRef,
        });
      } catch (e2) {
        actions.push({
          target: "vars.SUPABASE_PROJECT_REF",
          status: "failed",
          detail: e2 instanceof Error ? e2.message : String(e2),
        });
      }
    } else {
      actions.push({
        target: "vars.SUPABASE_PROJECT_REF",
        status: "failed",
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // 2. config.toml
  try {
    const f = await readFile(CONFIG_TOML_PATH);
    if (!f) {
      actions.push({ target: CONFIG_TOML_PATH, status: "absent" });
    } else if (!configTomlNamesForeignProject(f.text, cloneProjectRef)) {
      actions.push({ target: CONFIG_TOML_PATH, status: "unchanged" });
    } else {
      await writeFile(
        CONFIG_TOML_PATH,
        rewriteConfigTomlProjectId(f.text, cloneProjectRef),
        f.sha,
        "chore(aurixa): point supabase/config.toml at this deployment's own project",
      );
      actions.push({ target: CONFIG_TOML_PATH, status: "rewritten", detail: cloneProjectRef });
    }
  } catch (e) {
    actions.push({
      target: CONFIG_TOML_PATH,
      status: "failed",
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // 3. The workflows' hard-coded fallbacks
  for (const path of RETARGET_WORKFLOWS) {
    try {
      const f = await readFile(path);
      if (!f) {
        actions.push({ target: path, status: "absent" });
        continue;
      }
      if (!workflowHasProjectRefDefault(f.text)) {
        actions.push({ target: path, status: "unchanged" });
        continue;
      }
      await writeFile(
        path,
        stripWorkflowProjectRefDefault(f.text),
        f.sha,
        "chore(aurixa): fail closed when SUPABASE_PROJECT_REF is unset",
      );
      actions.push({ target: path, status: "rewritten" });
    } catch (e) {
      actions.push({
        target: path,
        status: "failed",
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // 4. The CLI's own link file, which outranks config.toml for a bare
  //    `supabase` command and is checked in naming the prime.
  try {
    const f = await readFile(LINKED_PROJECT_PATH);
    if (!f) {
      actions.push({ target: LINKED_PROJECT_PATH, status: "absent" });
    } else {
      await octokit.repos.deleteFile({
        owner: ref.owner,
        repo: ref.repo,
        path: LINKED_PROJECT_PATH,
        ...(branch ? { branch } : {}),
        message: "chore(aurixa): drop the checked-in CLI link to another project",
        sha: f.sha,
      });
      actions.push({ target: LINKED_PROJECT_PATH, status: "deleted" });
    }
  } catch (e) {
    actions.push({
      target: LINKED_PROJECT_PATH,
      status: "failed",
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // 5. The prime's Dependabot config, which describes a dependency graph this
  //    repository does not own — package.json and package-lock.json are
  //    cascaded repository invariants, so nothing merged here can survive.
  try {
    const f = await readFile(DEPENDABOT_CONFIG_PATH);
    if (!f) {
      actions.push({ target: DEPENDABOT_CONFIG_PATH, status: "absent" });
    } else {
      await octokit.repos.deleteFile({
        owner: ref.owner,
        repo: ref.repo,
        path: DEPENDABOT_CONFIG_PATH,
        ...(branch ? { branch } : {}),
        message:
          "chore(aurixa): drop the prime's Dependabot config\n\n" +
          "package.json and package-lock.json are cascaded from the prime, so a " +
          "bump merged here is reverted by the next cascade. The upgrade that " +
          "reaches this deployment is the one merged on the prime.",
        sha: f.sha,
      });
      actions.push({ target: DEPENDABOT_CONFIG_PATH, status: "deleted" });
    }
  } catch (e) {
    actions.push({
      target: DEPENDABOT_CONFIG_PATH,
      status: "failed",
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // 6. The shipped Supabase pair — the artefact that reaches a customer.
  //
  //    Each file is independent, and each is written only when it still names
  //    somewhere else: a clone provisioned twice, or one whose pair was
  //    already corrected by hand, records `unchanged` rather than churning a
  //    commit.
  //
  //    Skipped entirely, and said so, when no anon key was supplied. The pair
  //    is never half-written — a URL from one project with a key from another
  //    authenticates to nothing, so a partial rewrite would turn a deployment
  //    that works against the wrong database into one that works against none.
  if (!cloneAnonKey) {
    for (const path of [...SHIPPED_BACKEND_PAIR_PATHS, RESOLVER_MODULE_CANDIDATES.join(" | ")]) {
      actions.push({
        target: path,
        status: "failed",
        detail:
          "No anon key was supplied, and the pair is never half-written. This file still names another project's backend.",
      });
    }
  } else {
    for (const path of SHIPPED_BACKEND_PAIR_PATHS) {
      try {
        const f = await readFile(path);
        if (!f) {
          actions.push({ target: path, status: "absent" });
          continue;
        }
        if (!backendPairNamesForeignProject(f.text, cloneProjectRef)) {
          actions.push({ target: path, status: "unchanged" });
          continue;
        }
        const next = rewriteBackendPair(f.text, cloneProjectRef, cloneAnonKey);
        await writeFile(
          path,
          next,
          f.sha,
          `chore(aurixa): point ${path} at this deployment's own Supabase project`,
        );
        actions.push({ target: path, status: "rewritten", detail: cloneProjectRef });
      } catch (e) {
        actions.push({
          target: path,
          status: "failed",
          detail: e instanceof Error ? e.message : String(e),
        });
      }
    }

    //    The declaring module, found rather than named. A candidate that does
    //    not exist is not an error — one layout or the other is expected — but
    //    NONE of them declaring the pair is, because the fallback is then
    //    somewhere this step cannot see and the clone keeps whatever it
    //    inherited.
    try {
      let resolved: { path: string; text: string; sha: string } | null = null;
      for (const candidate of RESOLVER_MODULE_CANDIDATES) {
        const f = await readFile(candidate);
        if (f && declaresFallbackPair(f.text)) {
          resolved = { path: candidate, text: f.text, sha: f.sha };
          break;
        }
      }
      if (!resolved) {
        actions.push({
          target: RESOLVER_MODULE_CANDIDATES.join(" | "),
          status: "failed",
          detail:
            "No module declares FALLBACK_URL, so the built-in pair was not rewritten and this deployment still falls back to whichever project it inherited.",
        });
      } else if (!backendPairNamesForeignProject(resolved.text, cloneProjectRef)) {
        actions.push({ target: resolved.path, status: "unchanged" });
      } else {
        await writeFile(
          resolved.path,
          rewriteBackendPair(resolved.text, cloneProjectRef, cloneAnonKey),
          resolved.sha,
          `chore(aurixa): point ${resolved.path} at this deployment's own Supabase project`,
        );
        actions.push({ target: resolved.path, status: "rewritten", detail: cloneProjectRef });
      }
    } catch (e) {
      actions.push({
        target: RESOLVER_MODULE_CANDIDATES.join(" | "),
        status: "failed",
        detail: e instanceof Error ? e.message : String(e),
      });
    }

    // 7. The secret scan, which must learn the key step 6 just wrote.
    //
    //    Last, deliberately. If this fails the repository is left with a scan
    //    that refuses its own key — loud, and visible on the first pull
    //    request — which is a better failure than a scan quietly allowing a
    //    key nothing has written yet.
    try {
      const f = await readFile(GITLEAKS_CONFIG_PATH);
      if (!f) {
        actions.push({ target: GITLEAKS_CONFIG_PATH, status: "absent" });
      } else if (gitleaksAllowsKey(f.text, cloneAnonKey)) {
        actions.push({ target: GITLEAKS_CONFIG_PATH, status: "unchanged" });
      } else {
        await writeFile(
          GITLEAKS_CONFIG_PATH,
          appendOwnKeyAllowlist(f.text, cloneProjectRef, cloneAnonKey),
          f.sha,
          "chore(aurixa): allow this deployment's own Supabase anon key in the secret scan",
        );
        actions.push({
          target: GITLEAKS_CONFIG_PATH,
          status: "rewritten",
          detail: cloneProjectRef,
        });
      }
    } catch (e) {
      actions.push({
        target: GITLEAKS_CONFIG_PATH,
        status: "failed",
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // 8. The guard that will keep step 6 true after this run is over.
  //
  //    Nothing above re-checks itself. A cascade, a template refresh or a hand
  //    edit can put another deployment's project back into any of those files,
  //    and every surface would still read as healthy — which is the state all
  //    three existing clones were in, shipping the prime's pair from their own
  //    domains since their first commit.
  //
  //    This writes nothing. The spec is deployment-agnostic (it reads its own
  //    ref out of `supabase/config.toml`) and arrives in the byte copy because
  //    the prime carries it, so there is nothing here to rewrite — only to
  //    confirm, and to say so loudly when it is missing.
  //
  //    Both halves are asked because either alone is worth nothing: a spec
  //    nothing invokes cannot fail, and a workflow naming a spec that is not
  //    there is only loud because `passWithNoTests` is unset.
  try {
    const spec = await readFile(IDENTITY_GUARD_SPEC_PATH);
    const ci = await readFile(CI_WORKFLOW_PATH);
    if (!spec) {
      actions.push({
        target: IDENTITY_GUARD_SPEC_PATH,
        status: "failed",
        detail:
          "This deployment carries no guard over its own backend identity, so nothing will notice if the pair written above is replaced.",
      });
    } else if (!ci) {
      actions.push({
        target: CI_WORKFLOW_PATH,
        status: "failed",
        detail: "No CI workflow, so the backend-identity guard is never run.",
      });
    } else if (!ciRunsIdentityGuard(ci.text)) {
      actions.push({
        target: CI_WORKFLOW_PATH,
        status: "failed",
        detail: `The guard exists but no step names ${IDENTITY_GUARD_SPEC_PATH}, so it never runs. A test nothing invokes cannot fail.`,
      });
    } else {
      actions.push({
        target: IDENTITY_GUARD_SPEC_PATH,
        status: "unchanged",
        detail: "present and run by CI",
      });
    }
  } catch (e) {
    actions.push({
      target: IDENTITY_GUARD_SPEC_PATH,
      status: "failed",
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  return { ok: actions.every((a) => a.status !== "failed"), actions };
}
