import { createFileRoute } from "@tanstack/react-router";
import { appleAppSiteAssociation } from "@/server/mobile/appAssociation.pure";

/** GET /.well-known/apple-app-site-association — see `appAssociation.pure.ts`. */
export const Route = createFileRoute("/.well-known/apple-app-site-association")({
  server: {
    handlers: {
      GET: () =>
        new Response(JSON.stringify(appleAppSiteAssociation(process.env.APPLE_TEAM_ID)), {
          status: 200,
          headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
        }),
    },
  },
});
