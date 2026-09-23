import { describe, expect, it } from "vitest";
import { BREAKAGE_VECTORS, TICKET_CATEGORIES } from "@/lib/ticket-classification";
import {
  DRAFT_CATEGORY_COVERAGE,
  MIN_DESCRIPTION_CHARS,
  THIN_REPORT_NOTE,
  breakageFromSpeech,
  categoryFromSpeech,
  draftTicketFromSpeech,
  usableEmail,
} from "@/server/voiceTicketDraft.pure";

describe("categoryFromSpeech", () => {
  it("reads the distinctive categories out of ordinary speech", () => {
    expect(categoryFromSpeech({ summary: "I think my account has been hacked" }))
      .toBe("security_threat");
    expect(categoryFromSpeech({ summary: "I've been charged twice this month" }))
      .toBe("billing");
    expect(categoryFromSpeech({ summary: "I can't log in, it says access denied" }))
      .toBe("access");
    expect(categoryFromSpeech({ summary: "the report shows the wrong figure" }))
      .toBe("data_issue");
    expect(categoryFromSpeech({ summary: "everything is really slow today" }))
      .toBe("performance");
    expect(categoryFromSpeech({ summary: "the page is blank and it throws an error" }))
      .toBe("bug");
    expect(categoryFromSpeech({ summary: "how do I add a client?" }))
      .toBe("question");
    expect(categoryFromSpeech({ summary: "could you add a dark mode" }))
      .toBe("feature_request");
  });

  it("prefers the more consequential reading when two apply", () => {
    // Billing outranks performance: the money is the complaint, the speed is
    // colour. Getting this backwards files a refund request as a slow page.
    expect(categoryFromSpeech({ summary: "I've been charged twice and it's really slow" }))
      .toBe("billing");
    // A fault described as a question is still a fault.
    expect(categoryFromSpeech({ summary: "how do I fix this, it's not working" }))
      .toBe("bug");
  });

  it("falls back to other rather than refusing", () => {
    expect(categoryFromSpeech({})).toBe("other");
    expect(categoryFromSpeech({ summary: "hello" })).toBe("other");
    expect(categoryFromSpeech({ summary: "   " })).toBe("other");
  });

  it("is case and curly-quote insensitive", () => {
    expect(categoryFromSpeech({ summary: "I CAN’T LOG IN" })).toBe("access");
  });
});

describe("breakageFromSpeech", () => {
  it("reads the spread of the problem", () => {
    expect(breakageFromSpeech({ what_is_broken: "everything is down" })).toBe("full_outage");
    expect(breakageFromSpeech({ what_is_broken: "it comes and goes" })).toBe("intermittent");
    expect(breakageFromSpeech({ what_is_broken: "it's just slow" })).toBe("degraded_performance");
    expect(breakageFromSpeech({ what_is_broken: "some of the reports" })).toBe("partial_outage");
    expect(breakageFromSpeech({ what_is_broken: "it just looks wrong" })).toBe("cosmetic");
    expect(breakageFromSpeech({ what_is_broken: "only the one report" })).toBe("single_feature");
  });

  it("reads the field the caller was asked before the rest of the report", () => {
    // The detail mentions slowness; the answer to "how much is affected" says
    // everything. The answer to the question wins.
    expect(breakageFromSpeech({
      what_is_broken: "everything, none of it works",
      detail: "it has been slow all week",
    })).toBe("full_outage");
  });

  it("falls back to none", () => {
    expect(breakageFromSpeech({})).toBe("none");
    expect(breakageFromSpeech({ what_is_broken: "not sure really" })).toBe("none");
  });
});

