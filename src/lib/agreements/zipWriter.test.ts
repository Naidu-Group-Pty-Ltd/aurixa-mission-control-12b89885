import { describe, expect, it } from "vitest";
import { readCentralDirectory, readZipEntry } from "@/lib/email/zip.pure";
import { crc32, writeZip } from "./zipWriter.pure";

const enc = new TextEncoder();

describe("crc32", () => {
  it("matches the standard check value", () => {
    expect(crc32(enc.encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe("writeZip", () => {
  it("writes an archive the platform's own reader opens, entry for entry", async () => {
    const xml = enc.encode(`<?xml version="1.0"?><root>${"<a>repeat</a>".repeat(500)}</root>`);
    const image = crypto.getRandomValues(new Uint8Array(2048));
    const bytes = await writeZip([
      { name: "[Content_Types].xml", data: xml, compress: true },
      { name: "word/media/image1.png", data: image },
      { name: "word/naïve.xml", data: enc.encode("<x/>"), compress: true },
      { name: "empty.txt", data: new Uint8Array(), compress: true },
    ]);

    const entries = readCentralDirectory(bytes);
    expect(entries.map((e) => e.name)).toEqual([
      "[Content_Types].xml",
      "word/media/image1.png",
      "word/naïve.xml",
      "empty.txt",
    ]);
    expect(entries[0].method).toBe(8);
    expect(entries[0].compressedSize).toBeLessThan(xml.length);
    expect(entries[1].method).toBe(0);
    expect(await readZipEntry(bytes, entries[0])).toEqual(xml);
    expect(await readZipEntry(bytes, entries[1])).toEqual(image);
    expect(new TextDecoder().decode(await readZipEntry(bytes, entries[2]))).toBe("<x/>");
    expect((await readZipEntry(bytes, entries[3])).length).toBe(0);
  });

  it("stores an entry that deflating would enlarge", async () => {
    const noise = crypto.getRandomValues(new Uint8Array(4096));
    const bytes = await writeZip([{ name: "noise.bin", data: noise, compress: true }]);
    const [entry] = readCentralDirectory(bytes);
    expect(entry.method).toBe(0);
    expect(await readZipEntry(bytes, entry)).toEqual(noise);
  });

  it("is a pure function of its entries", async () => {
    const entries = [
      { name: "a.xml", data: enc.encode("<a>one</a>".repeat(100)), compress: true },
      { name: "b.bin", data: new Uint8Array([1, 2, 3]) },
    ];
    expect(await writeZip(entries)).toEqual(await writeZip(entries));
  });

  it("refuses names a package must not contain", async () => {
    const data = new Uint8Array([1]);
    await expect(writeZip([{ name: "/abs.xml", data }])).rejects.toThrow(/bad_name/);
    await expect(writeZip([{ name: "word\\doc.xml", data }])).rejects.toThrow(/bad_name/);
    await expect(writeZip([{ name: "", data }])).rejects.toThrow(/bad_name/);
    await expect(
      writeZip([
        { name: "a.xml", data },
        { name: "a.xml", data },
      ]),
    ).rejects.toThrow(/duplicate_name/);
  });
});
