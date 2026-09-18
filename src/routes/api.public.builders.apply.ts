/**
 * POST /api/public/builders/apply
 *
 * A builder or developer asks for access to the Builders Network from the
 * Aurixa Systems site. It is the same architecture as the Join Waitlist
 * ingest next door — a public, CORS-gated, rate-limited endpoint the
 * marketing site posts to — with one deliberate difference:
 *
 *   **This one is not fire-and-forget.** The waitlist mirrors into Mission
 *   Control after its primary webhook has already succeeded, so a failure
 *   there must never reach the visitor. Here the post IS the act: it creates
 *   the applicant's organisation and sends their invitation, and whether
 *   that happened is the only thing they came to find out. So the site
 *   awaits this, and this relays the network's own answer.
 *
 * **Mission Control signs; the applicant's browser never speaks to the
 * network.** `builder-network-admin` verifies a federation assertion on
 * every call, and minting one needs a private key that exists only on the
 * server. That is what lets a public form reach a privileged API without the
 * network growing a public door.
 *
 * ## The controls, and which of them actually hold
 *
 * `builderApplyGuard.pure.ts` carries the reasoning; the short version is
 * that the origin allow-list and the body cap are boundaries, the honeypot
 * and the fill-time check are cost raisers that anybody who looks at the
 * page can defeat, and the ceilings are what remain when they have. They are
 * layered because they answer different attacks:
 *
 *   per-IP per minute (here)      a burst from one caller
 *   global per minute (here)      many callers, a few requests each
 *   per-origin hour/day (network) a drip from one caller over a day
 *   per-address per day (network) repeated mail to one mailbox
 *
 * The first two count in `public_rate_limits` and FAIL CLOSED on a database
 * error, which `checkPublicRateLimit` does by construction and for the same
 * reason its storefront siblings do: what is behind them costs money.
 *
 * Turnstile is verified when `BUILDER_APPLY_TURNSTILE_SECRET` is set and the
 * branch is skipped without a network call when it is not. The secret's
 * presence is the switch — see `turnstileRequired`.
 *
 * ## What this endpoint will not do
 *
 * It never returns the invitation link. The link is the credential, it goes
 * to the mailbox named on the application, and an endpoint anybody can post
 * to that hands it back is an account-takeover primitive. It also validates
 * no field: the network's `readAccessRequest` is the authority and its
 * refusal codes are relayed verbatim, because two validators is how one of
 * them becomes wrong.
 */
import { createFileRoute } from "@tanstack/react-router";
import { callBuilderNetworkAdmin } from "@/server/buildersNetworkAdmin.server";
import { checkPublicRateLimit } from "@/server/token-rate-limit.server";
import {
  APPLY_GLOBAL_PER_MINUTE,
  APPLY_PER_IP_PER_MINUTE,
  DEFAULT_APPLY_ORIGINS,
  MAX_APPLY_BODY_BYTES,
  normaliseOrigin,
  originIsAllowed,
  projectApplyFields,
  readApplyHeuristics,
  turnstileRequired,
} from "@/server/builderApplyGuard.pure";

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = originIsAllowed(origin, process.env.BUILDER_APPLY_ALLOWED_ORIGINS);
  return {
    // Never a wildcard: an allow-list that answers `*` to a refused origin
    // has allowed it. A refused caller gets the canonical origin back, which
    // their browser then rejects — which is the same outcome as the 403 body.
    "Access-Control-Allow-Origin": allowed ? normaliseOrigin(origin) : DEFAULT_APPLY_ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      // Nothing about an application is cacheable, and an intermediary that
      // cached one applicant's answer would serve it to the next.
      "Cache-Control": "no-store",
      ...corsHeaders(origin),
    },
  });
}

/** The caller, as the edge sees them. Never read from the body. */
function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return request.headers.get("cf-connecting-ip") ?? forwarded ?? "unattributed";
}

/**
 * Verify a Turnstile token, when this deployment holds a secret.
 *
 * Fails CLOSED on anything but an explicit success: a token the endpoint
 * could not check is a token that did not pass. An unreachable Cloudflare
 * therefore refuses applications, which is the correct trade for a control
 * whose whole job is to stand between a public form and spending — and it
 * only applies at all where somebody deliberately set the secret.
 */
