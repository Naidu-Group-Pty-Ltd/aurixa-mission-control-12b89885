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
 * ## The reverse direction, which the measurement above could not see
 *
 * Both clones measured on 9 Sep are pure mirrors, so "the whole difference is
 * one line" held and the reconcile could be prime's file with that line put
 * back. `npc-crm-independent` is not a mirror: it owns `crm-calendar`,
 * `crm-inbound-message` and `crm-send-message`, which prime does not have, and
 * all three declare `verify_jwt = false` — one of them is an inbound webhook
 * whose caller has no Supabase JWT to present.
 *
 * Taking prime's file wholesale DROPPED all three blocks. Measured on the open
 * cascade proposal 20 Sep 2026: 416 function directories on the clone, 413
 * declarations in the reconciled file. By the same CLI rule this module was
 * written to honour, that gates three of the clone's own functions closed —
 * the harm named in the section above, pointing the other way.
 *
 * So a block the clone declares and prime does not is the CLONE'S, and it is
 * carried forward. Prime still wins every name the two share, which is the
 * whole point of the reconcile; the clone only keeps what prime has no opinion
 * about. And the composition is READ BACK for it: if any name the clone
 * declared is missing from the result, the reconcile refuses rather than
 * writing a file that silently closes a door.
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
 *
 * ## What the prime declares for itself alone is taken out
 *
 * The prime carries features no clone receives (`primeOnlyFeatures.pure.ts`):
 * twenty-eight GoHighLevel account-migration functions, the owner's decision
 * of 27 Sep 2026. Their directories are held by the write path, so a clone
 * without them would otherwise be handed prime's file declaring twenty-eight
 * functions it does not have — a gateway opinion about nothing, and a count
 * the clone's own ratchet then has to be told about.
 *
 * So `withheld` names the prime-only functions the clone's tree does not hold,
 * and their blocks are removed from prime's file rather than carried. It is
 * the clone's TREE that decides, not the register alone: a clone still holding
 * the feature keeps every declaration exactly as before, and nothing here
 * removes a declaration for a function that is on disk. The read-back holds
 * the other way too — a withheld block that survived the removal (a header
 * this reader did not recognise) is refused rather than written.
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
      /**
       * Names the clone declares that prime has no block for, kept from the
       * clone's own file. Reported on the pull request, because a write to
       * this file has to be legible as what it did.
       */
      carriedForward: string[];
      /**
       * Prime-only functions whose blocks were taken out of prime's file,
       * because this clone does not hold them. Sorted.
       */
      withheldDropped: string[];
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
  /**
   * Prime-only functions this clone's tree does not hold
   * (`withheldPrimeOnlyFunctions`). Their blocks are removed from prime's
   * file, and the clone's own block for one of them is not carried forward.
   * Empty or omitted keeps every declaration, which is what a clone still
   * holding the feature needs.
   */
  withheld?: readonly string[];
}): ConfigTomlReconcile {
  const { primeToml, cloneToml, ownRef } = args;
  const withheld = new Set(args.withheld ?? []);

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
  let merged = primeToml.replace(primeId.line, cloneId.line);

  // Prime's declarations for what this clone does not carry come out, before
  // anything of the clone's is appended — so a withheld name can only be
  // removed from prime's text, never from the clone's own carried blocks.
  const primeNames = new Set(functionBlocksIn(primeToml).map((b) => b.name));
  const withheldDropped = [...withheld].filter((n) => primeNames.has(n)).sort();
  if (withheldDropped.length > 0) merged = dropFunctionBlocks(merged, withheld);

  // Then the clone's own function declarations. Prime wins every name the two
  // share; this is only the set prime has no block for at all — and never a
  // prime-only function the clone does not hold, which it has no directory for.
  const cloneBlocks = functionBlocksIn(cloneToml);
  const cloneOnly = cloneBlocks.filter((b) => !primeNames.has(b.name) && !withheld.has(b.name));
  if (cloneOnly.length > 0) {
    const carried = cloneOnly.map((b) => b.text).join("\n\n");
    merged = `${merged.replace(/\n*$/, "")}\n\n${CLONE_OWNED_MARKER}\n\n${carried}\n`;
  }

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
  // And the second read-back, for the second thing this file decides. A name
  // the clone declared and the result does not is a function whose gate just
  // changed to the CLI's default of `true` — refuse, and let a person see it,
  // rather than write a file that closes a door nobody asked to close. A
  // withheld name is the one exception, and only because this clone holds no
  // directory for it: there is no door.
  const lost = declarationsLostBy(cloneToml, merged).filter((n) => !withheld.has(n));
  if (lost.length > 0) {
    return {
      ok: false,
      reason:
        `the reconciled file drops this clone's own declaration(s) for ${lost.join(", ")}. An ` +
        `omitted \`[functions.X]\` block is read as \`verify_jwt = true\`, so writing it would ` +
        `gate ${lost.length === 1 ? "that function" : "those functions"} behind a JWT their ` +
        `callers may have no way to present`,
    };
  }
  // The third, for the removal. Asked of the output rather than of the
  // removal, and by the LOOSEST reading of a header: `[functions.x] # note`
  // is not a block to `functionBlocksIn`, so the removal leaves it standing,
  // while the clone's own inventory generator counts it. A declaration for a
  // function the clone does not hold is exactly what the removal promised not
  // to write.
  const survived = [...merged.matchAll(/^\s*\[functions\.([^\]\s]+)\]/gm)]
    .map((m) => m[1])
    .filter((n) => withheld.has(n));
  if (survived.length > 0) {
    return {
      ok: false,
      reason:
        `the reconciled file still declares ${[...new Set(survived)].join(", ")}, which this ` +
        `clone does not hold and the prime keeps for itself`,
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

  return {
    ok: true,
    merged,
    ownRef: cloneId.value,
    changed: merged !== cloneToml,
    carriedForward: cloneOnly.map((b) => b.name),
    withheldDropped,
  };
}

/**
 * A config.toml with the named `[functions.X]` blocks taken out.
 *
 * A block here is its header, its keys, and any comment lines directly above
 * the header with no blank line between — a comment written against a
 * function goes with it. Comments after its last key are left alone: they sit
 * above whatever comes next and are read as that section's. One blank line
 * beside the block goes too, the one after it where there is one, so removing
 * a block from a file of blank-separated blocks leaves blank-separated blocks.
 *
 * Measured on prime@387feb03 for the twenty-eight prime-only functions: 101
 * lines removed — 28 headers, 45 keys, 28 blank lines, no comments — and not
 * one line belonging to any other section.
 *
 * The file's trailing newline is kept exactly: it is set aside before the
 * split and put back after, so removing a block that ends the file does not
 * change how the file ends.
 */
export function dropFunctionBlocks(toml: string, names: ReadonlySet<string>): string {
  if (names.size === 0) return toml;
  const endsWithNewline = toml.endsWith("\n");
  const lines = (endsWithNewline ? toml.slice(0, -1) : toml).split("\n");
  const isSection = (line: string) => /^\s*\[/.test(line);
  const isBlank = (line: string) => line.trim() === "";
  const isComment = (line: string) => line.trim().startsWith("#");
  const remove = new Set<number>();
  for (let h = 0; h < lines.length; h += 1) {
    const m = FUNCTION_HEADER.exec(lines[h]);
    if (!m || !names.has(m[1])) continue;
    let end = h + 1;
    while (end < lines.length && !isSection(lines[end])) end += 1;
    let last = h;
    for (let i = h + 1; i < end; i += 1) {
      if (!isBlank(lines[i]) && !isComment(lines[i])) last = i;
    }
    let start = h;
    while (start - 1 >= 0 && isComment(lines[start - 1])) start -= 1;
    for (let i = start; i <= last; i += 1) remove.add(i);
    if (last + 1 < lines.length && isBlank(lines[last + 1])) remove.add(last + 1);
    else if (start - 1 >= 0 && isBlank(lines[start - 1])) remove.add(start - 1);
  }
  const kept = lines.filter((_, i) => !remove.has(i)).join("\n");
  return endsWithNewline ? `${kept}\n` : kept;
}

/** One `[functions.X]` block: its name, and its text exactly as written. */
export type FunctionBlock = { name: string; text: string };

const FUNCTION_HEADER = /^\[functions\.([^\]]+)\]\s*$/;

/**
 * Every `[functions.X]` block in a config.toml, in file order.
 *
 * An array rather than a map, because a file carrying the same name twice is
 * reproduced as it stands rather than silently halved — this reader's job is
 * to let a clone's own text survive a rewrite, not to normalise it.
 *
 * A block runs from its header to the next `[section]` of any kind. Trailing
 * blank lines are dropped so blocks can be rejoined with one blank line
 * between them and the output does not grow a line on every cascade.
 */
export function functionBlocksIn(toml: string): FunctionBlock[] {
  const blocks: FunctionBlock[] = [];
  let current: { name: string; body: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    while (current.body.length > 0 && current.body[current.body.length - 1].trim() === "") {
      current.body.pop();
    }
    blocks.push({ name: current.name, text: current.body.join("\n") });
    current = null;
  };
  for (const line of toml.split(/\r?\n/)) {
    const header = FUNCTION_HEADER.exec(line);
    if (header) {
      flush();
      current = { name: header[1], body: [line] };
      continue;
    }
    // Any other section header ends the block. A comment or a key belongs to
    // the block it sits under, which is what makes the carried text faithful.
    if (/^\s*\[/.test(line)) {
      flush();
      continue;
    }
    if (current) current.body.push(line);
  }
  flush();
  return blocks;
}

/**
 * Names the clone declared that a candidate result does not.
 *
 * Its own function because the check inside `reconcileConfigToml` cannot be
 * reached through that function's own door: with the carry-forward working,
 * nothing is ever lost, so a test driving the public API can only ever see it
 * return empty. Exercised directly here instead, and its WIRING proved by
 * execution — planting the pre-fix composer (no carry-forward at all) makes
 * the reconcile refuse, naming all three CRM functions. Recorded because a
 * defensive read-back nobody has fired is indistinguishable from one that
 * cannot fire.
 */
export function declarationsLostBy(cloneToml: string, candidate: string): string[] {
  const kept = new Set(functionBlocksIn(candidate).map((b) => b.name));
  return [...new Set(functionBlocksIn(cloneToml).map((b) => b.name))].filter((n) => !kept.has(n));
}

/**
 * The line written above the carried blocks.
 *
 * It sits under the last block prime owns, so on the next pass it is read as
 * part of THAT block\u2019s body and dropped with it — the composition is rebuilt
 * from prime\u2019s file every time, so the marker cannot accumulate. Pinned by an
 * idempotence test rather than left to be believed.
 *
 * ## The placeholder is `<name>` and may never again be `X`
 *
 * It read `[functions.X]` until 21 Sep 2026, and that is a DECLARATION to
 * anything counting them loosely. `auditRemediation.spec.ts` on every clone
 * counts with
 *
 *     /\[functions\.([A-Za-z0-9_-]+)\][^[]*?verify_jwt\s*=\s*(true|false)/gs
 *
 * — unanchored, and `[^[]*?` runs happily through prose — so
 * `[functions.X] block is read by the CLI as verify_jwt = true` matched
 * ENTIRELY INSIDE THIS COMMENT and counted a function called `X`. Measured on
 * the open proposal for `npc-crm-independent`: the reconciled file declares
 * 417 and that spec counted 418, so the ratchet meant to catch a function
 * slipping in undeclared was itself tripped by this module's prose.
 *
 * `<` is outside `[A-Za-z0-9_-]`, so the regex cannot begin a match here at
 * all. `declaredFunctionCount` below was never fooled — it anchors to the
 * line — which is exactly why the disagreement showed up as an unexplained
 * off-by-one rather than as a wrong count anybody could see.
 */
export const CLONE_OWNED_MARKER =
  "# Declared by this clone for functions the prime does not have. An omitted\n" +
  "# [functions.<name>] block is read by the CLI as verify_jwt = true.";

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
