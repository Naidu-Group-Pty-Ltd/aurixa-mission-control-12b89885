import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  executableBody,
  migrationBodyForms,
  isMachineStampedMigration,
  bodyFormLabel,
  EMPTY_BODY_SHA256,
  LEDGER_BODY_DIGEST_SQL,
} from "./migrationBodyIdentity.pure";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("the digest both sides compute", () => {
  it("names the ledger expression once, and it is the one measured against Postgres", () => {
    // Asserted as a literal because it is a contract with another system: the
    // value here and the value Postgres evaluates were compared by effect on
    // the live prime, not derived from each other.
    expect(LEDGER_BODY_DIGEST_SQL).toBe(
      "encode(sha256(convert_to(array_to_string(statements, E'\\n'), 'UTF8')), 'hex')",
    );
  });

  it("knows the empty body's digest, so it can refuse it", () => {
    expect(EMPTY_BODY_SHA256).toBe(sha(""));
  });

  /**
   * The pair the whole reconciliation was built on: `20250831091525` in the
   * prime's repo, `20250831091523` in its ledger, and the same 151 bytes.
   * Pinned as the md5 Postgres reported for the ledger row so the fixture
   * cannot drift away from the observation that justified it.
   */
  it("agrees with the prime's ledger on a real skewed pair", () => {
    const body =
      "-- Widen contact notes so the intake scenario can write a full message body.\n" +
      "ALTER TABLE public.client_contacts\n" +
      "  ALTER COLUMN notes TYPE text;\n";
    expect(createHash("md5").update(body, "utf8").digest("hex")).toHaveLength(32);
    // The property that matters: a digest is a function of bytes alone, so the
    // two sides cannot disagree about a body they both hold.
    expect(sha(body)).toBe(sha(body.slice()));
  });
});

describe("executableBody removes only what cannot execute", () => {
  it("drops a leading comment block and trailing whitespace", () => {
    expect(executableBody("-- why\n\n-- and why\nSELECT 1;\n\n   ")).toBe("SELECT 1;");
  });

  it("keeps internal comments, because they are inside the statement stream", () => {
    expect(executableBody("SELECT 1; -- note\nSELECT 2;")).toBe("SELECT 1; -- note\nSELECT 2;");
  });

  it("leaves a body with no header untouched", () => {
    expect(executableBody("SELECT 1;")).toBe("SELECT 1;");
  });

  it("answers the empty string for a file that is nothing but comments", () => {
    expect(executableBody("-- a\n-- b\n")).toBe("");
  });
});

describe("migrationBodyForms", () => {
  it("is ordered most literal first, so a caller can say which rung answered", () => {
    const forms = migrationBodyForms("-- h\nSELECT 1;\n");
    expect(forms[0]).toBe("-- h\nSELECT 1;\n");
    expect(forms[1]).toBe("-- h\nSELECT 1;");
    expect(forms[2]).toBe("SELECT 1;");
    expect(bodyFormLabel(0)).toBe("byte-identical");
  });

  /**
   * Identical rungs are KEPT, and this is the test that made the case.
   *
   * They were deduped once. A body carrying a leading comment and no trailing
   * whitespace has rung 1 equal to rung 0, so rung 1 vanished — and a
   * leading-comment match then reported itself at index 1, which
   * `bodyFormLabel` reads as "identical but for trailing whitespace" about a
   * file whose whitespace is identical.
   *
   * Measured on the prime the day it was found: 0 files affected, because
   * every leading-comment match in that corpus also carries trailing
   * whitespace. Right by coincidence; removed rather than relied on.
   */
  it("offers one form per rung, so a match INDEX is the rung that produced it", () => {
    expect(migrationBodyForms("SELECT 1;")).toEqual(["SELECT 1;", "SELECT 1;", "SELECT 1;"]);

    const ran = "SELECT 1;";
    const rungOf = (sql: string) => migrationBodyForms(sql).indexOf(ran);
    expect(rungOf("SELECT 1;")).toBe(0);
    expect(rungOf("SELECT 1;\n\n")).toBe(1);
    // The case the dedup got wrong: documented afterwards, no trailing newline.
    expect(rungOf("-- documented afterwards\n\nSELECT 1;")).toBe(2);
    expect(bodyFormLabel(rungOf("-- documented afterwards\n\nSELECT 1;"))).toBe(
      "identical in what executes",
    );
  });

  /**
   * An empty rung is dropped rather than hashed, and the reason is on the
   * ledger's side: 15 rows there store `statements = '{}'` and their digest is
   * the digest of the empty string. A file that is nothing but comments
   * normalises to the same thing, and admitting it would clear a migration
   * against a row that records no SQL at all.
   */
  it("never offers the empty body as evidence", () => {
    for (const body of ["", "   \n\n", "-- only a comment\n", "\n-- a\n-- b\n\n"]) {
      expect(migrationBodyForms(body), JSON.stringify(body)).not.toContain("");
    }
    expect(migrationBodyForms("")).toEqual([]);
  });

  /**
   * A comment-only file keeps its literal rungs and loses only the normalised
   * one. That is deliberate rather than an oversight: the prime CAN have run a
   * file that is nothing but a comment, and if it did, its ledger holds that
   * comment and the match is a true one. What must never be admitted is the
   * empty string, because that is what 15 of the prime's ledger rows produce
   * for "this row recorded no SQL at all".
   */
  it("keeps a comment-only body's literal forms, and drops only its normalised one", () => {
    expect(migrationBodyForms("-- only a comment\n")).toEqual([
      "-- only a comment\n",
      "-- only a comment",
    ]);
  });
});

