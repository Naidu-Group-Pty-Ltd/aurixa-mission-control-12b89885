/**
 * Read the shared Listings marketplace on a tenant's behalf.
 *
 * `GET /api/public/listings/{tables|records|selftest}`, authenticated with the
 * clone's own Mission Control key.
 *
 * ## Why this endpoint exists at all
 *
 * The Listings and Overview pages are built from one Airtable table —
 * `Property Intake Master` in the `NPC Emails` base — and every clone shows the
 * same marketplace, so every clone needs the same token and the same base id.
 * The fleet-wide answer was to forward all six `AIRTABLE_*` names to every
 * clone. Measured 8 Sep 2026, all six read `missing` on all three clones, so
 * that answer had never once worked; and had it worked it would have put a
 * credential on three tenant projects whose scope is a set of BASES and a set
 * of PERMISSIONS, with nothing in it narrowing to the one table the
 * marketplace needs.
 *
 * So the credential stops travelling and the CALL travels — the shape Mission
 * Control already uses for identity verification, token spend and seat
 * reservation.
 *
 * ## What a tenant can reach through it
 *
 * Two read operations and a self-test, against a base and table it cannot
 * name. The policy — and why the base id carries the protection here that
 * "nothing readable is brokered" carried for verification — is
 * `listingsBroker.pure.ts`.
 *
 * `GET` rather than `POST` because every operation is a read and nothing is
 * sent; the query string is the parameter allow-list that module owns.
 */
import { createFileRoute } from "@tanstack/react-router";
import { resolveCloneApiKey } from "@/server/clone-api-keys.server";
import { checkRateLimit } from "@/server/token-rate-limit.server";
import { parseRecordIds, refusalHeaders } from "@/server/listingsBroker.pure";

/**
 * A refusal this endpoint makes, marked as ours.
 *
 * The clone has to tell "Mission Control would not serve me" apart from
 * "Airtable answered" — they share status codes (401, 403, 429) and send an
 * operator to opposite remedies. Only this side can set the header, so its
 * ABSENCE is what makes a relayed answer identifiable as the vendor's.
 */
const refuse = (error: string, extra: Record<string, unknown>, status: number) =>
  new Response(JSON.stringify({ ok: false, error, ...extra }), {
    status,
    headers: refusalHeaders(error),
  });

export const Route = createFileRoute("/api/public/listings/$operation")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const key = await resolveCloneApiKey(
          request.headers.get("x-clone-api-key"),
          "listings:read",
        );
        if (!key) {
          return refuse(
            "unauthorized",
            {
              message:
                "This Mission Control key is unknown, revoked, or lacks the listings:read scope.",
            },
            401,
          );
        }

        const rl = await checkRateLimit(key.id);
        if (!rl.ok) {
          const res = refuse(
            "rate_limited",
            { count: rl.count, limit: rl.limit, retry_after_seconds: rl.retry_after_seconds },
            429,
          );
          res.headers.set("Retry-After", String(rl.retry_after_seconds));
          return res;
        }

        const url = new URL(request.url);
        const num = (v: string | null) => (v === null || v === "" ? undefined : Number(v));
        const str = (v: string | null) => (v === null || v === "" ? undefined : v);
        const dir = url.searchParams.get("sortDirection");

        const { brokerListingsRead } = await import("@/server/listingsBroker.server");
        const outcome = await brokerListingsRead({
          operation: String((params as { operation?: string }).operation ?? ""),
          query: {
            // `table` is a REQUEST, resolved against Mission Control's
            // allow-list before it is used — never a table name passed through.
            table: str(url.searchParams.get("table")),
            pageSize: num(url.searchParams.get("pageSize")),
            offset: str(url.searchParams.get("offset")),
            sortField: str(url.searchParams.get("sortField")),
            sortDirection:
              dir === "asc" || dir === "desc" ? dir : dir ? ("invalid" as never) : undefined,
            /*
             * Row handles, never an expression. The caller names records and
             * Mission Control writes the `filterByFormula` — see rule 4 in
             * `listingsBroker.pure.ts`. Split here, judged by `refuseQuery`.
             */
            recordIds: parseRecordIds(url.searchParams.get("recordIds")),
          },
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
