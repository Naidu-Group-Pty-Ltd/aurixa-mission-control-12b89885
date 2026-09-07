/**
 * Just enough of the ZIP container to open a spreadsheet.
 *
 * An `.xlsx` is a ZIP of XML parts, so reading one starts here. Two decisions
 * worth stating:
 *
 * **The central directory is read, never the local headers alone.** Streaming
 * a ZIP front-to-back works only when every local header carries its sizes,
 * and a workbook written by a streaming producer sets the "sizes follow the
 * data" flag and leaves them zero. The central directory at the end of the
 * file is the authoritative index and always has them.
 *
 * **ZIP64 is handled.** Above 65,535 entries or 4 GiB the classic fields hold
 * sentinel values and the real numbers live in an extra field. A workbook with
 * a few hundred thousand rows crosses neither threshold — but a workbook whose
 * producer wrote ZIP64 unconditionally (several do) is otherwise read as
 * having its central directory at offset 4294967295, which fails as "not a
 * zip file" on a file that is perfectly valid.
 *
 * Inflation is `DecompressionStream("deflate-raw")` — the platform's own,
 * present in every browser this console supports and in the Workers runtime,
 * so there is no inflate implementation here to get wrong.
 */

export type ZipEntry = {
  name: string;
  /** 0 = stored, 8 = deflate. Anything else is refused at read time. */
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

const EOCD_SIG = 0x06054b50;
const EOCD64_SIG = 0x06064b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** A 64-bit field, narrowed to a JS number. Sizes here are far below 2^53. */
function u64(dv: DataView, at: number): number {
  const value = dv.getBigUint64(at, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ZipError("archive declares a size this reader cannot address");
  }
  return Number(value);
}

/** Locate the end-of-central-directory record by scanning back from the tail. */
function findEocd(bytes: Uint8Array): number {
  const dv = view(bytes);
  // 22 bytes fixed, plus a comment of at most 65,535.
  const earliest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let at = bytes.length - 22; at >= earliest; at--) {
    if (dv.getUint32(at, true) === EOCD_SIG) return at;
  }
  throw new ZipError("not a zip archive — no end-of-central-directory record");
}

export function readCentralDirectory(bytes: Uint8Array): ZipEntry[] {
  if (bytes.length < 22) throw new ZipError("file is too small to be a zip archive");
  const dv = view(bytes);
  const eocd = findEocd(bytes);

  let entryCount = dv.getUint16(eocd + 10, true);
  let directoryOffset = dv.getUint32(eocd + 16, true);

  // ZIP64: the classic fields are sentinels and the real ones are in a second
  // record, found through a locator that sits immediately before the EOCD.
  if (entryCount === 0xffff || directoryOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator >= 0 && dv.getUint32(locator, true) === EOCD64_LOCATOR_SIG) {
      const eocd64 = u64(dv, locator + 8);
      if (eocd64 >= 0 && eocd64 + 56 <= bytes.length && dv.getUint32(eocd64, true) === EOCD64_SIG) {
        entryCount = u64(dv, eocd64 + 32);
        directoryOffset = u64(dv, eocd64 + 48);
      }
    }
  }

  const entries: ZipEntry[] = [];
  let at = directoryOffset;
  for (let i = 0; i < entryCount; i++) {
    if (at + 46 > bytes.length || dv.getUint32(at, true) !== CENTRAL_SIG) {
      throw new ZipError(`central directory entry ${i + 1} of ${entryCount} is malformed`);
    }
    const method = dv.getUint16(at + 10, true);
    let compressedSize = dv.getUint32(at + 20, true);
    let uncompressedSize = dv.getUint32(at + 24, true);
    const nameLength = dv.getUint16(at + 28, true);
    const extraLength = dv.getUint16(at + 30, true);
    const commentLength = dv.getUint16(at + 32, true);
    let localHeaderOffset = dv.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));

    // ZIP64 extra field (header id 0x0001): the values it carries are exactly
    // those the fixed fields set to their sentinel, in this order.
    if (
      uncompressedSize === 0xffffffff ||
      compressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      let extraAt = at + 46 + nameLength;
      const extraEnd = extraAt + extraLength;
      while (extraAt + 4 <= extraEnd) {
        const headerId = dv.getUint16(extraAt, true);
        const size = dv.getUint16(extraAt + 2, true);
        let field = extraAt + 4;
        if (headerId === 0x0001) {
          if (uncompressedSize === 0xffffffff) {
            uncompressedSize = u64(dv, field);
            field += 8;
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = u64(dv, field);
            field += 8;
          }
          if (localHeaderOffset === 0xffffffff) {
            localHeaderOffset = u64(dv, field);
            field += 8;
          }
          break;
        }
        extraAt += 4 + size;
      }
    }

    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    at += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/**
 * The bytes of one entry.
 *
 * The local header's extra field is read rather than the central directory's:
 * they are allowed to differ, and using the wrong one starts the read a few
 * bytes into (or before) the compressed stream, which inflates to garbage
 * rather than failing.
 */
export async function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const dv = view(bytes);
  const at = entry.localHeaderOffset;
  if (at + 30 > bytes.length || dv.getUint32(at, true) !== LOCAL_SIG) {
    throw new ZipError(`entry "${entry.name}" has no local header where the index says`);
  }
  const nameLength = dv.getUint16(at + 26, true);
  const extraLength = dv.getUint16(at + 28, true);
  const start = at + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > bytes.length) throw new ZipError(`entry "${entry.name}" runs past the end of the file`);

  const payload = bytes.subarray(start, end);
  if (entry.method === 0) return payload;
  if (entry.method !== 8) {
    throw new ZipError(
      `entry "${entry.name}" uses compression method ${entry.method}, which this reader does not implement`,
    );
  }
  if (typeof DecompressionStream === "undefined") {
    throw new ZipError(
      "this browser cannot decompress the workbook — save the list as CSV and upload that instead",
    );
  }

  const stream = new Blob([payload as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  const inflated = new Uint8Array(await new Response(stream).arrayBuffer());
  return inflated;
}

/** Read one entry as UTF-8 text, or null when the archive does not hold it. */
export async function readZipText(
  bytes: Uint8Array,
  entries: ZipEntry[],
  name: string,
): Promise<string | null> {
  const wanted = name.toLowerCase();
  const entry = entries.find((e) => e.name.toLowerCase() === wanted);
  if (!entry) return null;
  return new TextDecoder().decode(await readZipEntry(bytes, entry));
}
