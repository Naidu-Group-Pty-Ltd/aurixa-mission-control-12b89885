/**
 * What the inbox is for.
 *
 * ## The rule
 *
 * **A notification is for something that needs a person. If it needs nobody,
 * it is a record.**
 *
 * Measured on the live database, 18 Sep 2026: 2,459 unread notifications, of
 * which 693 were `cascade_completed`, 250 `deployment_live` and 1,253
 * `drift_high` — **79% of the channel was either a success or the normal
 * operating state of a working pipeline.** `cascade_blocked`, the signal that
 * means *this will fail for ever until a person acts*, arrives into that at
 * 130–270 rows a day.
 *
 * The owner's own report behind the conflict work was that the notification
 * had already been learned and filtered. This is why. The mechanism was built
 * and the channel it speaks into was already saturated.
 *
 * ## What this does NOT do
 *
 * It does not stop anything being written, and it deletes nothing. Every row
 * still lands in `notifications` exactly as before, because
 * `CloneActivityHistory` READS that table as a clone's activity feed — so
 * suppressing the write would delete the history along with the noise, which
 * is the trap this repository names as *removing a notice must never remove a
 * control*.
 *
 * The split is at the READER. The record keeps everything; the inbox carries
 * only what needs a person. That also means the 983 already-unread rows stop
 * being counted the moment this lands, with no bulk `read_at` stamp and no
 * migration touching a single row.
 *
 * ## Why unknown means inbox
 *
 * `isInboxKind` asks whether a kind is on the RECORD list, and everything else
 * is inbox — so a kind added next year appears in the inbox until somebody
 * deliberately decides it should not. Under-notifying is the worse error, and
 * a list that silently swallows what nobody remembered to classify is how a
 * channel goes quiet for the wrong reason.
 *
 * This is orthogonal to `notification_preferences`, which is a per-person mute
 * over toasts. Disposition decides what may ever reach the inbox; a preference
 * decides which of those a given person wants to see. Conflating them would
 * make a product decision look like somebody's setting.
 */
import { Constants, type Database } from "@/integrations/supabase/types";

export type NotificationKind = Database["public"]["Enums"]["notification_kind"];

/**
 * Kinds that record something that went RIGHT, where nobody is owed an act.
 *
 * Every entry is a deliberate decision with its reason beside it. The test of
 * membership is: *if nobody ever read this, would anything be wrong?* Where
 * the answer is "possibly", the kind stays in the inbox — which is why a
 * rejection, a deletion, a captured lead and an armed payment gate are all
 * absent from this list despite being ordinary events.
 */
export const NOTIFICATION_RECORD_KINDS: ReadonlySet<NotificationKind> = new Set<NotificationKind>([
  // The delivery worked. 693 unread on 18 Sep 2026 — the largest single
  // success in the channel.
  "cascade_completed",
  // It began. The outcome is the thing worth a person's attention.
  "cascade_started",
  // The approval IS the act, and the approver is the one who performed it.
  "cascade_approved",
  // Provisioning succeeded.
  "clone_created",
  // The install worked.
  "module_installed",
  // The removal worked.
  "module_removed",
  // The deployment worked. 250 unread.
  "deployment_live",
  // Issued to whoever asked for it.
  "tokens_key_issued",
  "tokens_key_rotated",
  // A key being used is the expected consequence of issuing one.
  "tokens_key_first_use",
  "device_registered",
  "device_released",
  // The change completed.
  "seat_plan_changed",
  // The approval IS the act.
  "library_entry_approved",
  // It healed itself, which is the system working rather than news.
  "remediation_auto_completed",
  "agreement_signed",
  "agreement_provisioned",
  // Payment landed and the workspace opened.
  "clone_gate_unlocked",
  "clone_announcement_published",
  "clone_announcement_archived",
  // Terminal: the assessment is closed and its findings had their own kinds.
  "security_assessment_closed",
  "purchase_completed",
]);

/**
 * Does this kind belong in the inbox?
 *
 * Membership of the record list is the only thing that removes a kind, so a
 * kind nobody has classified is in the inbox by construction.
 */
export function isInboxKind(kind: NotificationKind): boolean {
  return !NOTIFICATION_RECORD_KINDS.has(kind);
}

/** Every kind the database declares, as the generated constants list them. */
export const ALL_NOTIFICATION_KINDS: readonly NotificationKind[] =
  Constants.public.Enums.notification_kind;

/** The inbox kinds. For display and tests — never for a query; see below. */
export const INBOX_KINDS: readonly NotificationKind[] = ALL_NOTIFICATION_KINDS.filter(isInboxKind);

/**
 * The record list, as a PostgREST group for a `NOT IN` filter.
 *
 * A query asks for "everything EXCEPT the record", never for an enumerated
 * list of the inbox, and the reason is the same one that makes `isInboxKind`
 * ask about the record list rather than an inbox list.
 *
 * `Constants` is generated from the database by hand and goes stale. A kind
 * added there and not yet regenerated here is missing from `INBOX_KINDS`, so
 * an `IN` filter would silently drop it OUT of the inbox — the exact failure
 * this module exists to prevent, arriving through the query instead of through
 * the list. `NOT IN` cannot do that: an unclassified kind matches nothing on
 * the record list and appears in the inbox, which is where a kind nobody has
 * decided about belongs.
 *
 * `notifications.kind` is NOT NULL, so there is no three-valued logic here.
 */
export const RECORD_KINDS_FILTER = `(${[...NOTIFICATION_RECORD_KINDS].join(",")})`;

/** What the operator is told the default view is showing. */
export const INBOX_SCOPE_LABEL = "Needs attention";
export const RECORD_SCOPE_LABEL = "Everything";
export const INBOX_SCOPE_NOTE =
  "Completions and other records are kept and still shown on each clone's activity, and in Everything.";
