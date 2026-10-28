/**
 * Clone announcements — the pure rules, shared by the public route and the
 * operator console so the two can never disagree about who sees what.
 *
 * Three rules carry this module:
 *   * State is DERIVED, never stored (the activation gate's rule): a row's
 *     lifecycle is computed from its timestamps at every read, so no worker
 *     has to move a status and none can go stale.
 *   * NULL audience means everyone. A plan list narrows to those plans, a
 *     clone list narrows to those clones, and the two AND together — and the
 *     matcher the console previews with is the matcher the route serves with.
 *   * The wire projection leaks nothing: a clone is never told which plans or
 *     clones a notice targets, only what to draw. `WIRE_KEYS` exists so a
 *     test can assert the projection's exact surface instead of trusting it.
 *
 * A "workspace" is a clone or the prime. The prime has no `clones` row and
 * its key carries no clone, so it is addressed by a reserved id
 * (`PRIME_WORKSPACE_ID`) that every rule here treats as one more workspace
 * with no plan on record. Until 27 Oct 2026 the prime was served an empty
 * list forever, which is why the operator's own staff never saw a message.
 */

export type AnnouncementSeverity = "info" | "success" | "warning" | "critical";
export type AnnouncementDisplay = "banner" | "modal";
export type AnnouncementState =
  | "draft"
  /** Withdrawn by its operator after it went out: a draft again, marked so (`recallRefusal`). */
  | "recalled"
  | "scheduled"
  | "active"
  | "expired"
  | "archived";

export const ANNOUNCEMENT_SEVERITIES: readonly AnnouncementSeverity[] = [
  "info",
  "success",
  "warning",
  "critical",
] as const;

/**
 * How each severity reads in a workspace — the word beside it and the colour
 * it is drawn in there (the workspace's `src/components/announcements/severity.ts`,
 * since 28 Oct 2026: the platform's own colours, the same in every workspace,
 * never the workspace's white-label brand). Shown beside the severity picker
 * so the operator chooses what the reader will see.
 */
export const SEVERITY_IN_WORKSPACE: Record<
  AnnouncementSeverity,
  { option: string; word: string; colour: string }
> = {
  info: { option: "Info", word: "Information", colour: "Aurixa blue" },
  success: { option: "Success", word: "Good news", colour: "green" },
  warning: { option: "Warning", word: "Needs attention", colour: "Aurixa orange" },
  critical: { option: "Critical", word: "Critical", colour: "red" },
};

export const ANNOUNCEMENT_DISPLAYS: readonly AnnouncementDisplay[] = [
  "banner",
  "modal",
] as const;

/**
 * The prime's workspace id: the nil UUID, which no `gen_random_uuid()` clone
 * id can ever be. It is stored in `audience_clone_ids`, in delivery stamps
 * and in reply threads exactly where a clone's id would be.
 */
export const PRIME_WORKSPACE_ID = "00000000-0000-0000-0000-000000000000";

export function isPrimeWorkspace(id: string | null | undefined): boolean {
  return id === PRIME_WORKSPACE_ID;
}

/** The name a workspace reads on everything Mission Control sends it. */
export const AURIXA_SYSTEMS_NAME = "Aurixa Systems";

/** How a plan list and a workspace list combine when both are set. */
export type AudienceMatch = "all" | "any";

/** The columns of `clone_announcements` this module reasons over. Structural
 *  on purpose — the route hands it rows, the console hands it drafts. */
export interface AnnouncementFacts {
  id: string;
  title: string;
  body: string;
  link_url: string | null;
  link_label: string | null;
  severity: string;
  display: string;
  dismissible: boolean;
  audience_plan_slugs: string[] | null;
  audience_clone_ids: string[] | null;
  /** 'all' (the original AND) when absent — every row written before it. */
  audience_match?: string | null;
  /** False (an announcement) when absent — every row written before it. */
  replies_enabled?: boolean | null;
  starts_at: string | null;
  ends_at: string | null;
  revision: number;
  published_at: string | null;
  archived_at: string | null;
  /** When it was recalled; absent on every row written before recall existed. */
  recalled_at?: string | null;
}

