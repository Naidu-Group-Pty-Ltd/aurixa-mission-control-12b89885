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
 */
import { withRetry, isTransientHttpError } from "@/lib/with-retry";

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

export type GraphRecipient = { emailAddress: { address: string; name?: string } };

export type GraphMessage = {
  subject: string;
  body: { contentType: "HTML" | "Text"; content: string };
  toRecipients: GraphRecipient[];
  bccRecipients?: GraphRecipient[];
  replyTo?: GraphRecipient[];
  from?: GraphRecipient;
};

export type SendOutcome =
  | { kind: "sent"; status: number; requestId: string | null }
  | { kind: "refused"; status: number; message: string; code: string | null }
  | { kind: "throttled"; retryAfterMs: number }
  | { kind: "unconfirmed"; message: string };

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

  const requestId = response.headers.get("request-id");

  if (response.status === 202 || response.status === 200 || response.status === 204) {
    return { kind: "sent", status: response.status, requestId };
  }

  if (response.status === 429 || response.status === 503) {
    const retryAfter = Number(response.headers.get("retry-after") ?? "");
    return {
      kind: "throttled",
      retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 30_000,
    };
  }

  if (response.status === 401) forgetToken();

  const detail = await response.text().catch(() => "");
  let code: string | null = null;
  let readable = "";
  try {
    const parsed = JSON.parse(detail) as { error?: { code?: string; message?: string } };
    code = parsed?.error?.code ?? null;
    readable = parsed?.error?.message ?? "";
  } catch {
    readable = detail.slice(0, 300);
  }

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

/** Confirm a mailbox exists and this credential can reach it. */
export async function probeMailbox(mailbox: string): Promise<{ displayName: string | null }> {
  const payload = await graphGet<{ displayName?: string }>(
    `/users/${encodeURIComponent(mailbox)}?$select=displayName,mail`,
  );
  return { displayName: payload.displayName ?? null };
}
