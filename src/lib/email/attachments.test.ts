// What a campaign may attach and how each message travels. Every rule here is
// one whose failure is seen by a recipient rather than by an operator: an
// executable that a gateway quarantines, a broken inline image, a message too
// large for one request that Graph refuses, an upload range Graph rejects.
import { describe, expect, it } from "vitest";
import {
  MAX_ATTACHMENTS_PER_CAMPAIGN,
  MAX_CAMPAIGN_ATTACHMENT_BYTES,
  SENDMAIL_REQUEST_LIMIT_BYTES,
  UPLOAD_CHUNK_BYTES,
  admissionProblem,
  attachmentReadiness,
  base64Length,
  blockedReason,
  bytesToBase64,
  contentIdFor,
  contentTypeFor,
  deliveryPath,
  estimateSendMailBytes,
  fileExtension,
  isInline,
  likelyDeliveryPath,
  messagesPerFiveMinutes,
  previewInlineImages,
  referencedContentIds,
  safeObjectName,
  sha256Hex,
  uploadRanges,
} from "./attachments.pure";

const MB = 1024 * 1024;

describe("blockedReason", () => {
  it("allows the documents a campaign actually sends", () => {
    for (const name of ["Brochure.pdf", "price list.xlsx", "photo.JPG", "notes", "a.b.docx"]) {
      expect(blockedReason(name), name).toBeNull();
    }
  });

  it("refuses executables and scripts, reading the LAST extension", () => {
    for (const name of ["setup.exe", "invoice.pdf.exe", "run.BAT", "x.ps1", "image.iso", "a.js"]) {
      expect(blockedReason(name), name).toMatch(/blocked by Outlook/);
    }
  });

  it("refuses a nameless or absurdly long file", () => {
    expect(blockedReason("")).toMatch(/no name/);
    expect(blockedReason(`${"a".repeat(260)}.pdf`)).toMatch(/255/);
  });
});

describe("fileExtension", () => {
  it("is empty for a dotfile or a trailing dot, not the whole name", () => {
    expect(fileExtension(".env")).toBe("");
    expect(fileExtension("report.")).toBe("");
    expect(fileExtension("dir/report.PDF")).toBe("pdf");
  });
});

describe("contentTypeFor", () => {
  it("keeps a useful browser label", () => {
    expect(contentTypeFor("x.bin", "image/png")).toBe("image/png");
  });

  it("names the type from the extension when the browser could not", () => {
    expect(contentTypeFor("brochure.pdf", "")).toBe("application/pdf");
    expect(contentTypeFor("brochure.pdf", "application/octet-stream")).toBe("application/pdf");
    expect(contentTypeFor("sheet.xlsx", null)).toMatch(/spreadsheetml/);
  });

  it("falls back to octet-stream rather than guessing, and ignores a malformed label", () => {
    expect(contentTypeFor("mystery.qqq")).toBe("application/octet-stream");
    expect(contentTypeFor("brochure.pdf", "not a type; x=<y>")).toBe("application/pdf");
  });
});

describe("safeObjectName", () => {
  it("keeps the extension and drops path-like characters", () => {
    expect(safeObjectName("My Report (final).pdf")).toBe("My_Report_final_.pdf");
    expect(safeObjectName("../../etc/passwd")).toBe("etc_passwd");
    expect(safeObjectName("")).toBe("file");
  });

  it("shortens a long name without losing the extension", () => {
    const name = safeObjectName(`${"x".repeat(300)}.docx`);
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name.endsWith(".docx")).toBe(true);
  });
});

describe("contentIdFor", () => {
  it("derives a guessable id the column's CHECK admits", () => {
    expect(contentIdFor("Logo Large.PNG")).toBe("logo-large.png");
    expect(contentIdFor("--Header--.jpg")).toBe("header-.jpg");
    expect(contentIdFor("###")).toBe("attachment");
    for (const id of [contentIdFor("Ünïcode name!.gif"), contentIdFor("a".repeat(200))]) {
      expect(id).toMatch(/^[a-z0-9][a-z0-9._-]{0,99}$/);
    }
  });

  it("is unique against the campaign's other files", () => {
    expect(contentIdFor("logo.png", ["logo.png"])).toBe("logo.png-2");
    expect(contentIdFor("logo.png", ["LOGO.PNG", "logo.png-2"])).toBe("logo.png-3");
  });
});

