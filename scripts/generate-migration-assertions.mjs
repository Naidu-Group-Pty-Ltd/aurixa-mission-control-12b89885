#!/usr/bin/env node
// Compile every `-- @asserts` claim in supabase/migrations into a module the
// server can import.
//
// The drift alarm runs inside a Cloudflare Worker, where there is no filesystem
// and no `supabase/migrations` directory — the SQL is not part of the deployed
// bundle. So the claims have to travel as code, and the only honest way to do
// that is to generate them from the SQL rather than have anybody retype them.
//
//     npm run migrations:assertions          # write
//     npm run migrations:assertions:check    # fail if stale (CI)
//
// The `:check` mode exists because a generated file that is allowed to go stale
// is worse than no generated file: the alarm keeps reporting on a corpus that
// has moved, and reports it as healthy.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { format, resolveConfig } from "prettier";

const { parseAssertions, parseSupersedes, formatAssertion } = await import(
  "../src/server/migrationAssertions.pure.ts"
);

const MIGRATIONS = "supabase/migrations";
const OUT = "src/server/migrationAssertions.generated.ts";

const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const entries = [];
const errors = [];

for (const file of files) {
  const sql = readFileSync(join(MIGRATIONS, file), "utf8");
  const parsed = parseAssertions(sql);
  const retired = parseSupersedes(sql);
  const fileErrors = [
    ...(parsed.ok ? [] : parsed.errors),
    ...(retired.ok ? [] : retired.errors),
  ];
  if (fileErrors.length > 0) {
    errors.push(`${file}\n    ${fileErrors.join("\n    ")}`);
    continue;
  }
  if (parsed.assertions.length === 0 && retired.supersedes.length === 0) continue;
  const version = /^(\d{14})_/.exec(file)?.[1] ?? "";
  entries.push({
    migration: file,
    version,
    assertions: parsed.assertions,
    supersedes: retired.supersedes,
  });
}

// A supersede is judged against the whole corpus, which only exists here.
// It must name a claim that was actually WRITTEN (exact source form, in that
// file) and one strictly OLDER than the migration retiring it — otherwise
// the directive could silence a claim that never existed, or a migration
// could pre-retire its own promises.
for (const e of entries) {
  for (const s of e.supersedes) {
    const target = entries.find((t) => t.migration === s.migration);
    if (!target) {
      errors.push(
        `${e.migration}\n    \`@supersedes ${s.migration}:${s.assertion}\` — no migration with a claim by that filename`,
      );
      continue;
    }
    if (!(target.version < e.version)) {
      errors.push(
        `${e.migration}\n    \`@supersedes ${s.migration}:${s.assertion}\` — a migration may only retire a STRICTLY OLDER migration's claim`,
      );
      continue;
    }
    if (!target.assertions.some((a) => formatAssertion(a) === s.assertion)) {
      errors.push(
        `${e.migration}\n    \`@supersedes ${s.migration}:${s.assertion}\` — ${s.migration} carries no claim with that exact source form`,
      );
    }
  }
}

if (errors.length > 0) {
  console.error(
    `\n✗ Cannot generate ${OUT} — ${errors.length} migration(s) carry an unparseable claim:\n\n` +
      errors.map((e) => `  ${e}`).join("\n") +
      `\n\n  Run \`npm run check:migration-assertions\` for the grammar.\n`,
  );
  process.exit(1);
}

const claims = entries.reduce((n, e) => n + e.assertions.length, 0);

const body =
  `// GENERATED FILE — do not edit by hand.\n` +
  `//\n` +
  `// Source: the \`-- @asserts\` comments in supabase/migrations/*.sql.\n` +
  `// Regenerate: \`npm run migrations:assertions\`.\n` +
  `// CI fails on drift: \`npm run migrations:assertions:check\`.\n` +
  `//\n` +
  `// The drift alarm runs in a Worker with no filesystem, so the claims travel\n` +
  `// as code. Editing this file by hand makes the alarm report on a corpus that\n` +
  `// does not exist — which is the failure it was built to catch, pointed the\n` +
  `// wrong way.\n` +
  `import type { Assertion, Supersede } from "./migrationAssertions.pure";\n` +
  `\n` +
  `export type MigrationClaims = {\n` +
  `  /** Migration filename, e.g. \`20260828010000_client_agreements.sql\`. */\n` +
  `  readonly migration: string;\n` +
  `  /** Its 14-digit version, the only identity it has in the ledger. */\n` +
  `  readonly version: string;\n` +
  `  readonly assertions: readonly Assertion[];\n` +
  `  /** Earlier migrations' claims this one retires. Validated at generation. */\n` +
  `  readonly supersedes?: readonly Supersede[];\n` +
  `};\n` +
  `\n` +
  (entries.length === 0
    ? `export const MIGRATION_CLAIMS: readonly MigrationClaims[] = [];\n`
    : `export const MIGRATION_CLAIMS: readonly MigrationClaims[] = [\n` +
      entries
        .map(
          (e) =>
            `  {\n` +
            `    migration: ${JSON.stringify(e.migration)},\n` +
            `    version: ${JSON.stringify(e.version)},\n` +
            `    assertions: [\n` +
            e.assertions.map((a) => `      ${JSON.stringify(a)},`).join("\n") +
            `\n    ],\n` +
            (e.supersedes.length > 0
              ? `    supersedes: [\n` +
                e.supersedes.map((s) => `      ${JSON.stringify(s)},`).join("\n") +
                `\n    ],\n`
              : ``) +
            `  },`,
        )
        .join("\n") +
      `\n];\n`);

// Formatted with the repository's own prettier config rather than by hand.
// `npm run format` runs over the whole tree, so a generated file it would
// reformat is a file that goes stale the moment anybody runs it -- and then
// `:check` fails for a reason that has nothing to do with the migrations.
const formatted = await format(body, {
  ...(await resolveConfig(OUT)),
  filepath: OUT,
});

const check = process.argv.includes("--check");
const current = (() => {
  try {
    return readFileSync(OUT, "utf8");
  } catch {
    return null;
  }
})();

if (check) {
  if (current === formatted) {
    console.log(`✓ ${OUT} is current: ${entries.length} migration(s), ${claims} claim(s).`);
    process.exit(0);
  }
  console.error(
    `\n✗ ${OUT} is stale.\n\n` +
      `  ${entries.length} migration(s) in supabase/migrations carry ${claims} claim(s);\n` +
      `  the generated module does not match.\n\n` +
      `  Run: npm run migrations:assertions\n`,
  );
  process.exit(1);
}

if (current === formatted) {
  console.log(`✓ ${OUT} already current: ${entries.length} migration(s), ${claims} claim(s).`);
} else {
  writeFileSync(OUT, formatted);
  console.log(`✓ Wrote ${OUT}: ${entries.length} migration(s), ${claims} claim(s).`);
}
