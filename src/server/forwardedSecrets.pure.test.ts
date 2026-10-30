/**
 * Which prime credentials the forward policy sends to one clone (PF-27).
 *
 * The comparison with the prime counts a missing credential only when this
 * says the clone is sent it, so this must read the policy exactly as the code
 * that applies it does: the fleet's `inherit` rows less the CRM line's
 * refusals (provisioning), and each per-clone row through `planCloneForwards`
 * (the push).
 */
import { describe, it, expect } from "vitest";
import { forwardedSecretNames } from "./forwardedSecrets.pure";
import type { SecretClass } from "./prime-backend.server";

const vendor = (): SecretClass => "vendor";

describe("forwardedSecretNames", () => {
  it("sends the fleet's inherit rows, and not its deliberate refusals", () => {
    const sent = forwardedSecretNames({
      fleet: [
        { name: "RESEND_API_KEY", inherit: true },
        { name: "OPENAI_API_KEY", inherit: true },
        { name: "STRIPE_SECRET_KEY", inherit: false },
      ],
      authorised: [],
      crmMode: null,
      classOf: vendor,
    });
    expect(sent).toEqual(["OPENAI_API_KEY", "RESEND_API_KEY"]);
  });

  it("does not count a fleet `inherit` row its class refuses, as the fleet sweep does not send it", () => {
    // A row marked `inherit` is data; the class is the boundary
    // (`decideFleetForward`), so a signing key is never owed to a clone.
    const sent = forwardedSecretNames({
      fleet: [
        { name: "JWT_SECRET", inherit: true },
        { name: "SB_MANAGEMENT_ACCESS_TOKEN", inherit: true },
        { name: "RESEND_API_KEY", inherit: true },
      ],
      authorised: [],
      crmMode: null,
      classOf: (name) =>
        name === "JWT_SECRET"
          ? "tenant_scoped"
          : name === "SB_MANAGEMENT_ACCESS_TOKEN"
            ? "prime_only"
            : "vendor",
    });
    expect(sent).toEqual(["RESEND_API_KEY"]);
  });

  it("does not send the independent line a credential it carries none of", () => {
    const sent = forwardedSecretNames({
      fleet: [
        { name: "GOHIGHLEVEL_API_KEY", inherit: true },
        { name: "RESEND_API_KEY", inherit: true },
      ],
      authorised: ["GOHIGHLEVEL_LOCATION_ID"],
      crmMode: "independent",
      classOf: vendor,
    });
    expect(sent).toEqual(["RESEND_API_KEY"]);
  });

  it("sends a clone's own authorisation, unless the per-clone decision refuses it", () => {
    const sent = forwardedSecretNames({
      fleet: [{ name: "STRIPE_SECRET_KEY", inherit: false }],
      // Allowed; refused by a fleet `inherit = false`; refused by class.
      authorised: ["DOCUSIGN_INTEGRATION_KEY", "STRIPE_SECRET_KEY", "JWT_SECRET"],
      crmMode: null,
      classOf: (name) => (name === "JWT_SECRET" ? "tenant_scoped" : "vendor"),
    });
    expect(sent).toEqual(["DOCUSIGN_INTEGRATION_KEY"]);
  });

  it("counts a name authorised without a value as sent: its absence is a real gap", () => {
    // `envHas` is not asked. A no-value authorisation is policy sending it.
    const sent = forwardedSecretNames({
      fleet: [{ name: "MICROSOFT_CLIENT_SECRET", inherit: true }],
      authorised: [],
      crmMode: null,
      classOf: vendor,
    });
    expect(sent).toEqual(["MICROSOFT_CLIENT_SECRET"]);
  });
});
