/**
 * A workflow that JUDGES the repository may only travel to a clone that holds
 * the repository.
 *
 * ## The defect
 *
 * `.github/workflows/**` is a repository invariant — the workflow file *is* the
 * definition of what a clone must pass, so a clone running a workflow the prime
 * has since fixed is being judged by a standard nobody maintains any more. That
 * argument is sound for a MIRROR, which receives the whole tree by blob-SHA
 * diff, and false for a module-scoped clone, which receives
 * `listFilesMatchingGlobs(prime, installedGlobs)` plus the invariants and
 * nothing else.
 *
 * Delivering prime's `ci.yml` to a partial tree hands the clone a judge for
 * files it was never sent. Measured 9 Sep 2026: prime's `ci.yml` carries a
 * `builder-stock-pdf-worker` job whose first command is
 *
 *     deno check cloudflare/builder-stock-pdf-worker/src/index.ts
 *
 * Neither `npc-test-76b3b3` nor `preflight-property-group` holds that directory
 * at all — both carry `cloudflare/builder-stock-image-worker` and nothing else
 * under `cloudflare/` — and no installed module's globs reach `cloudflare/**`.
 * The job went red on both clones the moment the file arrived, on every pull
 * request, with nothing the cascade could ever send to fix it. It also broke
 * base-inheritance while it was there: `reclassifyAgainstBase` can only call a
 * failure the base branch's when the base runs the same job, and a job that
 * exists solely on the head never can.
 *
 * `repositoryInvariants.pure.ts` records five rounds of trying to close that
 * gap by widening the payload instead — deliver the judge, then deliver what the
 * judge reads, then what THAT reads. The closure is not finite: the next check
 * reads the next thing. So the rule is inverted here. Rather than growing the
 * tree until the judge is satisfied, the judge is withheld until the tree can
 * answer it.
 *
 * ## Derived from the workflow, never listed
 *
 * A hand-kept list of "workflows a clone may have" would sit in this repository
 * and describe files in another one; the next workflow prime adds is absent
 * from it, and absent means whatever the default is. So the decision is read
 * from the workflow's own `on:` block, which is the only place that says what
 * the file is FOR:
 *
 *   - `pull_request` / `push` — it judges a tree. Every run is a verdict on the
 *     repository it sits in, and it appears as a check on the clone's cascade
 *     pull request. **Held.**
 *   - `schedule` / `workflow_dispatch` / anything else — it performs an
 *     operation somebody asked for. It cannot turn a pull request red, and its
 *     inputs are the operator's problem at the moment they run it. **Travels.**
 *
 * Measured against prime's eighteen workflows on 9 Sep 2026: four judge
 * (`ci.yml`, `pdf-extraction-v3-gates.yml`, `pdf-import-regression.yml`,
 * `pdf-import-release-gate.yml`) and three more carry `push`
 * (`deploy-pdf-parse-service.yml`, `deploy-supabase-functions.yml`,
 * `deploy-weasyprint-service.yml`). The eleven that remain — the AML register
 * loaders, the secret rotations, the Codex scans — read `scripts/**` and
 * `package.json`, both of which ARE invariants, and keep cascading exactly as
 * they do today.
 *
 * ## Held, not dropped
 *
 * The verdict is a `HeldPath` with reason `manual_reconcile`, which is the
 * existing mechanism for "the clone's version is deliberately not prime's":
 * withheld from the commit AND named in the pull request. A silently skipped
 * file is indistinguishable from one that never changed, and this is a file an
 * operator may well want to port a job out of by hand.
 *
 * ## A mirror is never held
 *
 * The caller passes `scope`. For a mirror the judge and the tree match by
 * construction, so holding would withhold a correct file and freeze that
 * clone's CI at whatever it forked with — the exact failure this module exists
 * to prevent, in the other direction.
 */

import type { HeldPath } from "./syncExclusions.pure";

/** Anything under this prefix is a GitHub Actions workflow definition. */
const WORKFLOW_PREFIX = ".github/workflows/";

/**
 * The triggers that make a workflow a verdict on the tree rather than an
 * operation on it.
 *
 * `push` is here as well as `pull_request` because the cascade's merge lands on
 * the clone's default branch: a `push`-triggered workflow that cannot pass runs
 * on every merge and leaves a permanent red on the branch, which is what an
 * operator looks at to decide whether the clone is healthy.
 */
