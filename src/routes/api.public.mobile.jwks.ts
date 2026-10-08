import { createFileRoute } from "@tanstack/react-router";
import { publicJwks } from "@/server/anthropicOidc.server";
import { releasePublicJwk, releaseSigningKeyPresent } from "@/server/mobile/signing.server";

/**
 * GET /api/public/mobile/jwks
 *
 * Every key a clone or an app needs to check something Mission Control signed
 * for the mobile gateway:
 *
 * - the federation RS256 key(s) the 60-second activation assertion is signed
 *   with — a clone's `mobile-auth-exchange` verifies against these;
 * - the Ed25519 release key the release manifests and workspace bootstraps
 *   are signed with — the apps compile this in, and it is published so an
 *   operator can see what they should hold.
 *
 * Public by definition. A key that is not configured is left out rather than
 * answered with a 500, for the reason the Anthropic JWKS records.
 */
export const Route = createFileRoute("/api/public/mobile/jwks")({
  server: {
    handlers: {
      GET: async () => {
        const keys: unknown[] = [];
        try {
          keys.push(...(await publicJwks()).keys);
        } catch {
          /* no federation key configured */
        }
        if (releaseSigningKeyPresent()) {
          try {
            keys.push(await releasePublicJwk());
          } catch {
            /* a malformed release key publishes nothing */
          }
        }
        return new Response(JSON.stringify({ keys }), {
          status: 200,
          headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
        });
      },
    },
  },
});
