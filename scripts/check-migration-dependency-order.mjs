#!/usr/bin/env node
/**
 * A migration must run AFTER the objects it needs exist.
 *
 * The analysis is `scripts/lib/migrationDependencyOrder.mjs`; this is the gate
 * around it. It is a RATCHET rather than a ban: what this corpus already
 * carries is frozen in `MIGRATION_DEPENDENCY_ORDER.json` and anything new
 * fails.
 *
 * The frozen set is an inventory, not permission. It is keyed by
 * `file|object|form` rather than by line, so moving a statement does not
 * churn it, and a frozen finding that stops firing fails too — a ratchet that
 * cannot tighten is a list that only grows.
 *
 * Run `--update` to rewrite the baseline, and say in the commit why the number
 * moved.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { analyse } from "./lib/migrationDependencyOrder.mjs";

const MIGRATIONS = "supabase/migrations";
const BASELINE = "supabase/migrations/MIGRATION_DEPENDENCY_ORDER.json";

const keyOf = (f) => `${f.file}|${f.object}|${f.form}`;

const HEADER = [
  "Frozen migration dependency-order findings: a statement that runs before the",
  "object it needs is created. A version is the order a migration runs in, and",
  "this tree's versions are sequence numbers wearing a date's clothes — they run",
  "months ahead of the wall clock — so naming a new migration after today puts it",
  "in the middle of applied history.",
  "",
  "This is an inventory, not an exemption list. Every entry below is a real",
  "ordering fault in history that is not worth rewriting: the 2025-01 files are",
  "rollback and RLS-fix migrations that could never have run (their own headers",
  "record the parse errors) and are never replayed, because clone backends are",
  "built by catalog introspection rather than by replaying this directory.",
  "",
  "Regenerate with `npm run check:migration-order -- --update`. Never hand-edit.",
];

function main() {
  const update = process.argv.includes("--update");
  const { files, findings } = analyse(MIGRATIONS);

  const frozen = existsSync(BASELINE)
    ? new Map((JSON.parse(readFileSync(BASELINE, "utf8")).findings ?? []).map((f) => [keyOf(f), f]))
    : new Map();

  const seen = new Map();
  for (const f of findings) if (!seen.has(keyOf(f))) seen.set(keyOf(f), f);

  const fresh = [...seen.values()].filter((f) => !frozen.has(keyOf(f)));
  const stale = [...frozen.keys()].filter((k) => !seen.has(k));

  if (update) {
    const out = {
      "//": HEADER,
      schema_version: 1,
      findings: [...seen.values()]
        .map(({ file, object, form, created_by, reason }) => ({ file, object, form, created_by, reason }))
        .sort((a, b) => keyOf(a).localeCompare(keyOf(b))),
    };
    writeFileSync(BASELINE, `${JSON.stringify(out, null, 2)}\n`);
    console.log(`Wrote ${BASELINE} — ${out.findings.length} frozen finding(s) over ${files} migration(s).`);
    return;
  }

  if (fresh.length === 0 && stale.length === 0) {
    console.log(
      `Migration dependency-order check passed (${files} migration(s); ` +
        `${frozen.size} frozen finding(s), 0 new).`,
    );
    return;
  }

  if (fresh.length) {
    console.error("Migration dependency-order check FAILED — a migration runs before what it needs:\n");
    for (const f of fresh) {
      console.error(`  ${f.file}:${f.line}`);
      console.error(`      ${f.form} \`${f.object}\` — ${f.reason}`);
      if (f.created_by) console.error(`      created by ${f.created_by}`);
      console.error("");
    }
    console.error(
      "A migration's version is the order it runs in. Renumber this file to sort\n" +
        "after the migration that creates the object — this tree's versions run\n" +
        "ahead of the wall clock, so the last version in the directory is the\n" +
        "floor, not today's date.\n",
    );
  }

  if (stale.length) {
    console.error(`${stale.length} frozen finding(s) no longer fire:\n`);
    for (const k of stale) console.error(`  ${k}`);
    console.error(
      "\nThat is good news. Re-run with `--update` so the baseline cannot be\n" +
        "re-entered silently.\n",
    );
  }

  process.exit(1);
}

main();
