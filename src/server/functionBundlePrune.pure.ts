/**
 * Which shared files a function bundle actually needs.
 *
 * ## The measurement
 *
 * Every bundle carries the whole `supabase/functions/_shared` tree by
 * convention — 6.42 MB across 523 files, measured on the prime 2 Sep 2026 —
 * while a typical function's own source is a single `index.ts` of 24 KB. So
 * more than 96% of every deploy is shared code the function does not import.
 *
 * Supabase's Management API refuses it. Measured the same day, on the first
 * live cascade deploy this platform ever attempted:
 *
 *   all 60 function deploys failed: Deploy failed for abs-data-service:
 *   413 — {"message":"request entity too large"}
 *
 * That is not a batching problem. Sixty bundles, six, or one all fail the same
 * way, because the size is per-request. The payload is already multipart with
 * raw bytes, so there is no encoding left to win either — the only thing left
 * is to stop sending files nothing imports.
 *
 * ## Why static resolution is trustworthy here
 *
 * These modules "must parse under Deno: no `@/` aliases, explicit `.ts`
 * extensions" — the repository's own rule for `supabase/functions/_shared`.
 * That makes every internal specifier a literal relative path with its
 * extension, which resolves by string manipulation alone. No module resolver,
 * no `index.ts` guessing, no extension inference.
 *
 * ## The rule that keeps it safe
 *
 * **Anything the walk cannot see, it does not prune.** A relative specifier
 * that resolves to a file the bundle does not hold, or a dynamic `import()`
 * whose argument is not a literal, means the graph is incomplete — and an
 * incomplete graph falls back to the whole tree for that bundle, recording
 * why. A bundle that deploys too large fails loudly at the API; a bundle
 * missing one transitively-imported file fails at RUNTIME on the tenant's
 * clone, which is far worse and much harder to attribute.
 */

export type BundleFileRef = {
  readonly path: string;
};

export type PruneOutcome = {
  /** Paths to include, in the bundle's original order. */
  readonly keep: readonly string[];
  /** False when the walk fell back to carrying everything. */
  readonly pruned: boolean;
  /** Why it fell back, or null when it did not. */
  readonly reason: string | null;
};

/** Specifiers that leave the bundle entirely — never resolved, never fetched. */
function isExternal(spec: string): boolean {
  return (
    spec.startsWith("npm:") ||
    spec.startsWith("jsr:") ||
    spec.startsWith("node:") ||
    spec.startsWith("http://") ||
    spec.startsWith("https://") ||
    spec.startsWith("data:")
  );
}

/**
 * Comments removed before scanning, so a specifier quoted in prose is not
 * mistaken for an import.
 *
 * Imprecise by design and only ever in the safe direction: a miss adds an edge
 * that does not exist, which carries one extra file; the alternative is a
 * missing edge, which loses one.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/** Resolve a relative specifier against the directory of the file importing it. */