/** The scope columns, and how they combine. */
export type AudienceScopeFacts = Pick<
  AnnouncementFacts,
  "audience_plan_slugs" | "audience_clone_ids" | "audience_match"
>;

/** What audience matching needs to know about a workspace. `planSlug` is
 *  `clones.entitled_plan_slug` — the same authority the gate console lists —
 *  and always null for the prime, which has no plan. */
export interface AudienceClone {
  id: string;
  planSlug: string | null;
}

/** Derived lifecycle — never persisted anywhere. */
export function resolveAnnouncementState(
  row: Pick<
    AnnouncementFacts,
    "published_at" | "archived_at" | "starts_at" | "ends_at" | "recalled_at"
  >,
  now: Date = new Date(),
): AnnouncementState {
  if (row.archived_at) return "archived";
  if (!row.published_at) return row.recalled_at ? "recalled" : "draft";
  if (row.starts_at && Date.parse(row.starts_at) > now.getTime()) {
    return "scheduled";
  }
  if (row.ends_at && Date.parse(row.ends_at) <= now.getTime()) {
    return "expired";
  }
  return "active";
}

/**
 * Does this announcement reach this workspace? NULL lists match everyone; a
 * plan list can only match a workspace whose entitled plan is known — one with
 * no plan on record (the prime among them) is excluded from plan-scoped
 * notices rather than guessed at.
 *
 * When both lists are set, `audience_match` says how they combine: 'all' (the
 * original rule, and the reading of every row that predates the column) needs
 * both, 'any' needs either — "everyone on Scale, plus these two".
 */
export function announcementReachesClone(
  row: AudienceScopeFacts,
  clone: AudienceClone,
): boolean {
  const byWorkspace = row.audience_clone_ids
    ? row.audience_clone_ids.includes(clone.id)
    : null;
  const byPlan = row.audience_plan_slugs
    ? clone.planSlug !== null && row.audience_plan_slugs.includes(clone.planSlug)
    : null;
  if (byWorkspace === null && byPlan === null) return true;
  if (byWorkspace === null) return byPlan === true;
  if (byPlan === null) return byWorkspace;
  return row.audience_match === "any" ? byWorkspace || byPlan : byWorkspace && byPlan;
}

/**
 * One message in a workspace's own thread. An operator's message is signed
 * "Aurixa Systems", never with the operator's name: the workspace is talking
 * to the platform, not to whoever is on shift.
 */
export interface ThreadMessageWire {
  id: string;
  from: "workspace" | "aurixa";
  authorName: string;
  body: string;
  createdAt: string;
}

export const THREAD_WIRE_KEYS: readonly (keyof ThreadMessageWire)[] = [
  "id",
  "from",
  "authorName",
  "body",
  "createdAt",
] as const;

/** What a clone is allowed to see. Exactly these keys, nothing else. */
export interface CloneAnnouncementWire {
  id: string;
  title: string;
  body: string;
  linkUrl: string | null;
  linkLabel: string | null;
  severity: AnnouncementSeverity;
  display: AnnouncementDisplay;
  dismissible: boolean;
  revision: number;
  publishedAt: string;
  /** False: an announcement, nothing to reply to. */
  repliesEnabled: boolean;
  /** This workspace's thread, oldest first. Always empty when replies are off. */
  thread: ThreadMessageWire[];
}

export const WIRE_KEYS: readonly (keyof CloneAnnouncementWire)[] = [
  "id",
  "title",
  "body",
  "linkUrl",
  "linkLabel",
  "severity",
  "display",
  "dismissible",
  "revision",
  "publishedAt",
  "repliesEnabled",
  "thread",
] as const;

