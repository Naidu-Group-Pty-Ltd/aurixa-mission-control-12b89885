/**
 * Which mailboxes in the Microsoft tenant a campaign may send from.
 *
 * The application identity this deployment holds (MICROSOFT_TENANT_ID /
 * CLIENT_ID / CLIENT_SECRET) is not tied to one mailbox. `Mail.Send` as an
 * APPLICATION permission reaches every mailbox in the tenant, unless an
 * Exchange application access policy, or Exchange's RBAC for Applications,
 * narrows it. `MICROSOFT_MAILBOX_EMAIL` only names the default. So "which
 * mailboxes can this campaign use" has a real answer in the tenant, and this
 * file reads it.
 *
 * ## What "valid" means here
 *
 * A mailbox is offered as usable only when this application can READ its
 * inbox, not merely when it exists. Two reasons:
 *
 * - **It is the honest test of the access policy.** Exchange applies the same
 *   policy to reading and sending, and there is no way to ask "may I send as
 *   X" without sending something. Reading one folder id is free.
 * - **A mailbox that cannot be read cannot have its bounces read.** The bounce
 *   scan is the only source of the never-mail-a-bouncer rule. A campaign
 *   sending from a mailbox it cannot scan would report that rule as enforced
 *   while it had no data at all — the exact failure docs/EMAIL_CAMPAIGNS.md
 *   was written to prevent.
 *
 * ## The token says what it was granted — usually
 *
 * A client-credentials token is a JWT whose `roles` claim lists the
 * application permissions consented in Entra. Reading it lets the page say
 * "this application cannot list the directory" instead of failing with a 403.
 * It is ADVISORY only: Exchange's RBAC for Applications grants mailbox access
 * outside Entra, and such a token carries no `Mail.*` role at all while
 * sending perfectly well. So a missing role is a warning, never a block; the
 * probe is the authority.
 */
import { emailKey } from "@/lib/email/emailAddress.pure";

export type DirectoryUser = {
  id?: string | null;
  displayName?: string | null;
  mail?: string | null;
  userPrincipalName?: string | null;
};

export type DirectoryMailbox = { id: string | null; address: string; displayName: string | null };

/**
 * Directory users that can be a mailbox: those with a mail address, that are
 * not guests.
 *
 * `mail` is set by Exchange when it provisions a mailbox, so a cloud user
 * without one has none — a good first filter, confirmed by the probe. Guests
 * carry `#EXT#` in their principal name and a mail address in somebody else's
 * tenant, which no application here can send as. Shared mailboxes are KEPT:
 * they are disabled accounts, and they are exactly what a campaign is usually
 * sent from.
 */
export function mailboxesFromDirectory(users: DirectoryUser[]): DirectoryMailbox[] {
  const seen = new Map<string, DirectoryMailbox>();
  for (const user of users) {
    const principal = String(user.userPrincipalName ?? "");
    if (principal.includes("#EXT#")) continue;
    const address = emailKey(String(user.mail ?? ""));
    if (!address || seen.has(address)) continue;
    const name = String(user.displayName ?? "").trim();
    seen.set(address, { id: user.id ?? null, address, displayName: name || null });
  }
  return [...seen.values()].sort(compareMailboxes);
}

function compareMailboxes(a: DirectoryMailbox, b: DirectoryMailbox): number {
  const left = (a.displayName ?? a.address).toLowerCase();
  const right = (b.displayName ?? b.address).toLowerCase();
  return left < right ? -1 : left > right ? 1 : a.address.localeCompare(b.address);
}

/**
 * `unverifiable` is its own answer, not a kind of `denied`: an application
 * holding Mail.Send but no Mail.Read is refused EVERY inbox read, so the probe
 * says nothing about any one mailbox. Calling that "denied" would block
 * campaigns that send perfectly well; calling it "reachable" would hide that
 * the bounce scan cannot run either. See `qualifyAccess`.
 */
export type MailboxAccessState = "reachable" | "denied" | "no_mailbox" | "unknown" | "unverifiable";
export type MailboxAccess = { state: MailboxAccessState; reason: string | null };

const NO_MAILBOX_CODES = new Set([
  "mailboxnotenabledforrestapi",
  "mailboxnotsupportedforrestapi",
  "erroritemnotfound",
  "errornonexistentmailbox",
  "errorinvaliduser",
  "resourcenotfound",
  "request_resourcenotfound",
]);

/**
 * What the answer to "read this mailbox's inbox folder" means for sending
 * from it.
 */
