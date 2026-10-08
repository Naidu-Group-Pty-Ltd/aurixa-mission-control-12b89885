import { createFileRoute } from "@tanstack/react-router";
import { assetLinks, normaliseCertFingerprints } from "@/server/mobile/appAssociation.pure";

/** GET /.well-known/assetlinks.json — see `appAssociation.pure.ts`. */
export const Route = createFileRoute("/.well-known/assetlinks.json")({
  server: {
    handlers: {
      GET: () =>
        new Response(
          JSON.stringify(
            assetLinks(normaliseCertFingerprints(process.env.MOBILE_ANDROID_CERT_SHA256)),
          ),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "cache-control": "public, max-age=3600",
            },
          },
        ),
    },
  },
});