/** The columns of `clone_announcement_replies` the wire and console reason over. */
export interface ReplyFacts {
  id: string;
  announcement_id: string;
  workspace_id: string;
  direction: string;
  body: string;
  author_name: string;
  created_at: string;
}

/** The newest this many messages of a thread travel; the console keeps all. */
export const MAX_THREAD_ON_WIRE = 50;

/** One reply as its own workspace reads it. Email, role and refs never travel. */
export function toThreadWire(reply: ReplyFacts): ThreadMessageWire {
  const fromAurixa = reply.direction === "operator";
  return {
    id: reply.id,
    from: fromAurixa ? "aurixa" : "workspace",
    authorName: fromAurixa ? AURIXA_SYSTEMS_NAME : reply.author_name,
    body: reply.body,
    createdAt: reply.created_at,
  };
}

/**
 * A thread for the wire: only the replies of THIS announcement and THIS
 * workspace (the caller's filter is checked again here, because the
 * projection is the last line before another tenant's words would leak),
 * oldest first, the newest `MAX_THREAD_ON_WIRE` kept.
 */
export function threadForWorkspace(
  replies: readonly ReplyFacts[],
  announcementId: string,
  workspaceId: string,
): ThreadMessageWire[] {
  return replies
    .filter((r) => r.announcement_id === announcementId && r.workspace_id === workspaceId)
    .sort((a, b) => (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0))
    .slice(-MAX_THREAD_ON_WIRE)
    .map(toThreadWire);
}

const isSeverity = (v: string): v is AnnouncementSeverity =>
  (ANNOUNCEMENT_SEVERITIES as readonly string[]).includes(v);
const isDisplay = (v: string): v is AnnouncementDisplay =>
  (ANNOUNCEMENT_DISPLAYS as readonly string[]).includes(v);

/**
 * Project a row onto the wire. Unknown vocabulary degrades to the mildest
 * reading (an info banner) rather than throwing — a clone dashboard must
 * render something sane whatever this table comes to hold — and a modal is
 * forced dismissible here as well as by the CHECK constraint, because the
 * projection is the last line before somebody's screen.
 */
export function toCloneWire(
  row: AnnouncementFacts,
  thread: ThreadMessageWire[] = [],
): CloneAnnouncementWire {
  const display: AnnouncementDisplay = isDisplay(row.display)
    ? row.display
    : "banner";
  const repliesEnabled = row.replies_enabled === true;
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    linkUrl: row.link_url,
    linkLabel: row.link_url ? (row.link_label ?? row.link_url) : null,
    severity: isSeverity(row.severity) ? row.severity : "info",
    display,
    dismissible: display === "modal" ? true : row.dismissible,
    revision: row.revision,
    publishedAt: row.published_at ?? "",
    repliesEnabled,
    thread: repliesEnabled ? thread : [],
  };
}

/** Newest first, capped — a dashboard is not a feed. */
export const MAX_WIRE_ANNOUNCEMENTS = 20;

export function activeAnnouncementsForClone(
  rows: AnnouncementFacts[],
  clone: AudienceClone,
  now: Date = new Date(),
  replies: readonly ReplyFacts[] = [],
): CloneAnnouncementWire[] {
  return rows
    .filter((row) => resolveAnnouncementState(row, now) === "active")
    .filter((row) => announcementReachesClone(row, clone))
    .sort(
      (a, b) =>
        (Date.parse(b.published_at ?? "") || 0) -
        (Date.parse(a.published_at ?? "") || 0),
    )
    .slice(0, MAX_WIRE_ANNOUNCEMENTS)
    .map((row) => toCloneWire(row, threadForWorkspace(replies, row.id, clone.id)));
}

/**
 * May this workspace reply to this message right now? Only to a message that
 * asked for replies, that is live, and that reaches it — the same matcher the
 * list is served with, so a workspace can only answer what it was shown.
 */
