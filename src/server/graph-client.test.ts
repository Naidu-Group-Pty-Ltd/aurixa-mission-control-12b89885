// The two ways a message leaves, and what each failure means. The property
// under test throughout is the one the whole scheduler rests on: a failure
// BEFORE the send is "not sent" (safe to retry), a failure OF the send is
// "unconfirmed" (never retried automatically), and a draft whose send was
// unconfirmed is kept, because a draft still in Drafts is the proof it never
// went.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accessToken,
  createDraftMessage,
  deliverMessage,
  ensureMailFolder,
  findMessageByInternetId,
  forgetToken,
  getMailboxMessage,
  moveMailboxMessage,
  organisationOf,
  sendDraftMessage,
  listDirectoryUsers,
  probeMailboxes,
  type GraphMessage,
  type OutboundAttachment,
} from "./graph-client";
import { UPLOAD_CHUNK_BYTES } from "@/lib/email/attachments.pure";

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
type Reply = Response | Error;

let calls: Call[] = [];
let route: (call: Call) => Reply;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

beforeEach(() => {
  process.env.MICROSOFT_TENANT_ID = "tenant";
  process.env.MICROSOFT_CLIENT_ID = "client";
  process.env.MICROSOFT_CLIENT_SECRET = "secret";
  forgetToken();
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const headers = Object.fromEntries(new Headers(init.headers ?? {}).entries());
      const call: Call = {
        url: String(input),
        method: init.method ?? "GET",
        headers,
        body: init.body,
      };
      if (call.url.includes("login.microsoftonline.com")) {
        return json(200, { access_token: "token-1", expires_in: 3600 });
      }
      calls.push(call);
      const reply = route(call);
      if (reply instanceof Error) throw reply;
      return reply;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const message: GraphMessage = {
  subject: "Hello",
  body: { contentType: "HTML", content: '<p>Hi <img src="cid:logo.png"></p>' },
  toRecipients: [{ emailAddress: { address: "reader@example.test" } }],
};

function file(name: string, size: number, inline = false): OutboundAttachment {
  return {
    name,
    contentType: "application/pdf",
    bytes: new Uint8Array(size).map((_, i) => i % 251),
    isInline: inline,
    contentId: name.toLowerCase(),
  };
}

const paths = () => calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);

describe("deliverMessage — one sendMail", () => {
  it("is plain sendMail when there are no files", async () => {
    route = () => new Response(null, { status: 202 });
    const outcome = await deliverMessage("sales@aurixa.test", message);
    expect(outcome).toMatchObject({ kind: "sent", path: "sendmail", draftId: null });
    expect(paths()).toEqual(["POST /v1.0/users/sales%40aurixa.test/sendMail"]);
  });

  it("carries small files inside the request, naming a content id only for inline ones", async () => {
    route = () => new Response(null, { status: 202 });
    const outcome = await deliverMessage("sales@aurixa.test", message, [
      file("logo.png", 1000, true),
      file("brochure.pdf", 2000),
    ]);
    expect(outcome).toMatchObject({ kind: "sent", path: "sendmail" });
    const sent = JSON.parse(String(calls[0].body)) as { message: GraphMessage };
    expect(sent.message.attachments).toHaveLength(2);
    expect(sent.message.attachments?.[0]).toMatchObject({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: "logo.png",
      isInline: true,
      contentId: "logo.png",
    });
    expect(sent.message.attachments?.[1]).not.toHaveProperty("contentId");
    expect(sent.message.attachments?.[1].contentBytes).toBe(
      Buffer.from(file("brochure.pdf", 2000).bytes).toString("base64"),
    );
  });

  it("keeps the three outcomes of a send apart", async () => {
    route = () => json(503, {}, { "retry-after": "7" });
    expect(await deliverMessage("a@x.test", message, [file("a.pdf", 10)])).toMatchObject({
      kind: "throttled",
      retryAfterMs: 7000,
    });
    route = () => json(500, { error: { code: "x", message: "boom" } });
    expect(await deliverMessage("a@x.test", message, [file("a.pdf", 10)])).toMatchObject({
      kind: "unconfirmed",
    });
    route = () => new Error("socket hang up");
    expect(await deliverMessage("a@x.test", message, [file("a.pdf", 10)])).toMatchObject({
      kind: "unconfirmed",
    });
    route = () => json(403, { error: { code: "ErrorAccessDenied", message: "Access is denied" } });
    expect(await deliverMessage("a@x.test", message, [file("a.pdf", 10)])).toMatchObject({
      kind: "refused",
      status: 403,
      code: "ErrorAccessDenied",
    });
  });
});

describe("deliverMessage — a draft, for files too large for one request", () => {
  const big = UPLOAD_CHUNK_BYTES + 1000; // over 3 MB: an upload session, two PUTs

  function happy(call: Call): Reply {
    const path = new URL(call.url).pathname;
    if (call.url.startsWith("https://outlook.office.test/upload")) {
      const range = call.headers["content-range"];
      return range.endsWith(`-${big - 1}/${big}`)
        ? new Response(null, { status: 201 })
        : json(200, { nextExpectedRanges: [String(UPLOAD_CHUNK_BYTES)] });
    }
    if (call.method === "POST" && path.endsWith("/messages")) return json(201, { id: "draft-1" });
    if (path.endsWith("/createUploadSession")) {
      return json(201, { uploadUrl: "https://outlook.office.test/upload?authtoken=abc" });
    }
    if (path.endsWith("/attachments")) return json(201, { id: "att" });
    if (path.endsWith("/send")) return new Response(null, { status: 202 });
    if (call.method === "DELETE") return new Response(null, { status: 204 });
    return json(500, {});
  }

  it("creates, uploads in ranges without our token, then sends", async () => {
    route = happy;
    const outcome = await deliverMessage("sales@aurixa.test", message, [
      file("logo.png", 1000, true),
      file("report.pdf", big),
    ]);
    expect(outcome).toMatchObject({ kind: "sent", path: "draft", draftId: "draft-1" });
    expect(paths()).toEqual([
      "POST /v1.0/users/sales%40aurixa.test/messages",
      "POST /v1.0/users/sales%40aurixa.test/messages/draft-1/attachments",
      "POST /v1.0/users/sales%40aurixa.test/messages/draft-1/attachments/createUploadSession",
      "PUT /upload",
      "PUT /upload",
      "POST /v1.0/users/sales%40aurixa.test/messages/draft-1/send",
    ]);
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts.map((c) => c.headers["content-range"])).toEqual([
      `bytes 0-${UPLOAD_CHUNK_BYTES - 1}/${big}`,
      `bytes ${UPLOAD_CHUNK_BYTES}-${big - 1}/${big}`,
    ]);
    // The upload URL is pre-authenticated; our bearer token must not go there.
    for (const put of puts) expect(put.headers.authorization).toBeUndefined();
    const session = JSON.parse(String(calls[2].body)) as { AttachmentItem: { size: number } };
    expect(session.AttachmentItem).toMatchObject({ attachmentType: "file", size: big });
  });

  it("calls a failed upload 'not sent', retries the range, and deletes the draft", async () => {
    route = (call) =>
      call.method === "PUT" ? json(500, { error: { message: "busy" } }) : happy(call);
    const outcome = await deliverMessage("sales@aurixa.test", message, [file("r.pdf", big)]);
    expect(outcome).toMatchObject({ kind: "deferred", path: "draft", draftId: null });
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(3);
    expect(paths()).toContain("DELETE /v1.0/users/sales%40aurixa.test/messages/draft-1");
    expect(paths().some((p) => p.endsWith("/send"))).toBe(false);
  });

  it("refuses without a draft when the mailbox will not take one", async () => {
    route = () => json(403, { error: { code: "ErrorAccessDenied", message: "denied" } });
    const outcome = await deliverMessage("ceo@aurixa.test", message, [file("r.pdf", big)]);
    expect(outcome).toMatchObject({ kind: "refused", status: 403, draftId: null });
    expect(paths()).toEqual(["POST /v1.0/users/ceo%40aurixa.test/messages"]);
  });

  it("KEEPS the draft and names it when the send itself goes unanswered", async () => {
    route = (call) => (call.url.endsWith("/send") ? new Error("connection reset") : happy(call));
    const outcome = await deliverMessage("sales@aurixa.test", message, [file("r.pdf", big)]);
    expect(outcome).toMatchObject({ kind: "unconfirmed", path: "draft", draftId: "draft-1" });
    if (outcome.kind === "unconfirmed") expect(outcome.message).toMatch(/Drafts folder/);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("deletes the draft when the send is refused or throttled, since nothing left", async () => {
    route = (call) =>
      call.url.endsWith("/send") ? json(429, {}, { "retry-after": "2" }) : happy(call);
    const outcome = await deliverMessage("sales@aurixa.test", message, [file("r.pdf", big)]);
    expect(outcome).toMatchObject({ kind: "throttled", draftId: null });
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });
});

describe("probeMailboxes", () => {
  it("batches twenty to a request and reports each answer", async () => {
    route = (call) => {
      const body = JSON.parse(String(call.body)) as { requests: { id: string; url: string }[] };
      return json(200, {
        responses: body.requests.map((request) => ({
          id: request.id,
          status: request.url.includes("ceo") ? 403 : 200,
          body: request.url.includes("ceo") ? { error: { code: "ErrorAccessDenied" } } : {},
        })),
      });
    };
    const addresses = Array.from({ length: 24 }, (_, i) => `user${i}@aurixa.test`);
    addresses.push("ceo@aurixa.test", "USER0@aurixa.test ".trim());
    const result = await probeMailboxes(addresses);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/v1.0/$batch", "/v1.0/$batch"]);
    const first = JSON.parse(String(calls[0].body)) as { requests: { url: string }[] };
    expect(first.requests).toHaveLength(20);
    expect(first.requests[0].url).toBe("/users/user0%40aurixa.test/mailFolders/inbox?$select=id");
    expect(result.find((r) => r.address === "ceo@aurixa.test")).toEqual({
      address: "ceo@aurixa.test",
      status: 403,
      code: "ErrorAccessDenied",
    });
    expect(result.filter((r) => r.status === 200)).toHaveLength(25);
  });

  it("reports a whole batch as unanswered rather than inventing a verdict", async () => {
    route = () => new Error("offline");
    expect(await probeMailboxes(["a@x.test"])).toEqual([
      { address: "a@x.test", status: 0, code: null },
    ]);
  });
});

describe("listDirectoryUsers", () => {
  it("follows Graph's pages and stops at the limit", async () => {
    route = (call) =>
      call.url.includes("page2")
        ? json(200, { value: [{ id: "3", mail: "c@x.test" }] })
        : json(200, {
            value: [
              { id: "1", mail: "a@x.test" },
              { id: "2", mail: "b@x.test" },
            ],
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/users?page2",
          });
    expect(await listDirectoryUsers()).toMatchObject({ truncated: false, users: { length: 3 } });
    calls = [];
    expect(await listDirectoryUsers(2)).toMatchObject({ truncated: true, users: { length: 2 } });
    expect(calls).toHaveLength(1);
  });
});

describe("tokens — one per tenant", () => {
  const partner = {
    tenantId: "partner-tenant",
    clientId: "partner-client",
    clientSecret: "partner-secret",
    mailbox: null,
    key: "tenant:p1:v1",
    label: "Partner",
  };

  it("asks each tenant's own directory for a token and presents only that one", async () => {
    const issued: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit = {}) => {
        const url = String(input);
        if (url.includes("login.microsoftonline.com")) {
          const tenant = new URL(url).pathname.split("/")[1];
          issued.push(tenant);
          return json(200, { access_token: `token-for-${tenant}`, expires_in: 3600 });
        }
        calls.push({
          url,
          method: init.method ?? "GET",
          headers: Object.fromEntries(new Headers(init.headers ?? {}).entries()),
          body: init.body,
        });
        return new Response(null, { status: 202 });
      }),
    );

    await deliverMessage("a@deployment.test", message, []);
    await deliverMessage("b@partner.test", message, [], partner);
    await deliverMessage("c@partner.test", message, [], partner);

    // One token each, cached per tenant.
    expect(issued).toEqual(["tenant", "partner-tenant"]);
    expect(calls.map((call) => call.headers.authorization)).toEqual([
      "Bearer token-for-tenant",
      "Bearer token-for-partner-tenant",
      "Bearer token-for-partner-tenant",
    ]);
  });

  it("says which tenant was refused, and why, from Microsoft's code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(401, {
          error: "invalid_client",
          error_description: "AADSTS7000215: Invalid client secret provided.",
          error_codes: [7000215],
        }),
      ),
    );
    await expect(accessToken(partner)).rejects.toThrow(
      /rejected the application credentials for Partner: the client secret is wrong/,
    );
  });
});

