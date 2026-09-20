/**
 * Corpus position is not dependency.
 *
 * ## What the prefix barrier cost
 *
 * `partitionByDependency` (fleetCorpusScope.pure.ts) keeps one `holes` array
 * for a whole corpus walk, appends to it, and never clears it. So the FIRST
 * version the prime's ledger does not record stops every later version, for
 * every clone, permanently — the barrier is a prefix, and its only discharge
 * is somebody reconciling the prime.
 *
 * That is the right instinct and the wrong scope, and this fleet is the proof.
 * Measured 19 September 2026 on `npc-client-dashboard` and
 * `preflight-property-group`, both stalled at frontier `20261201100000`:
 *
 * - the hole is `20261202090000_builder_marketplace_ranking.sql`, which adds
 *   rank columns to `builder_network_stock_items`, a `rank_applied_at` column
 *   to `builder_network_inbound_events`, the view
 *   `builder_network_stock_ranked` and the function
 *   `builder_network_apply_stock_ranks`;
 * - the three migrations it withheld are template-library seed and
 *   active-master refresh work, against `template_library_entries` and
 *   `report_templates`.
 *
 * **No object in common.** Neither withheld migration could have failed for
 * want of anything the hole creates. What those two tenants actually got for
 * the barrier's caution was a report catalogue three releases stale — every
 * generated report still drawing the pre-v14 master, which is the exact
 * condition `TIER_FRAMEWORK § Decision E` exists to prevent.
 *
 * ## The rule
 *
 * **A hole blocks a later migration only where that migration names something
 * the hole creates.** Where the evidence to say so cannot be established —
 * either SQL will not load, or the file is past the byte ceiling a lane can
 * afford to read — the prefix barrier applies unchanged. The guard stays
 * fail-closed exactly where it is blind, and stops being a stop-the-world
 * where it can see.
 *
 * ## Why a substring test and not a parse
 *
 * A dependency can be spelled in more ways than a parser this size will ever
 * enumerate: a column in a `SELECT`, a table in a `REFERENCES`, a function in
 * a `DEFAULT`, a view inside a dollar-quoted body, a name built by `format()`.
 * Matching any MENTION of the hole's own relation names is deliberately
 * over-eager: a name that appears only in a comment or a string literal counts
 * as a dependency and the migration stays blocked, which is what the code did
 * before this module existed. Every way this test is wrong is a way that keeps
 * today's behaviour.
 *
 * Client-safe: pure, and its only import is the object extractor the ledger
 * reconciliation already uses.
 */
import { extractCreatedObjects } from "../primeLedgerReconciliation.pure";
import { stripSqlComments } from "../sqlComments.pure";

/**
 * Comments out, dollar-quoted bodies KEPT.
 *
 * `stripSqlNoise` removes function bodies before extracting what a file
 * creates, and is right to: a body routinely contains the word CREATE, and
 * counting those would attribute a caller's mention to the file as a
 * definition. For the opposite question it is exactly wrong — a `plpgsql` body
 * that calls `builder_network_apply_stock_ranks` IS a dependency on the
 * migration that defines it, and Postgres will not refuse the CREATE, so
 * nothing downstream would catch it either. Found by the test that pins it.
 *
 * Comments still go, so a version named in a `-- see 20261202090000` note is
 * not read as a reference to it.
 */
const stripCommentsOnly = stripSqlComments;

/**
 * The largest migration this scoping will read.
 *
 * Two of the corpus's template-library seeds are around 41 MB of INSERT
 * tuples. Reading one to ask a yes/no question costs more than the question is
 * worth and risks the isolate the fleet lane runs in, so anything past this
 * is `indeterminate` and keeps the prefix barrier. Generous enough that every
 * DDL migration in the corpus is inside it — the ones excluded are seeds.
 */
export const MAX_SCOPING_BYTES = 2_000_000;

/**
 * The bare relation names a migration creates or alters.
 *
 * Bare — `builder_network_stock_items`, not `public.builder_network_stock_items`
 * — because a later migration may name it either way, and the schema half
 * carries no information a dependency test can use: two objects of the same
 * bare name in different schemas is a collision this corpus does not have, and
 * treating one as the other only ever blocks.
 *
 * Column, trigger and index entries contribute their TABLE rather than
 * themselves: a migration depending on `rank_item_score` says
 * `builder_network_stock_items.rank_item_score`, and the table name is what a
 * mention test can find.
 */
