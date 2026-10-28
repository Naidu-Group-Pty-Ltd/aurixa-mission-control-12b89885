/**
 * Website → Videos, rendered.
 *
 * The rules and the acts have their own tests; these prove the two pages
 * render from the data their server functions return — the library with its
 * statuses and the rebuild line, and the editor with every field, the
 * problems that stand between a draft and Publish, and the media it plays —
 * without a browser.
 */
import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({ queries: new Map<string, unknown>(), briefingId: "b1" }));

vi.mock("@tanstack/react-router", async () => {
  const { createElement: el } = await import("react");
  return {
    createFileRoute: () => (options: Record<string, unknown>) => ({
      options,
      useParams: () => ({ briefingId: h.briefingId }),
    }),
    Link: ({ to, children, className }: { to: string; children?: ReactNode; className?: string }) =>
      el("a", { href: to, className }, children),
    useNavigate: () => () => undefined,
  };
});
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    const data = h.queries.get(JSON.stringify(queryKey));
    return {
      data,
      isLoading: data === undefined,
      isSuccess: data !== undefined,
      isFetching: false,
      error: null,
    };
  },
  useQueryClient: () => ({ invalidateQueries: async () => undefined }),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: () => async () => undefined }));
vi.mock("@/server/website-briefings.functions", () => {
  const fn = async () => undefined;
  return {
    createBriefingUploadFn: fn,
    createWebsiteBriefingFn: fn,
    deleteDraftWebsiteBriefingFn: fn,
    finalizeBriefingUploadFn: fn,
    getWebsiteBriefingFn: fn,
    listWebsiteBriefingsFn: fn,
    requestWebsiteRebuildFn: fn,
    saveWebsiteBriefingFn: fn,
    setWebsiteBriefingStatusFn: fn,
  };
});
vi.mock("@/components/protected-route", () => ({
  ProtectedRoute: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@/components/route-error", () => ({ RouteError: () => null }));
vi.mock("@/components/confirm-dialog", () => ({ useConfirm: () => async () => true }));

const { Route: ListRoute } = await import("@/routes/website.videos.index");
const { Route: EditorRoute } = await import("@/routes/website.videos.$briefingId");

const ORIGIN = "https://bucket.test/public";
const LIVE = {
  id: "b1",
  slug: "borrowing-capacity",
  status: "published",
  title: "Borrowing Capacity, in Moments",
  kicker: "From one client questionnaire to an indicative assessment, scenarios and a report.",
  summary:
    "Your client has found the property; can they afford it? From one client questionnaire, Aurixa produces an indicative borrowing capacity assessment and a report.",
  series: "platform",
  artwork: "/brand/layer-03-financial-modelling.webp",
  artwork_position: null,
  takeaways: ["One questionnaire.", "An indicative assessment."],
  explore_label: "See the serviceability engine",
  explore_to: "/platform#serviceability",
  orientation: "portrait",
  disclaimer: "Illustrative example only.",
  transcript: ["Your client has found the property."],
  chapters: [{ at: 0, label: "Can they afford it?" }],
  media_version: "v1",
  media_hls: "videos/borrowing-capacity/v1/master.m3u8",
  media_mp4: "videos/borrowing-capacity/v1/fallback-720p.mp4",
  media_poster: "videos/borrowing-capacity/v1/poster.jpg",
  media_card: "videos/borrowing-capacity/v1/card-2.jpg",
  media_captions: null,
  duration_seconds: 147,
  published_on: "2026-10-28",
  sort_order: 30,
  created_at: "2026-10-28T00:00:00Z",
  updated_at: "2026-10-28T00:00:00Z",
  created_by: null,
  updated_by: null,
};
const DRAFT = {
  ...LIVE,
  id: "b2",
  slug: "client-reporting",
  status: "draft",
  title: "Client Reporting, Branded",
  summary: "Too short.",
  media_version: null,
  media_hls: null,
  media_mp4: null,
  media_poster: null,
  media_card: null,
  duration_seconds: null,
  published_on: null,
};

const render = (route: unknown) =>
  renderToStaticMarkup(
    createElement((route as { options: { component: () => ReactNode } }).options.component),
  );

describe("Website → Videos", () => {
  it("lists every video with its status, address and media", () => {
    h.queries.set(JSON.stringify(["website-briefings"]), {
      rows: [LIVE, DRAFT],
      error: null,
      mediaOrigin: ORIGIN,
      rebuild: { configured: false, last: null },
    });
    const html = render(ListRoute);
    expect(html).toContain("Website videos");
    expect(html).toContain("Borrowing Capacity, in Moments");
    expect(html).toContain("live on the website");
    expect(html).toContain("/watch/client-reporting");
    expect(html).toContain("no media yet");
    expect(html).toContain(`${ORIGIN}/videos/borrowing-capacity/v1/poster.jpg`);
    expect(html).toContain("WEBSITE_DEPLOY_HOOK_URL");
  });

  it("opens a live video with its copy, chapters, transcript and media", () => {
    h.briefingId = "b1";
    h.queries.set(JSON.stringify(["website-briefing", "b1"]), {
      row: LIVE,
      publishProblems: [],
      premiereProblems: [],
      mediaOrigin: ORIGIN,
      rebuildConfigured: true,
    });
    const html = render(EditorRoute);
    expect(html).toContain("Borrowing Capacity, in Moments");
    expect(html).toContain("Fixed: its media folder is named after it.");
    expect(html).toContain("Can they afford it?");
    expect(html).toContain("Your client has found the property.");
    expect(html).toContain('Playing <span class="font-mono">v1</span>');
    expect(html).toContain("card-2.jpg");
    expect(html).toContain("Return to draft");
    expect(html).not.toContain(">Publish<");
  });

  it("shows a draft what stands between it and Publish", () => {
    h.briefingId = "b2";
    h.queries.set(JSON.stringify(["website-briefing", "b2"]), {
      row: DRAFT,
      publishProblems: [],
      premiereProblems: [],
      mediaOrigin: ORIGIN,
      rebuildConfigured: false,
    });
    const html = render(EditorRoute);
    expect(html).toContain("Before it can be published:");
    expect(html).toContain("Upload the video first.");
    expect(html).toMatch(/summary is 10 characters/);
    expect(html).toContain("Delete draft");
    expect(html).toContain("No video yet.");
  });
});
