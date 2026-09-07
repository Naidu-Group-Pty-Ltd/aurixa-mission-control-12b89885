import { describe, expect, it } from "vitest";
import {
  auStateCode,
  auStateSiblings,
  columnKey,
  extractContacts,
  normaliseValue,
  profileTable,
} from "./listProfile.pure";
import {
  claimQuota,
  minutesOfClock,
  planTick,
  quotaBlocking,
  quotaCovers,
  startOfZonedDay,
  windowState,
  zonedParts,
  zonedTimeToInstant,
  type CampaignRules,
  type QuotaRule,
} from "./campaignRules.pure";
import {
  bodyPreview,
  escapeHtml,
  findTokens,
  missingFields,
  personalisingFields,
  renderTemplate,
  requiresOneRecipient,
} from "./mergeTemplate.pure";
import { isDeliveryReport, readDeliveryReport, readSmtpCode } from "./bounceReport.pure";

const RULES: CampaignRules = {
  timezone: "Australia/Sydney",
  sendDays: [1, 2, 3, 4, 5],
  windowStart: "09:00",
  windowEnd: "17:00",
  maxMessagesPerDay: null,
  maxRecipientsPerDay: null,
  recipientsPerMessage: 1,
  minGapSeconds: 0,
  maxMessagesPerRun: 20,
  startsAt: null,
  endsAt: null,
};

const quota = (over: Partial<QuotaRule> = {}): QuotaRule => ({
  id: "q1",
  dimension: "state",
  dimensionLabel: "State",
  matchValues: ["nsw"],
  valueLabel: "NSW",
  maxPerDay: 2,
  maxTotal: null,
  enabled: true,
  ...over,
});

describe("listProfile.pure", () => {
  it("makes a stable key out of any heading, and never collides", () => {
    const taken = new Set<string>();
    expect(columnKey("State / Territory", taken, 0)).toBe("state_territory");
    expect(columnKey("State / Territory", taken, 1)).toBe("state_territory_2");
    expect(columnKey("   ", taken, 5)).toBe("column_6");
    expect(columnKey("2024 spend", taken, 2)).toBe("c_2024_spend");
  });

  it("folds case and collapses whitespace, and does nothing else", () => {
    expect(normaliseValue("  New   South Wales ")).toBe("new south wales");
    // Not merged with NSW — that is the operator's call, not the parser's.
    expect(normaliseValue("NSW")).toBe("nsw");
  });

  it("offers the other spellings of a state without rewriting either", () => {
    expect(auStateSiblings("New South Wales")).toContain("nsw");
    expect(auStateCode("queensland")).toBe("QLD");
    expect(auStateSiblings("Auckland")).toEqual([]);
  });

  it("finds the address column by heading", () => {
    const profile = profileTable(
      ["Name", "Email Address", "State"],
      [
        ["Ann", "a@b.com", "NSW"],
        ["Bob", "c@d.com", "QLD"],
      ],
    );
    expect(profile.emailColumnKey).toBe("email_address");
  });

  it("lets content outvote a heading whose column is empty", () => {
    const profile = profileTable(
      ["Email", "Primary Contact"],
      [
        ["", "a@b.com"],
        ["", "c@d.com"],
      ],
    );
    expect(profile.emailColumnKey).toBe("primary_contact");
  });

  it("offers a repeating column as a parameter and refuses a unique one", () => {
    const rows = Array.from({ length: 40 }, (_, i) => [
      `person${i}@example.com`,
      i % 2 === 0 ? "NSW" : "QLD",
      `Person Number ${i}`,
    ]);
    const profile = profileTable(["Email", "State", "Full Name"], rows);
    const byKey = Object.fromEntries(profile.columns.map((c) => [c.key, c]));
    expect(byKey.state.isDimension).toBe(true);
    expect(byKey.state.values.map((v) => v.value).sort()).toEqual(["nsw", "qld"]);
    expect(byKey.full_name.isDimension).toBe(false);
    // The address column is never a parameter.
    expect(byKey.email.isDimension).toBe(false);
  });

  it("keeps a representative spelling beside the normalised value", () => {
    const profile = profileTable(
      ["Email", "State"],
      [
        ["a@b.com", "NSW"],
        ["c@d.com", " nsw "],
      ],
    );
    const state = profile.columns.find((c) => c.key === "state")!;
    expect(state.values).toEqual([{ value: "nsw", label: "NSW", count: 2 }]);
  });

  it("returns a column even when nothing looks like an address, so the page can ask", () => {
    const profile = profileTable(["Email", "State"], [["not-an-address", "NSW"]]);
    expect(profile.emailColumnKey).toBe("email");
  });

  it("extracts contacts, counts duplicates and names the unreadable rows", () => {
    const headers = ["Email", "State", "First Name"];
    const rows = [
      ["Ann@Example.com", "NSW", "Ann"],
      ["ann@example.com", "NSW", "Ann again"],
      ["broken-at-example.com", "QLD", "Bob"],
      ["", "VIC", "Nobody"],
      ["cara@example.com", "QLD", "Cara"],
    ];
    const profile = profileTable(headers, rows);
    const result = extractContacts(headers, rows, profile);

    expect(result.contacts.map((c) => c.email_key)).toEqual([
      "ann@example.com",
      "cara@example.com",
    ]);
    expect(result.duplicates).toBe(1);
    expect(result.invalid).toEqual([{ row_number: 3, value: "broken-at-example.com" }]);
    expect(result.contacts[0].attributes).toEqual({ state: "NSW", first_name: "Ann" });
    expect(result.contacts[0].attributes_norm).toEqual({ state: "nsw", first_name: "ann" });
  });

  it("keeps the address exactly as the sheet spelled it, beside its identity", () => {
    const headers = ["Email"];
    const rows = [["  Ann@Example.com "]];
    const profile = profileTable(headers, rows);
    const [contact] = extractContacts(headers, rows, profile).contacts;
    expect(contact.email).toBe("Ann@Example.com");
    expect(contact.email_key).toBe("ann@example.com");
  });

  it("honours an operator's override of the address column", () => {
    const headers = ["Work Email", "Personal Email"];
    const rows = [["work@a.com", "home@b.com"]];
    const profile = profileTable(headers, rows);
    const result = extractContacts(headers, rows, profile, "personal_email");
    expect(result.contacts[0].email_key).toBe("home@b.com");
  });
});