export function resolveRelative(fromPath: string, spec: string): string | null {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
  const base = fromPath.split("/").slice(0, -1);
  const out = [...base];
  for (const part of spec.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null; // climbed out of the tree
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

/**
 * The source with the TEXT of string and template literals blanked, for the
 * opacity test alone.
 *
 * A dynamic `import(` whose argument is not a literal means the graph cannot
 * be walked, so the bundle must carry everything. That test read the raw
 * source, and English is full of the phrase: `pdf-import-monitoring` contains
 * "PDF import(s) failed in the last 24h.", which matched, and the function
 * shipped the whole 6.44 MB tree — refused 413 — over a plural.
 *
 * Blanking is applied to the opacity test alone, never to specifier
 * extraction, which needs the very literals this removes.
 *
 * ## What it must not do
 *
 * A template literal's `${…}` holds CODE, not text, so blanking it would hide
 * a real `${await import(path)}` and produce a bundle pruned against a graph
 * that was never fully read — the one failure this module exists to prevent.
 * Interpolations are therefore left exactly as they are.
 *
 * ## Failing safe
 *
 * Over-reporting opacity costs a large bundle and a loud refusal;
 * under-reporting silently loses a file. So anything this scanner cannot make
 * sense of — an unterminated literal, a backtick nested inside an
 * interpolation — returns the ORIGINAL source, and the test behaves exactly
 * as it did before.
 */
export function blankStringContents(src: string): string {
  const out = src.split("");
  let i = 0;

  /** Index just past the `}` closing an interpolation opened at `from`, or -1. */
  const endOfInterpolation = (from: number): number => {
    let depth = 1;
    let k = from;
    while (k < src.length) {
      const c = src[k];
      if (c === "\\") {
        k += 2;
        continue;
      }
      if (c === "'" || c === '"') {
        const quote = c;
        k += 1;
        while (k < src.length && src[k] !== quote) {
          if (src[k] === "\\") k += 1;
          else if (src[k] === "\n") return -1;
          k += 1;
        }
        if (k >= src.length) return -1;
        k += 1;
        continue;
      }
      // A template nested inside an interpolation is more than this scanner
      // claims to understand. Bail rather than guess.
      if (c === "`") return -1;
      if (c === "{") depth += 1;
      if (c === "}") {
        depth -= 1;
        if (depth === 0) return k;
      }
      k += 1;
    }
    return -1;
  };

  while (i < src.length) {
    const ch = src[i];
    if (ch !== '"' && ch !== "'" && ch !== "`") {
      i += 1;
      continue;
    }

    if (ch === "`") {
      let j = i + 1;
      let closed = false;
      while (j < src.length) {
        const c = src[j];
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "`") {
          closed = true;
          break;
        }
        if (c === "$" && src[j + 1] === "{") {
          const close = endOfInterpolation(j + 2);
          if (close < 0) return src;
          j = close + 1; // the interpolation's code is left untouched
          continue;
        }
        out[j] = " ";
        j += 1;
      }
      if (!closed) return src;
      i = j + 1;
      continue;
    }

    let j = i + 1;
    let closed = false;
    while (j < src.length) {
      const c = src[j];
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === ch) {
        closed = true;
        break;
      }
      // A newline ends an unterminated quoted string — not this scanner's
      // assumption about the source, so say nothing rather than guess.
      if (c === "\n") break;
      j += 1;
    }
    if (!closed) return src;
    for (let k = i + 1; k < j; k += 1) out[k] = " ";
    i = j + 1;
  }
  return out.join("");
}

/**
 * Every internal specifier a source file imports, and whether anything about
 * its imports could not be read.
 */