describe("warmup operations", () => {
  const config = {
    tenantId: "Partner.Example",
    clientId: "client",
    clientSecret: "secret",
    mailbox: null,
    key: "tenant:w:v1",
    label: "Partner",
  };

  it("asks for immutable ids on every call", async () => {
    route = () => json(201, { id: "AAMk-immutable=", internetMessageId: "<m1@x>" });
    const created = await createDraftMessage("a@x.test", message, config);
    expect(created).toEqual({ id: "AAMk-immutable=", internetMessageId: "<m1@x>" });
    expect(calls[0].headers.prefer).toBe('IdType="ImmutableId"');
    expect(paths()).toEqual(["POST /v1.0/users/a%40x.test/messages"]);
  });

  it("finds a message by its Message-ID in one folder, quoting it for OData", async () => {
    route = () => json(200, { value: [{ id: "found", isRead: false }] });
    const item = await findMessageByInternetId("b@y.test", "junkemail", "<o'brien@x>", config);
    expect(item?.id).toBe("found");
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/v1.0/users/b%40y.test/mailFolders/junkemail/messages");
    expect(url.searchParams.get("$filter")).toBe("internetMessageId eq '<o''brien@x>'");

    route = () => json(200, { value: [] });
    expect(await findMessageByInternetId("b@y.test", null, "<none@x>", config)).toBeNull();
    expect(new URL(calls[1].url).pathname).toBe("/v1.0/users/b%40y.test/messages");
  });

  it("reads a gone message as null, and other failures as errors with their status", async () => {
    route = () => json(404, { error: { code: "ErrorItemNotFound", message: "gone" } });
    expect(await getMailboxMessage("a@x.test", "id-1", config)).toBeNull();

    route = () => json(403, { error: { code: "ErrorAccessDenied", message: "Access is denied." } });
    await expect(getMailboxMessage("a@x.test", "id-1", config)).rejects.toMatchObject({
      status: 403,
      code: "ErrorAccessDenied",
    });
  });

  it("sends a draft and classifies the answer like any send", async () => {
    route = () => new Response(null, { status: 202 });
    expect(await sendDraftMessage("a@x.test", "draft/1", config)).toMatchObject({ kind: "sent" });
    expect(paths()).toEqual(["POST /v1.0/users/a%40x.test/messages/draft%2F1/send"]);

    route = () => new Error("connection reset");
    expect(await sendDraftMessage("a@x.test", "draft-2", config)).toMatchObject({
      kind: "unconfirmed",
    });
  });

  it("does not retry a write that failed on the way back", async () => {
    route = () => json(503, { error: { message: "busy" } });
    await expect(moveMailboxMessage("a@x.test", "m1", "inbox", config)).rejects.toMatchObject({
      status: 503,
    });
    expect(calls).toHaveLength(1);
  });

  it("finds the warmup folder, or creates it, surviving a race to create it", async () => {
    route = () => json(200, { value: [{ id: "folder-1" }] });
    expect(await ensureMailFolder("a@x.test", "Warmup", config)).toBe("folder-1");
    expect(calls).toHaveLength(1);

    calls = [];
    let lists = 0;
    route = (call) => {
      if (call.method === "GET")
        return json(200, { value: lists++ === 0 ? [] : [{ id: "theirs" }] });
      return json(409, { error: { code: "ErrorFolderExists", message: "exists" } });
    };
    expect(await ensureMailFolder("a@x.test", "Warmup", config)).toBe("theirs");
    expect(paths()).toEqual([
      "GET /v1.0/users/a%40x.test/mailFolders",
      "POST /v1.0/users/a%40x.test/mailFolders",
      "GET /v1.0/users/a%40x.test/mailFolders",
    ]);
  });

  it("names the organisation by the directory that issued the token", async () => {
    const payload = btoa(JSON.stringify({ tid: "8F1C2D3E-4A5B-4C6D-8E7F-901234567890" }))
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(200, { access_token: `h.${payload}.s`, expires_in: 3600 })),
    );
    expect(await organisationOf({ ...config, key: "tenant:jwt:v1" })).toBe(
      "8f1c2d3e-4a5b-4c6d-8e7f-901234567890",
    );
    // A token that is not a JWT falls back to the configured tenant.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(200, { access_token: "opaque", expires_in: 3600 })),
    );
    expect(await organisationOf({ ...config, key: "tenant:opaque:v1" })).toBe("partner.example");
  });
});
