// The dispatcher's pure decisions: how a jsonb attribute becomes a PostgREST
// filter, and how many contacts a message may carry. Both are places where
// being wrong is silent — a filter that matches nothing reads as a quota with
// no usage, and a batch size taken from the wrong place mails forty people a
// letter addressed to one of them.
import { describe, expect, it } from "vitest";
import { jsonPathColumn, pgInList } from "@/lib/email/quotaFilter.pure";
import { messageBatchSize, rulesFor } from "./email-campaigns.server";

describe("jsonPathColumn", () => {
  it("builds the filter column for an attribute", () => {
    expect(jsonPathColumn("attributes_norm", "state")).toBe("attributes_norm->>state");
  });

  it("refuses a key the parser could not have produced", () => {
    // `columnKey()` only ever emits [a-z][a-z0-9_]*, so anything else reached
    // this from somewhere that is not a parsed heading.
    for (const bad of ["state; drop", "State", "1state", "a.b", "", "attributes_norm->>x"]) {
      expect(() => jsonPathColumn("attributes_norm", bad), bad).toThrow(
        /unrecognised attribute key/,
      );
    }
  });
});

describe("pgInList", () => {
  it("quotes every value, so a comma inside one cannot split it", () => {
    expect(pgInList(["nsw", "qld"])).toBe('("nsw","qld")');
    expect(pgInList(["sydney, nsw"])).toBe('("sydney, nsw")');
  });

  it("escapes a quote rather than closing the list early", () => {
    expect(pgInList(['o"brien'])).toBe('("o\\"brien")');
    expect(pgInList(["back\\slash"])).toBe('("back\\\\slash")');
  });
});

describe("messageBatchSize", () => {
  const campaign = (over: Partial<Parameters<typeof messageBatchSize>[0]> = {}) => ({
    subject_template: "A notice",
    body_template: "<p>For everybody.</p>",
    recipients_per_message: 40,
    ...over,
  });

  it("honours the configured batch when nothing is per-recipient", () => {
    expect(messageBatchSize(campaign())).toBe(40);
  });

  it("collapses to one as soon as the message names a column", () => {
    expect(messageBatchSize(campaign({ body_template: "<p>Hi {{first_name}}</p>" }))).toBe(1);
    expect(messageBatchSize(campaign({ subject_template: "For {{state}}" }))).toBe(1);
  });

  it("collapses to one for an unsubscribe link, which identifies the reader", () => {
    expect(
      messageBatchSize(campaign({ body_template: "<a href='{{unsubscribe_url}}'>Stop</a>" })),
    ).toBe(1);
  });

  it("never returns zero", () => {
    expect(messageBatchSize(campaign({ recipients_per_message: 0 }))).toBe(1);
  });
});

describe("rulesFor", () => {
  const row = {
    id: "c1",
    name: "Test",
    status: "running",
    from_mailbox: null,
    from_name: null,
    reply_to: null,
    subject_template: "s",
    body_template: "b",
    body_format: "html",
    timezone: "",
    send_days: null,
    window_start: "09:00:00",
    window_end: "17:00:00",
    max_messages_per_day: null,
    max_recipients_per_day: null,
    recipients_per_message: 1,
    min_gap_seconds: 60,
    max_messages_per_run: 20,
    starts_at: null,
    ends_at: null,
    last_message_at: null,
  };

  it("fills a missing zone and an empty day list rather than sending nothing", () => {
    const rules = rulesFor(row);
    expect(rules.timezone).toBe("Australia/Sydney");
    // An empty day list would close the window for ever, which reads on screen
    // as a campaign that is running and does nothing.
    expect(rules.sendDays).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
