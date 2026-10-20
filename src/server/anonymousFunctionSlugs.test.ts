/**
 * The anonymous-webhook override, held to the one answer both the deploy and
 * the bundle digest read.
 */
import { describe, expect, it } from "vitest";
import { deployedVerifyJwt, shouldForceAnonymousFunction } from "./anonymousFunctionSlugs.pure";

describe("shouldForceAnonymousFunction", () => {
  it("matches the webhook-style slug conventions", () => {
    for (const slug of [
      "hooks-stripe",
      "hook_retell",
      "webhook",
      "webhooks-github",
      "vapi-call-webhook",
      "didit-webhook",
      "public-listings",
      "cron-daily",
      "health",
      "healthcheck",
      "stripe-webhook-v2",
      "github_webhook",
    ]) {
      expect(shouldForceAnonymousFunction(slug)).toBe(true);
    }
  });

  it("leaves every other slug to the prime's own flag", () => {
    for (const slug of [
      "listings-cache",
      "aml-reliance",
      "generate-investment-report",
      "healthy",
    ]) {
      expect(shouldForceAnonymousFunction(slug)).toBe(false);
    }
  });
});

describe("deployedVerifyJwt — the flag a clone is actually sent", () => {
  it("overrides a webhook declared with verify_jwt=true, and says why", () => {
    const sent = deployedVerifyJwt("didit-webhook", true);
    expect(sent.verifyJwt).toBe(false);
    expect(sent.overrideReason).toMatch(/anonymous-webhook pattern/);
  });

  it("never turns a check ON, and never touches an ordinary function", () => {
    expect(deployedVerifyJwt("didit-webhook", false)).toEqual({
      verifyJwt: false,
      overrideReason: null,
    });
    expect(deployedVerifyJwt("listings-cache", true)).toEqual({
      verifyJwt: true,
      overrideReason: null,
    });
    expect(deployedVerifyJwt("listings-cache", false)).toEqual({
      verifyJwt: false,
      overrideReason: null,
    });
  });
});
