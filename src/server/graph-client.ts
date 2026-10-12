/**
 * Microsoft Graph — the only place this codebase talks to a mailbox.
 *
 * Shaped after `src/server/resend-client.ts`: a typed error carrying the
 * status, the credential read from `process.env` at CALL time rather than at
 * module load (a module-level read makes an absent credential a boot failure
 * instead of a dormant feature), and no behaviour at import.
 *
 * ## Which credential this is
 *
 * The same application registration the prime property dashboard uses —
 * `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`,
 * `MICROSOFT_MAILBOX_EMAIL`. It is a client-credentials (application) identity
 * with `Mail.Send` and `Mail.Read`, which means it can act on a mailbox with
 * nobody signed in — and, unless an Exchange application access policy
 * restricts it, on ANY mailbox in the tenant. That is why the mailbox a
 * campaign sends from is a stored, operator-set field rather than something a
 * request may name.
 *
 * ## Why the send does not retry
 *
 * `withRetry` is right for reading a mailbox and wrong for sending one
 * message. `sendMail` answers 202 with no body: an error after the request has
 * left the isolate does not say whether the message was created, and retrying
 * on that is precisely the duplicate the whole feature is built to prevent. So
 * the send classifies its outcome and hands it back — `sent`, `refused` (the
 * service said no BEFORE accepting, so no message exists), `throttled` (a 429,
 * which is a refusal to start and safe to try again later), or `unconfirmed`
 * (we do not know, and nothing may resend on that). Only the reads retry.
 *
 * ## Attachments, and the second way to send
 *
 * `sendMail` carries attachments inside its one request, as base64, and that
 * request is capped at about 4 MB — so a message whose files total more than
 * about 2.9 MB cannot be sent that way at all. Such a message is built as a
 * DRAFT: created, each file attached (a file of 3 MB or more through an upload
 * session, in pieces), then sent. Everything before the final `send` call
 * creates a draft and sends nothing, so a failure there is `refused`,
 * `throttled` or `deferred` — never `unconfirmed` — and the draft is deleted.
 * The final call is classified exactly as `sendMail` is. When it ends
 * unconfirmed the draft is KEPT and its id returned: a draft still sitting in
 * Drafts is proof that it never left, and that is a person's to check.
 *
 * ## Which mailbox
 *
 * `MICROSOFT_MAILBOX_EMAIL` is a default, not a limit: an application
 * permission reaches every mailbox the tenant's Exchange policy allows. So
 * this also lists the tenant's mailboxes (`listDirectoryUsers`, which needs a
 * directory permission) and asks which of them this application can actually
 * use (`probeMailboxes`, one inbox-folder read each, batched twenty to a
 * request). `src/lib/email/mailboxes.pure.ts` says why "can read its inbox" is
 * the test.
 */
import { withRetry, isTransientHttpError } from "@/lib/with-retry";
import {
  UPLOAD_SESSION_MIN_BYTES,
  bytesToBase64,
  deliveryPath,
  estimateSendMailBytes,
  uploadRanges,
  type DeliveryPath,
} from "@/lib/email/attachments.pure";
import { tokenRoles, type DirectoryUser } from "@/lib/email/mailboxes.pure";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const LOGIN_BASE = "https://login.microsoftonline.com";

export class GraphError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /** Graph's own error code, e.g. "ErrorAccessDenied", when the body carried one. */
    public readonly code: string | null,
  ) {
    super(message);
    this.name = "GraphError";
  }
}

export type GraphConfig = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  mailbox: string | null;
};

function readConfig(): GraphConfig | null {
  const tenantId = process.env.MICROSOFT_TENANT_ID?.trim();
  const clientId = process.env.MICROSOFT_CLIENT_ID?.trim();
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET?.trim();
  if (!tenantId || !clientId || !clientSecret) return null;
  return {
    tenantId,
    clientId,
    clientSecret,
    mailbox: process.env.MICROSOFT_MAILBOX_EMAIL?.trim() || null,
  };
}

/**
 * Whether this deployment can send at all. The campaign page asks so an
 * unconfigured console says "no mailbox is configured" rather than offering a
 * Start button that can only fail.
 */
export function isGraphConfigured(): boolean {
  return readConfig() !== null;
}

