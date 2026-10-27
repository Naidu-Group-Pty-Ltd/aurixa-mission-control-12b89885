/**
 * What a bulk "mark read" may touch.
 *
 * ## The rule
 *
 * **No bulk mark ever changes a `cascade_blocked` notice.**
 *
 * An unread `cascade_blocked` notice is more than a message. It is the merge
 * drain's verdict on one pull request it read and refused to merge, and the
 * blockage ledger reads every UNREAD one as a standing CI refusal
 * (`blockedNotices` in `cascade/blockageTaxonomy.pure.ts`). That is where a
 * clone's `ci_red` comes from. Marking the notice read takes the refusal out
 * of the ledger while the pull request is exactly as it was: the clone loses
 * its `ci_red`, and the false `unreconciled_proposal` the notice was standing
 * down comes back (`blockedNoticeRead.server.ts`).
 *
 * "Mark all matching", "Mark page read" and the bell's "Mark all read" could
 * each do that to every blocked notice in reach in one click. The inbox was
 * split from the record so that `cascade_blocked` would be seen
 * (`notificationDisposition.ts`), and its bulk controls could silence it.
 *
 * ## Why nobody needs to clear one
 *
 * A blocked notice clears itself. When the merge drain reads its pull request
 * closed, merged or declined, it marks that notice read
 * (`clearBlockedNotifications` in `cascadeMergeDrain.server.ts`). The notice
 * stands exactly as long as the refusal does.
 *
 * Opening ONE still marks it read, as it always did: that is a person acting
 * on one named refusal, not a sweep.
 *
 * The rule also holds the other way. A bulk "mark unread" would raise a
 * refusal over a pull request that has closed, so no bulk mark changes these
 * notices in either direction.
 *
 * Client-safe: pure. The server applies it to every bulk write, and the pages
 * apply it to what they show.
 */
import { isInboxKind, type NotificationKind } from "./notificationDisposition";
import type { Database } from "@/integrations/supabase/types";

type Severity = Database["public"]["Enums"]["notification_severity"];

/** Kinds no bulk mark may change. */
export const BULK_READ_EXEMPT_KINDS: ReadonlySet<NotificationKind> = new Set<NotificationKind>([
  "cascade_blocked",
]);

/** Whether a bulk mark may change a notification of this kind. */
export function mayBulkMarkRead(kind: string): boolean {
  return !BULK_READ_EXEMPT_KINDS.has(kind as NotificationKind);
}

/** What the pages say about the rule, in one spelling. */
export const BULK_READ_EXEMPT_NOTE =
  "Blocked-cascade notices stay unread: each clears itself when its pull request closes.";

/** The sentence after a bulk mark that left some blocked notices standing. */
export function describeLeftUnread(count: number): string {
  return count === 1
    ? "1 blocked-cascade notice was left unread: it clears itself when its pull request closes."
    : `${count} blocked-cascade notices were left unread: each clears itself when its pull request closes.`;
}

/** The inbox filters "Mark all matching" acts on, as the page holds them. */
export type MarkMatchingFilters = {
  kind: "all" | NotificationKind;
  severity: "all" | Severity;
  /** "all", or one clone's id. */
  clone: string;
  scope: "attention" | "everything";
};

export type MarkMatchingPlan =
  | { act: false; why: string }
  | {
      act: true;
      /** A kind the operator chose. It outranks the scope, as it does for the list. */
      kind: NotificationKind | null;
      /** True when the page is showing "Needs attention" and no kind was chosen. */
      excludeRecordKinds: boolean;
      severity: Severity | null;
      cloneId: string | null;
      /** Excluded from the write, always. */
      exempt: NotificationKind[];
      /** The exempt kinds these filters would otherwise have matched: counted, and named after. */
      leftUnread: NotificationKind[];
    };

/**
 * The write "Mark all matching" makes, or why it makes none.
 *
 * It matches what the page is SHOWING, as it always did: an explicitly chosen
 * kind outranks the scope, and "Needs attention" leaves out the record kinds.
 * Then every exempt kind is taken out of it.
 */
export function planMarkMatching(filters: MarkMatchingFilters): MarkMatchingPlan {
  if (filters.kind !== "all" && !mayBulkMarkRead(filters.kind)) {
    return { act: false, why: BULK_READ_EXEMPT_NOTE };
  }
  const kind = filters.kind === "all" ? null : filters.kind;
  const excludeRecordKinds = kind === null && filters.scope === "attention";
  const exempt = [...BULK_READ_EXEMPT_KINDS];
  const leftUnread =
    kind === null ? exempt.filter((k) => !excludeRecordKinds || isInboxKind(k)) : [];
  return {
    act: true,
    kind,
    excludeRecordKinds,
    severity: filters.severity === "all" ? null : filters.severity,
    cloneId: filters.clone === "all" ? null : filters.clone,
    exempt,
    leftUnread,
  };
}