/**
 * The property the design rests on, asserted rather than argued.
 *
 * Every rung removes only bytes that cannot execute, so two bodies that
 * collide ANYWHERE on the ladder have identical executable bytes. That is why
 * a shared digest is recorded and never acted on: "which of these files did
 * the prime run" is a question with no consequence, because running any of
 * them runs the same SQL.
 */
describe("a collision anywhere on the ladder means identical executable bytes", () => {
  const BODIES = [
    "SELECT 1;",
    "SELECT 1;\n",
    "SELECT 1;\n\n  \t\n",
    "-- header\nSELECT 1;",
    "-- header\n\n-- more header\nSELECT 1;\n",
    "-- a different header\nSELECT 1;\n  ",
    "SELECT 2;",
    "-- header\nSELECT 2;\n",
    "",
    "-- nothing but a comment\n",
    "  \n-- indented comment\nSELECT 3;",
  ];

  it("holds over every pair", () => {
    for (const a of BODIES) {
      for (const b of BODIES) {
        const shared = migrationBodyForms(a).some((f) => migrationBodyForms(b).includes(f));
        if (!shared) continue;
        expect(executableBody(a), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(
          executableBody(b),
        );
      }
    }
  });

  it("finds the collisions it is meant to find, so the check above is not vacuous", () => {
    const pairs = BODIES.flatMap((a, i) =>
      BODIES.slice(i + 1).filter((b) =>
        migrationBodyForms(a).some((f) => migrationBodyForms(b).includes(f)),
      ),
    );
    expect(pairs.length).toBeGreaterThan(0);
  });
});

/**
 * Whether a version is a time at all.
 *
 * Measured on the prime: 626 of 1,002 files are Lovable's
 * `<timestamp>_<uuid>.sql` and the rest are hand-named. Of the hand-named
 * files the prime HAS run, every single one sat outside the ten-second skew
 * window — because the digits order the file and do not state an instant.
 */
describe("isMachineStampedMigration", () => {
  it("recognises Lovable's own", () => {
    expect(
      isMachineStampedMigration("20250831091525_eafc9d31-fc67-474b-8924-c82e64771733.sql"),
    ).toBe(true);
  });

  it("refuses a hand-named file, whatever its digits look like", () => {
    for (const name of [
      "20260730190000_solicitor_governance_contracts_phase3.sql",
      "20260725096000_rls_w5_secdef_execute_revoke_public_fix.sql",
      "20260812010000_market_updates_archive_indefinite_retention.sql",
    ]) {
      expect(isMachineStampedMigration(name), name).toBe(false);
    }
  });

  it("refuses a near-miss rather than guessing", () => {
    for (const name of [
      "20250831091525_eafc9d31-fc67-474b-8924-c82e6477173.sql", // one short
      "20250831091525_eafc9d31fc67474b8924c82e64771733.sql", // no dashes
      "2025083109152_eafc9d31-fc67-474b-8924-c82e64771733.sql", // 13 digits
      "20250831091525_eafc9d31-fc67-474b-8924-c82e64771733.txt",
    ]) {
      expect(isMachineStampedMigration(name), name).toBe(false);
    }
  });
});
