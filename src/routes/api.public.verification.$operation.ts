/**
 * Run one identity-verification call on a tenant's behalf.
 *
 * `POST /api/public/verification/{id-verification|passive-liveness|face-match}`
 * with the same multipart body the vendor takes, authenticated with the
 * clone's own Mission Control key.
 *
 * ## Why this endpoint exists at all
 *
 * A Didit API key is application-scoped, and that scope includes the session
 * list: measured 7 Sep 2026, `GET …/application/{id}/sessions/` returns every
 * session with the customer's name and **live pre-signed URLs to their
 * passport portrait and selfie**. Forwarding that key to every clone — as the
 * fleet-wide decision did — put a credential on three tenant projects that
 * could read every other tenant's customers' identity documents.
 *
 * Didit publishes no API to create an application or mint a key, so per-tenant
 * credentials cannot be provisioned, and creating one by hand per client is
 * the manual step this control plane exists to abolish. So the credential
 * stops travelling and the CALL travels instead — the same shape Mission
 * Control already uses for token spend and seat reservation.
 *
 * ## What a tenant can reach through it
 *
 * Three write operations that each create a new verification, resolved from an
 * allow-list in `verificationBroker.pure.ts`. Nothing readable is offered, so
 * the enumeration this closes cannot be reached through the thing that closes
 * it. That module also owns the header, ceiling and response rules and says
 * why each one is there.
 */
import { createFileRoute } from "@tanstack/react-router";
import { jsonResponse, resolveCloneApiKey } from "@/server/clone-api-keys.server";
import { checkRateLimit } from "@/server/token-rate-limit.server";

export const Route = createFileRoute("/api/public/verification/$operation")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const key = await resolveCloneApiKey(
          request.headers.get("x-clone-api-key"),
          "verification:run",
        );
        if (!key) return jsonResponse({ ok: false, error: "unauthorized" }, 401);

        const rl = await checkRateLimit(key.id);
        if (!rl.ok) {
          return new Response(
            JSON.stringify({
              ok: false,
              error: "rate_limited",
              count: rl.count,
              limit: rl.limit,
              retry_after_seconds: rl.retry_after_seconds,
            }),
            {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": String(rl.retry_after_seconds),
              },
            },
          );
        }

        const { brokerVerification } = await import("@/server/verificationBroker.server");
        const outcome = await brokerVerification({
          request,
          operation: String((params as { operation?: string }).operation ?? ""),
          cloneId: key.clone_id,
          /*
           * The tenant reference defaults to the clone itself, which is the
           * grain recharge is settled at. A clone may send a finer one for its
           * own attribution; it can never name another clone's, because the
           * usage row is written against `key.clone_id` regardless.
           */
          tenantRef: request.headers.get("x-tenant-ref")?.trim() || (key.clone_id ?? "unknown"),
        });

        return outcome.response;
      },
    },
  },
});