describe("campaignRules.pure — the clock", () => {
  it("reads the campaign's zone, not the server's", () => {
    // 22:30 UTC on a Tuesday is 09:30 Wednesday in Sydney (AEDT, +11).
    const parts = zonedParts(new Date("2026-01-06T22:30:00Z"), "Australia/Sydney");
    expect([parts.year, parts.month, parts.day, parts.hour]).toEqual([2026, 1, 7, 9]);
    expect(parts.weekday).toBe(3);
  });

  it("survives an unknown zone rather than stopping the campaign", () => {
    const parts = zonedParts(new Date("2026-01-06T22:30:00Z"), "Mars/Olympus");
    expect(parts.hour).toBe(22);
  });

  it("resolves a wall-clock reading to an instant across a daylight-saving change", () => {
    // Sydney leaves daylight saving at 03:00 on 2026-04-05.
    const before = zonedTimeToInstant("Australia/Sydney", 2026, 4, 4, 12, 0, 0);
    const after = zonedTimeToInstant("Australia/Sydney", 2026, 4, 6, 12, 0, 0);
    expect(zonedParts(before, "Australia/Sydney").hour).toBe(12);
    expect(zonedParts(after, "Australia/Sydney").hour).toBe(12);
  });

  it("puts the start of the day at local midnight", () => {
    const start = startOfZonedDay(new Date("2026-01-07T05:00:00Z"), "Australia/Sydney");
    const parts = zonedParts(start, "Australia/Sydney");
    expect([parts.hour, parts.minute, parts.day]).toEqual([0, 0, 7]);
  });

  it("reads a Postgres time value as well as HH:MM", () => {
    expect(minutesOfClock("09:30:00")).toBe(570);
    expect(minutesOfClock("17:00")).toBe(1020);
  });
});

