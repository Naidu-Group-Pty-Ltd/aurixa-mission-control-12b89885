// What warmup mail says: varied, plausible, and free of everything a filter
// looks harder at.
import { describe, expect, it } from "vitest";
import {
  composeWarmupMessage,
  composeWarmupReply,
  firstNameFor,
  prependToReplyBody,
  seededRandom,
} from "./warmupContent.pure";

// Words and shapes a warmup message must never contain.
const SPAMMY =
  /https?:|www\.|\$|%|free\b|guarantee|winner|urgent|act now|click|buy|offer|discount|credit|money|cash|unsubscribe|!!/i;

describe("seededRandom", () => {
  it("is deterministic per seed, in [0, 1), and differs between seeds", () => {
    const a = seededRandom("seed");
    const b = seededRandom("seed");
    const values = Array.from({ length: 1000 }, () => a());
    expect(values).toEqual(Array.from({ length: 1000 }, () => b()));
    expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(seededRandom("other")()).not.toBe(values[0]);
  });
});

describe("composeWarmupMessage", () => {
  const messages = Array.from({ length: 400 }, (_, i) =>
    composeWarmupMessage({
      seed: `seed-${i}`,
      senderName: "Alex",
      recipientName: i % 3 === 0 ? null : "Sam",
      localHour: i % 24,
    }),
  );

  it("is the same message for the same seed", () => {
    const input = { seed: "x", senderName: "Alex", recipientName: "Sam", localHour: 10 };
    expect(composeWarmupMessage(input)).toEqual(composeWarmupMessage(input));
  });

  it("varies", () => {
    expect(new Set(messages.map((m) => m.subject)).size).toBeGreaterThan(60);
    expect(new Set(messages.map((m) => m.text)).size).toBe(messages.length);
  });

  it("leaves nothing unfilled and nothing a filter would dwell on", () => {
    for (const message of messages) {
      const all = `${message.subject}\n${message.text}\n${message.html}`;
      expect(all).not.toMatch(/[{}]/);
      expect(all).not.toMatch(SPAMMY);
      expect(message.html).not.toMatch(/<a\b|<img\b|<script/i);
      expect(message.subject.length).toBeLessThan(80);
      // Sentences start with a capital.
      expect(message.subject[0]).toBe(message.subject[0].toUpperCase());
    }
  });

  it("greets by name when there is one, and signs off with the sender's", () => {
    const named = messages.filter((_, i) => i % 3 !== 0);
    expect(named.every((m) => m.text.split("\n")[0].includes("Sam"))).toBe(true);
    const anonymous = messages.filter((_, i) => i % 3 === 0);
    expect(anonymous.every((m) => !m.text.includes("Sam"))).toBe(true);
    expect(messages.every((m) => m.text.trimEnd().endsWith("Alex"))).toBe(true);
  });

  it("only says good morning in the morning", () => {
    const afternoon = messages.filter((_, i) => i % 24 >= 11);
    expect(afternoon.some((m) => /morning/i.test(m.text.split("\n")[0]))).toBe(false);
  });

  it("escapes what it is given", () => {
    const message = composeWarmupMessage({
      seed: "x",
      senderName: "<b>Alex</b>",
      recipientName: null,
    });
    expect(message.html).toContain("&lt;b&gt;Alex&lt;/b&gt;");
    expect(message.html).not.toContain("<b>");
  });
});

describe("composeWarmupReply", () => {
  it("is short, filled in, and signed", () => {
    for (let i = 0; i < 300; i++) {
      const reply = composeWarmupReply({
        seed: `r-${i}`,
        senderName: "Sam",
        recipientName: i % 2 ? "Alex" : null,
        depth: 1 + (i % 2),
      });
      expect(reply.text).not.toMatch(/[{}]/);
      expect(reply.text).not.toMatch(SPAMMY);
      expect(reply.text.trimEnd().endsWith("Sam")).toBe(true);
      expect(reply.text.length).toBeLessThan(220);
    }
  });
});

describe("firstNameFor", () => {
  it("finds a person's first name, and declines for a shared mailbox", () => {
    expect(firstNameFor("Sam Jones", "x@y.test")).toBe("Sam");
    expect(firstNameFor("Jones, Sam", "x@y.test")).toBe("Sam");
    expect(firstNameFor("sam", "x@y.test")).toBe("Sam");
    expect(firstNameFor("Sales Team", "x@y.test")).toBeNull();
    expect(firstNameFor("NPC Services", "x@y.test")).toBeNull();
    expect(firstNameFor(null, "sam.jones@y.test")).toBe("Sam");
    expect(firstNameFor(null, "info@y.test")).toBeNull();
    expect(firstNameFor(null, "support.team@y.test")).toBeNull();
  });
});

describe("prependToReplyBody", () => {
  it("writes the reply inside the body, above the quoted message", () => {
    const draft = '<html><head></head><body dir="ltr"><hr><p>From: Alex</p></body></html>';
    expect(prependToReplyBody("<p>Thanks</p>", draft)).toBe(
      '<html><head></head><body dir="ltr"><div><p>Thanks</p></div><hr><p>From: Alex</p></body></html>',
    );
    expect(prependToReplyBody("<p>Thanks</p>", "<p>quoted</p>")).toBe(
      "<div><p>Thanks</p></div><p>quoted</p>",
    );
    expect(prependToReplyBody("<p>Thanks</p>", null)).toBe("<div><p>Thanks</p></div>");
  });
});
