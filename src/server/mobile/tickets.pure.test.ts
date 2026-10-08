import { describe, expect, it } from "vitest";
import {
  buildGatewayLink,
  isActivationTicket,
  isCloneMobileCredential,
  isGrantRef,
  newActivationTicket,
  newCloneMobileCredential,
  newGrantRef,
  parseGatewayLink,
  sha256Hex,
  ticketExpiry,
  ticketState,
} from "./tickets.pure";

describe("tokens", () => {
  it("mints tokens of the right shape, never the same twice", () => {
    const a = newActivationTicket();
    const b = newActivationTicket();
    expect(isActivationTicket(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(isGrantRef(newGrantRef())).toBe(true);
    expect(isCloneMobileCredential(newCloneMobileCredential())).toBe(true);
  });

  it("refuses a token of one kind presented as another", () => {
    expect(isGrantRef(newActivationTicket())).toBe(false);
    expect(isActivationTicket(newGrantRef())).toBe(false);
  });

  it("hashes to lowercase hex SHA-256", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("links", () => {
  it("carries the ticket in the fragment, never the path or query", () => {
    const grant = newGrantRef();
    const ticket = newActivationTicket();
    const link = buildGatewayLink(grant, ticket);
    const url = new URL(link);
    expect(url.host).toBe("mobile.aurixasystems.com.au");
    expect(url.pathname).toBe(`/a/${grant}`);
    expect(url.search).toBe("");
    expect(url.pathname + url.search).not.toContain(ticket);
    expect(parseGatewayLink(link)).toEqual({ grantRef: grant, ticket });
  });

  it("refuses another host and an unknown path", () => {
    const grant = newGrantRef();
    expect(parseGatewayLink(`https://evil.example/a/${grant}`)).toBeNull();
    expect(parseGatewayLink(`https://mobile.aurixasystems.com.au/b/${grant}`)).toBeNull();
    expect(parseGatewayLink("not a url")).toBeNull();
  });

  it("still names the grant when the ticket is absent or malformed", () => {
    const grant = newGrantRef();
    expect(parseGatewayLink(`https://mobile.aurixasystems.com.au/a/${grant}#t=junk`)).toEqual({
      grantRef: grant,
      ticket: null,
    });
  });
});

describe("ticket lifetimes and state", () => {
  const issued = new Date("2026-10-08T00:00:00.000Z");
  it("gives a magic link fifteen minutes and a provisioned URL forty-eight hours", () => {
    expect(ticketExpiry("magic_link", issued).toISOString()).toBe("2026-10-08T00:15:00.000Z");
    expect(ticketExpiry("provisioned_url", issued).toISOString()).toBe("2026-10-10T00:00:00.000Z");
  });

  it("is valid, expired, used, or used by this installation", () => {
    const row = {
      expires_at: "2026-10-08T00:15:00.000Z",
      consumed_at: null,
      consumed_install_id: null,
    };
    expect(ticketState(row, issued, "i")).toBe("valid");
    expect(ticketState(row, new Date("2026-10-08T00:15:00.000Z"), "i")).toBe("expired");
    const spent = {
      ...row,
      consumed_at: "2026-10-08T00:01:00.000Z",
      consumed_install_id: "install-a",
    };
    expect(ticketState(spent, issued, "install-b")).toBe("used");
    expect(ticketState(spent, issued, "install-a")).toBe("used_by_this_install");
    expect(ticketState(spent, issued, null)).toBe("used");
  });
});
