/**
 * A held line variant follows prime by a three-way merge, not by a person.
 *
 * ## The cost this removes
 *
 * A `manual_reconcile` hold keeps the clone's copy because the copy carries
 * work prime does not — on the CRM-independent line, `ai-dashboard-agent`
 * calls this line's own `crm-calendar` and creates clients in its own
 * Postgres. That hold is right, and it was the most expensive thing in the
 * fleet: the files AROUND a held file keep crossing (the agent's policy,
 * projection and authorisation modules, the specs that read it), so every
 * prime change to the agent left the clone red until somebody merged prime's
 * new copy into the line's by hand. Measured on `npc-crm-independent-6505dc`,
 * 10 Oct 2026: eight of the eleven cascades from #82 to #104 needed exactly
 * that, and every one of those merges was clean except a label, with the
 * line's own difference from prime "the same 235 lines before and after".
 * A person was being asked to run `git merge-file` eight times.
 *
 * ## The rule
 *
 * Three texts, the ordinary three-way merge:
 *
 *   - **base**   — prime's copy at the revision the clone's copy was last
 *                  reconciled to;
 *   - **ours**   — the clone's copy (the line's work);
 *   - **theirs** — prime's copy now.
 *
 * A hunk only one side changed takes that side; a hunk both sides changed the
 * same way takes it once; a hunk both changed DIFFERENTLY is a conflict, and
 * one conflict anywhere means NO write — the file stays held for a person,
 * exactly as before this module existed. There is no conflict marker, no
 * "prefer ours" and no partial result: a merge either replays both sides'
 * work completely or it does not happen.
 *
 * ## Where the base comes from — evidence, never the sync pointer
 *
 * `clones.last_synced_sha` is the wrong base. A held file can lag the pointer
 * (that is what being held MEANS), and merging against a base newer than the
 * file's real one reads every prime change the file never received as the
 * line having deleted it — the merge would silently revert prime. So the base
 * is read off the clone's own history: the newest commit that touched the
 * path and names the prime revision it was reconciled to (`prime@<sha>`).
 * Every reconcile on the line names one ("Reconcile the CRM's agent at
 * prime@e02572f"), and so does the engine's own statement commit ("chore(aurixa):
 * cascade 258 file(s) from prime@6c2180a"). A commit naming two different
 * revisions is ambiguous and yields no base; no base means no merge.
 *
 * A LATER commit that touched the path without naming a revision is the
 * line's own edit on top of that base (a CRM change), which a three-way merge
 * carries as "ours" — so the walk passes over it to the newest commit that
 * does name one.
 *
 * ## Why a hand-written diff
 *
 * The engine imports nothing it does not declare, and the merge must not
 * depend on a transitive package a lockfile refresh can remove. The matcher
 * is patience diff (unique lines as anchors, recursing into the gaps), with an
 * exact LCS only for small gaps and NO matches for a large anchorless gap.
 * The fallback is deliberately the conservative one: fewer matches make
 * larger hunks, larger hunks collide more, and a collision is a hold.
 *
 * Pure: no I/O.
 */

/** A gap larger than this (cells of the LCS table) is not matched line by line. */
export const MAX_LCS_CELLS = 4_000_000;

/** `prime@<sha>` as a reconcile or a statement commit writes it. */
const PRIME_REVISION = /\bprime@([0-9a-f]{7,40})\b/gi;

/**
 * The prime revision a commit message says a file was reconciled to, or null
 * when it names none or names two different ones.
 *
 * Two names are refused rather than ordered: "Land the cascades at
 * prime@278cdc3 and prime@1a39b32" does not say which one each file reached,
 * and a guessed base is the silent-revert failure described above.
 */
export function primeRevisionNamedBy(message: string): string | null {
  const found = new Set<string>();
  for (const m of message.matchAll(PRIME_REVISION)) found.add(m[1].toLowerCase());
  if (found.size !== 1) return null;
  return [...found][0];
}

export type VariantBase =
  | { kind: "named"; primeRevision: string; commit: string }
  | { kind: "ambiguous"; commit: string }
  | { kind: "none" };

/**
 * The base for one held path, from the commits that touched it, newest first.
 *
 * The first commit naming exactly one revision decides. The first commit that
 * names TWO stops the walk as ambiguous rather than reaching past it to an
 * older, unambiguous one — the file's content was decided by the ambiguous
 * commit, and an older base would misattribute everything it brought.
 */
export function variantBaseFrom(commits: readonly { sha: string; message: string }[]): VariantBase {
  for (const c of commits) {
    const names = new Set<string>();
    for (const m of c.message.matchAll(PRIME_REVISION)) names.add(m[1].toLowerCase());
    if (names.size === 1) return { kind: "named", primeRevision: [...names][0], commit: c.sha };
    if (names.size > 1) return { kind: "ambiguous", commit: c.sha };
  }
  return { kind: "none" };
}

// ── The matcher ─────────────────────────────────────────────────────────────

/**
 * Matching line pairs between `a` and `b`, strictly increasing on both sides:
 * `out[i] = j` means a[i] is matched to b[j]; -1 means unmatched.
 */
