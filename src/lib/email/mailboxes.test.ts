// Which tenant mailboxes a campaign may send from, and what a refusal from
// one of them means. A mistake here either hides a usable mailbox, offers one
// whose bounces can never be read, or turns one revoked permission into a
// whole contact list marked "failed".
import { describe, expect, it } from "vitest";
import {
  capabilitiesFrom,
  describeMailboxAccess,
  mailboxesFromDirectory,
  mayChoose,
  mergeMailboxOptions,
  qualifyAccess,
  refusalPauseReason,
  refusalScope,
  sameMailbox,
  tokenRoles,
  type MailboxAccess,
} from "./mailboxes.pure";

describe("mailboxesFromDirectory", () => {
  it("keeps users and shared mailboxes with a mail address, normalised and sorted", () => {
    const result = mailboxesFromDirectory([
      { id: "2", displayName: "Sales", mail: "Sales@Aurixa.test", userPrincipalName: "sales@x" },
      { id: "1", displayName: "Accounts", mail: "accounts@aurixa.test" },
      { id: "3", displayName: "No mailbox", mail: null },
    ]);
    expect(result).toEqual([
      { id: "1", address: "accounts@aurixa.test", displayName: "Accounts" },
      { id: "2", address: "sales@aurixa.test", displayName: "Sales" },
    ]);
  });

  it("drops guests, whose address belongs to another tenant", () => {
    const result = mailboxesFromDirectory([
      {
        id: "g",
        displayName: "Guest",
        mail: "guest@elsewhere.test",
        userPrincipalName: "guest_elsewhere.test#EXT#@aurixa.onmicrosoft.com",
      },
    ]);
    expect(result).toEqual([]);
  });

  it("lists one entry per address", () => {
    const result = mailboxesFromDirectory([
      { id: "a", mail: "hello@aurixa.test" },
      { id: "b", mail: "HELLO@aurixa.test" },
    ]);
    expect(result).toHaveLength(1);
  });
});

describe("describeMailboxAccess", () => {
  it("is usable on success", () => {
    expect(describeMailboxAccess(200, null)).toEqual({ state: "reachable", reason: null });
  });

  it("names the access policy when Exchange refuses", () => {
    const access = describeMailboxAccess(403, "ErrorAccessDenied");
    expect(access.state).toBe("denied");
    expect(access.reason).toMatch(/access policy/);
  });

  it("distinguishes a user with no Exchange Online mailbox from no such user", () => {
    expect(describeMailboxAccess(404, "MailboxNotEnabledForRESTAPI")).toMatchObject({
      state: "no_mailbox",
      reason: expect.stringMatching(/on-premises/),
    });
    expect(describeMailboxAccess(404, "ResourceNotFound")).toMatchObject({
      state: "no_mailbox",
      reason: expect.stringMatching(/no such mailbox/),
    });
  });

  it("does not call a throttled or unreachable probe a verdict", () => {
    expect(describeMailboxAccess(429, null).state).toBe("unknown");
    expect(describeMailboxAccess(503, null).state).toBe("unknown");
    expect(describeMailboxAccess(0, null).state).toBe("unknown");
  });
});

describe("refusalScope", () => {
  it("keeps an address problem on the recipient", () => {
    expect(refusalScope(400, "ErrorInvalidRecipients")).toBe("recipient");
    expect(refusalScope(400, null)).toBe("recipient");
  });

  it("lifts a mailbox problem to the campaign", () => {
    expect(refusalScope(403, "ErrorAccessDenied")).toBe("mailbox");
    expect(refusalScope(403, null)).toBe("mailbox");
    expect(refusalScope(401, null)).toBe("mailbox");
    expect(refusalScope(404, "ErrorInvalidUser")).toBe("mailbox");
    expect(refusalScope(400, "ErrorSendAsDenied")).toBe("mailbox");
  });

  it("lifts an oversized message to the campaign, whatever the status", () => {
    expect(refusalScope(413, null)).toBe("message");
    expect(refusalScope(400, "ErrorMessageSizeExceeded")).toBe("message");
    expect(refusalScope(400, "ErrorAttachmentSizeShouldNotBeLessThanMinimumSize")).toBe("message");
  });

  it("explains a pause in a sentence that says nothing was sent", () => {
    expect(refusalPauseReason("mailbox", "sales@x.test", "Access denied")).toMatch(
      /sales@x\.test.*Nothing was sent/,
    );
    expect(refusalPauseReason("message", "sales@x.test", "")).toMatch(/attachments/);
  });

  it("names Mail.ReadWrite, not another mailbox, when the refusal came while building a draft", () => {
    const reason = refusalPauseReason("mailbox", "sales@x.test", "Access is denied.", "draft");
    expect(reason).toMatch(/Mail\.ReadWrite/);
    expect(reason).not.toMatch(/Choose a mailbox/);
  });
});

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url").replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode(payload)}.signature`;
}

