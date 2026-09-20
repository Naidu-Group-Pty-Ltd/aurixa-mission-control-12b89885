/**
 * Read a source file as CODE, with its prose removed.
 *
 * ## Why this exists at all
 *
 * Two source contracts in this repository ask "does anything reference X?",
 * and both were answered wrongly by a comment:
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
 *
 * One implementation rather than two, because two copies of a rule is how
 * two copies come to disagree, and this one has been wrong twice already in
 * ways that took a measurement to see.
 *
 * ## Why it is LINE-ORIENTED and not a regex over the file
 *
 * The obvious `/\/\*[\s\S]*?\*\//` is not safe on this codebase, measured
 * rather than feared. Two shapes here break it, and both produced FALSE
 * results — the failure that gets a gate switched off:
 *
 *     redirectSet.add(`${site}/*`);   // an opener inside a template literal:
 *                                     // a file-wide regex runs to the next
 *                                     // closer and eats the declaration below
 *
 *     const { retargetCloneRepo } = await import(
 *       /* @vite-ignore *\/ "@/lib/_server-shims/clone-repo-retarget.server"
 *     );                              // a comment that CLOSES mid-line: a
 *                                     // tracker asking whether the line ENDS
 *                                     // with the closer eats the rest of the
 *                                     // module
 *
 * So a line opens a block only when its first non-space characters are the
 * opener — which a `/*` inside an expression never is — and the closer is
 * looked for anywhere after it, with the tail kept.
 *
 * It is deliberately CONSERVATIVE: a trailing comment after code survives, so
 * a reference hiding there still reads as real. Erring toward keeping prose
 * is the right direction for both callers — a missed orphan costs a name a
 * list does not carry, and a lane detected for a comment is judged rather
 * than skipped. Inventing a finding costs every run.
 */
export function stripComments(source: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of source.split("\n")) {
    const t = line.trim();
    if (inBlock) {
      const close = t.indexOf("*/");
      if (close === -1) {
        out.push("");
      } else {
        inBlock = false;
        out.push(t.slice(close + 2));
      }
      continue;
    }
    if (t.startsWith("//")) {
      out.push("");
      continue;
    }
    if (t.startsWith("/*")) {
      const close = t.indexOf("*/", 2);
      if (close === -1) {
        inBlock = true;
        out.push("");
      } else {
        out.push(t.slice(close + 2));
      }
      continue;
    }
    out.push(line);
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
 * blanking it would hide genuine calls. A name inside a regex literal also
 * still counts — telling a regex from a division needs a tokeniser, and a
 * wrong one invents findings.
 */
export function stripCommentsAndStrings(source: string): string {
  return stripComments(source)
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
}
