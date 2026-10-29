// Who a lead email sends as (Email → Lead emails' "Sent as").
//
// The deployment's own mailbox lives in the deployment's own tenant. Found by
// setting the identity on production: the deployment's campaigns send from a
// Naidu Property Consulting mailbox, Aurixa's tenant is an added one, and a
// blank mailbox under it used to resolve to the deployment's address — which
// Graph refuses to send as through another directory's credentials.
import { describe, it, expect, vi } from "vitest";

const DEPLOYMENT = {
  tenantId: "deployment-directory",
  clientId: "deployment-client",
  clientSecret: "x",
  mailbox: "property@npcservices.com.au",
};
const AURIXA = {
  tenantId: "aurixa-directory",
  clientId: "aurixa-client",
  clientSecret: "y",
  mailbox: "admin@aurixasystems.com.au",
  key: "tenant:aurixa:v1",
  label: "Aurixa Systems",
};

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/server/graph-client", () => ({
  defaultGraphConfig: () => DEPLOYMENT,
  sendMail: async () => ({ kind: "sent", status: 202, requestId: null }),
}));
vi.mock("@/server/microsoft-tenants.server", () => ({
  graphConfigFor: async (tenantId: string | null) =>
    tenantId === "aurixa" ? AURIXA : tenantId ? null : DEPLOYMENT,
}));

import { DEFAULT_LEAD_EMAIL_SETTINGS, sendingIdentity } from "./lead-emails.server";

const settings = (over: Partial<typeof DEFAULT_LEAD_EMAIL_SETTINGS>) => ({
  ...DEFAULT_LEAD_EMAIL_SETTINGS,
  ...over,
});
const ENV_MAILBOX = "property@npcservices.com.au";

describe("sendingIdentity", () => {
  it("sends as an added tenant's own mailbox when none is named", async () => {
    const identity = await sendingIdentity(settings({ tenantId: "aurixa" }), ENV_MAILBOX);
    expect(identity).toMatchObject({ ok: true, mailbox: "admin@aurixasystems.com.au" });
    if (identity.ok) expect(identity.config.key).toBe("tenant:aurixa:v1");
  });

  it("sends as the mailbox named, under the tenant chosen", async () => {
    const identity = await sendingIdentity(
      settings({
        tenantId: "aurixa",
        fromMailbox: "trials@aurixasystems.com.au",
        fromName: "Aurixa Systems",
        replyTo: "admin@aurixasystems.com.au",
      }),
      ENV_MAILBOX,
    );
    expect(identity).toMatchObject({
      ok: true,
      mailbox: "trials@aurixasystems.com.au",
      fromName: "Aurixa Systems",
      replyTo: "admin@aurixasystems.com.au",
      supportEmail: "admin@aurixasystems.com.au",
    });
  });

  it("keeps the deployment's mailbox for the deployment's tenant", async () => {
    const identity = await sendingIdentity(settings({}), ENV_MAILBOX);
    expect(identity).toMatchObject({ ok: true, mailbox: ENV_MAILBOX, supportEmail: ENV_MAILBOX });
  });

  it("refuses a tenant with no usable credentials rather than sending as another", async () => {
    const identity = await sendingIdentity(settings({ tenantId: "removed" }), ENV_MAILBOX);
    expect(identity).toEqual({
      ok: false,
      error: "the chosen Microsoft tenant has no usable credentials",
    });
  });
});