/** The mailbox campaigns send from when they do not name one themselves. */
export function defaultMailbox(): string | null {
  return readConfig()?.mailbox ?? null;
}

export function requireGraphConfig(): GraphConfig {
  const config = readConfig();
  if (!config) {
    throw new GraphError(
      "Microsoft Graph is not configured — MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET must all be set",
      0,
      "not_configured",
    );
  }
  return config;
}

// A client-credentials token lasts about an hour. Cached per isolate, which is
// the correct scope: an isolate is one machine's copy of the worker, the cache
// dies with it, and nothing is shared between tenants because there is only
// one tenant. Sixty seconds of headroom, so a token cannot expire in flight.
let cachedToken: { value: string; expiresAt: number } | null = null;

export async function accessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now) return cachedToken.value;

  const config = requireGraphConfig();
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });

  const response = await fetch(
    `${LOGIN_BASE}/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  );

  const payload = (await response.json().catch(() => null)) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  } | null;

  if (!response.ok || !payload?.access_token) {
    // The description names the tenant and the application; it is logged and
    // not returned, and the sentence the operator sees is authored here.
    console.error(
      "[graph] token request failed:",
      response.status,
      payload?.error_description ?? "",
    );
    throw new GraphError(
      response.status === 401 || response.status === 400
        ? "Microsoft rejected this deployment's application credentials"
        : `Microsoft did not issue a token (${response.status})`,
      response.status,
      payload?.error ?? null,
    );
  }

  const lifetime = Math.max(60, Number(payload.expires_in ?? 3600));
  cachedToken = { value: payload.access_token, expiresAt: now + (lifetime - 60) * 1000 };
  return cachedToken.value;
}

/** Drop the cached token. Called when Graph answers 401 on a call that had one. */
export function forgetToken(): void {
  cachedToken = null;
}

/**
 * The application permissions this deployment's token carries, or null when
 * the token is not a readable JWT. Advisory — see `tokenRoles`.
 */
export async function grantedRoles(): Promise<string[] | null> {
  return tokenRoles(await accessToken());
}

export type GraphRecipient = { emailAddress: { address: string; name?: string } };

export type GraphFileAttachment = {
  "@odata.type": "#microsoft.graph.fileAttachment";
  name: string;
  contentType: string;
  contentBytes: string;
  isInline?: boolean;
  contentId?: string;
};

export type GraphMessage = {
  subject: string;
  body: { contentType: "HTML" | "Text"; content: string };
  toRecipients: GraphRecipient[];
  bccRecipients?: GraphRecipient[];
  replyTo?: GraphRecipient[];
  from?: GraphRecipient;
  attachments?: GraphFileAttachment[];
};

export type SendOutcome =
  | { kind: "sent"; status: number; requestId: string | null }
  | { kind: "refused"; status: number; message: string; code: string | null }
  | { kind: "throttled"; retryAfterMs: number }
  | { kind: "unconfirmed"; message: string };

/**
 * Nothing was sent, and the cause looks temporary — a 5xx or a dropped
 * connection while a DRAFT was being built, before anything was asked to
 * leave. As safe to retry as a throttle. Only the draft path produces it, so
 * it is not part of `SendOutcome`, which every other sender here narrows.
 */
export type DeferredOutcome = { kind: "deferred"; message: string };

type PreSendOutcome = SendOutcome | DeferredOutcome;

/** Graph's error body, read without trusting it to be JSON. */
async function readGraphError(response: Response): Promise<{ code: string | null; text: string }> {
  const detail = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(detail) as { error?: { code?: string; message?: string } };
    return { code: parsed?.error?.code ?? null, text: parsed?.error?.message ?? "" };
  } catch {
    return { code: null, text: detail.slice(0, 300) };
  }
}

function retryAfterMs(response: Response): number {
  const retryAfter = Number(response.headers.get("retry-after") ?? "");
  return Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 30_000;
}

/**
 * What the answer to a SEND means — `sendMail`, or a draft's `send`. The one
 * place the three-outcome rule is written down.
 */
async function classifySendResponse(response: Response): Promise<SendOutcome> {
  const requestId = response.headers.get("request-id");

  if (response.status === 202 || response.status === 200 || response.status === 204) {
    return { kind: "sent", status: response.status, requestId };
  }

  if (response.status === 429 || response.status === 503) {
    return { kind: "throttled", retryAfterMs: retryAfterMs(response) };
  }

  if (response.status === 401) forgetToken();

  const { code, text: readable } = await readGraphError(response);

  // A 5xx from Graph is the ambiguous case: the service may have accepted the
  // message and failed on the way back. It is recorded as unconfirmed rather
  // than as a failure, because a failure is retried and this must not be.
  if (response.status >= 500) {
    return {
      kind: "unconfirmed",
      message: `Graph answered ${response.status}${readable ? `: ${readable.slice(0, 200)}` : ""}`,
    };
  }

  return {
    kind: "refused",
    status: response.status,
    message: readable.slice(0, 400) || `Graph refused the message (${response.status})`,
    code,
  };
}

/**
 * Hand one message to Graph.
 *
 * Never throws for a send failure — the outcome is the return value, because
 * the caller has to record three different facts and a thrown error collapses
 * them into one. It throws only for a missing or refused credential, which
 * happens before anything is on the wire.
 */
export async function sendMail(
  mailbox: string,
  message: GraphMessage,
  saveToSentItems = true,
): Promise<SendOutcome> {
  const token = await accessToken();
  const url = `${GRAPH_BASE}/users/${encodeURIComponent(mailbox)}/sendMail`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message, saveToSentItems }),
    });
  } catch (error) {
    // The request left and no answer came back. Whether a message exists is
    // unknowable from here, and "unknowable" is not "no".
    return {
      kind: "unconfirmed",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  return classifySendResponse(response);
}

/** A file to send, already read and verified by the caller. */
export type OutboundAttachment = {
  name: string;
  contentType: string;
  bytes: Uint8Array;
  /** Shown in the body through `cid:<contentId>` rather than listed as a file. */
  isInline: boolean;
  contentId: string;
};

export type DeliveryOutcome = PreSendOutcome & {
  path: DeliveryPath;
  /**
   * The draft's id, kept only when a draft send ended `unconfirmed` (or
   * `sent`): that is when a person may need to look for it. Null whenever the
   * draft was deleted or never existed.
   */
  draftId: string | null;
};

// One message per contact re-sends the same files many times a tick; the
// base64 is computed once per set of bytes rather than once per message.
const base64Memo = new WeakMap<Uint8Array, string>();

function toFileAttachment(attachment: OutboundAttachment): GraphFileAttachment {
  let contentBytes = base64Memo.get(attachment.bytes);
  if (contentBytes === undefined) {
    contentBytes = bytesToBase64(attachment.bytes);
    base64Memo.set(attachment.bytes, contentBytes);
  }
  return {
    "@odata.type": "#microsoft.graph.fileAttachment",
    name: attachment.name,
    contentType: attachment.contentType,
    contentBytes,
    isInline: attachment.isInline,
    ...(attachment.isInline ? { contentId: attachment.contentId } : {}),
  };
}

/**
 * Send one message with its files, by whichever path fits.
 *
 * With no files, or files small enough to ride inside one request, this IS
 * `sendMail`. Larger, it builds a draft — see the header. Either way the
 * outcome means what `sendMail`'s means, plus `deferred`.
 */
export async function deliverMessage(
  mailbox: string,
  message: GraphMessage,
  attachments: OutboundAttachment[] = [],
): Promise<DeliveryOutcome> {
  if (attachments.length === 0) {
    return { ...(await sendMail(mailbox, message)), path: "sendmail", draftId: null };
  }

  const bareBytes = new TextEncoder().encode(
    JSON.stringify({ message, saveToSentItems: true }),
  ).length;
  const estimate = estimateSendMailBytes(
    bareBytes,
    attachments.map((attachment) => ({ size: attachment.bytes.length, name: attachment.name })),
  );

  if (deliveryPath(estimate, attachments.length) === "sendmail") {
    const outcome = await sendMail(mailbox, {
      ...message,
      attachments: attachments.map(toFileAttachment),
    });
    return { ...outcome, path: "sendmail", draftId: null };
  }

  return sendThroughDraft(mailbox, message, attachments);
}

type Step<T> = { ok: true; value: T } | { ok: false; outcome: PreSendOutcome };

/**
 * One call while a draft is being built. Nothing it does sends anything, so
 * no failure here is `unconfirmed`: a 4xx is `refused`, a 429/503 is
 * `throttled`, and a 5xx or a dropped connection is `deferred`.
 */
async function draftStep<T>(method: "POST", path: string, body: unknown): Promise<Step<T>> {
  let token: string;
  try {
    token = await accessToken();
  } catch (error) {
    return {
      ok: false,
      outcome: {
        kind: "deferred",
        message: error instanceof Error ? error.message : "could not obtain a Microsoft token",
      },
    };
  }

  let response: Response;
  try {
    response = await fetch(`${GRAPH_BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return {
      ok: false,
      outcome: {
        kind: "deferred",
        message: `building the draft: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }

  if (response.ok) {
    return { ok: true, value: (await response.json().catch(() => null)) as T };
  }
  return { ok: false, outcome: await preSendFailure(response, "building the draft") };
}

async function preSendFailure(response: Response, during: string): Promise<PreSendOutcome> {
  if (response.status === 429 || response.status === 503) {
    return { kind: "throttled", retryAfterMs: retryAfterMs(response) };
  }
  if (response.status === 401) forgetToken();
  const { code, text } = await readGraphError(response);
  if (response.status >= 500) {
    return {
      kind: "deferred",
      message: `${during}: Graph answered ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
    };
  }
  return {
    kind: "refused",
    status: response.status,
    message: text.slice(0, 400) || `Graph refused ${during} (${response.status})`,
    code,
  };
}

/** Delete a draft that will not be sent. Best effort: a stray draft sends nothing. */
async function discardDraft(draftPath: string): Promise<void> {
  try {
    const token = await accessToken();
    const response = await fetch(`${GRAPH_BASE}${draftPath}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok && response.status !== 404) {
      console.error(`[graph] could not delete an unsent draft (${response.status})`);
    }
  } catch (error) {
    console.error(
      "[graph] could not delete an unsent draft:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Attach a file of 3 MB or more through an upload session.
 *
 * The upload URL is pre-authenticated on outlook.office.com and must NOT carry
 * our bearer token. A range is idempotent — the session says which bytes it
 * expects next — so a range that fails on the way is retried; nothing in this
 * function can send a message.
 */
async function uploadLargeAttachment(
  draftPath: string,
  attachment: OutboundAttachment,
): Promise<Step<null>> {
  const size = attachment.bytes.length;
  const session = await draftStep<{ uploadUrl?: string }>(
    "POST",
    `${draftPath}/attachments/createUploadSession`,
    {
      AttachmentItem: {
        attachmentType: "file",
        name: attachment.name,
        size,
        contentType: attachment.contentType,
        isInline: attachment.isInline,
        ...(attachment.isInline ? { contentId: attachment.contentId } : {}),
      },
    },
  );
  if (!session.ok) return session;
  const uploadUrl = session.value?.uploadUrl;
  if (!uploadUrl) {
    return {
      ok: false,
      outcome: { kind: "deferred", message: "Microsoft opened an upload session with no URL" },
    };
  }

  for (const range of uploadRanges(size)) {
    let lastFailure: PreSendOutcome | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      let response: Response;
      try {
        response = await fetch(uploadUrl, {
          method: "PUT",
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
          },
          body: attachment.bytes.subarray(range.start, range.end + 1) as unknown as BodyInit,
        });
      } catch (error) {
        lastFailure = {
          kind: "deferred",
          message: `uploading ${attachment.name}: ${error instanceof Error ? error.message : String(error)}`,
        };
        continue;
      }
      if (response.ok) {
        lastFailure = null;
        break;
      }
      lastFailure = await preSendFailure(response, `uploading ${attachment.name}`);
      // Only a server-side hiccup is worth another go; a refusal or a throttle
      // will answer the same way a moment later.
      if (lastFailure.kind !== "deferred") break;
    }
    if (lastFailure) return { ok: false, outcome: lastFailure };
  }
  return { ok: true, value: null };
}

async function sendThroughDraft(
  mailbox: string,
  message: GraphMessage,
  attachments: OutboundAttachment[],
): Promise<DeliveryOutcome> {
  const messages = `/users/${encodeURIComponent(mailbox)}/messages`;
  const created = await draftStep<{ id?: string }>("POST", messages, message);
  if (!created.ok) return { ...created.outcome, path: "draft", draftId: null };
  const draftId = created.value?.id;
  if (!draftId) {
    return {
      kind: "deferred",
      message: "Microsoft created a draft but did not say which",
      path: "draft",
      draftId: null,
    };
  }
  const draftPath = `${messages}/${encodeURIComponent(draftId)}`;

  for (const attachment of attachments) {
    const attached =
      attachment.bytes.length < UPLOAD_SESSION_MIN_BYTES
        ? await draftStep<unknown>("POST", `${draftPath}/attachments`, toFileAttachment(attachment))
        : await uploadLargeAttachment(draftPath, attachment);
    if (!attached.ok) {
      await discardDraft(draftPath);
      return { ...attached.outcome, path: "draft", draftId: null };
    }
  }

  // Taken before the send, so a credential failure here is "not sent" rather
  // than being caught below and recorded as "may have been sent".
  let token: string;
  try {
    token = await accessToken();
  } catch (error) {
    await discardDraft(draftPath);
    return {
      kind: "deferred",
      message: error instanceof Error ? error.message : "could not obtain a Microsoft token",
      path: "draft",
      draftId: null,
    };
  }

  let response: Response;
  try {
    response = await fetch(`${GRAPH_BASE}${draftPath}/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    // The send left and no answer came back. The draft stays where it is: if
    // it is still in Drafts, it never went.
    return {
      kind: "unconfirmed",
      message: `${error instanceof Error ? error.message : String(error)} — if draft ${draftId} is still in the mailbox's Drafts folder, it was not sent`,
      path: "draft",
      draftId,
    };
  }

  const outcome = await classifySendResponse(response);
  if (outcome.kind === "refused" || outcome.kind === "throttled") {
    await discardDraft(draftPath);
    return { ...outcome, path: "draft", draftId: null };
  }
  if (outcome.kind === "unconfirmed") {
    return {
      ...outcome,
      message: `${outcome.message} — if draft ${draftId} is still in the mailbox's Drafts folder, it was not sent`,
      path: "draft",
      draftId,
    };
  }
  return { ...outcome, path: "draft", draftId };
}

export type GraphMailMessage = {
  id: string;
  subject: string | null;
  receivedDateTime: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  body?: { contentType?: string; content?: string };
  bodyPreview?: string;
  internetMessageHeaders?: { name: string; value: string }[];
};

async function graphGet<T>(path: string, headers: Record<string, string> = {}): Promise<T> {
  return withRetry(
    async () => {
      const token = await accessToken();
      const response = await fetch(path.startsWith("http") ? path : `${GRAPH_BASE}${path}`, {
        headers: { Authorization: `Bearer ${token}`, ...headers },
      });
      if (response.status === 401) forgetToken();
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        let code: string | null = null;
        let readable = detail.slice(0, 300);
        try {
          const parsed = JSON.parse(detail) as { error?: { code?: string; message?: string } };
          code = parsed?.error?.code ?? null;
          readable = parsed?.error?.message ?? readable;
        } catch {
          /* the body was not JSON */
        }
        throw new GraphError(readable || `Graph ${response.status}`, response.status, code);
      }
      return (await response.json()) as T;
    },
    {
      attempts: 3,
      shouldRetry: (error) => {
        if (error instanceof GraphError) return error.status === 429 || error.status >= 500;
        return isTransientHttpError(error);
      },
    },
  );
}

/**
 * Messages that arrived in a mailbox's inbox since an instant.
 *
 * `Prefer: outlook.body-content-type="text"` asks Exchange to render the body
 * as plain text. A delivery report's machine-readable part is line-oriented
 * (`Final-Recipient:`, `Status:`), and reading it out of the HTML rendering
 * means unpicking `<br>` and entities to recover lines that were already there.
 */
export type MailPage = { messages: GraphMailMessage[]; nextLink: string | null };

export async function listInboxSince(mailbox: string, since: Date, top = 50): Promise<MailPage> {
  const filter = `receivedDateTime ge ${since.toISOString().replace(/\.\d{3}Z$/, "Z")}`;
  const query = new URLSearchParams({
    $select: "id,subject,receivedDateTime,from,body,internetMessageHeaders",
    $filter: filter,
    $orderby: "receivedDateTime asc",
    $top: String(Math.min(Math.max(top, 1), 100)),
  });
  const path = `/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages?${query.toString()}`;
  return readMailPage(path);
}

/** Continue a listing from Graph's own `@odata.nextLink`. */
export async function listInboxPage(nextLink: string): Promise<MailPage> {
  return readMailPage(nextLink);
}

async function readMailPage(path: string): Promise<MailPage> {
  const payload = await graphGet<{ value: GraphMailMessage[]; "@odata.nextLink"?: string }>(path, {
    Prefer: 'outlook.body-content-type="text"',
  });
  return { messages: payload.value ?? [], nextLink: payload["@odata.nextLink"] ?? null };
}

/**
 * The tenant's users, enough of each to offer it as a mailbox.
 *
 * Needs a directory permission (`User.ReadBasic.All` is the least of them);
 * without one Graph answers 403 and this throws, which the caller turns into
 * "the directory cannot be listed" rather than an empty list — an empty list
 * would read as "this tenant has no mailboxes".
 *
 * Only basic profile fields are asked for, so `User.ReadBasic.All` suffices.
 */
export async function listDirectoryUsers(
  limit = 2000,
): Promise<{ users: DirectoryUser[]; truncated: boolean }> {
  const users: DirectoryUser[] = [];
  let next: string | null = `/users?${new URLSearchParams({
    $select: "id,displayName,mail,userPrincipalName",
    $top: "999",
  }).toString()}`;
  while (next) {
    const page: { value?: DirectoryUser[]; "@odata.nextLink"?: string } = await graphGet(next);
    users.push(...(page.value ?? []));
    if (users.length >= limit) return { users: users.slice(0, limit), truncated: true };
    next = page["@odata.nextLink"] ?? null;
  }
  return { users, truncated: false };
}

export type MailboxProbe = { address: string; status: number; code: string | null };

/** Graph's JSON batching ceiling. */
const BATCH_SIZE = 20;
/** Batches in flight at once — gentle enough that a probe never trips throttling. */
const BATCH_CONCURRENCY = 3;

/**
 * Can this application use each of these mailboxes? One inbox-folder read
 * apiece, twenty to a `$batch`.
 *
 * Reports the raw status and code per address and judges nothing —
 * `describeMailboxAccess` does that. A batch that fails as a whole (network,
 * throttle) reports its status against every address in it, so the caller
 * sees "unknown" rather than a verdict nobody reached.
 */
export async function probeMailboxes(addresses: string[]): Promise<MailboxProbe[]> {
  const unique = [...new Set(addresses.map((address) => address.trim()).filter(Boolean))];
  const chunks: string[][] = [];
  for (let at = 0; at < unique.length; at += BATCH_SIZE) {
    chunks.push(unique.slice(at, at + BATCH_SIZE));
  }

  const results: MailboxProbe[] = [];
  for (let at = 0; at < chunks.length; at += BATCH_CONCURRENCY) {
    const settled = await Promise.all(chunks.slice(at, at + BATCH_CONCURRENCY).map(probeBatch));
    for (const batch of settled) results.push(...batch);
  }
  return results;
}

async function probeBatch(addresses: string[]): Promise<MailboxProbe[]> {
  const everyone = (status: number, code: string | null = null) =>
    addresses.map((address) => ({ address, status, code }));

  let token: string;
  try {
    token = await accessToken();
  } catch (error) {
    return everyone(error instanceof GraphError ? error.status : 0, "token");
  }

  let response: Response;
  try {
    response = await fetch(`${GRAPH_BASE}/$batch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: addresses.map((address, index) => ({
          id: String(index),
          method: "GET",
          url: `/users/${encodeURIComponent(address)}/mailFolders/inbox?$select=id`,
        })),
      }),
    });
  } catch {
    return everyone(0);
  }
  if (response.status === 401) forgetToken();
  if (!response.ok) return everyone(response.status);

  const payload = (await response.json().catch(() => null)) as {
    responses?: { id?: string; status?: number; body?: { error?: { code?: string } } }[];
  } | null;
  const byId = new Map((payload?.responses ?? []).map((entry) => [String(entry.id), entry]));
  return addresses.map((address, index) => {
    const entry = byId.get(String(index));
    return {
      address,
      status: typeof entry?.status === "number" ? entry.status : 0,
      code: entry?.body?.error?.code ?? null,
    };
  });
}