describe("inline detection", () => {
  const body = '<p><img src="cid:logo.png" alt=""> and <img src=\'CID:Banner.jpg\'></p>';

  it("finds every cid the body shows, case-folded", () => {
    expect([...referencedContentIds(body)].sort()).toEqual(["banner.jpg", "logo.png"]);
  });

  it("does not take a sentence's full stop as part of the id", () => {
    expect([...referencedContentIds("see cid:logo.png.")]).toEqual(["logo.png"]);
  });

  it("is inline only when an HTML body refers to it", () => {
    expect(isInline("logo.png", body, "html")).toBe(true);
    expect(isInline("brochure.pdf", body, "html")).toBe(false);
    // A plain-text body cannot show an image, so nothing in it is inline.
    expect(isInline("logo.png", body, "text")).toBe(false);
  });
});

describe("delivery path", () => {
  it("measures base64, which is a third larger than the file", () => {
    expect(base64Length(0)).toBe(0);
    expect(base64Length(1)).toBe(4);
    expect(base64Length(3)).toBe(4);
    expect(base64Length(3 * MB)).toBe(4 * MB);
  });

  it("sends small files in one sendMail and large ones through a draft", () => {
    const small = estimateSendMailBytes(5_000, [{ size: 1 * MB, name: "a.pdf" }]);
    expect(deliveryPath(small, 1)).toBe("sendmail");
    // 2.9 MB of file is just under 3.9 MB of base64 — over the line once the
    // body is counted, which is why the decision is made on the estimate.
    const heavy = estimateSendMailBytes(200_000, [{ size: 2.9 * MB, name: "a.pdf" }]);
    expect(heavy).toBeGreaterThan(SENDMAIL_REQUEST_LIMIT_BYTES);
    expect(deliveryPath(heavy, 1)).toBe("draft");
  });

  it("never takes the draft path for a message with no files", () => {
    expect(deliveryPath(10 * MB, 0)).toBe("sendmail");
  });

  it("guesses conservatively for the page", () => {
    expect(likelyDeliveryPath(500_000, 1, 2_000)).toBe("sendmail");
    expect(likelyDeliveryPath(3 * MB, 1, 2_000)).toBe("draft");
  });
});

describe("uploadRanges", () => {
  it("covers every byte once, in order, with inclusive ends", () => {
    const size = UPLOAD_CHUNK_BYTES * 2 + 17;
    const ranges = uploadRanges(size);
    expect(ranges).toEqual([
      { start: 0, end: UPLOAD_CHUNK_BYTES - 1 },
      { start: UPLOAD_CHUNK_BYTES, end: UPLOAD_CHUNK_BYTES * 2 - 1 },
      { start: UPLOAD_CHUNK_BYTES * 2, end: size - 1 },
    ]);
  });

  it("keeps every PUT under Graph's 4 MB", () => {
    expect(UPLOAD_CHUNK_BYTES).toBeLessThan(4 * MB);
    expect(UPLOAD_CHUNK_BYTES % (320 * 1024)).toBe(0);
  });

  it("is empty for nothing", () => {
    expect(uploadRanges(0)).toEqual([]);
    expect(uploadRanges(Number.NaN)).toEqual([]);
  });
});

describe("bytesToBase64", () => {
  it("matches the platform encoder, including across slice boundaries", () => {
    const bytes = new Uint8Array(0x8000 * 2 + 5).map((_, i) => (i * 31) % 256);
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    expect(bytesToBase64(new Uint8Array())).toBe("");
  });
});

