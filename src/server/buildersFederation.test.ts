/**
 * The Builders Network as a second relying party.
 *
 * The tests that carry weight are the boundary ones, same as the Anthropic
 * suite this mirrors: the audiences must be disjoint (one signing key must
 * never mean one trust domain), the profile must not be able to override the
 * registered claims, and a request naming somebody else's workspace must be
 * refused rather than corrected.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  ASSERTION_LIFETIME_SECONDS,
  federationSubject,
  identityClaims,
} from "./anthropicFederation.pure";
import {
  BUILDERS_AUDIENCE,
  BUILDERS_JWKS_PATH,
  BUILDERS_NETWORK_HOST,
  buildersIdentityRefusal,
  buildersProfileClaims,
  buildersScopesOf,
  mergeAssertionClaims,
} from "./buildersFederation.pure";

const CLONE = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-8888-7777-6666-555555555555";

describe("the audience is the network's own origin", () => {
  it("is the reserved host, as an https origin", () => {
    expect(BUILDERS_AUDIENCE).toBe(`https://${BUILDERS_NETWORK_HOST}`);
    expect(BUILDERS_NETWORK_HOST).toBe("builders.aurixasystems.com.au");
  });

  it("is disjoint from Anthropic's, so one key never means one trust domain", () => {
    // The Anthropic identity route binds its assertions to Anthropic's token
    // endpoint. If these ever coincide, an assertion minted for one relying
    // party satisfies the other, and the isolation carried by `aud` is gone.
    const anthropicRoute = readFileSync(
      new URL("../routes/api.public.anthropic.identity.ts", import.meta.url),
      "utf8",
    );
    const m = /const TOKEN_URL = "([^"]+)"/.exec(anthropicRoute);
    expect(m).not.toBeNull();
    expect(m![1]).not.toBe(BUILDERS_AUDIENCE);
  });

  it("keeps the network's slug reserved in the same change that names the host", () => {
    // The host constant is only safe to publish because no clone can claim
    // the slug under it. The reservation migration is the other half of this
    // module and the two must not drift.
    const migration = readFileSync(
      new URL(
        "../../supabase/migrations/20260914120000_reserve_platform_service_slugs.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(migration).toContain("'builders'");
  });
});

describe("the profile discloses the builders family and nothing else", () => {
  it("filters to builders:* and sorts", () => {
    expect(
      buildersScopesOf(["tokens:meter", "builders:operate", "builders:federate", "usage:report"]),
    ).toEqual(["builders:federate", "builders:operate"]);
  });

  it("omits display_name rather than sending null", () => {
    const claims = buildersProfileClaims({
      cloneId: CLONE,
      slug: "npc",
      displayName: null,
      scopes: ["builders:federate"],
    });
    expect(claims).toEqual({ clone_id: CLONE, slug: "npc", scopes: ["builders:federate"] });
    expect("display_name" in claims).toBe(false);
  });

  it("carries display_name when the row has one", () => {
    const claims = buildersProfileClaims({
      cloneId: CLONE,
      slug: "npc",
      displayName: "NPC Services",
      scopes: [],
    });
    expect(claims.display_name).toBe("NPC Services");
    expect(claims.scopes).toEqual([]);
  });
});

describe("registered claims win, always", () => {
  const registered = identityClaims({
    issuer: "https://mc.example",
    subject: federationSubject(CLONE),
    audience: BUILDERS_AUDIENCE,
    nowSeconds: 1_700_000_000,
    jti: "one-jti",
  }) as unknown as Record<string, unknown>;

  it("a profile cannot rename the subject, the audience, or the expiry", () => {
    const hostile = {
      sub: `clone:${OTHER}`,
      aud: "https://api.anthropic.com/v1/oauth/token",
      exp: 9_999_999_999,
      jti: "replayable",
      clone_id: CLONE,
    };
    const merged = mergeAssertionClaims(hostile, registered);
    expect(merged.sub).toBe(`clone:${CLONE}`);
    expect(merged.aud).toBe(BUILDERS_AUDIENCE);
    expect(merged.exp).toBe(1_700_000_000 + ASSERTION_LIFETIME_SECONDS);
    expect(merged.jti).toBe("one-jti");
    // and the honest profile survives alongside
    expect(merged.clone_id).toBe(CLONE);
  });

  it("keeps the five-minute lifetime the Anthropic flow set", () => {
    expect(ASSERTION_LIFETIME_SECONDS).toBe(300);
  });
});

describe("a request naming somebody else's workspace is refused, never corrected", () => {
  it("no body claim: nothing to disagree with", () => {
    expect(buildersIdentityRefusal({ requestedCloneId: undefined, keyCloneId: CLONE })).toBeNull();
    expect(buildersIdentityRefusal({ requestedCloneId: "", keyCloneId: CLONE })).toBeNull();
  });

  it("agreement passes, case- and whitespace-insensitively", () => {
    expect(
      buildersIdentityRefusal({
        requestedCloneId: `  ${CLONE.toUpperCase()}  `,
        keyCloneId: CLONE,
      }),
    ).toBeNull();
  });

  it("disagreement is a refusal that names the rule", () => {
    const refusal = buildersIdentityRefusal({ requestedCloneId: OTHER, keyCloneId: CLONE });
    expect(refusal).toMatch(/different workspace/);
    expect(refusal).toMatch(/silent correction/);
  });
});

describe("the published verification path is the network's own", () => {
  it("names builders, not another vendor", () => {
    expect(BUILDERS_JWKS_PATH).toBe("/api/public/builders/jwks");
  });

  it("the jwks route serves the shared key set from the one signer module", () => {
    const route = readFileSync(
      new URL("../routes/api.public.builders.jwks.ts", import.meta.url),
      "utf8",
    );
    // One key set, one implementation: the route must import publicJwks
    // rather than exporting a second key or importing a second signer.
    expect(route).toContain('import { publicJwks } from "@/server/anthropicOidc.server"');
    expect(route).not.toMatch(/PRIVATE KEY|importKey|pkcs8/);
  });
});