describe("tokenRoles", () => {
  it("reads the application permissions a token carries", () => {
    expect(tokenRoles(jwt({ roles: ["Mail.Send", "Mail.Read"] }))).toEqual([
      "Mail.Send",
      "Mail.Read",
    ]);
  });

  it("is an empty list for a token granted through Exchange alone", () => {
    expect(tokenRoles(jwt({ appid: "x" }))).toEqual([]);
  });

  it("is null for something that is not a JWT", () => {
    expect(tokenRoles("opaque-token")).toBeNull();
    expect(tokenRoles("a.!!!.c")).toBeNull();
  });
});

describe("capabilitiesFrom", () => {
  it("maps roles to what the page needs to know", () => {
    expect(capabilitiesFrom(["Mail.Send", "Mail.ReadWrite", "User.ReadBasic.All"])).toMatchObject({
      send: true,
      read: true,
      readWrite: true,
      directory: true,
    });
    expect(capabilitiesFrom(["Mail.Send", "Mail.Read"])).toMatchObject({
      send: true,
      read: true,
      readWrite: false,
      directory: false,
    });
  });

  it("knows nothing when the token could not be read", () => {
    expect(capabilitiesFrom(null)).toEqual({
      roles: null,
      send: null,
      read: null,
      readWrite: null,
      directory: null,
    });
  });
});

describe("mergeMailboxOptions", () => {
  const access = new Map<string, MailboxAccess>([
    ["hello@aurixa.test", { state: "reachable", reason: null }],
    ["ceo@aurixa.test", { state: "denied", reason: "policy" }],
    ["sales@aurixa.test", { state: "reachable", reason: null }],
  ]);

  it("puts the default first, then usable mailboxes, then the ones that cannot be used", () => {
    const options = mergeMailboxOptions({
      defaultMailbox: "Hello@Aurixa.test",
      directory: [
        { id: "1", address: "ceo@aurixa.test", displayName: "Chief" },
        { id: "2", address: "sales@aurixa.test", displayName: "Sales" },
        { id: "3", address: "hello@aurixa.test", displayName: "Hello" },
        { id: "4", address: "unchecked@aurixa.test", displayName: "Unchecked" },
      ],
      known: [{ address: "sales@aurixa.test", source: "campaign" }],
      access,
    });
    expect(options.map((o) => o.address)).toEqual([
      "hello@aurixa.test",
      "sales@aurixa.test",
      "unchecked@aurixa.test",
      "ceo@aurixa.test",
    ]);
    expect(options[0]).toMatchObject({ isDefault: true, displayName: "Hello" });
    expect(options[1].sources).toEqual(["directory", "campaign"]);
    expect(options[2].access).toBeNull();
  });

  it("still offers known mailboxes when the directory cannot be read", () => {
    const options = mergeMailboxOptions({
      defaultMailbox: null,
      directory: [],
      known: [
        { address: "sales@aurixa.test", source: "history" },
        { address: "not an address", source: "campaign" },
      ],
      access,
    });
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ address: "sales@aurixa.test", isDefault: false });
  });
});

describe("sameMailbox", () => {
  it("compares the normalised address", () => {
    expect(sameMailbox("Sales@X.test", " sales@x.test ")).toBe(true);
    expect(sameMailbox("a@x.test", "b@x.test")).toBe(false);
    expect(sameMailbox(null, undefined)).toBe(true);
  });
});

describe("qualifyAccess", () => {
  const denied = describeMailboxAccess(403, "ErrorAccessDenied");

  it("does not call every mailbox blocked when the application simply cannot read mail", () => {
    // Mail.Send without Mail.Read: Exchange refuses EVERY inbox read, so the
    // probe says nothing about any one mailbox. Blocking here would stop
    // campaigns that send today.
    const access = qualifyAccess(denied, capabilitiesFrom(["Mail.Send"]));
    expect(access.state).toBe("unverifiable");
    expect(access.reason).toMatch(/Mail\.Read.*bounce/);
    expect(mayChoose(access)).toBe(true);
  });

  it("trusts the probe when the application can read mail", () => {
    expect(qualifyAccess(denied, capabilitiesFrom(["Mail.Send", "Mail.Read"]))).toEqual(denied);
  });

  it("trusts the probe when the token says nothing (Exchange RBAC, or unreadable)", () => {
    expect(qualifyAccess(denied, capabilitiesFrom([]))).toEqual(denied);
    expect(qualifyAccess(denied, capabilitiesFrom(null))).toEqual(denied);
  });

  it("leaves every other answer alone", () => {
    const reachable = describeMailboxAccess(200, null);
    expect(qualifyAccess(reachable, capabilitiesFrom(["Mail.Send"]))).toEqual(reachable);
  });
});

describe("mayChoose", () => {
  it("allows only a usable or an uncheckable-by-design mailbox", () => {
    expect(mayChoose({ state: "reachable", reason: null })).toBe(true);
    expect(mayChoose({ state: "unverifiable", reason: "x" })).toBe(true);
    for (const state of ["denied", "no_mailbox", "unknown"] as const) {
      expect(mayChoose({ state, reason: "x" })).toBe(false);
    }
    expect(mayChoose(null)).toBe(false);
  });
});
