/**
 * `supabase/config.toml` is one file carrying two different kinds of fact, and
 * excluding it whole loses one of them.
 *
 * ## What the exclusion is for, and what it costs
 *
 * The file is `protected` in `DEFAULT_MIRROR_EXCLUSIONS` because its first line
 * names the Supabase project this deployment talks to. Writing prime's copy
 * over a clone's would point the clone at the prime's database — the failure
 * `src/integrations/supabase/env.ts` already caused once, where the deployed
 * dashboard served the prime's production data and signing in authenticated
 * against real staff accounts. That exclusion is correct and stays.
 *
 * The cost is that the rest of the file is frozen for ever, and the rest of the
 * file is 435 `[functions.X] verify_jwt = …` declarations, which are facts
 * about the REPOSITORY rather than about the deployment. A clone forked in
 * September never learns about a function prime added in November — and an
 * omitted `[functions.X]` block is not "no opinion": the Supabase CLI reads it
 * as `verify_jwt = true`, so the gateway starts demanding a Supabase JWT in
 * front of a function the prime declares open.
 *
 * Measured 9 Sep 2026 against prime's 435 declarations:
 *
 *   npc-test-76b3b3          425 declared, 10 missing
 *   preflight-property-group 423 declared, 12 missing
 *
 * and four of those are `verify_jwt = false` on prime — `abs-regional-service`
 * and `planning-data-service` on both, plus `builder-stock-link-callback` and
 * `mission-control-gate` on preflight. A callback endpoint an external service
 * posts to, gated behind a JWT that caller has no way to present, answers 401
 * for ever. It is also why the `security` job cannot pass: the cascaded
 * `SECURITY_INVENTORY.json` records `config_declared_function_count: 435`, the
 * clone regenerates it from its own frozen file and writes 425, and CI diffs
 * the two.
 *
 * ## The whole difference is one line, and that was measured
 *
 * Strip every `[functions.*]` block from both files and diff what is left:
 * 50 non-blank lines each, and **one** differing line.
 *
 *     -project_id = "umrtusxohxjxzodxorim"
 *     +project_id = "dduzbchuswwbefdunfct"
 *
 * Everything else is local-development configuration — ports 54321-54329,
 * `http://127.0.0.1:3000`, `realtime-dev` — identical on both sides because it
 * describes a developer's machine rather than a deployment.
 *
 * So the reconcile is not a merge of two evolving files. It is prime's file
 * with one line put back, and that carries the function declarations, the
 * exposed `[api] schemas` list, the storage limit and anything prime adds
 * later, without a per-key policy anybody has to maintain.
 *
 * ## Refusing is the default
 *
 * Every rule below returns a refusal rather than a best guess, because the
 * thing being written is the file that decides which database a deployment
 * talks to. The load-bearing one is the last: the result is READ BACK and must
 * name the clone's own project and nothing else. That check does not trust the
 * substitution it just performed — it asks the output.
 *
 * `backendRefsIn` is deliberately not the reader here. It matches a project URL
 * and a JWT `ref` claim, which is right for a shipped `.ts` file and blind to a
 * bare TOML assignment; reusing it would have produced an assertion that always
 * passed. It is still applied as a second, independent check, so a project URL
 * appearing in this file in future is caught by one of the two.
 */

import { backendRefsIn } from "./syncExclusions.pure";

/** The one path this module has an opinion about. */
export const CONFIG_TOML_PATH = "supabase/config.toml";

export type ConfigTomlReconcile =
  | {
      ok: true;
      /** Prime's file with the clone's own `project_id` line put back. */
      merged: string;
      /** The project this file will still name after the write. */
      ownRef: string;
      /** False when the clone's copy already equals the reconciled result. */
      changed: boolean;
    }
  | { ok: false; reason: string };

/**
 * The `project_id` assignment, as a whole line, from a config.toml.
 *
 * Only the PREAMBLE is searched — everything before the first `[section]`
 * header. `project_id` is a top-level key, and a same-named key inside some
 * future `[table]` would be a different setting entirely; reading it as this
 * one is how a parser that is nearly right writes the wrong database name.
 */
