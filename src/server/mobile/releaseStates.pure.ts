/**
 * The life of a release record.
 *
 *   candidate ──approve──▶ approved ──promote──▶ promoted ◀──resume── paused
 *       │                     │                     │ └────pause──────▶ │
 *       └──────────┬──────────┴──────────┬──────────┴───────────────────┘
 *               withdraw (terminal: a bad build is superseded by a HIGHER one)
 *
 * An Android candidate is approvable only once its artefact is uploaded: the
 * database refuses an approved row with no path, and this says so first in
 * words an operator can act on.
 */
export const RELEASE_STATES = ["candidate", "approved", "promoted", "paused", "withdrawn"] as const;
export type ReleaseState = (typeof RELEASE_STATES)[number];
export type ReleaseAction = "approve" | "promote" | "pause" | "resume" | "withdraw";

const MOVES: Record<ReleaseState, Partial<Record<ReleaseAction, ReleaseState>>> = {
  candidate: { approve: "approved", withdraw: "withdrawn" },
  approved: { promote: "promoted", withdraw: "withdrawn" },
  promoted: { promote: "promoted", pause: "paused", withdraw: "withdrawn" },
  paused: { resume: "promoted", withdraw: "withdrawn" },
  withdrawn: {},
};

export type ReleaseMove = { ok: true; to: ReleaseState } | { ok: false; reason: string };

export function moveRelease(
  from: ReleaseState,
  action: ReleaseAction,
  facts: { platform: string; uploaded: boolean; percentage?: number },
): ReleaseMove {
  const to = MOVES[from]?.[action];
  if (!to) return { ok: false, reason: `A ${from} release cannot be told to ${action}.` };
  if (action === "approve" && facts.platform === "android" && !facts.uploaded) {
    return { ok: false, reason: "The artefact has not been uploaded yet." };
  }
  if (action === "promote") {
    const p = facts.percentage;
    if (p === undefined || !Number.isInteger(p) || p < 1 || p > 100) {
      return { ok: false, reason: "A rollout percentage must be a whole number from 1 to 100." };
    }
  }
  return { ok: true, to };
}

export function isReleaseState(v: unknown): v is ReleaseState {
  return typeof v === "string" && (RELEASE_STATES as readonly string[]).includes(v);
}
