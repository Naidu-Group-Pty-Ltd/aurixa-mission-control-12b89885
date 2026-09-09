/**
 * `.github/workflows/deploy-supabase-functions.yml` — the second file whose
 * exclusion froze it, and the one that made it visible.
 *
 * ## What the exclusion was for, and what it cost
 *
 * The path is `protected` in `DEFAULT_MIRROR_EXCLUSIONS` with the note "Fail-
 * closed guard against deploying into the wrong project", and that was exactly
 * right for the file it was written about. That file said
 *
 *     PROJECT_REF: ${{ vars.SUPABASE_PROJECT_REF || '<the prime's ref>' }}
 *
 * twice, so prime's copy landing on a clone would, the moment that clone
 * acquired a deploy token of its own, deploy the CLONE's edge functions into
 * the PRIME's production on every push to main.
 *
 * The cost was the same shape as `config.toml`'s: the exclusion is whole-file,
 * so it also froze every improvement to the other 500 lines. Measured 9 Sep
 * 2026:
 *
 *   npc-property-dashbord     25 failures in its last 100 runs
 *   npc-test-76b3b3            9 failures in 9 runs
 *   preflight-property-group   8 failures in 8 runs
 *   npc-client-dashboard       0 since 2 Sep — 19 consecutive clean runs
 *
 * The two 100%-failing clones were forked BEFORE the change that stands the
 * check down where Mission Control deploys (prime, 1 Sep 15:47 UTC; npc-test
 * forked 04:39 the same morning, preflight two days earlier). The exclusion
 * meant they could never receive it. Mission Control had meanwhile set
 * `BACKEND_DEPLOYED_BY=mission-control` on both — its own reconcile cron
 * recorded the write on 2 Sep 14:29 — and their workflow had no line that
 * reads it. A declaration maintained faithfully against a file that had never
 * heard of it.
 *
 * ## Why this one is simpler than config.toml
 *
 * `config.toml` will always carry `project_id`, so its reconcile is prime's
 * file with one line put back. This file no longer carries a deploy target at
 * all: the workflow resolves it at run time from the `SUPABASE_PROJECT_REF`
 * repository variable and, failing that, from the repository's OWN
 * `supabase/config.toml`. So there is nothing to substitute, and the reconcile
 * is a carry — but only once the assertions below hold.
 *
 * ## What is asserted, and why these things
 *
 * The guarantee that makes carrying safe is narrow and worth stating exactly:
 * **nothing in the file may name a Supabase project except in a position that
 * cannot select a deploy target.** There is one such position, the
 * `BUILTIN_ORIGIN_PROJECT` line, which pairs a built-in CORS origin to the one
 * deployment that origin belongs to — the same rule `turnstileSiteKey.ts`
 * applies to a site key. It is read to decide whether a DEFAULT ORIGIN may be
 * used, never to decide where anything is sent.
 *
 * So the assertions are structural rather than a diff of two texts: any
 * twenty-lowercase-letter token that is not on that line is a refusal, a
 * default standing in for an IDENTITY is a refusal wherever it appears, and
 * the resolution step must still be present and still read
 * `supabase/config.toml`.
 * A future edit that reintroduces the hazard is held and named instead of
 * being carried to every clone in the fleet.
 *
 * `backendRefsIn` is applied as a second, independent check for a project URL
 * or a JWT `ref` claim — shapes a bare YAML scalar does not have, so it is
 * blind to what the rule above catches and catches what that one cannot.
 */

import { backendRefsIn } from "./syncExclusions.pure";

/** The one path this module has an opinion about. */
export const DEPLOY_WORKFLOW_PATH = ".github/workflows/deploy-supabase-functions.yml";

/**
 * The key whose value is allowed to be a project ref, because reading it
 * cannot send anything anywhere.
 */
export const PAIRED_ORIGIN_PROJECT_KEY = "BUILTIN_ORIGIN_PROJECT";

export type DeployWorkflowReconcile =
  | {
      ok: true;
      /** Prime's file, carried whole. */
      merged: string;
      /** False when the clone's copy already equals it. */
      changed: boolean;
      /** True when the clone's copy still carries a hard-coded deploy target. */
      cloneWasHazardous: boolean;
    }
  | { ok: false; reason: string };

/** A Supabase project ref is exactly twenty lowercase letters. */
const PROJECT_REF = /(?<![A-Za-z0-9_-])[a-z]{20}(?![A-Za-z0-9_-])/g;

/**
 * `${{ vars.X || 'literal' }}` where the literal STANDS IN FOR AN IDENTITY.
 *
 * A default is not a fallback when the thing being defaulted is which database
 * a deployment talks to, and this shape is refused wherever it appears rather
 * than only on the two lines it appeared on last time.
 *
 * It is deliberately not "any defaulted variable". The first version of this
 * rule was, and it flagged `${{ vars.CORS_VERIFY_ORIGIN || '<an origin>' }}`
 * on a clone that had no project hazard at all — measured on
 * npc-client-dashboard, whose file names no project ref anywhere. A guard that
 * cannot tell a harmless default from an identity one produces refusals nobody
 * can act on, and refusals nobody can act on are how a guard gets removed.
 *
 * So it fires on exactly two things: a default whose value is a project ref,
 * and any default on `SUPABASE_PROJECT_REF` whatever the value.
 */