export function describeMailboxAccess(status: number, code?: string | null): MailboxAccess {
  const normalised = String(code ?? "").toLowerCase();
  if (status >= 200 && status < 300) return { state: "reachable", reason: null };
  if (status === 401 || status === 403) {
    return {
      state: "denied",
      reason:
        "this application is not permitted to use this mailbox — an Exchange application access policy excludes it, or Mail.Read has not been granted",
    };
  }
  if (
    normalised === "mailboxnotenabledforrestapi" ||
    normalised === "mailboxnotsupportedforrestapi"
  ) {
    return {
      state: "no_mailbox",
      reason:
        "it has no Exchange Online mailbox Microsoft Graph can use — it may be unlicensed, inactive, or hosted on-premises",
    };
  }
  if (status === 404 || NO_MAILBOX_CODES.has(normalised)) {
    return { state: "no_mailbox", reason: "there is no such mailbox in this tenant" };
  }
  if (status === 400) {
    return { state: "no_mailbox", reason: "Microsoft does not recognise that as a mailbox" };
  }
  return {
    state: "unknown",
    reason:
      status === 429
        ? "Microsoft is throttling requests — try again in a minute"
        : status === 0
          ? "Microsoft could not be reached — try again"
          : `Microsoft answered ${status} — try again`,
  };
}

/**
 * How far a refused send reaches.
 *
 * `recipient` — something about these addresses; mark them refused and carry
 * on, which is what the dispatcher always did.
 *
 * `mailbox` — the sending mailbox cannot be used at all: access withdrawn, the
 * mailbox gone, the credential no longer valid for it. Every later message
 * would be refused the same way, so marking each recipient refused just turns
 * a configuration fault into a whole list of "failed" rows a person must
 * release one by one. Nothing was sent, so the contacts go back in the queue
 * and the campaign pauses with the reason.
 *
 * `message` — the message itself is unacceptable to the mailbox, almost always
 * because its attachments are too large. The same for every recipient; same
 * remedy.
 */
export type RefusalScope = "recipient" | "mailbox" | "message";

const MAILBOX_CODES = new Set([
  "erroraccessdenied",
  "accessdenied",
  "errorsendasdenied",
  "authorization_requestdenied",
  "errorquotaexceeded",
  "errormailboxstoreunavailable",
  "errormailboxmoveinprogress",
  "erroraccountdisabled",
  "mailboxnotenabledforrestapi",
  "mailboxnotsupportedforrestapi",
  "errornonexistentmailbox",
  "errorinvaliduser",
  "resourcenotfound",
  "request_resourcenotfound",
  "invalidauthenticationtoken",
]);

const MESSAGE_CODES = new Set([
  "errormessagesizeexceeded",
  "requestbodytoolarge",
  "errorattachmentsizeshouldnotbelessthanminimumsize",
  "errorexceededmessagelimit",
  "errormaxrequestedunavailable",
]);

export function refusalScope(status: number, code?: string | null): RefusalScope {
  const normalised = String(code ?? "").toLowerCase();
  if (MESSAGE_CODES.has(normalised) || status === 413) return "message";
  if (MAILBOX_CODES.has(normalised)) return "mailbox";
  if (status === 401 || status === 403 || status === 404) return "mailbox";
  return "recipient";
}

/**
 * The sentence a paused campaign carries when a refusal stopped it.
 *
 * `path` matters for the remedy: a message too large for one request is built
 * as a draft, which needs Mail.ReadWrite on top of Mail.Send. Refused THERE,
 * "choose another mailbox" sends the operator after the wrong fix.
 */
export function refusalPauseReason(
  scope: RefusalScope,
  mailbox: string,
  detail: string,
  path: "sendmail" | "draft" = "sendmail",
): string {
  const said = String(detail ?? "")
    .trim()
    .slice(0, 300);
  if (scope === "message") {
    return `Microsoft refused the message itself (${said || "no detail"}) — usually its attachments are too large for ${mailbox}. Nothing was sent; the contacts are back in the queue.`;
  }
  if (path === "draft") {
    return `Microsoft refused to build the message as a draft in ${mailbox} (${said || "no detail"}). Messages whose attachments are larger than about 2.9 MB are built as drafts, which needs the Mail.ReadWrite application permission as well as Mail.Send — grant it, or make the attachments smaller, then resume. Nothing was sent; the contacts are back in the queue.`;
  }
  return `Microsoft refused to send from ${mailbox} (${said || "no detail"}). Nothing was sent; the contacts are back in the queue. Choose a mailbox this application may use, or have the tenant's administrator grant access, then resume.`;
}

/**
 * The application permissions a client-credentials token carries, from its
 * `roles` claim. `null` when the token is not a readable JWT.
 *
 * Decoded, never verified: the token came straight from Microsoft's token
 * endpoint over TLS a moment ago, and nothing here grants anything on the
 * strength of it — it only decides which sentence the page shows.
 */
