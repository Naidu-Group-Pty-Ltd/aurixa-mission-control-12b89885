/**
 * The clone page's one line on how its backend compares with the prime (PF-30).
 *
 * `clone_backends.parity_report` was written at provisioning and read by
 * nothing: four of the five clones' reports dated from September, and nobody
 * could see one without querying the table. The catch-up now keeps it current
 * (`deferredParity.server.ts`), and this is where it is read.
 *
 * It says what the report says and no more. Credentials no forward policy
 * sends are information, never a difference (PF-27), so they are counted
 * beside the verdict rather than in it.
 */
export function parityReading(
  checkedAt: string | null,
  report: unknown,
  ago: (when: string) => string,
): { text: string; differs: boolean } {
  if (!checkedAt) return { text: "Not yet compared with the prime.", differs: false };
  const r = (report ?? {}) as {
    blocking_issues?: unknown;
    secrets_diff?: { not_forwarded?: unknown } | null;
  };
  const blocking = Array.isArray(r.blocking_issues)
    ? r.blocking_issues.filter((i): i is string => typeof i === "string")
    : [];
  const notForwarded = Array.isArray(r.secrets_diff?.not_forwarded)
    ? r.secrets_diff.not_forwarded.length
    : 0;
  const verdict = blocking.length > 0 ? `differs: ${blocking.join(", ")}` : "matches";
  const info =
    notForwarded > 0
      ? ` · ${notForwarded} credential${notForwarded === 1 ? "" : "s"} no forward policy sends (the tenant's own to supply)`
      : "";
  return {
    text: `Compared with the prime ${ago(checkedAt)}: ${verdict}${info}`,
    differs: blocking.length > 0,
  };
}