const IDENTITY_DEFAULT =
  /\$\{\{\s*vars\.(SUPABASE_PROJECT_REF\s*\|\|\s*'[^']*'|[A-Za-z0-9_]+\s*\|\|\s*'[a-z]{20}')\s*\}\}/;

/**
 * Every line naming a project ref that is NOT the paired-origin declaration.
 *
 * The comparison is by LINE rather than by offset because the reason a ref is
 * acceptable is entirely about which key it sits under, and a line is the
 * smallest thing that carries that.
 */
function foreignRefLines(yaml: string): string[] {
  const offending: string[] = [];
  for (const raw of yaml.split(/\r?\n/)) {
    const line = raw.trim();
    // A comment can quote a ref while telling the story of why one must not be
    // here — which this file's own header does. It sends nothing anywhere.
    if (line.startsWith("#")) continue;
    if (line.startsWith(`${PAIRED_ORIGIN_PROJECT_KEY}:`)) continue;
    PROJECT_REF.lastIndex = 0;
    if (PROJECT_REF.test(line)) offending.push(line);
  }
  return offending;
}

/** Does this copy still resolve its project the way the current file does? */
function resolvesItsOwnProject(yaml: string): boolean {
  return (
    /^\s*id:\s*project\s*$/m.test(yaml) &&
    yaml.includes("supabase/config.toml") &&
    yaml.includes("steps.project.outputs.ref")
  );
}

/**
 * Compose the deploy workflow this clone should hold.
 *
 * Refusing is the default, and every refusal names what it saw. The file being
 * carried decides where a repository's code is SENT, so "probably fine" is not
 * a state this module has.
 */
export function reconcileDeployWorkflow(args: {
  primeYaml: string;
  cloneYaml: string;
  /** The project this clone is registered against, or null when unprovisioned. */
  ownRef: string | null;
}): DeployWorkflowReconcile {
  const { primeYaml, cloneYaml, ownRef } = args;

  if (!resolvesItsOwnProject(primeYaml)) {
    return {
      ok: false,
      reason:
        "prime's deploy workflow no longer resolves its project from `supabase/config.toml` " +
        "through a `project` step, so there is no way to tell what a clone running it would " +
        "deploy to. Refusing to carry it",
    };
  }

  if (IDENTITY_DEFAULT.test(primeYaml)) {
    return {
      ok: false,
      reason:
        "prime's deploy workflow defaults a project identity — `${{ vars.SUPABASE_PROJECT_REF " +
        "|| '…' }}`, or a default whose value is a project ref. A default is not a fallback " +
        "when the thing defaulted is which project a deployment talks to; that exact shape is " +
        "what made a clone deploy into the prime's production",
    };
  }

  const foreign = foreignRefLines(primeYaml);
  if (foreign.length > 0) {
    return {
      ok: false,
      reason:
        `prime's deploy workflow names a Supabase project outside the ` +
        `\`${PAIRED_ORIGIN_PROJECT_KEY}\` declaration, on: ${foreign.slice(0, 3).join(" / ")}` +
        `${foreign.length > 3 ? ` (and ${foreign.length - 3} more)` : ""}. Only a ref that ` +
        `cannot select a deploy target may travel`,
    };
  }

  // Read the result back. Not "did the carry work" — what does the output
  // actually say. Trivially the same text here, and asserted anyway, because
  // the day this stops being a straight carry is the day that matters.
  const merged = primeYaml;
  if (foreignRefLines(merged).length > 0 || IDENTITY_DEFAULT.test(merged)) {
    return {
      ok: false,
      reason:
        "the reconciled deploy workflow names a project it must not, or defaults one. Writing " +
        "it would let this deployment's automation act on another deployment's project",
    };
  }

  const refs = backendRefsIn(merged).filter((r) => r !== ownRef);
  if (refs.length > 0) {
    return {
      ok: false,
      reason:
        `the reconciled deploy workflow names Supabase project(s) ${refs.join(", ")} by URL or ` +
        `key. This file has never carried either; something new is in it and it needs a person`,
    };
  }

  return {
    ok: true,
    merged,
    changed: merged !== cloneYaml,
    // Worth saying out loud on the pull request: the copy being replaced could
    // have sent this repository's functions somewhere else.
    cloneWasHazardous: IDENTITY_DEFAULT.test(cloneYaml) || foreignRefLines(cloneYaml).length > 0,
  };
}

/**
 * Whether a copy stands the check down where Mission Control deploys.
 *
 * Reported on the pull request so the change is legible as what it is — the
 * clone gaining the branch that reads a variable Mission Control has been
 * setting on it for a week — rather than as an opaque write to a file an
 * operator has been told is never written.
 */
export function readsDeployerDeclaration(yaml: string): boolean {
  return yaml.includes("BACKEND_DEPLOYED_BY");
}
