/**
 * Writing a ZIP archive — the other half of `@/lib/email/zip.pure`.
 *
 * A `.docx` is a ZIP of XML parts. Issuing a completed agreement means
 * opening the approved template with the existing reader, changing two or
 * three parts, and writing the package back out. That has to work inside a
 * Cloudflare Worker, so there is no filesystem, no native zlib binding and no
 * WebAssembly: compression is the platform's own
 * `CompressionStream("deflate-raw")`, the same primitive the reader inflates
 * with, and the checksum is computed here.
 *
 * Three decisions worth stating:
 *
 * **Every entry is rewritten, none is copied through.** Copying an unchanged
 * entry's compressed bytes would need its CRC from the central directory,
 * which the reader does not surface — and a stale CRC is a document Word
 * refuses to open ("unreadable content") with no hint as to why. Recomputing
 * from the inflated bytes costs milliseconds and makes the checksum a fact
 * about the bytes actually written.
 *
 * **Timestamps are fixed.** Every entry is stamped 1980-01-01 00:00, the
 * earliest DOS date. The archive is then a pure function of its entries, so
 * the same completed offer always produces the same bytes (and the same
 * SHA-256) — the issued-document hash means something rather than recording
 * the second it happened to be built in.
 *
 * **ZIP64 is refused rather than written.** A subscription agreement is a few
 * megabytes; an archive that needs ZIP64 is a bug upstream, and failing loudly
 * beats emitting a format some consumers mishandle.
 */

export type ZipWriteEntry = {
  name: string;
  data: Uint8Array;
  /** Deflate this entry. Ignored (stored instead) when deflating does not shrink it. */
  compress?: boolean;
};

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
/** 2.0 — deflate and directory entries. */
const VERSION = 20;
/** General-purpose flag bit 11: the name is UTF-8. */
const FLAG_UTF8 = 0x0800;
/** 1980-01-01, 00:00:00 in MS-DOS date/time form. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const DOS_TIME = 0;
const MAX_U32 = 0xffffffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3), as ZIP requires. */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === "undefined") {
    throw new Error("zip_writer_no_compression: this runtime has no CompressionStream");
  }
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

type Prepared = {
  nameBytes: Uint8Array;
  flags: number;
  method: 0 | 8;
  crc: number;
  payload: Uint8Array;
  size: number;
};

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7e) return false;
  return true;
}

/**
 * Build an archive from entries, in the order given.
 *
 * Order matters to some consumers — `[Content_Types].xml` conventionally
 * leads a package — so callers pass the template's own order through.
 */
export async function writeZip(entries: readonly ZipWriteEntry[]): Promise<Uint8Array> {
  if (entries.length > 0xfffe) throw new Error("zip_writer_too_many_entries");
  const seen = new Set<string>();
  const prepared: Prepared[] = [];

  for (const entry of entries) {
    if (!entry.name || entry.name.startsWith("/") || entry.name.includes("\\")) {
      throw new Error(`zip_writer_bad_name: ${JSON.stringify(entry.name)}`);
    }
    if (seen.has(entry.name)) throw new Error(`zip_writer_duplicate_name: ${entry.name}`);
    seen.add(entry.name);

    const size = entry.data.length;
    const crc = crc32(entry.data);
    let method: 0 | 8 = 0;
    let payload = entry.data;
    if (entry.compress && size > 0) {
      const deflated = await deflateRaw(entry.data);
      if (deflated.length < size) {
        method = 8;
        payload = deflated;
      }
    }
    if (size >= MAX_U32 || payload.length >= MAX_U32) {
      throw new Error(`zip_writer_entry_too_large: ${entry.name}`);
    }
    prepared.push({
      nameBytes: new TextEncoder().encode(entry.name),
      flags: isAscii(entry.name) ? 0 : FLAG_UTF8,
      method,
      crc,
      payload,
      size,
    });
  }

  const localTotal = prepared.reduce((n, p) => n + 30 + p.nameBytes.length + p.payload.length, 0);
  const centralTotal = prepared.reduce((n, p) => n + 46 + p.nameBytes.length, 0);
  if (localTotal + centralTotal + 22 >= MAX_U32) throw new Error("zip_writer_archive_too_large");

  const out = new Uint8Array(localTotal + centralTotal + 22);
  const dv = new DataView(out.buffer);
  const offsets: number[] = [];
  let at = 0;

  for (const p of prepared) {
    offsets.push(at);
    dv.setUint32(at, LOCAL_SIG, true);
    dv.setUint16(at + 4, VERSION, true);
    dv.setUint16(at + 6, p.flags, true);
    dv.setUint16(at + 8, p.method, true);
    dv.setUint16(at + 10, DOS_TIME, true);
    dv.setUint16(at + 12, DOS_DATE, true);
    dv.setUint32(at + 14, p.crc, true);
    dv.setUint32(at + 18, p.payload.length, true);
    dv.setUint32(at + 22, p.size, true);
    dv.setUint16(at + 26, p.nameBytes.length, true);
    dv.setUint16(at + 28, 0, true);
    out.set(p.nameBytes, at + 30);
    out.set(p.payload, at + 30 + p.nameBytes.length);
    at += 30 + p.nameBytes.length + p.payload.length;
  }

  const centralStart = at;
  prepared.forEach((p, i) => {
    dv.setUint32(at, CENTRAL_SIG, true);
    dv.setUint16(at + 4, VERSION, true);
    dv.setUint16(at + 6, VERSION, true);
    dv.setUint16(at + 8, p.flags, true);
    dv.setUint16(at + 10, p.method, true);
    dv.setUint16(at + 12, DOS_TIME, true);
    dv.setUint16(at + 14, DOS_DATE, true);
    dv.setUint32(at + 16, p.crc, true);
    dv.setUint32(at + 20, p.payload.length, true);
    dv.setUint32(at + 24, p.size, true);
    dv.setUint16(at + 28, p.nameBytes.length, true);
    dv.setUint16(at + 30, 0, true); // extra
    dv.setUint16(at + 32, 0, true); // comment
    dv.setUint16(at + 34, 0, true); // disk
    dv.setUint16(at + 36, 0, true); // internal attributes
    dv.setUint32(at + 38, 0, true); // external attributes
    dv.setUint32(at + 42, offsets[i], true);
    out.set(p.nameBytes, at + 46);
    at += 46 + p.nameBytes.length;
  });

  const centralSize = at - centralStart;
  dv.setUint32(at, EOCD_SIG, true);
  dv.setUint16(at + 4, 0, true);
  dv.setUint16(at + 6, 0, true);
  dv.setUint16(at + 8, prepared.length, true);
  dv.setUint16(at + 10, prepared.length, true);
  dv.setUint32(at + 12, centralSize, true);
  dv.setUint32(at + 16, centralStart, true);
  dv.setUint16(at + 20, 0, true);

  return out;
}