describe("sha256Hex", () => {
  it("is the standard digest", async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("admissionProblem", () => {
  it("admits a file that fits", () => {
    expect(admissionProblem({ fileName: "a.pdf", sizeBytes: MB }, [])).toBeNull();
  });

  it("refuses an empty file, a blocked type, an eleventh file and a total over the ceiling", () => {
    expect(admissionProblem({ fileName: "a.pdf", sizeBytes: 0 }, [])).toMatch(/empty/);
    expect(admissionProblem({ fileName: "a.exe", sizeBytes: 10 }, [])).toMatch(/blocked/);
    const ten = Array.from({ length: MAX_ATTACHMENTS_PER_CAMPAIGN }, () => ({ sizeBytes: 1 }));
    expect(admissionProblem({ fileName: "a.pdf", sizeBytes: 1 }, ten)).toMatch(/at most/);
    expect(
      admissionProblem({ fileName: "a.pdf", sizeBytes: MAX_CAMPAIGN_ATTACHMENT_BYTES }, [
        { sizeBytes: 1 },
      ]),
    ).toMatch(/ceiling/);
  });
});

describe("messagesPerFiveMinutes", () => {
  it("is bounded by the gap when there is one, and by the tick cap otherwise", () => {
    expect(messagesPerFiveMinutes({ minGapSeconds: 60, maxMessagesPerRun: 20 })).toBe(5);
    expect(messagesPerFiveMinutes({ minGapSeconds: 5, maxMessagesPerRun: 20 })).toBe(60);
    expect(messagesPerFiveMinutes({ minGapSeconds: 0, maxMessagesPerRun: 20 })).toBe(100);
    expect(messagesPerFiveMinutes({ minGapSeconds: 3600, maxMessagesPerRun: 20 })).toBe(1);
  });
});

describe("attachmentReadiness", () => {
  const base = {
    body: "<p>Hello</p>",
    bodyFormat: "html",
    minGapSeconds: 60,
    maxMessagesPerRun: 20,
    canBuildDrafts: true as boolean | null,
  };
  const file = (contentId: string, sizeBytes: number, fileName = contentId) => ({
    contentId,
    fileName,
    sizeBytes,
    contentType: "application/pdf",
  });

  it("says nothing about a campaign with no files", () => {
    const result = attachmentReadiness({ ...base, attachments: [] });
    expect(result).toMatchObject({ blocking: [], warnings: [], totalBytes: 0, path: "sendmail" });
  });

  it("blocks a body that shows an image nobody attached", () => {
    const result = attachmentReadiness({
      ...base,
      body: '<img src="cid:logo.png">',
      attachments: [file("brochure.pdf", 1000)],
    });
    expect(result.blocking.join(" ")).toMatch(/cid:logo\.png.*broken image/);
  });

  it("accepts a body whose inline image is attached", () => {
    const result = attachmentReadiness({
      ...base,
      body: '<img src="cid:logo.png">',
      attachments: [file("logo.png", 1000)],
    });
    expect(result.blocking).toEqual([]);
  });

  it("blocks a total over the ceiling", () => {
    const result = attachmentReadiness({
      ...base,
      attachments: [file("a.pdf", MAX_CAMPAIGN_ATTACHMENT_BYTES), file("b.pdf", 10)],
    });
    expect(result.blocking.join(" ")).toMatch(/over the 20 MB/);
  });

  it("warns that a large message needs Mail.ReadWrite, and louder when the token lacks it", () => {
    const granted = attachmentReadiness({ ...base, attachments: [file("a.pdf", 5 * MB)] });
    expect(granted.path).toBe("draft");
    expect(granted.blocking).toEqual([]);
    expect(granted.warnings.join(" ")).toMatch(/built as a draft/);

    const missing = attachmentReadiness({
      ...base,
      canBuildDrafts: false,
      attachments: [file("a.pdf", 5 * MB)],
    });
    expect(missing.warnings.join(" ")).toMatch(/does not carry.*pause/);
  });

  it("warns when the rules would outrun Microsoft's per-mailbox upload allowance", () => {
    const result = attachmentReadiness({
      ...base,
      minGapSeconds: 0,
      attachments: [file("a.pdf", 8 * MB)],
    });
    expect(result.warnings.join(" ")).toMatch(/throttle/);
    const gentle = attachmentReadiness({
      ...base,
      minGapSeconds: 120,
      attachments: [file("a.pdf", 1 * MB)],
    });
    expect(gentle.warnings.join(" ")).not.toMatch(/throttle/);
  });

  it("warns that a plain-text body cannot show its cid images", () => {
    const result = attachmentReadiness({
      ...base,
      bodyFormat: "text",
      body: "see cid:logo.png",
      attachments: [file("logo.png", 1000)],
    });
    expect(result.blocking).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/plain text/);
  });
});

describe("previewInlineImages", () => {
  it("swaps a known cid for a loadable URL, escaped for an attribute", () => {
    const urls = new Map([["logo.png", "https://x.test/a?token=1&b=2"]]);
    expect(previewInlineImages('<img src="cid:logo.png">', urls)).toBe(
      '<img src="https://x.test/a?token=1&amp;b=2">',
    );
  });

  it("leaves an unknown cid alone", () => {
    expect(previewInlineImages('<img src="cid:other.png">', new Map())).toBe(
      '<img src="cid:other.png">',
    );
  });
});
