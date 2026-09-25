import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  bookStrategicReview,
  strategicReviewSlots,
} from "@/server/strategic-review-booking.server";
import { storefrontJson, storefrontPreflight } from "@/server/storefront-cors.server";

/**
 * GET  /api/public/storefront/strategic-review  — the free review times.
 * POST /api/public/storefront/strategic-review  — book (or move) one.
 *
 * The waitlist site's Stage 3 scheduler. Cal.com is the calendar; see
 * `strategic-review-booking.server.ts` for what is checked and why.
 *
 * A 503 `not_configured` means this deployment has no Cal.com key, and the
 * site answers it by falling back to the request form it used before — so
 * shipping this ahead of the key changes nothing an applicant sees.
 */
const BookSchema = z.object({
  applicationId: z.string().min(1).max(40),
  start: z.string().min(1).max(40),
  timeZone: z.string().max(64).optional().nullable(),
  name: z.string().max(200).optional().nullable(),
  email: z.string().max(320).optional().nullable(),
  organisation: z.string().max(200).optional().nullable(),
  phone: z.string().max(40).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  rescheduleExisting: z.boolean().optional().nullable(),
});

export const Route = createFileRoute("/api/public/storefront/strategic-review")({
  server: {
    handlers: {
      OPTIONS: async () => storefrontPreflight(),
      GET: async () => {
        try {
          const result = await strategicReviewSlots();
          return storefrontJson(result.body, result.status);
        } catch (err) {
          console.error("strategic review slots failed", err);
          return storefrontJson({ ok: false, reason: "calendar_unavailable" }, 503);
        }
      },
      POST: async ({ request }) => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return storefrontJson({ ok: false, reason: "invalid_request" }, 400);
        }
        const parsed = BookSchema.safeParse(body ?? {});
        if (!parsed.success) {
          return storefrontJson(
            {
              ok: false,
              reason: "invalid_request",
              field: parsed.error.issues[0]?.path.join(".") ?? null,
            },
            400,
          );
        }
        const input = parsed.data;
        try {
          const result = await bookStrategicReview({
            applicationId: input.applicationId,
            start: new Date(input.start),
            timeZone: input.timeZone,
            name: input.name,
            email: input.email,
            organisation: input.organisation,
            phone: input.phone,
            notes: input.notes,
            rescheduleExisting: input.rescheduleExisting === true,
          });
          return storefrontJson(result.body, result.status);
        } catch (err) {
          // Nothing below the handler throws by design; if something does, the
          // applicant must not be told the review is booked.
          console.error("strategic review booking failed", err);
          return storefrontJson({ ok: false, reason: "calendar_unavailable" }, 503);
        }
      },
    },
  },
});
