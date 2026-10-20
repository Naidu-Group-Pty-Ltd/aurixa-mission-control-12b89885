/**
 * How far a delivery's tree write had got when its pass stopped.
 *
 * A delivery is written as a chain of `createTree` calls, each layering up to
 * ~120 entries over the tree the previous call produced (`treeDelivery.pure.ts`),
 * and nothing gated the chain: every other stage of a pass asks the invocation
 * budget before it starts more work, and this one ran to the end or to the
 * platform. Measured 20 Oct 2026 with the pass trace (`passTrace.pure.ts`), on
 * the two lineage children's refreshes:
 *
 *  - NPC Test, 1,042 files: 30.6 s before the tree, then the tree, and no
 *    outcome — the pass was ended inside it, and the branch never moved.
 *  - Preflight Property Group, 1,109 files: 28.0 s before the tree, 27.0 s
 *    in it, the proposal entered at 55.0 s, and no outcome.
 *
 * Neither pass could have fitted: ~28 s of judging and ~27 s of tree before
 * the commit, against a hook the platform abandons at 60 s. And because the
 * chain was not kept, the next pass judged everything again and wrote the
 * same chain again from the start, so it died in the same place. Three of
 * those and the event is retired with nothing delivered.
 *
 * ## What is kept
 *
 * A tree object is content-addressed: the SHA a chain reached after N chunks
 * names exactly the clone's tree with those chunks layered on, whatever pass
 * wrote it. So a pass that stops between two chunks keeps `{ key, done, of,
 * sha }` on its ledger, and the next pass continues the chain from `sha` at
 * chunk `done` — but only where the chain it would write is the SAME chain:
 * `key` is a digest over the clone tree the chain starts from, and every entry
 * of every chunk in order (a text entry by the git blob id its bytes will
 * become, so the key is a fact about what the tree will hold). A different
 * base, a different entry, a different chunk boundary is a different key, and
 * the chain starts again from the clone's own tree. Nothing about a kept chain
 * is trusted beyond that comparison.
 *
 * ## What it costs to be wrong
 *
 * An unreferenced tree is an object GitHub may collect. A chain whose tree has
 * gone fails its next `createTree` with a "tree not found" refusal, and the
 * engine starts the chain again from the clone's tree in the same pass — the
 * cost is the pass's own budget, never a wrong tree, because a collected SHA
 * cannot be written over.
 *
 * Pure: hashing is computation, and the one write (`createTree`) is injected.
 */

import { createHash } from "node:crypto";
import { gitBlobSha } from "./gitBlobSha.pure";
import type { DeliveryTreeEntry } from "./treeDelivery.pure";

/** Changing the canonical form changes every key, so a kept chain is never misread. */
export const TREE_CHAIN_VERSION = "tree-chain/1";

export type TreeChainProgress = {
  /** What the chain is OF: `treeChainKey` over its base tree and its chunks. */
  key: string;
  /** Chunks written. A chain is kept only once at least one is. */
  done: number;
  /** Chunks in the delivery. */
  of: number;
  /** The tree the chain had produced after `done` chunks. */
  sha: string;
};

const SHA = /^[0-9a-f]{40}$/;
const KEY = /^[0-9a-f]{64}$/;

/**
 * The identity of a chain: the tree it starts from and every entry of every
 * chunk, in order. Text is named by the blob it will become rather than
 * carried, so the key is small and still a fact about the bytes.
 */
