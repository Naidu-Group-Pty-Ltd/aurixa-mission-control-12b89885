/**
 * The kept-spec channel reads prime's side and the clone's side of each hop
 * at once, and still reads a blob the two share only once.
 *
 * Structural — the order of awaits inside `processClone` — so asserted against
 * the source. The two sides used to take turns, prime first so the clone could
 * skip the blobs they share. That cost the pass to `npc-crm-independent-6505dc`
 * two of its four channel round trips, about four seconds of a 45-second tick,
 * on a two-hop walk. The dedupe survives because the clone's side leaves out
 * every blob prime's side is asking in the same round, and `readTexts` answers
 * every path it is asked or throws. So prime's answers are in hand before the
 * clone's paths are judged, exactly as when the sides took turns.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../sourceComments.pure";

const engine = stripComments(
  readFileSync(join(process.cwd(), "src/server/cascade-engine.server.ts"), "utf8"),
);
const hopStart = engine.indexOf("for (let hop = 0; hop <= MAX_SHIM_HOPS; hop += 1) {");
const hopEnd = engine.indexOf("for (const spec of kept) {\n          const subjects", hopStart);
const hop = engine.slice(hopStart, hopEnd);

describe("the kept-spec channel's hop", () => {
  it("is found", () => {
    expect(hopStart).toBeGreaterThan(-1);
    expect(hopEnd).toBeGreaterThan(hopStart);
  });

  it("reads both sides in one round", () => {
    expect(hop).toMatch(/await Promise\.all\(\s*\(\["prime", "clone"\] as const\)\.map\(/);
    // No read awaited one side at a time.
    expect(hop).not.toMatch(/\? await readTexts\(/);
  });

  it("has the clone skip every blob prime is asking, so a shared blob is read once", () => {
    expect(hop).toMatch(/const primeAsking = askingOf\("prime", new Set\(\)\);/);
    expect(hop).toMatch(/clone: askingOf\("clone", primeAskingShas\)/);
    expect(hop).toMatch(/!textBySha\.has\(sha\) && !alsoSkip\.has\(sha\)/);
  });

  it("absorbs prime's answers before judging the clone's paths", () => {
    const readAt = hop.indexOf("await Promise.all(");
    const absorbAt = hop.indexOf('for (const side of ["prime", "clone"] as const) {', readAt);
    expect(absorbAt).toBeGreaterThan(readAt);
    expect(hop.slice(absorbAt)).toMatch(
      /if \(sha !== undefined && text !== undefined\) textBySha\.set\(sha, text\);/,
    );
  });
});