export function replyRefusal(
  row: AnnouncementFacts | null,
  workspace: AudienceClone,
  now: Date = new Date(),
): null | "not_found" | "replies_disabled" | "not_live" | "not_addressed" {
  if (!row) return "not_found";
  if (!announcementReachesClone(row, workspace)) return "not_addressed";
  if (row.replies_enabled !== true) return "replies_disabled";
  if (resolveAnnouncementState(row, now) !== "active") return "not_live";
  return null;
}

/** May this workspace acknowledge this message? It must have been servable to it. */
export function acknowledgeRefusal(
  row: AnnouncementFacts | null,
  workspace: AudienceClone,
  now: Date = new Date(),
): null | "not_found" | "not_addressed" | "not_live" {
  if (!row) return "not_found";
  if (!announcementReachesClone(row, workspace)) return "not_addressed";
  if (resolveAnnouncementState(row, now) !== "active") return "not_live";
  return null;
}

/** Console helper: say who a notice reaches, in words. */
export function audienceSummary(
  row: AudienceScopeFacts,
  cloneNamesById: Record<string, string> = {},
): string {
  const parts: string[] = [];
  if (row.audience_plan_slugs) {
    parts.push(`plans: ${row.audience_plan_slugs.join(", ")}`);
  }
  if (row.audience_clone_ids) {
    const names = row.audience_clone_ids.map(
      (id) => cloneNamesById[id] ?? (isPrimeWorkspace(id) ? "the prime" : `${id.slice(0, 8)}…`),
    );
    parts.push(`workspaces: ${names.join(", ")}`);
  }
  if (parts.length === 0) return "all workspaces";
  return parts.join(row.audience_match === "any" && parts.length > 1 ? " + " : " · ");
}

/** One tone per state, in the console's spine vocabulary. */
export function announcementTone(
  state: AnnouncementState,
): "neutral" | "success" | "warning" | "danger" {
  switch (state) {
    case "active":
      return "success";
    case "scheduled":
      return "warning";
    case "recalled":
      return "danger";
    case "expired":
    case "archived":
    case "draft":
      return "neutral";
  }
}

/** One sentence per state, for the row under the title. */
export function describeAnnouncementState(
  row: AnnouncementFacts,
  state: AnnouncementState,
): string {
  switch (state) {
    case "draft":
      return "A draft nobody can see. Publish it to put it in front of its audience.";
    case "recalled":
      return "Recalled: withdrawn from every workspace it reached, and served to nobody. Correct it with Edit and send it again, or archive it.";
    case "scheduled":
      return `Published, waiting for its start time${row.starts_at ? ` (${row.starts_at})` : ""}.`;
    case "active":
      return row.ends_at
        ? "Live on every workspace it reaches until its end time."
        : "Live on every workspace it reaches until archived.";
    case "expired":
      return "Past its end time. It no longer renders anywhere; archive it to put it away.";
    case "archived":
      return "Archived. Kept for the record, served to nobody.";
  }
}

/* ------------------------------------------------------------------------- *
 * Recall: withdrawing a message that went out wrong (28 Oct 2026).
 *
 * Archive files a message away as finished. Recall says it should not have
 * gone out: it comes down from every dashboard at once — Mission Control
 * stops serving it and signals every workspace it reached — and returns to
 * the operator as a draft marked recalled, to be corrected and sent again or
 * archived. Recalling bumps the revision, so the corrected message is new to
 * every dashboard, those that had dismissed the wrong one included.
 *
 * Whether it has come down is read from the effect, never assumed from the
 * act: a workspace that had fetched it confirms the withdrawal the first time
 * it fetches after the recall (`withdrawn_at` on its delivery stamp).
 * ------------------------------------------------------------------------- */

/**
 * Why this message cannot be recalled, or null. Only a message that is out
 * — live, or scheduled to go live — can be: a draft is nobody's to withdraw,
 * an archived or ended one is already served to nobody.
 */
