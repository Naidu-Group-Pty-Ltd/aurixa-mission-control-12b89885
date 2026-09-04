#!/usr/bin/env node
// Every table with RLS enabled must either have a policy, or be declared
// service-role-only on purpose.
//
// Postgres RLS denies by default, so a table with RLS on and no policy is
// CLOSED. That is the correct state for a table only the service-role client
// touches, and a silent outage for anything reached with a user-scoped client:
// reads come back as an empty array with NO error, so the screen renders
// "none" and nobody has anything to report. A `GRANT SELECT, INSERT, UPDATE,
// DELETE … TO authenticated` sitting beside `ENABLE ROW LEVEL SECURITY` makes
// access look intended while RLS filters every row away — the grant confers the
// privilege, the policy decides the rows, and only the second one is missing.
//
// The repository passes today: 149 tables, all with RLS on, 147 with policies.
// This exists so that stays true, and because the gap it looks for is invisible
// from the application — there is no error to log and no failing request.
//
// One thing to know before trusting a hand-grep here: many of these policies are
// created inside `DO $$ … EXECUTE format('CREATE POLICY … ON public.%I', t)`
// loops, so the table name never appears literally next to `CREATE POLICY`.
// Scanning for the statement alone reports whole features as unprotected when
// they are fine. This script reads the FOREACH array literals too.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = "supabase/migrations";

// Tables reached only by the service-role client, which bypasses RLS. Closed to
// `authenticated` is the intended state; adding a policy would open them.
const SERVICE_ROLE_ONLY = new Set([
  "billing_handoffs",
  "support_ingest_requests",
  // Closed to `authenticated` on purpose, and closed HARDER than RLS can
  // manage: `service_role` has rolbypassrls, so the control on this table is
  // the explicit REVOKE of the default grants in its migration, not a policy.
  // A policy here would open a queue whose payload executes as `postgres`.
  "schema_migration_queue",
  // A per-commit cache of what the PRIME repo declares — secret NAMES and
  // function slugs, never a value. Written and read only by the provisioning
  // server routes, which hold the service role; its migration REVOKEs the
  // default grants from anon and authenticated, so there is no policy to
  // write and adding one would open a table no browser has business reading.
  "prime_snapshot_scans",
]);

const sql = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
  .join("\n")
  .replace(/--[^\n]*/g, "");

const tables = new Set();
for (const m of sql.matchAll(
  /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi,
))
  tables.add(m[1]);
for (const m of sql.matchAll(
  /drop\s+table\s+(?:if\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi,
))
  tables.delete(m[1]);

const rlsOn = new Set();
for (const m of sql.matchAll(
  /alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s+enable\s+row\s+level\s+security/gi,
))
  rlsOn.add(m[1]);

const policied = new Set();
// A policy body can run to a couple of hundred characters between CREATE POLICY
// and the ON clause, and the generator-free migrations here wrap freely.
for (const m of sql.matchAll(
  /create\s+policy[\s\S]{0,200}?\bon\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi,
))
  policied.add(m[1]);
// Policies created through `format(… %1$I …)` inside a DO block name their
// tables in the array literal rather than in the statement, so read those too.
for (const m of sql.matchAll(/foreach\s+\w+\s+in\s+array\s+array\[([\s\S]*?)\]/gi)) {
  for (const t of m[1].matchAll(/'([a-z_][a-z0-9_]*)'/g)) policied.add(t[1]);
}

const noRls = [...tables].filter((t) => !rlsOn.has(t)).sort();
const closed = [...tables]
  .filter((t) => rlsOn.has(t) && !policied.has(t) && !SERVICE_ROLE_ONLY.has(t))
  .sort();
const staleAllowlist = [...SERVICE_ROLE_ONLY].filter((t) => policied.has(t)).sort();

const problems = [];
if (noRls.length)
  problems.push(
    `Tables with no ENABLE ROW LEVEL SECURITY:\n` +
      noRls.map((t) => `  • ${t}`).join("\n") +
      `\n  Anyone holding the anon key can read and write these.`,
  );
if (closed.length)
  problems.push(
    `Tables with RLS enabled and NO policy:\n` +
      closed.map((t) => `  • ${t}`).join("\n") +
      `\n  RLS denies by default, so these are closed to \`authenticated\`. Reads\n` +
      `  return an empty array with no error and writes are refused — a silent\n` +
      `  outage, not a visible one. Add a policy, or add the table to\n` +
      `  SERVICE_ROLE_ONLY in this script if only the service-role client uses it.`,
  );
if (staleAllowlist.length)
  problems.push(
    `Declared service-role-only but now carry a policy:\n` +
      staleAllowlist.map((t) => `  • ${t}`).join("\n") +
      `\n  Remove them from SERVICE_ROLE_ONLY so the list keeps meaning something.`,
  );

if (problems.length) {
  console.error("\n✖ Row Level Security gaps\n");
  console.error(problems.join("\n\n") + "\n");
  process.exit(1);
}

console.log(
  `✓ RLS: ${tables.size} tables, all with RLS enabled; ` +
    `${tables.size - SERVICE_ROLE_ONLY.size} carry policies, ` +
    `${SERVICE_ROLE_ONLY.size} declared service-role-only.`,
);
