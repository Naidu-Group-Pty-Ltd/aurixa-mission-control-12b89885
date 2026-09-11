/**
 * The public key set Anthropic verifies clone assertions against.
 *
 * `GET /api/public/anthropic/jwks`. Unauthenticated by design — a JWKS is
 * public by definition, and its whole purpose is to be fetchable by a party
 * that holds no credential of ours. Anthropic fetches it when a federation
 * issuer is registered with `{"type": "explicit_url"}`, which is why nothing
 * here has to serve `/.well-known/openid-configuration`.
 *
 * Two registered issuers point at this one URL: the clone issuer and the
 * bootstrap issuer. They are separate records because Anthropic locks an
 * issuer backing an `org:admin` rule against OAuth edits, but they are signed
 * by the same key and so verify against the same set.
 *
 * A test asserts no private field ever appears in this answer.
 */
import { createFileRoute } from "@tanstack/react-router";
import { publicJwks } from "@/server/anthropicOidc.server";

export const Route = createFileRoute("/api/public/anthropic/jwks")({
  server: {
    handlers: {
      GET: async () => {
        let keys: Awaited<ReturnType<typeof publicJwks>>;
        try {
          keys = await publicJwks();
        } catch {
          /*
           * An empty key set rather than a 500, and deliberately.
           *
           * A deployment with no signing key configured federates nobody, so
           * nothing is broken by this being empty — and a 500 here would read,
           * from Anthropic's side, as an issuer that is misbehaving rather
           * than one that has nothing to publish yet. The error is not
           * echoed: this endpoint is public, and what it could say about the
           * environment is worth nothing to a legitimate caller.
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
            // Short, so rotating the signing key takes effect in minutes
            // rather than whenever a cache happens to expire — but not zero,
            // because Anthropic fetches this on every issuer verification.
            "cache-control": "public, max-age=300",
          },
        });
      },
    },
  },
});
