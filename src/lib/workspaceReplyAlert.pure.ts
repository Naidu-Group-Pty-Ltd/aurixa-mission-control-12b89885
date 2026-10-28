/**
 * What an operator is told when a workspace answers a message — the one
 * projection the bell, the pop-up and the desktop notification draw, and the
 * one a phone notification is to draw when the mobile app arrives.
 *
 * The server writes a `clone_announcement_reply` notification with
 * `replyNotificationOf`; every surface reads it back with
 * `workspaceReplyAlertOf`. The record is the notification row itself: a
 * mobile sender subscribes to the same inserts and renders the same fields,
 * so the wording cannot drift between a screen and a phone.
 *
 * Who wrote is named twice, on purpose: the BUSINESS (the workspace's own
 * trading name, as its server reported it) and the WORKSPACE (the clone's
 * name in this console, or "Prime workspace"). An operator recognises a
 * customer by the first and finds the record by the second.
 */
import { isPrimeWorkspace } from "./cloneAnnouncements.pure";

export const WORKSPACE_REPLY_KIND = "clone_announcement_reply";
/** The metadata shape's version, so a later reader can tell the fields apart. */
export const WORKSPACE_REPLY_ALERT_VERSION = 1;
export const PRIME_WORKSPACE_LABEL = "Prime workspace";
const EXCERPT_MAX = 160;
const BUSINESS_MAX = 120;

export interface WorkspaceReplyFacts {
  announcementId: string;
  messageTitle: string;
  workspaceId: string;
  /** `clones.name`; ignored for the prime. */
  cloneName: string | null;
  /** The business as the workspace's own server named it, or null. */
  businessName: string | null;
  authorName: string;
  body: string;
}

export interface WorkspaceReplyAlert {
  /** The notification row's id: one alert per row, wherever it is shown. */
  id: string;
  /** The business, or the workspace where no business was named. */
  business: string;
  /** The workspace's name here, or "Prime workspace". */
  workspace: string;
  isPrime: boolean;
  author: string | null;
  excerpt: string;
  messageTitle: string | null;
  /** Where Open goes: the message's conversation with that workspace. */
  href: string | null;
  createdAt: string;
}

function clean(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function workspaceLabelOf(workspaceId: string, cloneName: string | null): string {
  if (isPrimeWorkspace(workspaceId)) return PRIME_WORKSPACE_LABEL;
  return clean(cloneName, 120) ?? "A workspace";
}

/** The notification the server writes for one workspace reply. */
export function replyNotificationOf(facts: WorkspaceReplyFacts): {
  title: string;
  body: string;
  url: string;
  metadata: Record<string, string | number | null>;
} {
  const workspace = workspaceLabelOf(facts.workspaceId, facts.cloneName);
  const business = clean(facts.businessName, BUSINESS_MAX);
  const who = business && business !== workspace ? `${business} (${workspace})` : workspace;
  const excerpt = clean(facts.body, EXCERPT_MAX) ?? "";
  return {
    title: `New reply from ${who}`,
    body: `${facts.authorName} on “${facts.messageTitle}”: ${excerpt}`,
    url: `/announcements?thread=${facts.announcementId}&workspace=${facts.workspaceId}`,
    metadata: {
      v: WORKSPACE_REPLY_ALERT_VERSION,
      announcement_id: facts.announcementId,
      workspace_id: facts.workspaceId,
      workspace_name: workspace,
      business_name: business,
      author_name: clean(facts.authorName, 120),
      excerpt,
      message_title: clean(facts.messageTitle, 140),
    },
  };
}

/**
 * Read a notification row back as an alert, or null where it is not a
 * workspace reply. A row written before the metadata carried names (27 Oct
 * 2026) still reads, from its title and body.
 */
export function workspaceReplyAlertOf(n: {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  url: string | null;
  created_at: string;
  metadata: unknown;
}): WorkspaceReplyAlert | null {
  if (n.kind !== WORKSPACE_REPLY_KIND) return null;
  const m = (n.metadata && typeof n.metadata === "object" ? n.metadata : {}) as Record<
    string,
    unknown
  >;
  const workspaceId = typeof m.workspace_id === "string" ? m.workspace_id : "";
  const workspace = clean(m.workspace_name, 120);
  if (!workspace) {
    return {
      id: n.id,
      business: clean(n.title, 200) ?? "A workspace replied",
      workspace: isPrimeWorkspace(workspaceId) ? PRIME_WORKSPACE_LABEL : "",
      isPrime: isPrimeWorkspace(workspaceId),
      author: null,
      excerpt: clean(n.body, 240) ?? "",
      messageTitle: null,
      href: n.url,
      createdAt: n.created_at,
    };
  }
  return {
    id: n.id,
    business: clean(m.business_name, BUSINESS_MAX) ?? workspace,
    workspace,
    isPrime: isPrimeWorkspace(workspaceId),
    author: clean(m.author_name, 120),
    excerpt: clean(m.excerpt, EXCERPT_MAX) ?? "",
    messageTitle: clean(m.message_title, 140),
    href: n.url,
    createdAt: n.created_at,
  };
}