export function recallRefusal(
  row: Pick<
    AnnouncementFacts,
    "published_at" | "archived_at" | "starts_at" | "ends_at" | "recalled_at"
  > | null,
  now: Date = new Date(),
): null | "not_found" | "not_out" | "ended" {
  if (!row) return "not_found";
  const state = resolveAnnouncementState(row, now);
  if (state === "active" || state === "scheduled") return null;
  if (state === "draft" || state === "recalled") return "not_out";
  return "ended";
}

/** What a recall has done so far, as the workspaces themselves report it. */
export type WithdrawalSummary = {
  /** Workspaces that had fetched the message at least once, so had something to withdraw. */
  had: number;
  /** Of those, the ones that have fetched since the recall, and so no longer hold it. */
  confirmed: number;
};

/**
 * Count the withdrawal from the delivery stamps of the workspaces the message
 * reaches. A stamp withdrawn before THIS recall (a message recalled, sent
 * again and recalled again) does not count for it.
 */
export function withdrawalOf(
  recalledAt: string,
  stamps: ReadonlyArray<{ withdrawnAt: string | null } | null>,
): WithdrawalSummary {
  const at = Date.parse(recalledAt);
  let had = 0;
  let confirmed = 0;
  for (const s of stamps) {
    if (!s) continue;
    had += 1;
    const w = s.withdrawnAt ? Date.parse(s.withdrawnAt) : Number.NaN;
    if (Number.isFinite(w) && Number.isFinite(at) && w >= at) confirmed += 1;
  }
  return { had, confirmed };
}

/** How long after a recall the console watches for the withdrawals closely. */
export const RECALL_WATCH_MS = 10 * 60 * 1000;

/**
 * Is a recent recall still waiting on a workspace? The console then asks
 * every few seconds, so the operator watches the message come down rather
 * than waiting a minute to learn it has.
 */
export function withdrawalPending(
  rows: ReadonlyArray<{ recalledAt: string | null; withdrawal: WithdrawalSummary | null }>,
  now: Date = new Date(),
): boolean {
  return rows.some(
    (r) =>
      r.recalledAt !== null &&
      r.withdrawal !== null &&
      r.withdrawal.confirmed < r.withdrawal.had &&
      now.getTime() - Date.parse(r.recalledAt) < RECALL_WATCH_MS,
  );
}

/* ------------------------------------------------------------------------- *
 * Workspace messages: the three ways an operator addresses the fleet.
 *
 * The console offers them as three choices, and they are three views of the
 * ONE scope the table stores (`audience_plan_slugs` / `audience_clone_ids` /
 * `audience_match`), so delivery and reach run one matcher:
 *
 *  - everyone  — every workspace, the prime included (both lists null);
 *  - one       — exactly one named workspace (one id; the prime's is allowed);
 *  - selected  — chosen workspaces, every workspace on chosen plans, or both
 *                ("everyone on Scale, plus NPC Test" — stored with 'any').
 *
 * Whether a workspace can reply is the message's own setting
 * (`replies_enabled`), not part of who it is for.
 * ------------------------------------------------------------------------- */

export type WorkspaceAudienceMode = "everyone" | "one" | "selected";

export interface WorkspaceAudienceDraft {
  mode: WorkspaceAudienceMode;
  cloneIds: readonly string[];
  planSlugs: readonly string[];
  /**
   * How a stored row combined its lists. Only 'all' with BOTH lists set is
   * special: that is "these workspaces, if on these plans", which the console
   * no longer builds — it opens such a row as the workspaces it reaches.
   */
  match: AudienceMatch;
}

const matchOf = (row: AudienceScopeFacts | null): AudienceMatch =>
  row?.audience_match === "any" ? "any" : "all";

