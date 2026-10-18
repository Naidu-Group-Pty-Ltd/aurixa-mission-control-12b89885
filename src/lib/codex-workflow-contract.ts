// What the two Codex workflows (.github/workflows/codex-security-scan.yml and
// codex-remediation.yml) promise Mission Control, by version.
//
// Each workflow declares `WORKFLOW_VERSION` in its job env and sends it with
// every callback. Version 2 is the first that:
//   - reads its callback key from the event payload and masks it, rather than
//     printing it in every step's env dump;
//   - signs `<timestamp>.<body>` and sends `x-codex-timestamp`;
//   - reports each scanner's real outcome as `status`, so a scanner that
//     failed can never resolve findings by its absence;
//   - fingerprints by content, not line number.
// Version 3 is the first that:
//   - scans a pull request with the base's ignore files (.gitleaks.toml,
//     .gitleaksignore, .semgrepignore, osv-scanner.toml), so a change cannot
//     exempt itself, and reports the change's edits to them and the inline
//     suppressions it adds;
//   - records which semgrep rules ran (vendored or downloaded, hashed) and
//     counts findings per scanner;
//   - refuses a drafted fix that silences a scanner instead of fixing the
//     code, and catches CI changes git would have quoted or shown as renames.
// The contract test keeps these constants equal to the YAML.

export const CODEX_SCAN_WORKFLOW_VERSION = 3;
export const CODEX_REMEDIATION_WORKFLOW_VERSION = 3;

/** The version a scan reported, or 1 for workflows that predate versioning. */
export function reportedWorkflowVersion(summary: unknown): number {
  const raw = (summary as { workflow_version?: unknown } | null)?.workflow_version;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/** The `WORKFLOW_VERSION` a workflow file declares, or null when it declares none. */
export function declaredWorkflowVersion(yamlText: string): number | null {
  const m = /^\s*WORKFLOW_VERSION:\s*["']?(\d+)["']?\s*(?:#.*)?$/m.exec(yamlText);
  return m ? Number(m[1]) : null;
}
