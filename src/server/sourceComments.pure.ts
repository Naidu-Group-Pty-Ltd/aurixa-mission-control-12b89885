/**
 * Read a source file as CODE, with its prose removed.
 *
 * ## Why this exists at all
 *
 * Source-level contract tests are this repository's dominant idiom, and they
 * all ask the same shape of question: *does anything reference X?* A stripper
 * that answers wrongly does not fail — it produces a confident number, which
 * is the failure that gets a gate switched off. Three have already been
 * answered wrongly by a comment:
 *
 * - `serverExportsHaveCallers.contract.test.ts` derives the exported server
 *   functions nothing calls. The orphan it was built for —
 *   `buildPrimeLedgerReconciliation` — is named in the prose of two modules
 *   and a test, so a scan that read comments called it reached.
 * - `everyGithubLaneYields.contract.test.ts` derives the cron lanes that
 *   reach the App installation. `githubUsageMeter.ts` mentions
 *   `getAppOctokit` in a comment, and a route's own header explaining WHERE
 *   its GitHub call lives contains the same token — so a lane detected
 *   itself on its own documentation.
 * - Forty test and production modules carried a private
 *   `replace(/\/\*[\s\S]*?\*\//g, "")`. Measured 20 Sep 2026: that expression
 *   destroys **1,056 lines of real code across 66 files**, and **ten** of the
 *   forty read a file it damages — 123 lines out of `cascade-engine.server.ts`
 *   beginning at `partitionCascadePaths(…)`, and 20 out of
 *   `backend-provisioning.server.ts` beginning at
 *   `` redirectSet.add(`${site}/*`) ``.
 *
 * One implementation rather than forty-three, because two copies of a rule is
 * how two copies come to disagree, and this one has been wrong three times in
 * ways that took a measurement to see.
 *
 * ## The rule it is built on: NEVER EAT CODE
 *
 * Every defect above is the same defect. `/\/\*[\s\S]*?\*\//` does not know
 * what a string is, so anything that merely *spells* an opener starts a
 * comment that runs to the next `*\/` anywhere below. Measured across `src/`,
 * the openers are rarely comments at all — they are **data**:
 *
 *     pattern: "scripts/**"                   a glob, in a string
 *     redirectSet.add(`${site}/*`)            a glob, in a template literal
 *     // `src/integrations/**` would other…   a glob, quoted inside prose
 *
 * So this scans with string awareness, and where it cannot tell code from
 * prose it **declines rather than guesses**. A line carrying a bare `/` that
 * is neither `//` nor `/*` is ambiguous — a regex literal and a division are
 * not separable without a tokeniser, and a tokeniser that gets it wrong eats
 * code. Such a line is returned WHOLE, keeping any trailing comment on it.
 *
 * That asymmetry is the whole design. Keeping prose costs a contract test a
 * name it must be written to tolerate. Eating code costs it the truth, in
 * silence, on every run.
 *
 * ## What it removes
 *
 * - A whole-line `//` comment, and a whole-line or multi-line `/* … *\/` block.
 * - A **trailing** `//` comment after code, on an unambiguous line.
 * - A single-line `/* … *\/` in the middle of code, on an unambiguous line —
 *   which is how `import(/* @vite-ignore *\/ "…")` reads as the import it is.
 *
 * It preserves line count, so a reported line number still points at the
 * source, and `^`-anchored patterns still mean what they say.
 *
 * ## What it deliberately does not do
 *
 * A name inside a **regex literal** still counts as a reference, for the
 * reason above. A `*\/` inside a string *within* a block comment closes that
 * block early; modules here escape it (`*\\/`) by convention, and this file
 * does so in its own header.
 */

/** The outcome of reading one line: its code, and whether a block is left open. */
type LineScan = { text: string; opensBlock: boolean };

/**
 * One line, outside any block comment.
 *
 * Returns the line with its prose removed, or — where a bare `/` makes that
 * unsafe — the line exactly as it came in.
 */
function scanLine(line: string): LineScan {
  let out = "";
  let i = 0;
  // Template literals nest code in `${…}`, and that code may contain its own
  // strings and its own backticks. Without a stack, an inner backtick reads as
  // the outer one closing, and everything after it is scanned in the wrong
  // mode.
  const stack: Array<'"' | "'" | "`" | "${"> = [];
  const top = () => (stack.length ? stack[stack.length - 1] : null);

  while (i < line.length) {
    const c = line[i];
    const d = line[i + 1];
    const mode = top();

    if (mode === '"' || mode === "'" || mode === "`") {
      if (c === "\\") {
        out += line.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (mode === "`" && c === "$" && d === "{") {
        stack.push("${");
        out += "${";
        i += 2;
        continue;
      }
      if (c === mode) stack.pop();
      out += c;
      i += 1;
      continue;
    }

    // Code context (top level, or inside a template's `${…}`).
    if (c === '"' || c === "'" || c === "`") {
      stack.push(c);
      out += c;
      i += 1;
      continue;
    }
    if (mode === "${" && c === "}") {
      stack.pop();
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && d === "/") {
      // A trailing comment. Everything from here is prose.
      return { text: out, opensBlock: false };
    }
    if (c === "/" && d === "*") {
      const close = line.indexOf("*/", i + 2);
      if (close === -1) return { text: out, opensBlock: true };
      // A single-line block between code. One space, so `a/*x*/b` does not
      // silently become the identifier `ab`.
      out += " ";
      i = close + 2;
      continue;
    }
    if (c === "/") {
      // A regex literal or a division — not separable here. Decline.
      return { text: line, opensBlock: false };
    }
    out += c;
    i += 1;
  }
  return { text: out, opensBlock: false };
}

export function stripComments(source: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of source.split("\n")) {
    if (inBlock) {
      const close = line.indexOf("*/");
      if (close === -1) {
        out.push("");
        continue;
      }
      inBlock = false;
      const rest = scanLine(line.slice(close + 2));
      out.push(rest.text);
      inBlock = rest.opensBlock;
      continue;
    }
    const scan = scanLine(line);
    out.push(scan.text);
    inBlock = scan.opensBlock;
  }
  return out.join("\n");
}

/**
 * Prose removed AND quoted strings emptied.
 *
 * A name inside a quoted string is not a call: a source contract asserting
 * `toContain("someFunction")` is bookkeeping about that function, the same
 * way an orphan gate's own freeze list is. Measured over the whole of `src/`,
 * emptying them moves the orphan population by nothing and loses no
 * declaration.
 *
 * Template literals are left alone, because `${…}` holds real code and
 * blanking it would hide genuine calls.
 */
export function stripCommentsAndStrings(source: string): string {
  return stripComments(source)
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
}
