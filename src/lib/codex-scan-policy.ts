// Where and when Codex Security scans run: Prime, once a night.
//
// Clones are copies of Prime. Every fix lands on Prime and reaches each clone
// through the cascade, so scanning a clone found Prime's issues again under
// another repository's name — the same finding N times, none of them fixable
// there. Pull request and post-merge scans ran on top of the nightly one and
// paid for the same tree several times a day.
//
// The policy is enforced where a scan is queued (`enqueueScanNoAuth`), so a
// caller — the webhook, the self-healing queue, an older page — cannot route
// around it. The only other scan an operator can still start is an explicit
// "Scan Prime now".

export const SCAN_POLICY_SUMMARY =
  "Prime is scanned once a night. Clones are not scanned: they receive Prime's fixes through the cascade.";

/** Scan kinds that may still be queued: the nightly full scan, and a person's manual scan of Prime. */
export const ALLOWED_SCAN_KINDS = ["nightly_full", "manual"] as const;

export type ScanRequestVerdict = { ok: true } | { ok: false; reason: string };

export function scanRequestAllowed(input: {
  kind: string;
  targetKind: string;
}): ScanRequestVerdict {
  if (input.targetKind !== "prime") {
    return { ok: false, reason: "clones_not_scanned" };
  }
  if (!(ALLOWED_SCAN_KINDS as readonly string[]).includes(input.kind)) {
    return { ok: false, reason: `scans_run_nightly_on_prime:${input.kind}` };
  }
  return { ok: true };
}
