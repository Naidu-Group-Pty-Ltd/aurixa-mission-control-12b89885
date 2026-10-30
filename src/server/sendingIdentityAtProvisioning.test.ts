/**
 * A ticked "Start this clone's sending identity" box starts one, and the
 * wizard is told what became of it.
 *
 * Measured 29 Oct 2026 on a demo clone provisioned through the wizard with the
 * box ticked and the sending domain left blank: no `clone_email_identities`
 * row at all, while the wizard toasted "Sending identity started". The box
 * reached the server only through `sendingDomain`, which a blank field sends
 * as `null`, the same as an unticked box, and provisioning started an identity
 * only when a domain had been typed.
 *
 * Driven through the idempotent retry because it is the one door into the
 * shared side effects that creates no repository, and the first submit runs
 * the same function. `advanceEmailIdentity` answers the way it does (an
 * identity state, a named refusal, or a throw), and nothing here reaches a
 * Supabase host.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { ProvisionCloneInput } from "./clone-provisioning.functions";

const identity = vi.hoisted(() => ({ advance: vi.fn() }));

vi.mock("@/server/email-identity.server", () => ({
  advanceEmailIdentity: identity.advance,
}));
vi.mock("./clone-metering-tenant.server", () => ({
  resolveSoldPlan: async () => ({ ok: true, plan: null }),
  ensureCloneMeteringTenant: async () => ({
    ok: true,
    tenantId: "tenant-1",
    action: "kept",
    planSlug: null,
  }),
}));
// Nothing on this path may touch the service-role client.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: new Proxy(
    {},
    {
      get: () => {
        throw new Error("supabaseAdmin reached from a unit test");
      },
    },
  ),
}));

import { provisionCloneCore } from "./clone-provisioning.server";

/** The clone the first attempt created, as the idempotency read returns it. */
const EXISTING = {
  id: "clone-1",
  github_url: "https://github.com/aurixa/demo-abc123",
  name: "Demo",
  slug: "demo-abc123",
  billing_user_id: "demo",
  billing_stripe_customer_id: null,
};

/** The clone row for the idempotency read, and a notifications table that keeps what it is sent. */
function client() {
  const notices: Array<{ title: string; body: string; metadata: { stage: string } }> = [];
  const clones = {
    select: () => clones,
    eq: () => clones,
    maybeSingle: async () => ({ data: EXISTING, error: null }),
  };
  const db = {
    from(table: string) {
      if (table === "clones") return clones;
      if (table === "notifications") {
        return {
          insert: async (row: (typeof notices)[number]) => {
            notices.push(row);
            return { error: null };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { supabase: db as unknown as SupabaseClient<Database>, notices };
}

/** The wizard's submit, retried with the key its first attempt used. */
function submit(over: Partial<ProvisionCloneInput>): ProvisionCloneInput {
  return {
    name: "Demo",
    slug: "demo-abc123",
    method: "template",
    targetOwner: "aurixa",
    tags: [],
    cloudflareEnabled: false,
    notes: "",
    moduleIds: [],
    idempotencyKey: "key-1",
    // Declined, so the reservation (pinned by its own contract) stays out of this one.
    subdomain: null,
    backend: null,
    ...over,
  };
}

async function provision(over: Partial<ProvisionCloneInput>) {
  const { supabase, notices } = client();
  const result = await provisionCloneCore(supabase, "user-1", submit(over));
  if (!result.ok) throw new Error(`provisioning failed: ${result.error}`);
  return { result, notices };
}

const DERIVED = "send.demo.aurixasystems.com.au";

beforeEach(() => {
  identity.advance.mockReset();
  identity.advance.mockImplementation(
    async (_db: unknown, _cloneId: string, opts: { sendingDomain?: string }) => ({
      ok: true,
      resendConfigured: true,
      row: { sending_domain: opts.sendingDomain ?? DERIVED },
      advanced: ["row_created", "domain_registered"],
    }),
  );
});

describe("a ticked box starts the clone's sending identity", () => {
  it("on the derived default when the domain is left blank", async () => {
    const { result } = await provision({ startSendingIdentity: true, sendingDomain: null });

    expect(identity.advance).toHaveBeenCalledTimes(1);
    const [, cloneId, opts] = identity.advance.mock.calls[0];
    expect(cloneId).toBe("clone-1");
    expect(opts.mode).toBe("provision");
    // Undefined is the one value that makes `advanceEmailIdentity` derive;
    // an empty string reaches it as no hostname at all.
    expect(opts.sendingDomain).toBeUndefined();
    expect(result.sendingIdentity).toEqual({ status: "started", sendingDomain: DERIVED });
  });

  it("treats a domain of spaces as blank", async () => {
    await provision({ startSendingIdentity: true, sendingDomain: "   " });
    expect(identity.advance.mock.calls[0][2].sendingDomain).toBeUndefined();
  });

  it("on the domain the operator typed", async () => {
    const { result } = await provision({
      startSendingIdentity: true,
      sendingDomain: " mail.client.com.au ",
    });

    expect(identity.advance.mock.calls[0][2].sendingDomain).toBe("mail.client.com.au");
    expect(result.sendingIdentity).toEqual({
      status: "started",
      sendingDomain: "mail.client.com.au",
    });
  });
});

describe("a refusal is said, to the wizard and on the clone", () => {
  const REFUSAL =
    "RESEND_MASTER_API_KEY is not configured on Mission Control. Add it in the project's " +
    "environment (Settings → Secrets).";

  it("returns the refusal with its reason, and warns on the clone", async () => {
    identity.advance.mockResolvedValueOnce({ ok: false, error: REFUSAL });
    const { result, notices } = await provision({ startSendingIdentity: true });

    expect(result.sendingIdentity).toEqual({ status: "refused", error: REFUSAL });
    expect(notices).toHaveLength(1);
    expect(notices[0].metadata.stage).toBe("email_identity");
    expect(notices[0].body).toContain(REFUSAL);
    // A blank request names the default it asked for, never a domain of "null".
    expect(notices[0].body).toContain("the clone's default domain");
    expect(notices[0].body).not.toContain("null");
  });

  it("reports a throw as a refusal rather than as a start", async () => {
    identity.advance.mockRejectedValueOnce(new Error("Resend answered 503"));
    const { result, notices } = await provision({
      startSendingIdentity: true,
      sendingDomain: "mail.client.com.au",
    });

    expect(result.sendingIdentity).toEqual({ status: "refused", error: "Resend answered 503" });
    expect(notices).toHaveLength(1);
    expect(notices[0].body).toContain('"mail.client.com.au"');
  });
});

describe("nothing is started that was not asked for", () => {
  it("an unticked box starts nothing", async () => {
    const { result, notices } = await provision({
      startSendingIdentity: false,
      sendingDomain: null,
    });

    expect(identity.advance).not.toHaveBeenCalled();
    expect(result.sendingIdentity).toEqual({ status: "not_requested" });
    expect(notices).toEqual([]);
  });

  /*
   * The signed-agreement path calls `provisionCloneCore` directly and names
   * neither field, so its clones are started by the drain, as before.
   */
  it("a request that names neither field starts nothing", async () => {
    const { result } = await provision({});
    expect(identity.advance).not.toHaveBeenCalled();
    expect(result.sendingIdentity).toEqual({ status: "not_requested" });
  });

  it("a domain alone still asks for one, as it always has", async () => {
    const { result } = await provision({ sendingDomain: "mail.client.com.au" });
    expect(identity.advance.mock.calls[0][2].sendingDomain).toBe("mail.client.com.au");
    expect(result.sendingIdentity.status).toBe("started");
  });
});