export function treeChainKey(
  baseTreeSha: string,
  chunks: ReadonlyArray<ReadonlyArray<DeliveryTreeEntry>>,
): string {
  const canonical = JSON.stringify([
    TREE_CHAIN_VERSION,
    baseTreeSha,
    chunks.map((chunk) =>
      chunk.map((e) => [
        e.path,
        e.mode,
        e.type,
        e.content !== undefined ? `text:${gitBlobSha(e.content)}` : (e.sha ?? null),
      ]),
    ),
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** A kept chain, or nothing. Malformed is dropped alone: the cost is one rewrite. */
export function readTreeChain(raw: unknown): TreeChainProgress | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { key, done, of, sha } = raw as Partial<Record<keyof TreeChainProgress, unknown>>;
  if (typeof key !== "string" || !KEY.test(key)) return null;
  if (typeof sha !== "string" || !SHA.test(sha)) return null;
  if (typeof done !== "number" || !Number.isInteger(done) || done < 1) return null;
  if (typeof of !== "number" || !Number.isInteger(of) || of < done) return null;
  return { key, done, of, sha };
}

/**
 * Where the chain this pass would write may resume: only the same chain, by
 * key and length. Anything else starts from the clone's own tree.
 */
export function resumableTreeChain(
  kept: TreeChainProgress | null | undefined,
  key: string,
  of: number,
): { done: number; sha: string } | null {
  if (!kept || kept.key !== key || kept.of !== of) return null;
  if (kept.done < 1 || kept.done > of) return null;
  return { done: kept.done, sha: kept.sha };
}

/**
 * Whether a ledger's chain moved: a chain where there was none, a different
 * chain, or the same chain further along. What the drain counts as progress
 * kept, beside a grown blob or evidence list (`ledgerGrew`).
 */
export function treeChainGrew(
  prior: TreeChainProgress | null | undefined,
  now: TreeChainProgress | null | undefined,
): boolean {
  if (!now) return false;
  if (!prior || prior.key !== now.key) return true;
  return now.done > prior.done;
}

/** The one sentence a clone's row carries while its tree write is paused. */
export function describeTreePause(input: { done: number; of: number; files: number }): string {
  return input.done >= input.of
    ? `Paused at the invocation budget — the tree for ${input.files} file(s) is written; ` +
        "the commit and pull request resume next tick"
    : `Paused at the invocation budget — tree written for ${input.done} of ${input.of} ` +
        `chunk(s) of ${input.files} file(s); the rest resume next tick`;
}

export type TreeChainOutcome =
  | {
      kind: "written";
      /** The delivery's tree. */
      sha: string;
      /** Chunks this pass wrote. */
      written: number;
    }
  | {
      kind: "paused";
      /** Chunks the chain holds, this pass's and any it resumed. */
      done: number;
      /** The tree after `done` chunks: what the next pass continues from. */
      sha: string;
      written: number;
    };

/**
 * Write a delivery's chunks as one chain, stopping at the budget and keeping
 * where it stopped.
 *
 * The rules, each of which a test holds it to:
 *
 *  - **This pass's first chunk is always written.** A pass whose budget was
 *    spent before the tree would otherwise stop having written nothing, every
 *    time, and the chain would never move.
 *  - **The budget is asked before every later chunk**, with the slowest chunk
 *    so far as the reserve: one more like it must fit.
 *  - **A pass that wrote some of the chain and has no window left after it
 *    stops with the whole chain kept**, so the next pass goes straight to the
 *    commit. One that wrote none of it never stops here: it resumed a
 *    finished chain, and the commit is the forward progress left.
 *  - **A kept chain whose tree was collected starts again** from the clone's
 *    own tree, in the same pass, and only on the first chunk after a resume.
 *    Any other failure is the caller's, as it always was.
 *
 * The IO is injected, as `runWithinBudget` injects the deploy: the engine
 * passes the real `createTree` and the real budget.
 */
export async function writeTreeChain(input: {
  chunks: ReadonlyArray<ReadonlyArray<DeliveryTreeEntry>>;
  /** The clone's tree, which a chain starts from. */
  baseTreeSha: string;
  /** Where a kept chain resumes (`resumableTreeChain`), or null. */
  resumed: { done: number; sha: string } | null;
  /** Layers one chunk over `baseTree`; answers the new tree's SHA. */
  createTree: (baseTree: string, chunk: ReadonlyArray<DeliveryTreeEntry>) => Promise<string>;
  /** The pass's budget, asked with a reserve. Absent: the chain never stops. */
  isPastDeadline?: (reserveMs: number) => boolean;
  /** Whether a failure says a tree we named no longer exists. */
  isStaleObject: (e: unknown) => boolean;
  /** Injectable for tests; the wall clock otherwise. */
  now?: () => number;
}): Promise<TreeChainOutcome> {
  const now = input.now ?? Date.now;
  let resumed = input.resumed;
  let sha = resumed ? resumed.sha : input.baseTreeSha;
  let next = resumed ? resumed.done : 0;
  let written = 0;
  let slowestMs = 0;
  while (next < input.chunks.length) {
    if (written > 0 && input.isPastDeadline?.(slowestMs)) {
      return { kind: "paused", done: next, sha, written };
    }
    const startedAt = now();
    let tree: string;
    try {
      tree = await input.createTree(sha, input.chunks[next]);
    } catch (e) {
      if (resumed && written === 0 && input.isStaleObject(e)) {
        resumed = null;
        sha = input.baseTreeSha;
        next = 0;
        continue;
      }
      throw e;
    }
    sha = tree;
    next += 1;
    written += 1;
    slowestMs = Math.max(slowestMs, now() - startedAt);
  }
  if (written > 0 && input.isPastDeadline?.(0)) {
    return { kind: "paused", done: next, sha, written };
  }
  return { kind: "written", sha, written };
}
