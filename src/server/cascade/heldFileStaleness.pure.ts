/**
 * Does this cascade break a file it is not allowed to touch?
 *
 * ## The failure this exists for
 *
 * A `manual_reconcile` path is held because the clone's copy must win —
 * `src/App.tsx` carries route gates the prime does not have, so its routes are
 * brought across by hand. That hold is correct and it is not going away.
 *
 * What it cannot do is notice that a file the cascade DID deliver removed a
 * symbol the held file still imports. On 30 Aug 2026 the prime deleted
 * `AmlIntakeQueue` from `src/pages/aml/AmlShellPages.tsx` — deliberately; it
 * was a placeholder that rendered "Data wires in a later phase" and had
 * shipped to production. `AmlShellPages.tsx` cascaded to the clone.
 * `src/App.tsx` was held. The clone's `main` then carried an import of a
 * symbol nothing exported, and every Vercel deployment failed:
 *
 *     src/App.tsx (110:2): "AmlIntakeQueue" is not exported by
 *     "src/pages/aml/AmlShellPages.tsx", imported by "src/App.tsx".
 *
 * Nothing in the cascade reported a problem. Its summary read
 * `0 merged · 1 PRs · 1 awaiting manual reconcile`, which is what it reads on
 * every healthy run where a held path differs — the ordinary state, not this.
 *
 * `syncExclusions.pure.ts` already records the same class in the other
 * direction: the prime ADDED two routes plus source tests, the tests cascaded,
 * the routes could not, and the clone's CI was red for twelve hours. A removal
 * breaks it harder. An added route fails a test; a removed export fails the
 * build.
 *
 * ## What it will and will not claim
 *
 * A false positive holds a cascade that was fine, so every rule here is
 * written to stay silent unless it is certain:
 *
 *   - Only NAMED imports are considered. `import X from` and
 *     `import * as X from` do not fail this way.
 *   - A module carrying `export * from` is NOT exhaustively enumerable, so it
 *     is skipped entirely rather than guessed at.
 *   - A specifier that does not resolve to a file in this cascade is skipped:
 *     the file is not changing, so it cannot be what broke.
 *   - Only files the cascade is ACTUALLY delivering are examined. A held
 *     file's other imports are somebody else's problem and not this run's.
 *
 * Pure, so the rule is asserted against real production sources — the App.tsx
 * and AmlShellPages.tsx pair above is a test case — without a repository, a
 * token, or a network.
 */

export type StaleHeldReference = {
  /** The held file that will not compile — e.g. `src/App.tsx`. */
  heldPath: string;
  /** The cascaded file that stopped exporting it. */
  cascadedPath: string;
  /** The symbols the held file imports and the new content no longer exports. */
  missing: string[];
};

/** Extensions tried when resolving a specifier to a file in the cascade. */
const EXTENSIONS = [".ts", ".tsx", ".d.ts", "/index.ts", "/index.tsx"];

/**
 * Strip comments and string bodies so a `//` inside a URL, or the word
 * `export` inside prose, cannot be read as code.
 *
 * Deliberately crude and deliberately LOSSY in the safe direction: anything it
 * mangles produces fewer matches, and fewer matches means fewer claims.
 */
/**
 * Comments removed, so a path named in prose never counts as a reference.
 *
 * Quoted strings are stepped over rather than scanned, and that is not a
 * nicety. `"supabase/functions/**"` contains `/*`, so a regex that treats the
 * first `/*` it sees as a comment opens one inside a glob and closes it at the
 * next `*` + `/` anywhere in the file — swallowing every import in between.
 * The engine's own source has eleven such globs; scanning it that way loses
 * two thirds of the file.
 */
export function stripNonCode(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    // A string or template literal is copied through verbatim. Anything that
    // looks like a comment inside it is text.
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < source.length) {
        if (source[i] === "\\") {
          out += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += source[i];
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      // An unterminated block comment runs to the end of the file, which is
      // what a compiler would do with it too.
      const stop = end === -1 ? source.length : end + 2;
      // Newlines are kept so line-based readers downstream stay aligned.
      out += source.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
      continue;
    }

    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      out += " ".repeat(stop - i);
      i = stop;
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

/** One `import { … } from "…"` in a module, flattened to the local names. */
export type NamedImport = { specifier: string; names: string[] };

export function namedImportsOf(source: string): NamedImport[] {
  const code = stripNonCode(source);
  const out: NamedImport[] = [];
  // `import ... { a, b as c } ... from "spec"` — the brace group is what
  // matters; a default or namespace binding before it is ignored on purpose.
  const re = /import\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const names = m[1]
      .split(",")
      .map((raw) => raw.trim())
      .filter(Boolean)
      // `X as Y` imports X from the module; the local alias is irrelevant here.
      .map((raw) =>
        raw
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0]
          .trim(),
      )
      .filter((n) => /^[\w$]+$/.test(n));
    if (names.length > 0) out.push({ specifier: m[2], names });
  }
  return out;
}

