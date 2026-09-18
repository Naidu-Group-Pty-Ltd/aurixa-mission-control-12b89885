/**
 * Armed before claimable.
 *
 * Every path that creates a cascade event commits the EVENT and its result
 * rows in two separate statements — the webhook trigger, the provisioning
 * module cascade, both schedule lanes, the drift-suggestion apply and the
 * bulk card all share the shape — and the per-minute drain claimed one
 * inside that gap: 807ms on 16 Sep 2026 (event dd7180c7). The pass read
 * zero rows, honestly completed "(of 0)", and the three rows landed a
 * second later, stranded under a completed carrier with the delivery
 * silently lost.
 *
 * The rule is enforced at the CLAIM, once, rather than at six creation
 * sites: the drain does not offer an event until it has existed for this
 * long, so a creator that commits rows moments after the event — or a
 * future creation site nobody remembers to grace — is covered by
 * construction. The inline callers (webhook, console trigger,
 * `approveCascade`) run the engine directly, never claim, and are
 * unaffected. The engine's own unarmed hold is the belt to this brace: an
 * event whose rows NEVER arrive passes the age floor eventually, is held
 * `unarmed` with its attempt kept, and ends at the attempt ceiling with a
 * story.
 *
 * At least one full drain interval, so no tick can land inside a
 * creation gap it was born after.
 */
export const CREATION_ARM_GRACE_MS = 90_000;
