// What, out of a finished scan, is worth interrupting a person for. Pure; the
// server half (codex-scan-alerts.server.ts) reads the events and raises the
// notification.

export type AlertFinding = {
  event: "first_seen" | "regression" | "fix_ineffective";
  title: string;
  severity: string;
  /** Found by a secret scanner: a credential, not a code pattern. */
  secret: boolean;
};

export type FindingAlert = {
  severity: "error" | "warning";
  title: string;
  body: string;
  counts: { new_critical: number; new_secrets: number; regressions: number; ineffective: number };
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The alert for one scan's new and returning findings, or null when nothing
 * crosses the line. The line: a new critical finding, a new credential at high
 * or above, a high-or-critical finding coming back after it was resolved, or a
 * merged fix that did not remove its finding. Everything else waits for the
 * findings explorer — a notification for every medium is a channel people mute.
 */
export function newFindingAlert(label: string, findings: AlertFinding[]): FindingAlert | null {
  const isHighPlus = (s: string) => s === "critical" || s === "high";
  const newSecrets = findings.filter(
    (f) => f.event === "first_seen" && f.secret && isHighPlus(f.severity),
  );
  const newCritical = findings.filter(
    (f) => f.event === "first_seen" && !f.secret && f.severity === "critical",
  );
  const regressions = findings.filter((f) => f.event === "regression" && isHighPlus(f.severity));
  const ineffective = findings.filter((f) => f.event === "fix_ineffective");
  if (newSecrets.length + newCritical.length + regressions.length + ineffective.length === 0)
    return null;

  const parts = [
    newCritical.length ? plural(newCritical.length, "new critical finding") : null,
    newSecrets.length ? plural(newSecrets.length, "newly exposed secret") : null,
    regressions.length ? plural(regressions.length, "regression") : null,
    ineffective.length
      ? plural(ineffective.length, "merged fix that did not work", "merged fixes that did not work")
      : null,
  ].filter(Boolean);

  const listed = [...newSecrets, ...newCritical, ...regressions, ...ineffective];
  const lines = listed.slice(0, 5).map((f) => {
    const why =
      f.event === "regression"
        ? "came back"
        : f.event === "fix_ineffective"
          ? "fix did not work"
          : f.severity;
    return `• ${f.title.replace(/\s+/g, " ").slice(0, 140)} (${why})`;
  });
  if (listed.length > 5) lines.push(`…and ${listed.length - 5} more`);
  if (newSecrets.length) {
    lines.push("A committed credential stays exposed in history: rotate it, then mark it rotated.");
  }

  return {
    severity: newSecrets.length || newCritical.length ? "error" : "warning",
    title: `${label}: ${parts.join(", ")}`,
    body: lines.join("\n"),
    counts: {
      new_critical: newCritical.length,
      new_secrets: newSecrets.length,
      regressions: regressions.length,
      ineffective: ineffective.length,
    },
  };
}

/**
 * How many of the most recent scans, newest first, share the condition.
 * `null` (unknown — e.g. a scan that never reported its scanners) ends the
 * streak: an alert is for a pattern that is certain.
 */
export function consecutiveFailureStreak(newestFirst: (boolean | null | undefined)[]): number {
  let n = 0;
  for (const v of newestFirst) {
    if (v !== true) break;
    n += 1;
  }
  return n;
}