describe("campaignRules.pure — the window", () => {
  const at = (iso: string) => windowState(RULES, new Date(iso));

  it("opens inside the window on a sending day", () => {
    // Wednesday 10:00 Sydney.
    expect(at("2026-01-06T23:00:00Z")).toEqual({ open: true });
  });

  it("closes outside the hours and on a day that is not selected", () => {
    // Wednesday 08:00 Sydney.
    expect(at("2026-01-06T21:00:00Z")).toMatchObject({ open: false, reason: "outside_hours" });
    // Sunday 10:00 Sydney.
    expect(at("2026-01-10T23:00:00Z")).toMatchObject({ open: false, reason: "day_not_selected" });
  });

  it("closes at the end of the window rather than one minute past it", () => {
    // 17:00 Sydney exactly — the window is half-open.
    expect(at("2026-01-07T06:00:00Z")).toMatchObject({ open: false, reason: "outside_hours" });
    expect(at("2026-01-07T05:59:00Z")).toEqual({ open: true });
  });

  it("handles a window that wraps past midnight", () => {
    const overnight = {
      ...RULES,
      windowStart: "22:00",
      windowEnd: "02:00",
      sendDays: [1, 2, 3, 4, 5, 6, 7],
    };
    expect(windowState(overnight, new Date("2026-01-06T12:00:00Z"))).toEqual({ open: true }); // 23:00
    expect(windowState(overnight, new Date("2026-01-06T04:00:00Z"))).toMatchObject({ open: false }); // 15:00
  });

  it("respects the campaign's own start and end", () => {
    const scheduled = { ...RULES, startsAt: "2026-02-01T00:00:00Z" };
    expect(windowState(scheduled, new Date("2026-01-06T23:00:00Z"))).toMatchObject({
      open: false,
      reason: "before_start",
    });
  });
});

describe("campaignRules.pure — the tick", () => {
  const now = new Date("2026-01-06T23:00:00Z"); // Wednesday 10:00 Sydney

  const tick = (over: Partial<Parameters<typeof planTick>[0]> = {}) =>
    planTick({
      rules: RULES,
      now,
      lastMessageAt: null,
      messagesToday: 0,
      recipientsToday: 0,
      pendingCount: 1000,
      ...over,
    });

  it("stops at the per-run ceiling", () => {
    expect(tick().messageAllowance).toBe(20);
  });

  it("counts messages and contacts as different caps", () => {
    const batched = { ...RULES, recipientsPerMessage: 40, maxMessagesPerDay: 5 };
    const plan = planTick({
      rules: batched,
      now,
      lastMessageAt: null,
      messagesToday: 3,
      recipientsToday: 120,
      pendingCount: 1000,
    });
    // Two messages left today, which is eighty contacts — not two contacts.
    expect(plan.messageAllowance).toBe(2);
    expect(plan.recipientAllowance).toBe(80);
  });

  it("lets a contact cap cut a message short instead of skipping it", () => {
    const batched = { ...RULES, recipientsPerMessage: 40, maxRecipientsPerDay: 100 };
    const plan = planTick({
      rules: batched,
      now,
      lastMessageAt: null,
      messagesToday: 0,
      recipientsToday: 90,
      pendingCount: 1000,
    });
    expect(plan.recipientAllowance).toBe(10);
    expect(plan.messageAllowance).toBe(1);
  });

  it("refuses once a daily cap is spent, and says which one", () => {
    expect(
      planTick({
        rules: { ...RULES, maxMessagesPerDay: 5 },
        now,
        lastMessageAt: null,
        messagesToday: 5,
        recipientsToday: 5,
        pendingCount: 100,
      }),
    ).toMatchObject({ canSend: false, blockedBy: "today's message limit has been reached" });
  });

  it("never allows more than there are recipients waiting", () => {
    expect(tick({ pendingCount: 3 })).toMatchObject({ messageAllowance: 3, recipientAllowance: 3 });
    expect(tick({ pendingCount: 0 })).toMatchObject({ canSend: false });
  });

  it("waits out the remainder of the gap since the last message", () => {
    const plan = planTick({
      rules: { ...RULES, minGapSeconds: 300 },
      now,
      lastMessageAt: new Date(now.getTime() - 120_000).toISOString(),
      messagesToday: 1,
      recipientsToday: 1,
      pendingCount: 10,
    });
    expect(plan.canSend).toBe(true);
    expect(plan.initialDelayMs).toBe(180_000);
  });

  it("does not wait when the gap has already elapsed", () => {
    const plan = planTick({
      rules: { ...RULES, minGapSeconds: 60 },
      now,
      lastMessageAt: new Date(now.getTime() - 600_000).toISOString(),
      messagesToday: 1,
      recipientsToday: 1,
      pendingCount: 10,
    });
    expect(plan.initialDelayMs).toBe(0);
  });
});

