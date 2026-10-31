/**
 * A schema is not recorded as verified when the prime's ledger moved while the
 * pass walked its catalogue.
 *
 * The stamp reads the prime's ledger at the END of the pass. A migration the
 * prime recorded while the catalogue was being walked was stamped onto the
 * clone as run, the walk may have read the catalogue before its objects
 * existed, and `schema_verified_at` then made every later pass skip
 * introspection — so the fleet lane, which never sends a version the clone's
 * ledger holds, could never carry it either.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { primeLedgerMoved } from "./schema-introspection.server";
import { stripComments } from "./sourceComments.pure";

describe("primeLedgerMoved", () => {
  const before = { count: 1175, top: "20270213140000" };

  it("an unchanged ledger has not moved", () => {
    expect(primeLedgerMoved(before, { count: 1175, top: "20270213140000" })).toBe(false);
  });

  it("a new version on top has moved", () => {
    expect(primeLedgerMoved(before, { count: 1176, top: "20270214090000" })).toBe(true);
  });

  it("a version recorded below the top has moved, though the top is the same", () => {
    // The prime's ledger holes get recorded behind its head.
    expect(primeLedgerMoved(before, { count: 1176, top: "20270213140000" })).toBe(true);
  });

  it("an unreadable mark says nothing, so verification is never refused for ever", () => {
    expect(primeLedgerMoved(null, { count: 1176, top: "20270214090000" })).toBe(false);
  });
});

describe("the pipeline checks the mark before it records the schema verified", () => {
  const src = stripComments(
    readFileSync(join(process.cwd(), "src/server/backend-provisioning.server.ts"), "utf8"),
  );
  const body = src.slice(src.indexOf("export async function provisionCloneBackend"));

  it("takes the mark before the catalogue walk", () => {
    const markAt = body.indexOf("const ledgerBeforeWalk = await readPrimeLedgerMark(primeRef);");
    const walkAt = body.indexOf("await replicateSchemaByIntrospection(projectRef");
    expect(markAt).toBeGreaterThan(-1);
    expect(walkAt).toBeGreaterThan(markAt);
  });

  it("compares it with the stamp's reading, and pauses unverified when it moved", () => {
    const stampAt = body.indexOf("await stampMigrationLedgerFromPrime(projectRef, primeRef)");
    const checkAt = body.indexOf("primeLedgerMoved(ledgerBeforeWalk", stampAt);
    const verifiedAt = body.indexOf("await input.onSchemaVerified?.();", stampAt);
    expect(stampAt).toBeGreaterThan(-1);
    expect(checkAt).toBeGreaterThan(stampAt);
    expect(verifiedAt).toBeGreaterThan(checkAt);
    // An EMPTY resume stage: the next pass walks from the first stage.
    expect(body.slice(checkAt, verifiedAt)).toMatch(/throw new BudgetPause\([\s\S]*?"",\s*\);/);
  });
});
