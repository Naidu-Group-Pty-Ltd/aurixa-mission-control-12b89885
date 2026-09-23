/**
 * Which migration versions a migration's SQL NAMES.
 *
 * ## Why a name is a dependency
 *
 * The dependency facts (`migrationDependencyFacts.pure.ts`) answer one question
 * about two files: does the later one require an object the earlier one
 * creates? That catches the SCHEMA dependency and is blind to the DATA one, and
 * the corpus has a whole class of the second kind.
 *
 * Every template-library release since v15 is two files. The SEED
 * (`20261204020000_seed_template_library_v15_…`, 41 MB) writes the library's
 * rows and a `template_library_release_baselines` row per entry under its own
 * release name. The REFRESH a version later
 * (`20261204030000_refresh_active_masters_from_library_v15`, 17 KB) reads those
 * rows back — `JOIN template_library_release_baselines b … AND b.release =
 * '20261204020000_seed_template_library_v15_running_head_and_columns'` — and
 * decides from them which of a tenant's active masters it may replace. Run
 * without its seed, it finds no baseline, refreshes nothing, and is RECORDED:
 * nothing ever runs it again once the seed does land. Measured 23 Sep 2026:
 * NPC Test and Preflight hold the v16–v19 refreshes without their seeds,
 * `npc-client-dashboard` the v19 one, and on the CRM clone the v15 refresh
 * failed outright for want of the table and halted everything behind it.
 *
 * The refresh cannot be caught by the facts: it creates its own tables and the
 * one it reads was created by an earlier seed. What it does do is SAY which
 * migration it needs, by name, in the only place a person cannot miss — the
 * SQL itself.
 *
 * ## What counts as a name
 *
 * A fourteen-digit run of digits, in the file's EXECUTABLE text: comments are
 * stripped with the shared SQL rule, string literals and function bodies are
 * kept. A reference inside a string is still a reference — that is exactly
 * where the refresh keeps its seed's name, and where an author writes "X must
 * run first" into a `RAISE EXCEPTION`.
 *
 * Comments are not, because they are prose. Measured over the prime's corpus
 * on 23 Sep 2026: 95 files mention another migration's version only in a
 * comment ("`20260921100000` dropped the columns …") and would each have
 * waited on history they merely describe. 11 name one in executable SQL, and
 * every one of the 11 is a real dependency or a ledger operation: the five
 * refreshes naming their seeds, five `RAISE EXCEPTION '… 20260805150000 must
 * run first'` guards, and the withdrawal's own `DELETE … WHERE version IN`.
 *
 * ## What it is not
 *
 * It is a list of NAMES, not of dependencies — whether a name matters is
 * decided where it is compared, against the versions a clone is not being
 * sent. A token that happens to be fourteen digits and names no migration
 * matches nothing and costs nothing. A migration's own version is left in: a
 * seed spells its own release name, and a file is never a barrier to itself.
 *
 * Pure: no network, no database.
 */

import { stripSqlComments } from "./sqlComments.pure";

/**
 * A version, standing alone: fourteen digits with no digit either side, so a
 * longer number is not read as one and `20261204020000_seed…` is.
 */
const VERSION_TOKEN = /(?<![0-9])\d{14}(?![0-9])/g;

/** Every version `sql` names in executable text, de-duplicated and sorted. */
export function mentionedVersionsOf(sql: string): string[] {
  if (typeof sql !== "string" || sql === "") return [];
  const code = stripSqlComments(sql);
  return [...new Set(code.match(VERSION_TOKEN) ?? [])].sort();
}