describe("campaignRules.pure — per-parameter quotas", () => {
  it("covers a contact only on the value it names", () => {
    expect(quotaCovers(quota(), { state: "nsw" })).toBe(true);
    expect(quotaCovers(quota(), { state: "qld" })).toBe(false);
    // A contact with no value for the dimension is outside every rule on it.
    expect(quotaCovers(quota(), {})).toBe(false);
  });

  it("covers every spelling the rule was given", () => {
    const rule = quota({ matchValues: ["nsw", "new south wales"] });
    expect(quotaCovers(rule, { state: "new south wales" })).toBe(true);
  });

  it("blocks on the daily allowance and names the scope", () => {
    const usage = new Map([["q1", { today: 2, total: 2 }]]);
    expect(quotaBlocking([quota()], usage, new Map(), { state: "nsw" })).toMatchObject({
      scope: "day",
    });
    expect(quotaBlocking([quota()], usage, new Map(), { state: "qld" })).toBeNull();
  });

  it("blocks on a lifetime allowance independently of the day", () => {
    const rule = quota({ maxPerDay: null, maxTotal: 100 });
    const usage = new Map([["q1", { today: 0, total: 100 }]]);
    expect(quotaBlocking([rule], usage, new Map(), { state: "nsw" })).toMatchObject({
      scope: "total",
    });
  });

  it("counts what this tick has already allocated, so one tick cannot overrun", () => {
    const rules = [quota()];
    const usage = new Map([["q1", { today: 0, total: 0 }]]);
    const taken = new Map<string, number>();
    const contact = { state: "nsw" };

    expect(quotaBlocking(rules, usage, taken, contact)).toBeNull();
    claimQuota(rules, taken, contact);
    expect(quotaBlocking(rules, usage, taken, contact)).toBeNull();
    claimQuota(rules, taken, contact);
    // Two claimed against an allowance of two: the third is refused inside the
    // same tick, without any of them having been recorded as sent yet.
    expect(quotaBlocking(rules, usage, taken, contact)).toMatchObject({ scope: "day" });
  });

  it("ignores a disabled rule", () => {
    const usage = new Map([["q1", { today: 99, total: 99 }]]);
    expect(
      quotaBlocking([quota({ enabled: false })], usage, new Map(), { state: "nsw" }),
    ).toBeNull();
  });
});

describe("mergeTemplate.pure", () => {
  it("finds every field a template names, once each, in order", () => {
    expect(findTokens("Hi {{first_name}},", "<p>{{first_name}} of {{state}}</p>")).toEqual([
      "first_name",
      "state",
    ]);
  });

  it("escapes a substitution into HTML", () => {
    const out = renderTemplate(
      "<p>Hi {{name}}</p>",
      { name: 'Smith & Sons <"Trading">' },
      { html: true },
    );
    expect(out).toBe("<p>Hi Smith &amp; Sons &lt;&quot;Trading&quot;&gt;</p>");
  });

  it("does not escape into a plain-text body", () => {
    expect(renderTemplate("Hi {{name}}", { name: "Smith & Sons" }, { html: false })).toBe(
      "Hi Smith & Sons",
    );
  });

  it("renders an unknown or absent field as nothing", () => {
    expect(renderTemplate("Hi {{nope}}!", {}, { html: true })).toBe("Hi !");
  });

  it("reports a field nothing can supply, and accepts the built-ins", () => {
    const tokens = findTokens("{{first_name}} {{unsubscribe_url}} {{campaign_name}} {{firstname}}");
    expect(missingFields(tokens, ["first_name", "state"])).toEqual(["firstname"]);
  });

  it("forces one recipient per message as soon as anything is per-person", () => {
    expect(requiresOneRecipient("Hello", "<p>A notice for everyone.</p>")).toBe(false);
    expect(requiresOneRecipient("Hello", "<p>Hi {{first_name}}</p>")).toBe(true);
    // An unsubscribe link identifies the person clicking it, so it counts too.
    expect(requiresOneRecipient("Hello", "<p><a href='{{unsubscribe_url}}'>Stop</a></p>")).toBe(
      true,
    );
    // A campaign-level field does not.
    expect(requiresOneRecipient("{{campaign_name}}", "<p>Sent by {{sender_name}}</p>")).toBe(false);
    expect(personalisingFields("<p>{{state}} {{campaign_name}}</p>")).toEqual(["state"]);
  });

  it("escapes the characters that would otherwise close a tag", () => {
    expect(escapeHtml("<&>")).toBe("&lt;&amp;&gt;");
    expect(escapeHtml(`"'`)).toBe("&quot;&#39;");
  });

  it("previews a body without its markup", () => {
    expect(bodyPreview("<style>p{}</style><p>Hello <b>there</b></p>")).toBe("Hello there");
  });
});

