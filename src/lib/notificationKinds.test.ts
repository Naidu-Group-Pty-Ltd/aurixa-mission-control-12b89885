import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ALL_NOTIFICATION_KINDS } from "./notificationDisposition";
import {
  NOTIFICATION_KIND_FILTER_OPTIONS,
  NOTIFICATION_KIND_FILTER_VALUES,
  NOTIFICATION_KIND_LABELS,
  notificationKindLabel,
} from "./notificationKinds.pure";

describe("the inbox's kind filter is the database's list of kinds", () => {
  /* The acceptance line in DELIVERY_SYSTEM_PLAN.md W4: the filter lists every kind. */
  it("offers every kind in ALL_NOTIFICATION_KINDS", () => {
    const offered = new Set(NOTIFICATION_KIND_FILTER_OPTIONS.map((o) => o.value));
    for (const kind of ALL_NOTIFICATION_KINDS) {
      expect(offered.has(kind), `${kind} is missing from the kind filter`).toBe(true);
    }
  });

  it("accepts every kind in the URL, so a link to one is not read as All kinds", () => {
    for (const kind of ALL_NOTIFICATION_KINDS) {
      expect(NOTIFICATION_KIND_FILTER_VALUES).toContain(kind);
    }
  });

  /* The ones the hand list left out, measured 27 Oct 2026. */
  it("includes the kinds the hand list was missing", () => {
    for (const kind of [
      "cascade_blocked",
      "remediation_failed",
      "deployment_bundle_identity",
      "clone_ci_attention",
    ]) {
      expect(
        NOTIFICATION_KIND_FILTER_OPTIONS.some((o) => o.value === kind),
        kind,
      ).toBe(true);
    }
  });

  it("offers each kind once, and All kinds first", () => {
    expect(NOTIFICATION_KIND_FILTER_OPTIONS[0]).toEqual({ value: "all", label: "All kinds" });
    const values = NOTIFICATION_KIND_FILTER_OPTIONS.map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
    expect(values.length).toBe(ALL_NOTIFICATION_KINDS.length + 1);
  });

  it("offers only real kinds", () => {
    for (const o of NOTIFICATION_KIND_FILTER_OPTIONS.slice(1)) {
      expect(ALL_NOTIFICATION_KINDS).toContain(o.value);
    }
  });
});

describe("labels", () => {
  it("keeps every label a person wrote", () => {
    expect(notificationKindLabel("tokens_key_issued")).toBe("API key issued");
    expect(notificationKindLabel("drift_high")).toBe("Drift — high");
    for (const [kind, label] of Object.entries(NOTIFICATION_KIND_LABELS)) {
      const option = NOTIFICATION_KIND_FILTER_OPTIONS.find((o) => o.value === kind);
      expect(option?.label, kind).toBe(label);
    }
  });

  it("reads a kind nobody labelled as words", () => {
    expect(notificationKindLabel("cascade_blocked")).toBe("Cascade blocked");
    expect(notificationKindLabel("clone_ci_attention")).toBe("Clone CI attention");
    expect(notificationKindLabel("api_usage_settlement_failed")).toBe(
      "API usage settlement failed",
    );
    expect(notificationKindLabel("github_app_access_drift")).toBe("GitHub app access drift");
  });

  it("gives every kind a label a person can read", () => {
    for (const kind of ALL_NOTIFICATION_KINDS) {
      const label = notificationKindLabel(kind);
      expect(label.length, kind).toBeGreaterThan(0);
      expect(label, kind).not.toContain("_");
      expect(label[0], kind).toBe(label[0].toUpperCase());
    }
  });
});

describe("the page reads the filter from here", () => {
  const page = readFileSync("src/routes/notifications.tsx", "utf8");

  it("builds its Select and its URL schema from this module", () => {
    expect(page).toContain("NOTIFICATION_KIND_FILTER_OPTIONS.map(");
    expect(page).toContain("z.enum(NOTIFICATION_KIND_FILTER_VALUES)");
  });

  it("no longer carries a hand list of kinds", () => {
    expect(page).not.toMatch(/const KIND_VALUES\s*=/);
    expect(page).not.toMatch(/const KIND_OPTIONS\s*[:=]/);
  });
});