/** Read a stored scope back into the choice the console shows. */
export function audienceDraftOf(row: AudienceScopeFacts | null): WorkspaceAudienceDraft {
  const cloneIds = row?.audience_clone_ids ?? null;
  const planSlugs = row?.audience_plan_slugs ?? null;
  const match = matchOf(row);
  if (cloneIds && cloneIds.length > 0) {
    return {
      mode: cloneIds.length === 1 && !planSlugs ? "one" : "selected",
      cloneIds,
      planSlugs: planSlugs ?? [],
      match,
    };
  }
  if (planSlugs && planSlugs.length > 0) {
    return { mode: "selected", cloneIds: [], planSlugs, match };
  }
  return { mode: "everyone", cloneIds: [], planSlugs: [], match: "all" };
}

/** Is this the old "workspaces AND plans" narrowing the console no longer builds? */
export function isNarrowingScope(draft: WorkspaceAudienceDraft): boolean {
  return draft.match === "all" && draft.cloneIds.length > 0 && draft.planSlugs.length > 0;
}

export type AudienceScope =
  | {
      ok: true;
      audiencePlanSlugs: string[] | null;
      audienceCloneIds: string[] | null;
      audienceMatch: AudienceMatch;
    }
  | { ok: false; reason: string };

/**
 * The scope to store for a choice, or the reason it cannot be saved yet.
 * A selection that names nobody is refused rather than widened to everyone —
 * an empty list silently meaning "all workspaces" is the worst reading of it.
 * Choosing plans AND workspaces reaches either (`any`).
 */
export function audienceScopeOf(draft: WorkspaceAudienceDraft): AudienceScope {
  const uniq = (xs: readonly string[]) => [...new Set(xs.filter((x) => x.length > 0))];
  if (draft.mode === "everyone") {
    return { ok: true, audiencePlanSlugs: null, audienceCloneIds: null, audienceMatch: "all" };
  }
  if (draft.mode === "one") {
    const ids = uniq(draft.cloneIds);
    if (ids.length !== 1) return { ok: false, reason: "Choose the workspace this is for." };
    return { ok: true, audiencePlanSlugs: null, audienceCloneIds: ids, audienceMatch: "all" };
  }
  const ids = uniq(draft.cloneIds);
  const slugs = uniq(draft.planSlugs);
  if (ids.length === 0 && slugs.length === 0) {
    return { ok: false, reason: "Choose at least one plan or workspace." };
  }
  return {
    ok: true,
    audiencePlanSlugs: slugs.length > 0 ? slugs : null,
    audienceCloneIds: ids.length > 0 ? ids : null,
    audienceMatch: ids.length > 0 && slugs.length > 0 ? "any" : "all",
  };
}

/** Which of the three a stored message is, for the list's filter and badge. */
export function audienceModeOf(row: AudienceScopeFacts): WorkspaceAudienceMode {
  return audienceDraftOf(row).mode;
}

export const AUDIENCE_MODE_LABEL: Record<WorkspaceAudienceMode, string> = {
  everyone: "All workspaces",
  one: "One workspace",
  selected: "Selected workspaces",
};

