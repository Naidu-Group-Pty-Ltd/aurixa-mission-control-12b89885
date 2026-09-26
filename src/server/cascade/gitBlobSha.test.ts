import { describe, expect, it } from "vitest";
import { gitBlobSha } from "./gitBlobSha.pure";

/**
 * Every expected id below was produced by `git hash-object --stdin` on the same
 * bytes, so these pin git's own answer rather than this module's opinion of it.
 */
describe("gitBlobSha — the id git gives a blob, without asking git", () => {
  it("is git's id for the empty blob", () => {
    expect(gitBlobSha("")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });

  it("is git's id for a line of text", () => {
    expect(gitBlobSha("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it("counts BYTES, not characters, so a file with non-ASCII text still matches", () => {
    // 15 characters, 20 bytes in UTF-8. A character count in the header would
    // name a different blob, and every comparison against the clone's tree
    // would read as a change.
    const text = "café — déjà vu\n";
    expect(text.length).not.toBe(Buffer.byteLength(text, "utf8"));
    expect(gitBlobSha(text)).toBe("01433143e65f9c09c66792a4305a71693fb65d6c");
  });

  it("is git's id for the shape a reconcile pump writes", () => {
    expect(gitBlobSha('{\n  "a": 1\n}\n')).toBe("8d6b85c7b3f97652ab7fdfdf53f3dd2b6dc3ccef");
  });

  it("tells a text from the same text with one byte changed", () => {
    expect(gitBlobSha('{\n  "a": 1\n}\n')).not.toBe(gitBlobSha('{\n  "a": 2\n}\n'));
    // Trailing newline included: a pump that drops one has changed the file.
    expect(gitBlobSha("hello\n")).not.toBe(gitBlobSha("hello"));
  });
});