export function tokenRoles(token: string): string[] | null {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as { roles?: unknown };
    if (!Array.isArray(payload.roles)) return [];
    return payload.roles.filter((role): role is string => typeof role === "string");
  } catch {
    return null;
  }
}

export type GraphCapabilities = {
  /** The roles claim, or null when it could not be read. */
  roles: string[] | null;
  send: boolean | null;
  read: boolean | null;
  readWrite: boolean | null;
  directory: boolean | null;
};

export function capabilitiesFrom(roles: string[] | null): GraphCapabilities {
  if (roles === null) {
    return { roles: null, send: null, read: null, readWrite: null, directory: null };
  }
  const has = (...names: string[]) => names.some((name) => roles.includes(name));
  return {
    roles,
    send: has("Mail.Send"),
    read: has("Mail.Read", "Mail.ReadWrite", "Mail.ReadBasic.All", "Mail.ReadBasic"),
    readWrite: has("Mail.ReadWrite"),
    directory: has(
      "User.Read.All",
      "User.ReadBasic.All",
      "User.ReadWrite.All",
      "Directory.Read.All",
      "Directory.ReadWrite.All",
    ),
  };
}

/**
 * Read a probe in the light of what the token was granted.
 *
 * A 403 means "excluded by policy" only if the application could have read
 * the inbox at all. When the token plainly carries roles and none of them
 * reads mail, every inbox answers 403 whatever the policy says, so the answer
 * becomes `unverifiable`. An unreadable token, or one with no roles (Exchange's
 * RBAC for Applications grants access without any), leaves the probe as the
 * authority.
 */
export function qualifyAccess(
  access: MailboxAccess,
  capabilities: GraphCapabilities,
): MailboxAccess {
  if (access.state !== "denied") return access;
  if (!capabilities.roles || capabilities.roles.length === 0 || capabilities.read !== false) {
    return access;
  }
  return {
    state: "unverifiable",
    reason:
      "this application holds no Mail.Read permission, so Exchange will not let it check any mailbox — it may still send, but the bounce scan cannot read bounces either; grant Mail.Read to check mailboxes and enforce the bounce rule",
  };
}

/** A mailbox a campaign may be pointed at: checked and usable, or uncheckable by design. */
export function mayChoose(access: MailboxAccess | null | undefined): boolean {
  return access?.state === "reachable" || access?.state === "unverifiable";
}

export type MailboxSource = "default" | "directory" | "campaign" | "history" | "entered";

export type MailboxOption = {
  address: string;
  displayName: string | null;
  isDefault: boolean;
  sources: MailboxSource[];
  access: MailboxAccess | null;
};

const ACCESS_ORDER: Record<string, number> = {
  reachable: 0,
  unverifiable: 1,
  unknown: 1,
  unchecked: 2,
  no_mailbox: 3,
  denied: 4,
};

/**
 * One list for the picker: the deployment default first, then every mailbox
 * that can be used, then the ones that cannot (shown, with why, because "it is
 * not in the list" is a worse answer than "it is blocked by a policy").
 */
export function mergeMailboxOptions(input: {
  defaultMailbox: string | null;
  directory: DirectoryMailbox[];
  known: { address: string; source: MailboxSource }[];
  access: Map<string, MailboxAccess>;
}): MailboxOption[] {
  const byAddress = new Map<string, MailboxOption>();
  const add = (raw: string, source: MailboxSource, displayName: string | null = null) => {
    const address = emailKey(raw);
    if (!address) return;
    const existing = byAddress.get(address);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      if (!existing.displayName && displayName) existing.displayName = displayName;
      return;
    }
    byAddress.set(address, {
      address,
      displayName,
      isDefault: false,
      sources: [source],
      access: input.access.get(address) ?? null,
    });
  };

  if (input.defaultMailbox) add(input.defaultMailbox, "default");
  for (const mailbox of input.directory) add(mailbox.address, "directory", mailbox.displayName);
  for (const entry of input.known) add(entry.address, entry.source);

  const defaultKey = input.defaultMailbox ? emailKey(input.defaultMailbox) : null;
  if (defaultKey && byAddress.has(defaultKey)) byAddress.get(defaultKey)!.isDefault = true;

  return [...byAddress.values()].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    const rank = (option: MailboxOption) => ACCESS_ORDER[option.access?.state ?? "unchecked"];
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return compareMailboxes(
      { id: null, address: a.address, displayName: a.displayName },
      { id: null, address: b.address, displayName: b.displayName },
    );
  });
}

/** Two spellings of one mailbox. */
export function sameMailbox(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = a ? emailKey(a) : null;
  const right = b ? emailKey(b) : null;
  return left === right;
}