describe("bounceReport.pure", () => {
  const DSN = `Reporting-MTA: dns; mail.example.com

Final-Recipient: rfc822; gone@example.com
Action: failed
Status: 5.1.1
Diagnostic-Code: smtp; 550 5.1.1 <gone@example.com>: Recipient address rejected: User unknown

Final-Recipient: rfc822; full@example.com
Action: failed
Status: 4.2.2
Diagnostic-Code: smtp; 452 4.2.2 Mailbox full
`;

  it("recognises a report by its content type, and by postmaster plus subject", () => {
    expect(
      isDeliveryReport({
        headers: { "Content-Type": 'multipart/report; report-type=delivery-status; boundary="x"' },
      }),
    ).toBe(true);
    expect(
      isDeliveryReport({
        fromAddress: "postmaster@example.com",
        subject: "Undeliverable: Newsletter",
      }),
    ).toBe(true);
    expect(isDeliveryReport({ fromAddress: "ann@example.com", subject: "Re: Newsletter" })).toBe(
      false,
    );
  });

  it("reads one verdict per recipient, and keeps hard and soft apart", () => {
    const findings = readDeliveryReport({ bodyText: DSN });
    expect(findings).toHaveLength(2);
    expect(findings.find((f) => f.address === "gone@example.com")).toMatchObject({
      kind: "hard",
      status: "5.1.1",
      smtpCode: 550,
    });
    expect(findings.find((f) => f.address === "full@example.com")).toMatchObject({
      kind: "soft",
      status: "4.2.2",
    });
  });

  it("treats a delayed action as soft however hard the code looks", () => {
    const findings = readDeliveryReport({
      bodyText: "Final-Recipient: rfc822; slow@example.com\nAction: delayed\nStatus: 5.4.7\n",
    });
    expect(findings[0].kind).toBe("soft");
  });

  it("ignores a per-recipient success block", () => {
    const findings = readDeliveryReport({
      bodyText:
        "Final-Recipient: rfc822; ok@example.com\nAction: delivered\nStatus: 2.0.0\n\n" +
        "Final-Recipient: rfc822; gone@example.com\nAction: failed\nStatus: 5.1.1\n",
    });
    expect(findings.map((f) => f.address)).toEqual(["gone@example.com"]);
  });

  it("falls back to the non-standard header when there is no report part", () => {
    const findings = readDeliveryReport({
      subject: "Delivery Status Notification (Failure)",
      headers: { "X-Failed-Recipients": "nobody@example.com" },
      bodyText: "The following message could not be delivered. 550 5.1.1 user unknown",
    });
    expect(findings).toEqual([
      expect.objectContaining({ address: "nobody@example.com", kind: "hard" }),
    ]);
  });

  it("does not read a reply code out of an unrelated number", () => {
    expect(readSmtpCode("smtp; 550 5.1.1 rejected")).toBe(550);
    expect(readSmtpCode("Message size 553000 bytes exceeded")).toBeNull();
  });
});
