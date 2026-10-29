import { createFileRoute } from "@tanstack/react-router";
import { storefrontJson, storefrontPreflight } from "@/server/storefront-cors.server";
import { checkPublicRateLimit } from "@/server/token-rate-limit.server";
import { clientIpFrom } from "@/server/support-tickets.server";
import { normaliseApplicationId } from "@/server/lead-capture.server";
import { verifyStageThreeAccess } from "@/server/strategic-review-booking.server";

/**
 * POST /api/public/storefront/strategic-review-access   { applicationId }
 *
 * What the website's Stage 3 scheduler asks before it opens for an applicant
 * (docs/CALCOM_BOOKING.md). It answered from the Make scenario "Aurixa Stage 3
 * Access" until that account was deprecated; this is the same question, asked
 * of Mission Control's record by the rule the booking endpoint re-checks
 * (`accessFromLead`), answered in the shape the page already reads:
 *
 *   200 { ok: true, applicant: { applicationId, firstName, lastName,
 *                                workEmail, organisationName } }
 *   200 { ok: false, reason }    not granted, or not a reference — the page
 *                                says the reference could not be verified,
 *                                and is not told which
 *   503 { ok: false, reason: "unavailable" }
 *                                the record could not be read: never "no"
 *
 * Rate limited per address: a reference is the applicant's key to the page,
 * and a guess an attacker could repeat.
 */
const ATTEMPTS_PER_MINUTE = 20;

export const Route = createFileRoute("/api/public/storefront/strategic-review-access")({
  server: {
    handlers: {
      OPTIONS: async () => storefrontPreflight(),
      POST: async ({ request }) => {
        const rl = await checkPublicRateLimit(
          "storefront:strategic-review-access",
          clientIpFrom(request.headers),
          ATTEMPTS_PER_MINUTE,
        );
        if (!rl.ok) {
          return storefrontJson(
            { ok: false, reason: "rate_limited", retry_after_seconds: rl.retry_after_seconds },
            429,
          );
        }

        let body: Record<string, unknown>;
        try {
          const parsed = await request.json();
          body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
        } catch {
          return storefrontJson({ ok: false, reason: "invalid_json" }, 400);
        }

        const reference = normaliseApplicationId(body.applicationId);
        if (!reference) return storefrontJson({ ok: false, reason: "invalid_reference" });

        const access = await verifyStageThreeAccess(reference);
        if (!access.decided) return storefrontJson({ ok: false, reason: "unavailable" }, 503);
        if (!access.verdict.granted) return storefrontJson({ ok: false, reason: "not_granted" });
        const { applicant } = access.verdict;
        return storefrontJson({
          ok: true,
          applicant: {
            applicationId: applicant.applicationId,
            firstName: applicant.firstName,
            lastName: applicant.lastName,
            workEmail: applicant.email ?? "",
            organisationName: applicant.organisation ?? "",
          },
        });
      },
    },
  },
});
