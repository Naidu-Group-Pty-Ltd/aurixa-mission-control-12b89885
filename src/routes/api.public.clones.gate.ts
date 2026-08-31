import { createFileRoute } from "@tanstack/react-router";
import { jsonResponse, resolveCloneApiKey } from "@/server/clone-api-keys.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  factsOf,
  readGate,
  recordGateCheck,
  resolvePlanPricing,
} from "@/server/payment-gate.server";
import { resolveGateState } from "@/lib/clonePaymentGate.pure";
import { storefrontPricingBase } from "@/server/billing-handoffs.server";
import { checkRateLimit } from "@/server/token-rate-limit.server";

/**
 * GET /api/public/clones/gate
 *
 * What a clone asks about itself. Mission Control is the authority on whether a
 * workspace is open; the clone renders the answer and never derives one.
 *
 * ## The two answers that are not the same
 *
 * `gated: false` — there is no gate row. This is the prime, and every clone
 * provisioned before the gate existed. It is a definite answer and the clone
 * renders normally on it, forever.
 *
 * A FAILED read is not that answer. `readGate` carries `failed` separately for
 * the reason the prime repo's `CASE_TENANT_COLUMN.md` records: a read that
 * errored is not a row that is absent, and collapsing the two here would turn
 * a database blip into a fleet-wide unlock. A failure answers 503 and the
 * clone keeps its last known state.
 *
 * ## The scope is deliberately wide
 *
 * Any key that can do anything at all may read its own gate. A key issued
 * before `gate:read` existed would otherwise 403, and a clone that cannot read
 * its gate cannot tell its customer why it is locked or how to pay — which is
 * strictly worse than the read being slightly less privileged than it could
 * be. Nothing here is a secret: it is one workspace's own billing state.
 */
export const Route = createFileRoute("/api/public/clones/gate")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const key = await resolveCloneApiKey(request.headers.get("x-clone-api-key"), [
          "gate:read",
          "tokens:meter",
          "tokens:read",
          "seats:manage",
          "pricing:read",
        ]);
        if (!key) return jsonResponse({ ok: false, error: "unauthorized" }, 401);

        // Its own bucket, so polling the gate never eats the token budget, and
        // a ceiling well above what a large workspace produces: every browser
        // tab polls once every five minutes, so 120/min is ~600 concurrent
        // tabs. Being rate limited here fails OPEN on the clone (a 429 is an
        // error, and every error renders the dashboard), which is the right
        // direction — the reservation endpoints have their own limit and those
        // fail closed, so a workspace that out-polls this one still cannot
        // generate anything.
        const rl = await checkRateLimit(`gate:${key.id}`, 120);
        if (!rl.ok) {
          return new Response(
            JSON.stringify({
              ok: false,
              error: "rate_limited",
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

        // A key with no clone is a Prime-scoped key. The prime has no gate and
        // never will; answering `gated: false` here is the same definite
        // answer a clone with no row gets.
        if (!key.clone_id) {
          return jsonResponse({
            ok: true,
            gated: false,
            status: "open",
            reason: "not_gated",
            paid: false,
          });
        }

        const read = await readGate(key.clone_id);
        if (!read.ok) {
          // 503, never 200-with-open. See the header.
          return jsonResponse({ ok: false, error: "gate_read_failed" }, 503);
        }

        const state = resolveGateState(factsOf(read.row));

        if (!read.row) {
          return jsonResponse({
            ok: true,
            gated: false,
            status: "open",
            reason: "not_gated",
            paid: false,
          });
        }

        // Best-effort, unawaited: a gate no deployment has ever read is
        // otherwise indistinguishable from one that is working.
        recordGateCheck(key.clone_id, state.locked).catch(() => {});

        const { data: clone } = await supabaseAdmin
          .from("clones")
          .select("name, slug, billing_user_id")
          .eq("id", key.clone_id)
          .maybeSingle();

        const pricing = await resolvePlanPricing(read.row.plan_slug);

        // The fallback CTA. `POST /gate/checkout` is the one-click route; this
        // is where a customer lands if minting a session fails, and it carries
        // the clone's stable billing uid so the pricing page's purchase
        // buttons are live and correctly attributed rather than browse-only.
        const uid = clone?.billing_user_id ?? null;
        const pricingUrl = uid
          ? `${storefrontPricingBase()}?uid=${encodeURIComponent(uid)}`
          : storefrontPricingBase();

        return jsonResponse({
          ok: true,
          gated: true,
          status: state.status,
          reason: state.reason,
          locked: state.locked,
          paid: state.paid,
          locks_at: state.locksAt,
          ms_remaining: state.msRemaining,
          counting: state.counting,
          armed_at: read.row.armed_at,
          grace_hours: read.row.grace_hours,
          plan: {
            slug: read.row.plan_slug,
            name: read.row.plan_name ?? pricing.planName,
            amount_due_cents: read.row.amount_due_cents ?? pricing.amountDueCents,
            currency: read.row.currency ?? pricing.currency,
          },
          clone: { id: key.clone_id, name: clone?.name ?? null, slug: clone?.slug ?? null },
          checkout: {
            /** One-click: POST here with the same key to mint a Stripe session. */
            start_path: "/api/public/clones/gate/checkout",
            /** Where a customer lands if minting fails. Always present. */
            pricing_url: pricingUrl,
          },
        });
      },
    },
  },
});