export function holeRelationNames(sql: string): string[] {
  const names = new Set<string>();
  for (const obj of extractCreatedObjects(sql)) {
    const parts = obj.qualified.split(".");
    // `schema.table.column` and `schema.table.trigger` → the table.
    // `schema.name` → the name.
    const bare = parts.length >= 3 ? parts[parts.length - 2] : parts[parts.length - 1];
    // A one-letter or two-letter identifier would match half the corpus by
    // accident; nothing in this schema is named that, and a name too short to
    // be distinctive is no evidence of a dependency.
    if (bare && bare.length >= 4) names.add(bare);
  }
  return [...names].sort();
}

const isIdentChar = (c: string) => c !== "" && /[a-z0-9_]/.test(c);

/**
 * Word-boundary mention of any of `names` in `text`. Case-insensitive.
 *
 * ## Every occurrence, not the first one
 *
 * This searched with a single `indexOf` per name and gave up on that name when
 * the boundary check rejected it. So a migration containing
 * `report_templates_archive` BEFORE its real `report_templates` reference was
 * judged not to mention `report_templates` at all — and since a mention is
 * what makes `scopeHoles` withhold a migration, the failure is in the
 * dangerous direction: the migration is SENT, past a hole it genuinely depends
 * on, and the replay fails or part-applies against objects that do not exist.
 *
 * Raised by an automated review on this branch before it merged. The rejection
 * was right and the early exit was not: a substring hit is evidence about that
 * POSITION, never about the rest of the file.
 */
export function mentionsAny(text: string, names: readonly string[]): string | null {
  if (names.length === 0) return null;
  const haystack = text.toLowerCase();
  for (const name of names) {
    // Walk every occurrence. A name that appears embedded once and standalone
    // later mentions the relation, and stopping at the first hit is how that
    // second one goes unseen.
    for (let at = haystack.indexOf(name); at !== -1; at = haystack.indexOf(name, at + 1)) {
      // Guard against a name that is a substring of a longer identifier:
      // `report_templates` must not match `report_templates_archive` in a way
      // that claims a dependency the name does not have. Either side must be a
      // non-identifier character.
      const before = at === 0 ? "" : haystack[at - 1];
      const after = haystack[at + name.length] ?? "";
      if (!isIdentChar(before) && !isIdentChar(after)) return name;
    }
  }
  return null;
}

/**
 * What is known about one hole, for the scoping decision.
 *
 * `creates` empty with `readable` true is a real state and NOT a licence to
 * step over the hole: a migration whose SQL declares no relation at all is a
 * policy rewrite or a grant — the two `rollback_*` scripts in this corpus are
 * exactly that — and those are the files the prefix barrier was written for.
 */
export type HoleEvidence = {
  readonly id: string;
  /** Whether the hole's own SQL could be read at all. */
  readonly readable: boolean;
  /** Bare relation names it creates. Empty when unreadable or declaring none. */
  readonly creates: readonly string[];
};

export type ScopeDecision =
  /** Nothing before it is a hole, or no hole reaches it. Send. */
  | { readonly act: "send" }
  /** Held, with the holes that actually reach it and why. */
  | {
      readonly act: "blocked";
      readonly blockedBy: readonly string[];
      readonly why: "references" | "indeterminate";
    };

/**
 * Whether the holes ahead of a candidate reach it.
 *
 * @param candidateSql The candidate's SQL, or null where it could not be read
 *                     or is past {@link MAX_SCOPING_BYTES}. Null is the
 *                     fail-closed input: every hole then blocks.
 */
export function scopeHoles(
  candidateSql: string | null,
  holes: readonly HoleEvidence[],
): ScopeDecision {
  if (holes.length === 0) return { act: "send" };

  // Cannot read the candidate: cannot say it does not depend on anything.
  if (candidateSql === null) {
    return { act: "blocked", blockedBy: holes.map((h) => h.id), why: "indeterminate" };
  }

  // A hole this run cannot characterise blocks on its own, whatever the
  // candidate says — and it blocks ALONE rather than dragging the readable
  // holes into the reason, so the operator is sent to the one file that is
  // actually unaccounted for.
  const opaque = holes.filter((h) => !h.readable || h.creates.length === 0);
  if (opaque.length > 0) {
    return { act: "blocked", blockedBy: opaque.map((h) => h.id), why: "indeterminate" };
  }

  const text = stripCommentsOnly(candidateSql);
  const reaching = holes.filter((h) => mentionsAny(text, h.creates) !== null);
  if (reaching.length === 0) return { act: "send" };
  return { act: "blocked", blockedBy: reaching.map((h) => h.id), why: "references" };
}