async function turnstilePasses(token: unknown, ip: string): Promise<boolean> {
  const secret = process.env.BUILDER_APPLY_TURNSTILE_SECRET ?? "";
  if (!turnstileRequired(secret)) return true;
  if (typeof token !== "string" || !token.trim()) return false;
  try {
    const form = new URLSearchParams({ secret: secret.trim(), response: token.trim() });
    if (ip && ip !== "unattributed") form.set("remoteip", ip);
    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return false;
    const verdict = (await response.json()) as { success?: boolean };
    return verdict.success === true;
  } catch (error) {
    console.error("[builders/apply] turnstile verification failed", error);
    return false;
  }
}

export const Route = createFileRoute("/api/public/builders/apply")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) =>
        new Response(null, { status: 204, headers: corsHeaders(request.headers.get("origin")) }),

      POST: async ({ request }) => {
        const origin = request.headers.get("origin");

        // 1. Boundary: where it came from.
        if (!originIsAllowed(origin, process.env.BUILDER_APPLY_ALLOWED_ORIGINS)) {
          return json({ ok: false, error: "forbidden_origin" }, 403, origin);
        }

        // 2. Boundary: how big it is. Read as text so the cap is applied to
        //    what actually arrived — `Content-Length` is the caller's claim,
        //    and believing it is how a cap is passed by lying about it.
        const raw = await request.text();
        if (new TextEncoder().encode(raw).length > MAX_APPLY_BODY_BYTES) {
          return json({ ok: false, error: "payload_too_large" }, 413, origin);
        }

        let body: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(raw);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return json({ ok: false, error: "invalid_payload" }, 400, origin);
          }
          body = parsed as Record<string, unknown>;
        } catch {
          return json({ ok: false, error: "invalid_json" }, 400, origin);
        }

        // 3. Cost raisers: the honeypot and the fill clock. Both answer the
        //    same code, so tripping one tells the caller nothing about which.
        const heuristics = readApplyHeuristics(body);
        if (!heuristics.ok) {
          return json({ ok: false, error: heuristics.error }, heuristics.status, origin);
        }

        const ip = clientIp(request);

        // 4. Ceilings. Counted BEFORE the assertion is minted and before
        //    anything travels, because a limiter that runs after the work is
        //    a record of the work rather than a limit on it.
        const perIp = await checkPublicRateLimit("builders:apply:ip", ip, APPLY_PER_IP_PER_MINUTE);
        if (!perIp.ok) {
          return json(
            { ok: false, error: "rate_limited", retry_after_seconds: perIp.retry_after_seconds },
            429,
            origin,
          );
        }
        const global = await checkPublicRateLimit(
          "builders:apply:global",
          "all",
          APPLY_GLOBAL_PER_MINUTE,
        );
        if (!global.ok) {
          return json(
            {
              ok: false,
              error: "rate_limited",
              retry_after_seconds: global.retry_after_seconds,
            },
            429,
            origin,
          );
        }

        // 5. Turnstile, where this deployment holds a secret to check it with.
        if (!(await turnstilePasses(body.turnstile_token, ip))) {
          return json({ ok: false, error: "captcha_failed" }, 403, origin);
        }

        // Only the declared fields travel, plus the client this endpoint
        // measured itself. A `source_ip` in the body is dropped by the
        // projection rather than trusted — a caller who can name its own
        // origin has erased the evidence trail AND defeated the network's
        // per-origin window in one move.
        const result = await callBuilderNetworkAdmin("submit_access_request", {
          ...projectApplyFields(body),
          source_ip: ip,
          user_agent: (request.headers.get("user-agent") ?? "").slice(0, 500) || null,
        });

        if (!result.ok) {
          // The network's refusal code travels verbatim; the site reads it
          // into a sentence. A status is mapped rather than invented: an
          // applicant's own mistake is a 422, our own is a 502, and the
          // network's rate limits keep their 429.
          const status =
            result.status === 429
              ? 429
              : result.status === 409 || result.status === 400
                ? 422
                : 502;
          return json({ ok: false, error: result.error }, status, origin);
        }

        return json(
          {
            ok: true,
            outcome: result.body.outcome === "attached" ? "attached" : "provisioned",
            organisation_legal_name: String(result.body.organisation_legal_name ?? ""),
            email_sent: result.body.email_sent === true,
          },
          201,
          origin,
        );
      },
    },
  },
});