/** Who a message is addressed to, in a phrase an operator reads at a glance. */
export function audienceHeadline(
  row: AudienceScopeFacts,
  cloneNamesById: Record<string, string> = {},
  planNamesBySlug: Record<string, string> = {},
): string {
  const name = (id: string) =>
    cloneNamesById[id] ?? (isPrimeWorkspace(id) ? "the prime" : `${id.slice(0, 8)}…`);
  const draft = audienceDraftOf(row);
  if (draft.mode === "everyone") return "All workspaces";
  if (draft.mode === "one") return `Only ${name(draft.cloneIds[0])}`;
  const parts: string[] = [];
  if (draft.planSlugs.length > 0) {
    const plans = draft.planSlugs.map((s) => planNamesBySlug[s] ?? s);
    parts.push(`${plans.length === 1 ? "Plan" : "Plans"}: ${plans.join(", ")}`);
  }
  if (draft.cloneIds.length > 0) {
    const names = draft.cloneIds.map(name);
    parts.push(
      names.length <= 3
        ? names.join(", ")
        : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`,
    );
  }
  return parts.join(isNarrowingScope(draft) ? " · only " : " + ");
}

/** Case- and accent-insensitive match of a search box against a workspace. */
export function workspaceMatches(
  c: { name: string; slug?: string | null; planSlug?: string | null },
  query: string,
): boolean {
  const fold = (s: string) =>
    s
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLocaleLowerCase("en-AU");
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = fold([c.name, c.slug ?? "", c.planSlug ?? ""].join(" "));
  return words.every((w) => hay.includes(w));
}

/* ------------------------------------------------------------------------- *
 * When a message goes out.
 *
 *  - now      — published on save and live at once (no start time);
 *  - schedule — published on save and live from its start time, which must
 *               be in the future (otherwise it is "now" wearing a date);
 *  - draft    — saved, seen by nobody, published later from the list.
 *
 * Times travel as ISO instants. The console converts the operator's local
 * `datetime-local` input with the browser's own zone and says which zone that
 * was, so "5:38 pm" is never read in a zone the operator did not mean.
 * ------------------------------------------------------------------------- */

export type SendTiming = "now" | "schedule" | "draft";

export function sendTimingRefusal(
  timing: SendTiming,
  startsAt: string | null,
  endsAt: string | null,
  now: Date = new Date(),
): string | null {
  const start = startsAt ? Date.parse(startsAt) : null;
  const end = endsAt ? Date.parse(endsAt) : null;
  if (start !== null && !Number.isFinite(start)) return "The start time is not a valid date.";
  if (end !== null && !Number.isFinite(end)) return "The end time is not a valid date.";
  if (timing === "schedule") {
    if (start === null) return "Choose when it should go out.";
    if (start <= now.getTime()) return "A scheduled time must be in the future — use Send now instead.";
  }
  if (timing !== "draft" && end !== null && end <= now.getTime()) {
    return "The end time has already passed.";
  }
  const effectiveStart = timing === "now" ? now.getTime() : start;
  if (end !== null && effectiveStart !== null && end <= effectiveStart) {
    return "The end time must come after it starts.";
  }
  return null;
}

/** A thread's people, for the console: who wrote last and how many wait. */
export interface ThreadSummary {
  workspaceId: string;
  messages: number;
  unread: number;
  lastAt: string;
  lastFrom: "workspace" | "aurixa";
}

/** Group a message's replies into one summary per workspace, newest activity first. */
export function summariseThreads(
  replies: ReadonlyArray<ReplyFacts & { operator_read_at?: string | null }>,
): ThreadSummary[] {
  const byWorkspace = new Map<string, ThreadSummary>();
  const ordered = [...replies].sort(
    (a, b) => (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0),
  );
  for (const r of ordered) {
    const t = byWorkspace.get(r.workspace_id) ?? {
      workspaceId: r.workspace_id,
      messages: 0,
      unread: 0,
      lastAt: r.created_at,
      lastFrom: "workspace" as const,
    };
    t.messages += 1;
    if (r.direction === "workspace" && !r.operator_read_at) t.unread += 1;
    t.lastAt = r.created_at;
    t.lastFrom = r.direction === "operator" ? "aurixa" : "workspace";
    byWorkspace.set(r.workspace_id, t);
  }
  return [...byWorkspace.values()].sort(
    (a, b) => (Date.parse(b.lastAt) || 0) - (Date.parse(a.lastAt) || 0),
  );
}

/**
 * An instant as the console shows it: the operator's own zone, named. Built
 * from explicit fields because `Intl.DateTimeFormat` REFUSES `dateStyle` or
 * `timeStyle` beside `timeZoneName` ("Invalid option") — a throw inside a
 * list row takes the whole page down. Unreadable input says "—".
 */
export function formatInstant(
  iso: string | null | undefined,
  timeZone?: string,
): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  try {
    return new Intl.DateTimeFormat("en-AU", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
      ...(timeZone ? { timeZone } : {}),
    }).format(ms);
  } catch {
    return new Date(ms).toISOString();
  }
}