export function readSpecifiers(source: string): {
  readonly specifiers: readonly string[];
  readonly opaque: boolean;
} {
  const src = stripComments(source);
  const specifiers: string[] = [];

  /*
    Anchored to a statement BOUNDARY, never to a line, and never matched loose.

    A bare /from\s*["']…["']/ over the whole source reads `from "…"` inside
    ordinary strings as an import. Measured against the prime: it invented
    specifiers like `", "` and `"${heading}"` out of SQL and template
    literals, and 21 of 425 bundles fell back to carrying the whole 6.42 MB
    tree for it — the exact payload this exists to avoid. So an `import` or
    `export` keyword is required, and the span before its `from` may contain
    neither a semicolon (which would cross into the next statement) nor a
    backtick (which would mean a template literal).

    Anchoring that to `^` was wrong, and cost a real deployment. Several of
    the prime's functions are MINIFIED onto one physical line —
    `market-updates-feed/index.ts` is six imports separated by `; ` — so only
    the first was seen, the walk found no internal edges at all, and the
    bundle pruned to its entrypoint alone. Deno then answered
    `Module not found "…/_shared/auth.ts"` at deploy. That is the failure this
    module's header calls far worse than an oversized bundle: a bundle missing
    a file it imports. It happened to fail loudly here; a lazier import would
    have failed at runtime on a tenant's clone.

    A statement begins at the start of a line OR after `;` or `}`, which is
    what the prefix matches. Newlines stay allowed, because a multi-line
    `import { … } from "x"` is ordinary.
  */
  for (const m of src.matchAll(
    /(?:^|[;}])[ \t]*(?:import|export)\s[^;`]*?\bfrom\s*["']([^"']+)["']/gm,
  )) {
    specifiers.push(m[1]);
  }
  for (const m of src.matchAll(/(?:^|[;}])[ \t]*import\s*["']([^"']+)["']/gm)) {
    specifiers.push(m[1]);
  }
  // `import("x")` and `await import("x")`, literal argument only.
  for (const m of src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) specifiers.push(m[1]);

  /*
    A dynamic import whose argument is NOT a plain literal cannot be followed,
    and this platform uses `await import(...)` heavily. Seeing one means the
    graph is incomplete and the bundle must not be pruned.

    Tested against the source with string CONTENTS blanked, because English is
    full of the phrase — "PDF import(s) failed in the last 24h." matched, and
    `pdf-import-monitoring` shipped the whole 6.44 MB tree over a plural. The
    blanking is for this test only; specifier extraction above needs the very
    literals it removes.

    The whitespace class sits INSIDE the lookahead on purpose. With `(?!["'])`
    alone, `\s*` may match nothing, and the lookahead then reads the newline
    before a literal that begins on the next line —
    `import(\n  './x.ts')` — as "not a quote", so a plain literal import is
    reported computed. Measured on the prime, 2 Sep 2026:
    `_shared/builderStock/repairSourceImages.ts` breaks one such import over
    two lines, and the two functions importing it carried the whole 6.65 MB
    tree and were refused 413 on every pass.
  */
  const opaque = /\bimport\s*\(\s*(?![\s"'])/.test(blankStringContents(src));

  return { specifiers, opaque };
}

/**
 * Walk a bundle from its entrypoint and keep only what it reaches.
 *
 * `textOf` returns a file's source, or null where it is not text (an asset, a
 * binary) — such a file is kept when reached but contributes no edges.
 */
export function pruneBundleToReachable(input: {
  readonly entrypointPath: string;
  readonly files: readonly BundleFileRef[];
  /** Kept whatever the walk finds: the runtime reads it, not the module graph. */
  readonly importMapPath: string | null;
  readonly textOf: (path: string) => string | null;
}): PruneOutcome {
  const all = input.files.map((f) => f.path);
  const present = new Set(all);
  const everything: PruneOutcome = { keep: all, pruned: false, reason: null };

  if (!present.has(input.entrypointPath)) {
    return { ...everything, reason: "the entrypoint is not among the bundle's files" };
  }

  const reached = new Set<string>([input.entrypointPath]);
  if (input.importMapPath && present.has(input.importMapPath)) reached.add(input.importMapPath);

  const queue = [input.entrypointPath];
  while (queue.length > 0) {
    const path = queue.shift() as string;
    const source = input.textOf(path);
    if (source === null) continue; // not text — reached, but contributes no edges

    const { specifiers, opaque } = readSpecifiers(source);
    if (opaque) {
      return { ...everything, reason: `${path} imports a computed specifier` };
    }

    for (const spec of specifiers) {
      if (isExternal(spec)) continue;
      const resolved = resolveRelative(path, spec);
      if (resolved === null) {
        /*
          Not relative and not a scheme this walk knows.

          With an import map present it may be an alias onto a bundle file, and
          this walk does not interpret import maps — so it is a real dependency
          that cannot be followed, and the bundle is carried whole.

          With NO import map it cannot be a bundle file at all: Deno rejects a
          bare specifier that no map resolves, so a working function cannot
          contain one. What it is instead is a scanner artefact — measured
          against the prime, five bundles fell back on invented specifiers like
          `", "` picked out of ordinary strings. Ignoring it there costs
          nothing and is not a guess about the module graph.
        */
        if (input.importMapPath) {
          return {
            ...everything,
            reason: `${path} imports "${spec}", which this walk cannot resolve`,
          };
        }
        continue;
      }
      if (!present.has(resolved)) {
        return {
          ...everything,
          reason: `${path} imports "${spec}", which the bundle does not hold`,
        };
      }
      if (!reached.has(resolved)) {
        reached.add(resolved);
        queue.push(resolved);
      }
    }
  }

  // Original order preserved: the entrypoint's position among the files is
  // meaningful to the deploy call, and reordering it would be a change nobody
  // asked for.
  return { keep: all.filter((p) => reached.has(p)), pruned: true, reason: null };
}
