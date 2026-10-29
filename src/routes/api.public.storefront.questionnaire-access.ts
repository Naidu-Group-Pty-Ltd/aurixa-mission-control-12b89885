import { createFileRoute } from "@tanstack/react-router";
import { storefrontJson, storefrontPreflight } from "@/server/storefront-cors.server";
import { checkPublicRateLimit } from "@/server/token-rate-limit.server";
import { clientIpFrom } from "@/server/support-tickets.server";
import { verifyQuestionnaireAccess } from "@/server/lead-emails.server";

/**
 * POST /api/public/storefront/questionnaire-access
 *
 * What the website's Business Readiness Questionnaire asks before it opens for
 * an applicant (docs/LEAD_EMAILS.md):
 *
 *   { applicationId, token }      the secure link from the Stage 1 email
 *   { applicationId, workEmail }  "Continue with your Application ID", for a
 *                                 link that expired or was opened elsewhere
 *
 * `{ ok: true, applicant }` carries what the applicant typed at Stage 1 —
 * name, work email, organisation, and the role, organisation type and volume
 * codes — so the questionnaire is addressed to them and its submission names
 * them. Without it the questionnaire opened anonymously and its submission
 * reached Mission Control with no email, which the capture route refuses.
 *
 * A refusal is 200 with a reason the page shows: `invalid_reference` (also a
 * wrong email — the answer does not say which), `invalid_token`, `expired`,
 * `already_completed`. A failed read is 503, so a database blip is never read
 * as "that link is not yours".
 *
 * Rate limited per address: the reference-and-email form is a guess an
 * attacker could repeat.
 */
const ATTEMPTS_PER_MINUTE = 20;

export const Route = createFileRoute("/api/public/storefront/questionnaire-access")({
  server: {
    handlers: {
      OPTIONS: async () => storefrontPreflight(),
      POST: async ({ request }) => {
        const rl = await checkPublicRateLimit(
          "storefront:questionnaire-access",
          clientIpFrom(request.headers),
          ATTEMPTS_PER_MINUTE,
        );
        if (!rl.ok) {
          return storefrontJson(
            { ok: false, error: "rate_limited", retry_after_seconds: rl.retry_after_seconds },
            429,
          );
        }

        let body: Record<string, unknown>;
        try {
          const parsed = await request.json();
          body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
        } catch {
          return storefrontJson({ ok: false, error: "invalid_json" }, 400);
        }

        const access = await verifyQuestionnaireAccess({
          applicationId: body.applicationId,
          token: body.token,
          workEmail: body.workEmail,
        });
        if (!access.ok && access.reason === "unavailable") {
          return storefrontJson({ ok: false, error: "unavailable" }, 503);
        }
        return storefrontJson(access);
      },
    },
  },
});
