/**
 * The blob each path held at each commit of its walk, asked a batch at a time.
 *
 * The history probes in `cascadeDeletions.server.ts` list the commits that
 * touched a path, then read the path at each one, newest first, and stop at
 * the first version the clone holds. That was one contents call per commit,
 * in series. A clone whose copy matches nothing recent paid for the whole
 * walk, one round trip after another. Measured on the pass to
 * `npc-crm-independent-6505dc` at prime@0e89502: the left-behind probe's
 * fifteen walks took nine seconds, the last four of them one path reading its
 * ten versions in turn, and that phase is what pushed the carry past the
 * tick.
 *
 * GraphQL reads every commit of every walk at once: one alias per commit,
 * `object(oid: <commit>) { ... on Commit { file(path: $pN) { oid mode type } } }`,
 * each path passed as a variable. The commits still come from `listCommits`.
 * That list IS the walk, and nothing here chooses it. The walk still reads the
 * answers newest first and stops at the first match, so a probe reports the
 * same versions it reported before.
 *
 * Three rules keep it exact:
 *   1. Only a regular file's id is taken: type `blob`, mode 100644 or 100755.
 *      The contents API answers a link with the file it names, a submodule
 *      with the commit it pins and a directory with a listing. Each of those
 *      is read the old way, per commit, and answers what it always did.
 *   2. "Nothing at this path" is an answer, but only from a clean response.
 *      The contents API's 404 there is what the walk has always read as
 *      "prime held no blob here" (at the removing commit, most often). A
 *      response that carried errors may have nulled the field for its own
 *      reasons, so a null from one is not an answer.
 *   3. Anything else is not an answer: a missing alias, a commit GitHub did
 *      not resolve, an id that is not an id. That commit is read per file.
 *
 * Nothing user-shaped is written into a query. A commit id is checked to be
 * forty hex characters before it goes in, and every path travels as a
 * variable.
 */

import { MAX_VERSION_WALK } from "./deletionPropagation.pure";

/** One path's walk: the commits `listCommits` gave, newest first. */
export type VersionAsk = { path: string; commits: readonly string[] };

/**
 * What one commit's lookup says: the blob the path held there, `null` if it
 * held nothing there, or `undefined` if the lookup is not an answer and the
 * commit has to be read per file.
 */
export type VersionAnswer = string | null | undefined;

/** Commit lookups one request carries: eight full walks. */
export const VERSION_BATCH_LOOKUPS = MAX_VERSION_WALK * 8;

/**
 * Requests in flight at once. The probe that calls this runs its listings
 * four wide and asks nothing else meanwhile; three leaves room under the six
 * connections a Worker may hold open.
 */
export const VERSION_BATCH_CONCURRENCY = 3;

const OBJECT_ID = /^[0-9a-f]{40}$/;

/** Git's regular-file modes, as GraphQL reports them (an Int, not an octal string). */
const REGULAR_FILE_MODES: ReadonlySet<number> = new Set([0o100644, 0o100755]);

/**
 * Group walks into requests. A walk is never split across two, a path is
 * asked once, and a walk that cannot be asked exactly (no commits, too many,
 * or a commit that is not an id) is left out for its commits to be read per
 * file.
 */
export function planVersionBatches(asks: readonly VersionAsk[]): VersionAsk[][] {
  const batches: VersionAsk[][] = [];
  const seen = new Set<string>();
  let current: VersionAsk[] = [];
  let lookups = 0;
  for (const ask of asks) {
    if (seen.has(ask.path)) continue;
    seen.add(ask.path);
    const n = ask.commits.length;
    if (n === 0 || n > VERSION_BATCH_LOOKUPS) continue;
    if (!ask.commits.every((c) => OBJECT_ID.test(c))) continue;
    if (current.length > 0 && lookups + n > VERSION_BATCH_LOOKUPS) {
      batches.push(current);
      current = [];
      lookups = 0;
    }
    current.push(ask);
    lookups += n;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * The request for one batch: the query, and the path variables it declares.
 * The caller adds `owner` and `repo`. Throws on a commit that is not an id,
 * which `planVersionBatches` never lets through.
 */
export function versionBatchQuery(batch: readonly VersionAsk[]): {
  query: string;
  paths: Record<string, string>;
} {
  const declared: string[] = [];
  const fields: string[] = [];
  const paths: Record<string, string> = {};
  batch.forEach((ask, i) => {
    declared.push(`, $p${i}: String!`);
    paths[`p${i}`] = ask.path;
    ask.commits.forEach((commit, j) => {
      if (!OBJECT_ID.test(commit)) {
        throw new Error(`Not a commit id: ${JSON.stringify(commit)}`);
      }
      fields.push(
        `p${i}c${j}: object(oid: "${commit}") { ... on Commit { file(path: $p${i}) { oid mode type } } }`,
      );
    });
  });
  return {
    query:
      `query($owner: String!, $repo: String!${declared.join("")}) ` +
      `{ repository(owner: $owner, name: $repo) { ${fields.join("\n")} } }`,
    paths,
  };
}

/**
 * Each walk's answers, by path and in the walk's own order. `repository` is
 * what the response carried under that key, and `clean` says the response
 * carried no errors (rule 2).
 */
export function readVersionAnswers(
  batch: readonly VersionAsk[],
  repository: unknown,
  clean: boolean,
): Map<string, VersionAnswer[]> {
  const repo =
    repository !== null && typeof repository === "object"
      ? (repository as Record<string, unknown>)
      : null;
  const out = new Map<string, VersionAnswer[]>();
  batch.forEach((ask, i) => {
    out.set(
      ask.path,
      ask.commits.map((_, j) => (repo === null ? undefined : answerOf(repo[`p${i}c${j}`], clean))),
    );
  });
  return out;
}

function answerOf(node: unknown, clean: boolean): VersionAnswer {
  // No alias, or a commit GitHub did not resolve.
  if (node === null || typeof node !== "object") return undefined;
  // The fragment did not apply: the object is not a commit.
  if (!("file" in node)) return undefined;
  const file = (node as { file: unknown }).file;
  if (file === null) return clean ? null : undefined;
  if (typeof file !== "object") return undefined;
  const { oid, mode, type } = file as { oid?: unknown; mode?: unknown; type?: unknown };
  if (type !== "blob") return undefined;
  if (typeof mode !== "number" || !REGULAR_FILE_MODES.has(mode)) return undefined;
  if (typeof oid !== "string" || !OBJECT_ID.test(oid)) return undefined;
  return oid;
}
