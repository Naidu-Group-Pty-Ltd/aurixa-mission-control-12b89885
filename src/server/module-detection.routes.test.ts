/**
 * A test file is never a route (`isTestFile`).
 *
 * Measured on 29 Oct 2026 at prime@8312990: the specs under
 * `src/pages/__tests__/` and beside the pages were read as routes, became two
 * modules (`-tests-` and `bc-segment-engine-admin.security.test`), and every
 * page a spec imports was reached from two domains and filed as shared, in
 * platform-core: the Builder Portal, Cloudflare Management and the public
 * Compliance Passport among them.
 */
import { describe, expect, it } from "vitest";
import { identifyRouteFiles } from "./module-detection.server";
import { buildFeatureModules, isTestFile, PLATFORM_CORE_SLUG } from "./feature-detection.server";

describe("isTestFile", () => {
  it("knows a test by the directory it is in, or by its name", () => {
    for (const path of [
      "src/pages/__tests__/builderPortalPage.spec.tsx",
      "src/pages/__tests__/publicPassportPage.test.tsx",
      "src/pages/admin/__tests__/AccountantPortalAdmin.confirmPractice.test.tsx",
      "src/pages/admin/BcSegmentEngineAdmin.security.test.ts",
      "src/pages/TemplateSharePreview.security.test.ts",
      "src/pages/portal/portalHelpers.spec.mjs",
      "src/routes/__mocks__/session.ts",
    ]) {
      expect(isTestFile(path), path).toBe(true);
    }
  });

  it("does not take a page for a test because of a word in its name", () => {
    for (const path of [
      "src/pages/BuilderPortal.tsx",
      "src/pages/Testimonials.tsx",
      "src/pages/admin/ReportEngineInspector.tsx",
      "src/pages/LatestSpecials.tsx",
      "src/pages/qa/MarketQASubscriptions.tsx",
    ]) {
      expect(isTestFile(path), path).toBe(false);
    }
  });
});

describe("identifyRouteFiles", () => {
  it("finds the pages, and none of the specs beside them", () => {
    expect(
      identifyRouteFiles([
        "src/pages/BuilderPortal.tsx",
        "src/pages/__tests__/builderPortalPage.spec.tsx",
        "src/pages/admin/BcSegmentEngineAdmin.tsx",
        "src/pages/admin/BcSegmentEngineAdmin.security.test.ts",
        "src/routes/__root.tsx",
        "src/routes/clients.tsx",
        "src/routes/__tests__/clients.test.tsx",
      ]),
    ).toEqual([
      "src/pages/BuilderPortal.tsx",
      "src/pages/admin/BcSegmentEngineAdmin.tsx",
      "src/routes/clients.tsx",
    ]);
  });

  it("leaves a page a spec imports in its own module, not in platform-core", () => {
    const files = [
      "src/pages/BuilderPortal.tsx",
      "src/pages/CloudflareManagement.tsx",
      "src/pages/__tests__/builderPortalPage.spec.tsx",
      "src/pages/__tests__/CloudflareManagement.readOnly.spec.tsx",
      "src/components/ui/button.tsx",
    ];
    const imports: Record<string, string[]> = {
      "src/pages/__tests__/builderPortalPage.spec.tsx": ["src/pages/BuilderPortal.tsx"],
      "src/pages/__tests__/CloudflareManagement.readOnly.spec.tsx": [
        "src/pages/CloudflareManagement.tsx",
      ],
      "src/pages/BuilderPortal.tsx": ["src/components/ui/button.tsx"],
      "src/pages/CloudflareManagement.tsx": ["src/components/ui/button.tsx"],
    };
    const { modules } = buildFeatureModules({
      files,
      routeFiles: identifyRouteFiles(files),
      importsOf: (f) => imports[f] ?? [],
    });
    const ownerOf = (f: string) => modules.find((m) => m.resolvedFiles.includes(f))?.slug;

    expect(ownerOf("src/pages/BuilderPortal.tsx")).toBe("builder-portal");
    expect(ownerOf("src/pages/CloudflareManagement.tsx")).toBe("cloudflare-management");
    expect(ownerOf("src/components/ui/button.tsx")).toBe(PLATFORM_CORE_SLUG);
    // A spec is nobody's: no module is made of it, and none owns it.
    expect(modules.map((m) => m.slug).sort()).toEqual([
      "builder-portal",
      "cloudflare-management",
      PLATFORM_CORE_SLUG,
    ]);
    expect(ownerOf("src/pages/__tests__/builderPortalPage.spec.tsx")).toBeUndefined();
  });
});