export type ModuleExports = {
  names: Set<string>;
  /** False when `export * from` makes the list impossible to complete. */
  exhaustive: boolean;
};

export function exportedNamesOf(source: string): ModuleExports {
  const code = stripNonCode(source);
  const names = new Set<string>();

  // `export * from "..."` re-exports an unknown set. Anything after this point
  // is a guess, and a guess that holds a cascade is worse than no check.
  const exhaustive = !/export\s+\*\s+from/.test(code);

  // export { a, default as b, c as d }  (with or without a `from` clause)
  for (const m of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const raw of m[1].split(",")) {
      const part = raw.trim().replace(/^type\s+/, "");
      if (!part) continue;
      // The EXPORTED name is what a consumer imports: the right side of `as`.
      const exported = part.includes(" as ")
        ? part
            .split(/\s+as\s+/)
            .pop()!
            .trim()
        : part;
      if (/^[\w$]+$/.test(exported)) names.add(exported);
    }
  }

  // export const/let/var/function/class/type/interface/enum NAME
  for (const m of code.matchAll(
    /export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|type|interface|enum)\s+([\w$]+)/g,
  )) {
    names.add(m[1]);
  }

  return { names, exhaustive };
}

/**
 * Resolve an import specifier to the repo paths it could name.
 *
 * Handles the two forms this codebase uses: relative (`./pages/aml/Foo`) and
 * the `@/` alias for `src/`. A bare package specifier resolves to nothing,
 * which is correct — node_modules is not in the cascade.
 */
export function resolveSpecifier(fromPath: string, specifier: string): string[] {
  let base: string;
  if (specifier.startsWith("@/")) {
    base = `src/${specifier.slice(2)}`;
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const dir = fromPath.split("/").slice(0, -1);
    for (const seg of specifier.split("/")) {
      if (seg === "." || seg === "") continue;
      if (seg === "..") dir.pop();
      else dir.push(seg);
    }
    base = dir.join("/");
  } else {
    return [];
  }
  // An explicit extension is already a path.
  if (/\.[cm]?tsx?$/.test(base)) return [base];
  return EXTENSIONS.map((e) => `${base}${e}`);
}

export type StalenessInput = {
  /** Held files, by repo path, with the content the CLONE keeps. */
  heldFiles: Readonly<Record<string, string>>;
  /** Files this cascade delivers, by repo path, with the content it delivers. */
  cascadedFiles: Readonly<Record<string, string>>;
};

/**
 * Every symbol a held file imports that this cascade is about to remove.
 *
 * Empty means the cascade does not break any held file — not that the held
 * files agree with the prime, which they never do and are not meant to.
 */
export function findStaleHeldReferences(input: StalenessInput): StaleHeldReference[] {
  const out: StaleHeldReference[] = [];

  for (const [heldPath, heldSource] of Object.entries(input.heldFiles)) {
    for (const imp of namedImportsOf(heldSource)) {
      const candidates = resolveSpecifier(heldPath, imp.specifier);
      const target = candidates.find((c) => c in input.cascadedFiles);
      // Not a file this cascade is changing — it cannot be what breaks.
      if (!target) continue;

      const exports = exportedNamesOf(input.cascadedFiles[target]);
      if (!exports.exhaustive) continue;

      const missing = imp.names.filter((n) => !exports.names.has(n));
      if (missing.length === 0) continue;

      const already = out.find((r) => r.heldPath === heldPath && r.cascadedPath === target);
      if (already) {
        for (const n of missing) if (!already.missing.includes(n)) already.missing.push(n);
      } else {
        out.push({ heldPath, cascadedPath: target, missing: [...missing] });
      }
    }
  }

  return out;
}

/** One line per breakage, for a pull request body and a cascade summary. */
export function describeStaleHeldReferences(refs: readonly StaleHeldReference[]): string[] {
  return refs.map(
    (r) =>
      `\`${r.heldPath}\` imports ${r.missing.map((m) => `\`${m}\``).join(", ")} from ` +
      `\`${r.cascadedPath}\`, which this cascade no longer exports.`,
  );
}