const JUDGING_TRIGGERS = new Set(["pull_request", "pull_request_target", "push"]);

export function isWorkflowPath(path: string): boolean {
  return (
    path.startsWith(WORKFLOW_PREFIX) && (path.endsWith(".yml") || path.endsWith(".yaml"))
  );
}

/**
 * The trigger names in a workflow's `on:` block.
 *
 * Written by hand rather than with a YAML parser because this repository ships
 * none, and because the question is deliberately narrow: the NAMES at one level
 * of one top-level key. Every form GitHub accepts is handled, including the
 * quoted key — YAML 1.1 reads a bare `on` as the boolean `true`, so a workflow
 * may legitimately spell it `"on":` or `'on':` and several linters insist on
 * it.
 *
 * Returns an empty list for a file with no `on:` block at all. The caller must
 * treat that as "not a judge", because a workflow with no triggers never runs
 * — and guessing the other way would hold every file this function fails to
 * read.
 */
export function workflowTriggers(yaml: string): string[] {
  const lines = yaml.split(/\r?\n/);
  const triggers: string[] = [];

  let inOn = false;
  for (const line of lines) {
    if (!inOn) {
      // Top-level `on:` — column zero, optionally quoted.
      const head = /^(?:on|"on"|'on')\s*:(.*)$/.exec(line);
      if (!head) continue;
      inOn = true;

      // Inline forms: `on: push` and `on: [push, pull_request]`.
      const rest = head[1].replace(/#.*$/, "").trim();
      if (rest.length > 0) {
        const flow = /^\[(.*)\]$/.exec(rest);
        const items = flow ? flow[1].split(",") : [rest];
        for (const item of items) {
          const name = item.trim().replace(/^['"]|['"]$/g, "");
          if (name) triggers.push(name);
        }
        // An inline `on:` has no block under it; nothing more to read.
        return [...new Set(triggers)];
      }
      continue;
    }

    // Inside the block. A line at column zero that is not blank and not a
    // comment ends it — that is the next top-level key.
    if (/^\S/.test(line)) break;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;
    // Only the first level under `on:` names a trigger. Anything deeper is that
    // trigger's own configuration (`branches`, `paths`, `inputs`, `cron`), and
    // `paths:` in particular would otherwise read as a trigger called "paths".
    if (indent > 2) continue;

    const seq = /^-\s*(.+)$/.exec(trimmed);
    const name = (seq ? seq[1] : trimmed.replace(/:.*$/, ""))
      .trim()
      .replace(/^['"]|['"]$/g, "");
    if (name) triggers.push(name);
  }

  return [...new Set(triggers)];
}

/** Does this workflow deliver a verdict on the repository it sits in? */
export function judgesTheTree(yaml: string): boolean {
  return workflowTriggers(yaml).some((t) => JUDGING_TRIGGERS.has(t));
}

/**
 * Decide whether prime's copy of one workflow may be written to this clone.
 *
 * Returns `null` when the file may travel — which is the answer for every path
 * that is not a workflow, for every mirror, and for every workflow that is an
 * operation rather than a verdict.
 */
export function judgingWorkflowHold(args: {
  path: string;
  primeContent: string;
  /** `mirror` receives the whole tree, so its judge always has its tree. */
  scope: "mirror" | "modules";
}): HeldPath | null {
  const { path, primeContent, scope } = args;
  if (scope === "mirror") return null;
  if (!isWorkflowPath(path)) return null;

  const triggers = workflowTriggers(primeContent);
  const judging = triggers.filter((t) => JUDGING_TRIGGERS.has(t));
  if (judging.length === 0) return null;

  return {
    path,
    pattern: "(content: judges the whole repository)",
    reason: "manual_reconcile",
    note:
      `Runs on ${judging.join(", ")}, so it is a verdict on the tree it sits in. This clone is ` +
      `module-scoped and holds a subset of the prime's tree, so a job here can read a path the ` +
      `cascade will never send — and the check is then red on every pull request with no payload ` +
      `able to fix it. Port the jobs that apply to what this clone holds, by hand.`,
  };
}
