// What a PR scan reports back to the pull request, as a GitHub check run.
//
// Before this, PR scans were invisible to the people who could act on them:
// findings lived only in Mission Control, nothing was posted to the PR, and a
// PR that introduced a critical issue merged as easily as one that did not.
// The check run is the PR author's view; whether it BLOCKS a merge is a branch
// protection setting on the repository (require the "Codex Security" check).
//
// Pure: inputs in, the check's conclusion and text out.

import type { SuppressionChanges } from "@/lib/codex-scan-provenance";

export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type FailOn = Severity | "never";

export const PR_CHECK_NAME = "Codex Security";

const RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export type PrCheckFinding = {
  title: string;
  severity: Severity;
  affected_file?: string | null;
  affected_line?: number | null;
  scanner?: string | null;
  rule_id?: string | null;
  description?: string | null;
};

export type PrCheckAnnotation = {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "failure" | "warning" | "notice";
  title: string;
  message: string;
};

export type PrCheckReport = {
  conclusion: "success" | "failure" | "neutral";
  title: string;
  summary: string;
  annotations: PrCheckAnnotation[];
};

/** GitHub accepts at most 50 annotations per request. */
export const MAX_ANNOTATIONS = 50;
/** Output summary/text limit is 65,535 characters; stay well inside it. */
const MAX_SUMMARY = 60_000;

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Findings at or above the threshold block; `never` blocks nothing. */
export function isBlocking(severity: Severity, failOn: FailOn): boolean {
  if (failOn === "never") return false;
  return RANK[severity] <= RANK[failOn];
}

export function buildPrCheckReport(input: {
  findings: PrCheckFinding[];
  failOn: FailOn;
  degraded: Array<{ name: string; reason: string }>;
  incomplete: boolean;
  /** The PR's edits to what the scanners ignore, and inline suppressions it adds. */
  suppressionChanges?: SuppressionChanges | null;
  scanUrl?: string | null;
  runUrl?: string | null;
}): PrCheckReport {
  const findings = [...input.findings].sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  const blocking = findings.filter((f) => isBlocking(f.severity, input.failOn));

  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) counts[f.severity] += 1;

  const controls = input.suppressionChanges ?? null;
  let conclusion: PrCheckReport["conclusion"];
  let title: string;
  if (blocking.length > 0) {
    conclusion = "failure";
    title = `${blocking.length} finding${blocking.length === 1 ? "" : "s"} at or above ${input.failOn}`;
  } else if (input.incomplete || input.degraded.length > 0) {
    // Not a pass: a scanner that did not run cannot vouch for this change.
    conclusion = "neutral";
    title = input.incomplete
      ? "Scan results incomplete — not every batch arrived"
      : `${input.degraded.length} scanner${input.degraded.length === 1 ? "" : "s"} did not run`;
  } else if (controls) {
    // Not a failure — teams do change what is ignored — but not a plain pass
    // either: the change governs every scan after this PR merges, and an
    // inline suppression silences its scanner on this PR's own scan.
    conclusion = "neutral";
    title = "Changes what the security scanners ignore — needs a reviewer's look";
  } else {
    conclusion = "success";
    title =
      findings.length === 0
        ? "No security findings in this change"
        : `${findings.length} lower-severity finding${findings.length === 1 ? "" : "s"}`;
  }

  const lines: string[] = [];
  lines.push(
    `| critical | high | medium | low | info |`,
    `|---|---|---|---|---|`,
    `| ${counts.critical} | ${counts.high} | ${counts.medium} | ${counts.low} | ${counts.info} |`,
    "",
  );
  lines.push(
    input.failOn === "never"
      ? "This check reports findings but is configured never to fail."
      : `This check fails on findings at or above **${input.failOn}**.`,
  );
  if (input.degraded.length) {
    lines.push("", "**Scanners that did not run** — their silence is not a clean result:");
    for (const d of input.degraded) lines.push(`- \`${d.name}\`: ${d.reason}`);
  }
  if (input.incomplete) {
    lines.push("", "**Some result batches never arrived**, so findings may be missing.");
  }
  if (controls) {
    lines.push("", "### Changes to what the scanners ignore", "");
    if (controls.changed.length) {
      lines.push(
        "This PR was scanned with the base branch's copies of these files; its edits apply to every scan after it merges.",
        "",
      );
      for (const c of controls.changed.slice(0, 20)) {
        lines.push(`- ${c.change} \`${c.path.replace(/[`\r\n]/g, "")}\``);
      }
      if (controls.changed.length > 20) lines.push(`- …and ${controls.changed.length - 20} more`);
    }
    const inline = [
      controls.semgrepIgnoresAdded
        ? `${controls.semgrepIgnoresAdded} line${controls.semgrepIgnoresAdded === 1 ? "" : "s"} semgrep will skip (\`nosemgrep\`)`
        : null,
      controls.gitleaksAllowsAdded
        ? `${controls.gitleaksAllowsAdded} line${controls.gitleaksAllowsAdded === 1 ? "" : "s"} gitleaks will skip (its allow comment)`
        : null,
    ].filter(Boolean);
    if (inline.length) {
      if (controls.changed.length) lines.push("");
      lines.push(
        `Adds inline suppressions: ${inline.join(" and ")}. ` +
          "They are part of the code, so they hide findings from this scan too — what they silence is not listed here.",
      );
    }
  }
  if (findings.length) {
    lines.push("", "### Findings in this change", "");
    for (const f of findings.slice(0, 30)) {
      const where = f.affected_file
        ? ` — \`${f.affected_file}${f.affected_line ? `:${f.affected_line}` : ""}\``
        : "";
      const by = f.scanner ? ` _(${f.scanner}${f.rule_id ? `: ${f.rule_id}` : ""})_` : "";
      lines.push(`- **${f.severity}** ${clamp(f.title.replace(/\s+/g, " "), 200)}${where}${by}`);
    }
    if (findings.length > 30) lines.push(`- …and ${findings.length - 30} more`);
  }
  const links = [
    input.scanUrl ? `[Open in Mission Control](${input.scanUrl})` : null,
    input.runUrl ? `[Scan run log](${input.runUrl})` : null,
  ].filter(Boolean);
  if (links.length) lines.push("", links.join(" · "));

  const annotations: PrCheckAnnotation[] = findings
    .filter((f) => f.affected_file && f.affected_line && f.affected_line > 0)
    .slice(0, MAX_ANNOTATIONS)
    .map((f) => ({
      path: f.affected_file as string,
      start_line: f.affected_line as number,
      end_line: f.affected_line as number,
      annotation_level:
        f.severity === "critical" || f.severity === "high"
          ? "failure"
          : f.severity === "medium"
            ? "warning"
            : "notice",
      title: clamp(`${f.severity}: ${f.title.replace(/\s+/g, " ")}`, 250),
      message: clamp(f.description?.trim() || f.title, 1000),
    }));

  return {
    conclusion,
    title: clamp(title, 250),
    summary: clamp(lines.join("\n"), MAX_SUMMARY),
    annotations,
  };
}