function projectIdLine(toml: string): { line: string; value: string } | null {
  const found: { line: string; value: string }[] = [];
  for (const line of toml.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const m = /^\s*project_id\s*=\s*"([^"]*)"\s*$/.exec(line);
    if (m) found.push({ line, value: m[1] });
  }
  // Two assignments means the last one wins in TOML and the file is ambiguous
  // to a reader. Refuse rather than pick.
  return found.length === 1 ? found[0] : null;
}

/** A Supabase project ref is exactly twenty lowercase letters. */
function isProjectRef(value: string): boolean {
  return /^[a-z]{20}$/.test(value);
}

/**
 * Compose the config.toml this clone should hold.
 *
 * `ownRef` is the project this clone is REGISTERED against, from
 * `clone_backends_safe`, or null where no backend has been provisioned. It is
 * a cross-check and never the value written: the file is the authority on what
 * it currently says, and a reconcile that silently repointed a deployment
 * because a registry row disagreed would be the exact accident this module
 * exists to prevent.
 */
export function reconcileConfigToml(args: {
  primeToml: string;
  cloneToml: string;
  ownRef: string | null;
}): ConfigTomlReconcile {
  const { primeToml, cloneToml, ownRef } = args;

  const primeId = projectIdLine(primeToml);
  const cloneId = projectIdLine(cloneToml);

  if (!primeId) {
    return {
      ok: false,
      reason:
        "the prime's config.toml does not carry exactly one top-level `project_id`, so there is " +
        "nothing to substitute and no way to tell which project the result would name",
    };
  }
  if (!cloneId) {
    return {
      ok: false,
      reason:
        "this clone's config.toml does not carry exactly one top-level `project_id`, so the value " +
        "that must survive the write cannot be read from it",
    };
  }
  if (!isProjectRef(cloneId.value)) {
    return {
      ok: false,
      reason:
        `this clone's config.toml names \`${cloneId.value}\`, which is not a Supabase project ` +
        `ref (twenty lowercase letters). Refusing to carry a value nobody can recognise`,
    };
  }
  if (ownRef !== null && ownRef !== cloneId.value) {
    return {
      ok: false,
      reason:
        `this clone's config.toml names project \`${cloneId.value}\` while its registered backend ` +
        `is \`${ownRef}\`. The file and the registry disagree, and a reconcile must not decide ` +
        `which of them is right`,
    };
  }

  // Prime's file, with the clone's own line put back exactly as the clone
  // wrote it — its spacing and quoting survive, because the only thing being
  // carried across is prime's content everywhere else.
  const merged = primeToml.replace(primeId.line, cloneId.line);

  // Read the result back. Not "did the replace work" — what does the output
  // actually say.
  const after = projectIdLine(merged);
  if (!after || after.value !== cloneId.value) {
    return {
      ok: false,
      reason:
        "the reconciled file does not name this clone's own project. The substitution did not " +
        "take, and writing it would point this deployment at another tenant's database",
    };
  }
  const foreign = backendRefsIn(merged).filter((r) => r !== cloneId.value);
  if (foreign.length > 0) {
    return {
      ok: false,
      reason:
        `the reconciled file names Supabase project(s) ${foreign.join(", ")} besides this ` +
        `clone's own. config.toml has never carried a project URL or an anon key; something ` +
        `new is in it and it needs a person`,
    };
  }

  return { ok: true, merged, ownRef: cloneId.value, changed: merged !== cloneToml };
}

/**
 * How many `[functions.X]` blocks a config.toml declares.
 *
 * Reported on the pull request so the change is legible as what it is — "436
 * function declarations, was 425" — rather than as an opaque write to the one
 * file an operator has been told is never written. It is also the number the
 * `security` job's `config_declared_function_count` compares.
 */
export function declaredFunctionCount(toml: string): number {
  return (toml.match(/^\[functions\.[^\]]+\]\s*$/gm) ?? []).length;
}