export function matchLines(a: readonly string[], b: readonly string[]): Int32Array {
  const out = new Int32Array(a.length).fill(-1);
  matchRange(a, 0, a.length, b, 0, b.length, out);
  return out;
}

function matchRange(
  a: readonly string[],
  a0: number,
  a1: number,
  b: readonly string[],
  b0: number,
  b1: number,
  out: Int32Array,
): void {
  // Common prefix and suffix first: they are matches by definition and are
  // most of any file a merge is asked about.
  while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) {
    out[a0] = b0;
    a0++;
    b0++;
  }
  while (a0 < a1 && b0 < b1 && a[a1 - 1] === b[b1 - 1]) {
    out[a1 - 1] = b1 - 1;
    a1--;
    b1--;
  }
  if (a0 >= a1 || b0 >= b1) return;

  // Patience: lines occurring exactly once on each side are anchors.
  const countA = new Map<string, number>();
  const countB = new Map<string, number>();
  const posB = new Map<string, number>();
  for (let i = a0; i < a1; i++) countA.set(a[i], (countA.get(a[i]) ?? 0) + 1);
  for (let j = b0; j < b1; j++) {
    countB.set(b[j], (countB.get(b[j]) ?? 0) + 1);
    posB.set(b[j], j);
  }
  const pairs: [number, number][] = [];
  for (let i = a0; i < a1; i++) {
    const line = a[i];
    if (countA.get(line) === 1 && countB.get(line) === 1) pairs.push([i, posB.get(line)!]);
  }

  if (pairs.length > 0) {
    const anchors = longestIncreasing(pairs);
    let pa = a0;
    let pb = b0;
    for (const [i, j] of anchors) {
      matchRange(a, pa, i, b, pb, j, out);
      out[i] = j;
      pa = i + 1;
      pb = j + 1;
    }
    matchRange(a, pa, a1, b, pb, b1, out);
    return;
  }

  // No anchor: an exact LCS where it is affordable, nothing where it is not.
  const n = a1 - a0;
  const m = b1 - b0;
  if (n * m > MAX_LCS_CELLS) return;
  const w = m + 1;
  const table = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * w + j] =
        a[a0 + i] === b[b0 + j]
          ? table[(i + 1) * w + j + 1] + 1
          : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[a0 + i] === b[b0 + j]) {
      out[a0 + i] = b0 + j;
      i++;
      j++;
    } else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
}

/** The longest chain of pairs increasing in BOTH coordinates (input sorted by the first). */
function longestIncreasing(pairs: readonly [number, number][]): [number, number][] {
  const tails: number[] = []; // index into pairs of the smallest tail per length
  const prev = new Int32Array(pairs.length).fill(-1);
  for (let k = 0; k < pairs.length; k++) {
    const y = pairs[k][1];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]][1] < y) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[k] = tails[lo - 1];
    tails[lo] = k;
  }
  const chain: [number, number][] = [];
  let k = tails.length > 0 ? tails[tails.length - 1] : -1;
  while (k >= 0) {
    chain.push(pairs[k]);
    k = prev[k];
  }
  return chain.reverse();
}

// ── The merge ───────────────────────────────────────────────────────────────

export type ThreeWayMerge =
  | {
      clean: true;
      text: string;
      /** Hunks where only prime changed — what this merge brought across. */
      fromPrime: number;
      /** Hunks where only the clone changed — the line's work, kept. */
      fromClone: number;
    }
  | { clean: false; conflicts: number };

function sameSlice(
  x: readonly string[],
  x0: number,
  x1: number,
  y: readonly string[],
  y0: number,
  y1: number,
): boolean {
  if (x1 - x0 !== y1 - y0) return false;
  for (let k = 0; k < x1 - x0; k++) if (x[x0 + k] !== y[y0 + k]) return false;
  return true;
}

/**
 * The three-way merge of `ours` and `theirs` against `base`, line by line.
 *
 * Lines keep their endings exactly: the texts are split on `\n` and joined on
 * `\n`, so a file that ends with a newline (or does not) round-trips byte for
 * byte, and `\r` stays part of the line it belongs to.
 */
