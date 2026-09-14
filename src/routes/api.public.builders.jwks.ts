/**
 * The public key set the Builders Network verifies workspace assertions
 * against.
 *
 * `GET /api/public/builders/jwks`. Unauthenticated by design — a JWKS is
 * public by definition, and its whole purpose is to be fetchable by a party
 * that holds no credential of ours.
 *
 * It serves the SAME key set as `/api/public/anthropic/jwks`: there is one
 * federation signing key in the environment, one import path, and one
 * `publicJwks()` — a second key here would be a second thing to rotate in
 * step, which is the failure the Anthropic module's own header warns about.
 * What is separate is only the URL, because the network's trust root must
 * not depend on a path named for a different vendor: if the Anthropic
 * integration is ever retired, its route can go without severing every
 * workspace connection in the Builders Network.
 *
 * The isolation between the two relying parties is carried by `aud`, not by
 * the key: an assertion minted for Anthropic's token endpoint names that URL
 * and the network refuses it; one minted for the network names
 * `https://builders.aurixasystems.com.au` and Anthropic refuses that.
 */
import { createFileRoute } from "@tanstack/react-router";
import { publicJwks } from "@/server/anthropicOidc.server";

export const Route = createFileRoute("/api/public/builders/jwks")({
  server: {
    handlers: {
      GET: async () => {
        let keys: Awaited<ReturnType<typeof publicJwks>>;
        try {
          keys = await publicJwks();
        } catch {
          /*
           * An empty key set rather than a 500, for the same reason the
           * Anthropic JWKS answers this way: a deployment with no signing key
           * federates nobody, so nothing is broken by this being empty — and
           * what an error could say about the environment is worth nothing to
           * a legitimate caller.
           */
          return new Response(JSON.stringify({ keys: [] }), {
            status: 200,
            headers: { "content-type": "application/json", "cache-control": "no-store" },
          });
        }
        return new Response(JSON.stringify(keys), {
          status: 200,
          headers: {
            "content-type": "application/json",
            /*
             * Cacheable for five minutes: verification is offline and the kid
             * is derived from the modulus, so a rotated key shows up as a new
             * kid rather than a changed document — a short cache costs one
             * refused assertion at worst, never a wrong acceptance.
             */
            "cache-control": "public, max-age=300",
          },
        });
      },
    },
  },
});