// ─── The other direction: what the held file never received ──────────────────

export type MissingHeldReference = {
  /** The held file that is behind — e.g. `src/App.tsx`. */
  heldPath: string;
  /** The cascaded module the prime's copy pulls these from. */
  cascadedPath: string;
  /** Symbols the PRIME's copy imports and this clone's copy does not. */
  missing: string[];
};

/**
 * Everything the prime's held file uses from this cascade that the clone's
 * copy has not been given.
 *
 * `findStaleHeldReferences` catches a REMOVAL: a held file importing a symbol
 * that a cascaded file stopped exporting. That fails the build, loudly, which
 * is why it was findable at all.
 *
 * An ADDITION fails nothing. On 30 Aug 2026 the prime added
 * `AmlAustracReportDraft` and two routes for it; the cascade delivered the
 * page, the shell re-export and a source test asserting the routes, and could
 * not deliver `src/App.tsx`, which is held. The clone was left without the
 * routes. That was caught only because a test happened to assert them — a route
 * with no test would simply have been missing, on a clone nobody was comparing.
 *
 * `syncExclusions.pure.ts` records the same shape from the first time it
 * happened, with `/passport/:token`, and twelve hours of red CI.
 *
 * ## What makes this decidable
 *
 * The prime's copy of the held file is available — it is the copy the cascade
 * DECLINED to write, so it has already been read. Comparing the two copies in
 * general is useless (they differ on purpose; that is what "held" means), but
 * comparing them on ONE axis is not: a symbol the prime imports from a module
 * this cascade is delivering, which the clone imports from nowhere, is wiring
 * the clone was never handed.
 *
 * Restricted three ways so it stays quiet:
 *   - only modules THIS cascade delivers, so unrelated divergence is invisible;
 *   - only symbols the delivered module actually exports, so a prime-side
 *     import of something that never arrived is not double-reported (the
 *     removal check owns that);
 *   - matched on the RESOLVED target, so `@/pages/x` and `./pages/x` are the
 *     same module and an alias is never mistaken for an absence.
 */
export function findMissingHeldReferences(input: {
  /** Held files as the CLONE keeps them. */
  heldFilesClone: Readonly<Record<string, string>>;
  /** The same paths as the PRIME has them — the copy the cascade withheld. */
  heldFilesPrime: Readonly<Record<string, string>>;
  /** Files this cascade delivers, with the content it delivers. */
  cascadedFiles: Readonly<Record<string, string>>;
}): MissingHeldReference[] {
  const out: MissingHeldReference[] = [];

  for (const [heldPath, primeSource] of Object.entries(input.heldFilesPrime)) {
    const cloneSource = input.heldFilesClone[heldPath];
    // A held path the clone does not have at all is a different question, and
    // not this one's to answer.
    if (typeof cloneSource !== "string") continue;

    // What the clone already imports, keyed by resolved module plus symbol.
    const cloneHas = new Set<string>();
    for (const imp of namedImportsOf(cloneSource)) {
      for (const target of resolveSpecifier(heldPath, imp.specifier)) {
        for (const name of imp.names) cloneHas.add(`${target} ${name}`);
      }
    }

    for (const imp of namedImportsOf(primeSource)) {
      const candidates = resolveSpecifier(heldPath, imp.specifier);
      const target = candidates.find((c) => c in input.cascadedFiles);
      if (!target) continue;

      const exports = exportedNamesOf(input.cascadedFiles[target]);
      const missing = imp.names.filter(
        (n) =>
          // The delivered module really provides it ...
          (exports.exhaustive ? exports.names.has(n) : true) &&
          // ... and the clone's copy asks for it from nowhere.
          !cloneHas.has(`${target} ${n}`),
      );
      if (missing.length === 0) continue;

      const already = out.find((r) => r.heldPath === heldPath && r.cascadedPath === target);
      if (already) {
        for (const n of missing) if (!already.missing.includes(n)) already.missing.push(n);
      } else {
        out.push({ heldPath, cascadedPath: target, missing: [...missing] });
      }
    }
  }

  return out;
}

/** One line per gap, for a pull request body and a cascade summary. */
export function describeMissingHeldReferences(refs: readonly MissingHeldReference[]): string[] {
  return refs.map(
    (r) =>
      `\`${r.heldPath}\` upstream uses ${r.missing.map((m) => `\`${m}\``).join(", ")} from ` +
      `\`${r.cascadedPath}\`; this clone's copy does not, so the wiring never arrived.`,
  );
}
