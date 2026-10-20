/**
 * How many edge-function bundles each prime commit actually changed.
 *
 * The measurement behind `docs/EDGE_DEPLOY_LEDGER.md`. It walks a local
 * checkout of the prime and digests every bundle at every first-parent commit
 * since a date, with the snapshot's OWN grouping, prune and digest — the code
 * the deploy lane runs, not a model of it — and counts, per commit, the
 * bundles whose digest moved. That count is what a prime merge re-owes a clone
 * under the deploy ledger; under the timestamp rule alone it re-owed them all.
 *
 *   npx tsx scripts/edge-deploy/measure-bundle-churn.ts <prime-checkout> [since]
 *
 * `since` defaults to 2026-10-12T00:00:00Z, the day every clone's deploy run
 * parked (F23). The checkout needs history back that far; a shallow clone
 * fetched with `--shallow-since` is enough. Reads git, writes nothing.
 */
import { execFileSync } from "node:child_process";

import { bundleDigest } from "@/server/functionBundleDigest.pure";
import { deployedVerifyJwt } from "@/server/anonymousFunctionSlugs.pure";
import { memoisedSpecifiers, pruneBundleToReachable } from "@/server/functionBundlePrune.pure";
import {
  groupFunctionPaths,
  isCloneFunctionPath,
  isTextFile,
  parseFunctionConfig,
  pickEntrypoint,
} from "@/server/prime-backend.server";

const [repo, since = "2026-10-12T00:00:00Z"] = process.argv.slice(2);
if (!repo) {
  console.error("usage: measure-bundle-churn.ts <prime-checkout> [since]");
  process.exit(2);
}

const FUNCTIONS_PREFIX = "supabase/functions/";
const git = (args: string[], input?: string) =>
  execFileSync("git", ["-C", repo, ...args], { input, maxBuffer: 1 << 30 });

/** Blob text by blob id, read once however many commits share it. */
const blobText = new Map<string, string>();
function readBlobs(shas: string[]) {
  const missing = [...new Set(shas)].filter((sha) => !blobText.has(sha));
  if (missing.length === 0) return;
  const out = git(["cat-file", "--batch"], missing.join("\n") + "\n");
  let offset = 0;
  for (const sha of missing) {
    const newline = out.indexOf(10, offset);
    const size = Number(out.subarray(offset, newline).toString().split(" ")[2]);
    blobText.set(sha, out.subarray(newline + 1, newline + 1 + size).toString("utf8"));
    offset = newline + 1 + size + 1;
  }
}

/** Every bundle's digest at one commit, and how long pruning and digesting took. */
function digestsAt(commit: string) {
  const shaByRel = new Map<string, string>();
  for (const line of git(["ls-tree", "-r", commit, FUNCTIONS_PREFIX.slice(0, -1)])
    .toString("utf8")
    .trim()
    .split("\n")) {
    const [meta, path] = line.split("\t");
    if (!path || !isCloneFunctionPath(path)) continue;
    shaByRel.set(path.slice(FUNCTIONS_PREFIX.length), meta.split(" ")[2]);
  }
  readBlobs([...shaByRel.values()]);
  let configToml: string | null = null;
  try {
    configToml = git(["show", `${commit}:supabase/config.toml`]).toString("utf8");
  } catch {
    configToml = null;
  }
  const fnConfig = parseFunctionConfig(configToml);
  const { slugs, sharedFiles, importMapPath } = groupFunctionPaths([...shaByRel.keys()]);
  const textOf = (rel: string) => {
    const sha = shaByRel.get(rel);
    return sha && isTextFile(rel) ? (blobText.get(sha) ?? null) : null;
  };

  const startedMs = performance.now();
  const specifiersOf = memoisedSpecifiers(textOf);
  const digests = new Map<string, string>();
  for (const [slug, ownPaths] of [...slugs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const bundlePaths = [...ownPaths, ...sharedFiles];
    const entrypointPath = pickEntrypoint(slug, bundlePaths);
    if (!entrypointPath) continue;
    const outcome = pruneBundleToReachable({
      entrypointPath,
      files: bundlePaths.map((path) => ({ path })),
      importMapPath,
      textOf,
      specifiersOf,
    });
    digests.set(
      slug,
      bundleDigest({
        slug,
        entrypointPath,
        importMapPath,
        verifyJwt: deployedVerifyJwt(slug, fnConfig.get(slug)?.verifyJwt ?? true).verifyJwt,
        files: outcome.keep.map((path) => ({ path, sha: shaByRel.get(path) as string })),
      }),
    );
  }
  return { digests, ms: performance.now() - startedMs };
}

const commits = git(["rev-list", "--first-parent", `--since=${since}`, "HEAD"])
  .toString()
  .trim()
  .split("\n")
  .filter(Boolean)
  .reverse();
if (commits.length < 2) {
  console.error(`fewer than two commits since ${since}: is the checkout's history long enough?`);
  process.exit(1);
}

let previous = digestsAt(commits[0]);
const timings = [previous.ms];
const bands = { none: 0, "1-5": 0, "6-50": 0, "more than 50": 0 };
let reowed = 0;
let wholeFleet = 0;
for (const commit of commits.slice(1)) {
  const now = digestsAt(commit);
  timings.push(now.ms);
  let changed = 0;
  for (const [slug, digest] of now.digests) if (previous.digests.get(slug) !== digest) changed++;
  reowed += changed;
  wholeFleet += now.digests.size;
  if (changed === 0) bands.none++;
  else if (changed <= 5) bands["1-5"]++;
  else if (changed <= 50) bands["6-50"]++;
  else bands["more than 50"]++;
  previous = now;
}
timings.sort((a, b) => a - b);

console.log(`first-parent commits since ${since}: ${commits.length}`);
console.log(`bundles at the last commit: ${previous.digests.size}`);
console.log("commits by how many bundles they changed:", bands);
console.log(`re-owed under the ledger: ${reowed} bundle deploys`);
console.log(`re-owed by restarting on every commit: ${wholeFleet} bundle deploys`);
console.log(
  `prune + digest per commit: median ${timings[Math.floor(timings.length / 2)].toFixed(0)} ms, ` +
    `largest ${timings[timings.length - 1].toFixed(0)} ms`,
);
