// What a scan's summary says about the rules it ran and the controls it was
// told to honour, read defensively: the summary is written by a workflow in
// the scanned repository, so every field is optional and any shape may come
// back. Pure; used by the PR check and the scan drawer.

export type ControlChange = { path: string; change: "added" | "removed" | "modified" };

/**
 * A pull request's edits to what the scanners ignore (.gitleaksignore,
 * .semgrepignore, …), the rules, or the scan workflows, and the inline
 * suppression comments it adds. The PR itself is scanned with the base's
 * copies of those files, but its edits take effect for every scan after it
 * merges. An inline comment is different: it is part of the code, so it
 * silences the scanner on the PR's own scan too.
 */
export type SuppressionChanges = {
  changed: ControlChange[];
  /** Lines semgrep now skips (its `nosemgrep` / `nosem` marker). */
  semgrepIgnoresAdded: number;
  /** Lines gitleaks now skips (its inline allow marker). */
  gitleaksAllowsAdded: number;
};

export type SemgrepRuleset = {
  /** vendored: committed in the repo · registry: downloaded and hashed · registry-unrecorded: fetched by semgrep, not hashed */
  source: string;
  /** For vendored rules, the commit they were read from. */
  ref: string | null;
  digest: string;
  files: Array<{ name: string; sha256: string }>;
};

export type RulesetComparison =
  | { status: "same" }
  | {
      status: "changed";
      added: string[];
      removed: string[];
      modified: string[];
      sourceChanged: boolean;
    }
  | { status: "unknown"; reason: string };

const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type SeverityCounts = Record<(typeof SEVERITIES)[number], number>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;

/** The PR's changes to scanner controls, or null when it made none (or the scan predates reporting them). */
export function readSuppressionChanges(summary: unknown): SuppressionChanges | null {
  const s = isRecord(summary) && isRecord(summary.suppressions) ? summary.suppressions : null;
  if (!s) return null;
  const changed: ControlChange[] = (Array.isArray(s.changed) ? s.changed : [])
    .filter(isRecord)
    .map((c) => ({
      path: str(c.path, 300),
      change: c.change === "added" || c.change === "removed" ? c.change : ("modified" as const),
    }))
    .filter((c): c is ControlChange => c.path !== null)
    .slice(0, 50);
  const count = (v: unknown) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : 0;
  };
  const semgrepIgnoresAdded = count(s.nosemgrep_added);
  const gitleaksAllowsAdded = count(s.gitleaks_allow_added);
  return changed.length || semgrepIgnoresAdded || gitleaksAllowsAdded
    ? { changed, semgrepIgnoresAdded, gitleaksAllowsAdded }
    : null;
}

/** The semgrep rules a scan ran, as the workflow recorded them, or null. */
export function readSemgrepRuleset(summary: unknown): SemgrepRuleset | null {
  const r =
    isRecord(summary) && isRecord(summary.rulesets) && isRecord(summary.rulesets.semgrep)
      ? summary.rulesets.semgrep
      : null;
  return r ? normalizeRuleset(r) : null;
}

/** The same, from a bare ruleset record (e.g. selected straight out of the summary). */
export function normalizeRuleset(raw: unknown): SemgrepRuleset | null {
  if (!isRecord(raw)) return null;
  const source = str(raw.source, 40);
  const digest = str(raw.digest, 64);
  if (!source || !digest) return null;
  const files = (Array.isArray(raw.files) ? raw.files : [])
    .filter(isRecord)
    .map((f) => ({ name: str(f.name, 300), sha256: str(f.sha256, 64) }))
    .filter((f): f is { name: string; sha256: string } => f.name !== null && f.sha256 !== null)
    .slice(0, 200);
  return { source, ref: str(raw.ref, 64), digest, files };
}

/**
 * Whether two scans ran the same semgrep rules. The same code can pass one
 * night and fail the next because the registry's rules moved; this is how the
 * drawer tells that apart from a code change.
 */
export function compareRulesets(
  current: SemgrepRuleset | null,
  previous: SemgrepRuleset | null,
): RulesetComparison {
  if (!current) return { status: "unknown", reason: "this scan did not record its rules" };
  if (!previous) return { status: "unknown", reason: "no earlier scan recorded its rules" };
  if (current.source === "registry-unrecorded" || previous.source === "registry-unrecorded") {
    return {
      status: "unknown",
      reason: "a registry download failed, so not every rule was hashed",
    };
  }
  if (current.digest === previous.digest) return { status: "same" };
  const before = new Map(previous.files.map((f) => [f.name, f.sha256]));
  const after = new Map(current.files.map((f) => [f.name, f.sha256]));
  return {
    status: "changed",
    added: [...after.keys()].filter((n) => !before.has(n)),
    removed: [...before.keys()].filter((n) => !after.has(n)),
    modified: [...after.entries()]
      .filter(([n, h]) => before.has(n) && before.get(n) !== h)
      .map(([n]) => n),
    sourceChanged: current.source !== previous.source,
  };
}

/** Findings per scanner and severity, as the workflow counted them, largest first. */
export function readScannerCounts(
  summary: unknown,
): Array<{ scanner: string; counts: SeverityCounts; total: number }> {
  const by = isRecord(summary) && isRecord(summary.by_scanner) ? summary.by_scanner : null;
  if (!by) return [];
  return Object.entries(by)
    .filter((e): e is [string, Record<string, unknown>] => isRecord(e[1]))
    .slice(0, 20)
    .map(([scanner, raw]) => {
      const counts = Object.fromEntries(
        SEVERITIES.map((s) => {
          const n = Number(raw[s]);
          return [s, Number.isInteger(n) && n > 0 ? n : 0];
        }),
      ) as SeverityCounts;
      return {
        scanner: scanner.slice(0, 60),
        counts,
        total: SEVERITIES.reduce((t, s) => t + counts[s], 0),
      };
    })
    .sort((a, b) => b.total - a.total || a.scanner.localeCompare(b.scanner));
}