export function threeWayMerge(base: string, ours: string, theirs: string): ThreeWayMerge {
  if (ours === theirs) return { clean: true, text: ours, fromPrime: 0, fromClone: 0 };
  if (base === theirs)
    return { clean: true, text: ours, fromPrime: 0, fromClone: ours === base ? 0 : 1 };
  if (base === ours) return { clean: true, text: theirs, fromPrime: 1, fromClone: 0 };

  const o = base.split("\n");
  const a = ours.split("\n");
  const b = theirs.split("\n");
  const ma = matchLines(o, a);
  const mb = matchLines(o, b);

  const merged: string[] = [];
  let conflicts = 0;
  let fromPrime = 0;
  let fromClone = 0;
  let i = 0;
  let ia = 0;
  let ib = 0;
  while (i < o.length || ia < a.length || ib < b.length) {
    // A stable line: base, ours and theirs all hold it, here.
    if (i < o.length && ma[i] === ia && mb[i] === ib) {
      merged.push(o[i]);
      i++;
      ia++;
      ib++;
      continue;
    }
    // The next base line both sides still hold is where this chunk ends.
    let k = i;
    while (k < o.length && !(ma[k] >= ia && mb[k] >= ib)) k++;
    const ea = k < o.length ? ma[k] : a.length;
    const eb = k < o.length ? mb[k] : b.length;

    const oursSame = sameSlice(a, ia, ea, o, i, k);
    const theirsSame = sameSlice(b, ib, eb, o, i, k);
    if (oursSame) {
      for (let x = ib; x < eb; x++) merged.push(b[x]);
      if (!theirsSame) fromPrime++;
    } else if (theirsSame) {
      for (let x = ia; x < ea; x++) merged.push(a[x]);
      fromClone++;
    } else if (sameSlice(a, ia, ea, b, ib, eb)) {
      for (let x = ia; x < ea; x++) merged.push(a[x]);
    } else {
      conflicts++;
    }
    i = k;
    ia = ea;
    ib = eb;
  }
  if (conflicts > 0) return { clean: false, conflicts };
  return { clean: true, text: merged.join("\n"), fromPrime, fromClone };
}

// ── The verdict for one held path ───────────────────────────────────────────

export type VariantMergeVerdict =
  /** Prime's change merged into the line's copy: write `text`. */
  | { act: "write"; text: string; base: string; fromPrime: number; fromClone: number }
  /** The line's copy already holds everything prime changed: nothing is owed. */
  | { act: "current"; base: string }
  /** Still held for a person, and why. */
  | { act: "hold"; why: string };

/**
 * What to do with one held path, given the texts the engine read.
 *
 * `base` null means no reconciled revision was found (`variantBaseFrom`), and
 * that is a hold: the merge is only ever as safe as its base.
 */
export function decideVariantMerge(args: {
  base: { revision: string; text: string | null } | null;
  ours: string;
  theirs: string;
}): VariantMergeVerdict {
  if (!args.base) {
    return {
      act: "hold",
      why: "no commit on this line names the prime revision it was reconciled to",
    };
  }
  if (args.base.text === null) {
    return {
      act: "hold",
      why: `prime@${args.base.revision.slice(0, 7)} holds no copy of this path to merge from`,
    };
  }
  const m = threeWayMerge(args.base.text, args.ours, args.theirs);
  if (!m.clean) {
    return {
      act: "hold",
      why: `${m.conflicts} hunk(s) changed differently here and on prime since prime@${args.base.revision.slice(0, 7)}`,
    };
  }
  if (m.text === args.ours) return { act: "current", base: args.base.revision };
  return {
    act: "write",
    text: m.text,
    base: args.base.revision,
    fromPrime: m.fromPrime,
    fromClone: m.fromClone,
  };
}

// ── What a pass says about its merges ───────────────────────────────────────

/**
 * Held paths one pass asks about. Each is at most four requests (the line's
 * history of the file, the named revision, three file reads less what is
 * cached), so twelve is ~fifty requests at worst — and the CRM line holds
 * fewer than twelve paths that actually differ on any one cascade.
 */
export const MAX_VARIANT_MERGES = 12;

export type VariantMergeOutcome = { path: string; verdict: VariantMergeVerdict };

/** The one-line summary suffix: what was merged, and what was found current. */
export function variantMergeSuffixFor(
  outcomes: readonly VariantMergeOutcome[],
  landed: ReadonlySet<string>,
): string {
  const merged = outcomes.filter((o) => o.verdict.act === "write" && landed.has(o.path)).length;
  const current = outcomes.filter((o) => o.verdict.act === "current").length;
  const parts: string[] = [];
  if (merged > 0) parts.push(`${merged} line variant(s) merged with prime`);
  if (current > 0) parts.push(`${current} line variant(s) current`);
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

/**
 * The pull request's account, one line per path. A merge that a content hold
 * then refused (`landed` lacks it) is said to have been refused, because the
 * file did not travel; a hold says why, so the person it is left for starts
 * from the reason rather than from the diff.
 */
export function describeVariantMerges(
  outcomes: readonly VariantMergeOutcome[],
  landed: ReadonlySet<string>,
): string {
  const lines: string[] = [];
  for (const { path, verdict } of outcomes) {
    if (verdict.act === "write") {
      lines.push(
        landed.has(path)
          ? `- \`${path}\` — merged: prime's changes since prime@${verdict.base.slice(0, 7)} (${verdict.fromPrime} hunk(s)) on top of this line's own (${verdict.fromClone} kept)`
          : `- \`${path}\` — merged cleanly from prime@${verdict.base.slice(0, 7)}, but a content hold refused the result; held`,
      );
    } else if (verdict.act === "current") {
      lines.push(
        `- \`${path}\` — current: holds everything prime changed since prime@${verdict.base.slice(0, 7)}; nothing owed`,
      );
    } else {
      lines.push(`- \`${path}\` — held for a person: ${verdict.why}`);
    }
  }
  return lines.join("\n");
}