describe("draftTicketFromSpeech", () => {
  it("produces a draft the schema accepts from a full report", () => {
    const d = draftTicketFromSpeech({
      summary: "Reports are failing to generate",
      detail: "I click generate and after a few minutes it says Data Unavailable",
      what_is_broken: "just the reports, everything else is fine",
      since_when: "since yesterday afternoon",
    });
    expect(d.subject).toBe("Reports are failing to generate");
    expect(d.subject.length).toBeGreaterThanOrEqual(4);
    expect(d.subject.length).toBeLessThanOrEqual(160);
    expect(d.description.length).toBeGreaterThanOrEqual(MIN_DESCRIPTION_CHARS);
    expect(d.description).toContain("Data Unavailable");
    expect(d.description).toContain("How much is affected:");
    expect(d.description).toContain("Started: since yesterday afternoon");
    expect(TICKET_CATEGORIES).toContain(d.category);
    expect(BREAKAGE_VECTORS).toContain(d.breakage_vector);
  });

  it("clears the description floor without inventing a report", () => {
    const d = draftTicketFromSpeech({ summary: "broken", detail: "it broke" });
    expect(d.description.length).toBeGreaterThanOrEqual(MIN_DESCRIPTION_CHARS);
    expect(d.description).toContain(THIN_REPORT_NOTE);
    // The padding says where the report came from; it does not embellish it.
    expect(d.description).toContain("it broke");
  });

  it("is total — even an empty call yields a schema-valid draft", () => {
    const d = draftTicketFromSpeech({});
    expect(d.subject.length).toBeGreaterThanOrEqual(4);
    expect(d.subject.length).toBeLessThanOrEqual(160);
    expect(d.description.length).toBeGreaterThanOrEqual(MIN_DESCRIPTION_CHARS);
    expect(d.description.length).toBeLessThanOrEqual(5000);
    expect(d.category).toBe("other");
    expect(d.breakage_vector).toBe("none");
  });

  it("caps an overlong subject and description at the schema's bounds", () => {
    const d = draftTicketFromSpeech({ summary: "x".repeat(400), detail: "y".repeat(9000) });
    expect(d.subject.length).toBe(160);
    expect(d.description.length).toBeLessThanOrEqual(5000);
  });

  it("omits a line the caller did not give rather than writing an empty one", () => {
    const d = draftTicketFromSpeech({
      summary: "Cannot open the client portal",
      detail: "It spins forever on the login screen",
    });
    expect(d.description).not.toContain("How much is affected:");
    expect(d.description).not.toContain("Started:");
  });
});

describe("usableEmail", () => {
  it("accepts a plausible address and normalises it", () => {
    expect(usableEmail("  Sam.Jones@Example.COM ")).toBe("sam.jones@example.com");
    // Spoken addresses arrive with spaces around the parts.
    expect(usableEmail("sam @ example . com")).toBe("sam@example.com");
  });

  it("discards anything that is not an address", () => {
    // A mis-transcribed address that looks real is worse than none: the CRM
    // record is the better source and the schema would reject this anyway.
    expect(usableEmail("sam at example dot com")).toBeNull();
    expect(usableEmail("not an email")).toBeNull();
    expect(usableEmail("sam@example")).toBeNull();
    expect(usableEmail("")).toBeNull();
    expect(usableEmail(null)).toBeNull();
    expect(usableEmail(undefined)).toBeNull();
  });
});

describe("enum coverage", () => {
  it("every value this module emits is one the schema accepts", () => {
    for (const c of DRAFT_CATEGORY_COVERAGE.reachable) {
      expect(TICKET_CATEGORIES).toContain(c);
    }
    for (const v of DRAFT_CATEGORY_COVERAGE.reachableVectors) {
      expect(BREAKAGE_VECTORS).toContain(v);
    }
  });

  it("names which values speech can never reach, so the gap is deliberate", () => {
    // Nothing a caller says maps to these; they are set by operators or by the
    // classifier. Asserting the list means a new enum value shows up here as a
    // decision to make rather than as silence.
    const unreachable = TICKET_CATEGORIES.filter(
      (c) => !DRAFT_CATEGORY_COVERAGE.reachable.includes(c),
    );
    expect(unreachable).toEqual([]);
    const unreachableVectors = BREAKAGE_VECTORS.filter(
      (v) => !DRAFT_CATEGORY_COVERAGE.reachableVectors.includes(v),
    );
    expect(unreachableVectors).toEqual([]);
  });
});
