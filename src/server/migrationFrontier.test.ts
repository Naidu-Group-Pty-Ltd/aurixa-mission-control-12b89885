import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  frontierFromReplay,
  resolveMigrationFrontier,
  type LedgerReading,
} from "./migrationFrontier.pure";

const UNREADABLE: LedgerReading = { read: false, reason: "ECONNRESET" };

describe("resolveMigrationFrontier", () => {
  it("takes the clone's own ledger when the clone answers", () => {
    const f = resolveMigrationFrontier({
      clone: { read: true, version: "20261203010000" },
      primeLedgerTop: "20261203010000",
    });
    expect(f).toMatchObject({ version: "20261203010000", write: true, source: "clone_ledger" });
  });

  it("prefers the clone over the prime even when they disagree", () => {
    // The measured case, in reverse: the derivation says one thing and the
    // clone another. The clone is the subject of the column, so the clone wins
    // — and a stamp that half-succeeded is exactly when they differ.
    const f = resolveMigrationFrontier({
      clone: { read: true, version: "20261201100000" },
      primeLedgerTop: "20261203010000",
    });
    expect(f.version).toBe("20261201100000");
    expect(f.source).toBe("clone_ledger");
  });

  it("records an empty ledger as empty, because a full replay is its answer", () => {
    // `read: true, version: null` is a fact: this clone has applied nothing.
    // That is the state `stampMigrationLedgerFromPrime` refuses to leave a
    // clone in, and recording it is what lets anything notice.
    const f = resolveMigrationFrontier({ clone: { read: true, version: null } });
    expect(f).toMatchObject({ version: null, write: true, source: "clone_ledger" });
  });

  it("falls back to what the stamp copied when the clone cannot be read", () => {
    const f = resolveMigrationFrontier({
      clone: UNREADABLE,
      primeLedgerTop: "20261203010000",
    });
    expect(f).toMatchObject({ version: "20261203010000", write: true, source: "prime_ledger" });
    expect(f.why).toContain("ECONNRESET");
  });

  it("WITHHOLDS the write when nothing can be read — never clears the column", () => {
    // The half that matters. Writing null here says "this clone has applied no
    // migrations", which sends the next sync to replay ~1,000 migrations
    // against a populated database and die on the first one, permanently.
    for (const primeLedgerTop of [undefined, null, ""]) {
      const f = resolveMigrationFrontier({ clone: UNREADABLE, primeLedgerTop });
      expect(f.write, `primeLedgerTop=${String(primeLedgerTop)}`).toBe(false);
      expect(f.source).toBe("unreadable");
    }
  });

  it("never reports a version it is withholding as one to write", () => {
    const f = resolveMigrationFrontier({ clone: UNREADABLE });
    expect(f.write).toBe(false);
    expect(f.version).toBeNull();
  });
});

describe("frontierFromReplay", () => {
  it("is a reading by construction — a replay knows what it applied", () => {
    expect(frontierFromReplay("20261202000000")).toMatchObject({
      version: "20261202000000",
      write: true,
      source: "migration_replay",
    });
  });

  it("says a pass applied nothing rather than looking unreadable", () => {
    const f = frontierFromReplay(null);
    expect(f.write).toBe(true);
    expect(f.source).toBe("migration_replay");
    expect(f.why).toContain("no migrations");
  });
});

describe("the frontier can never be a corpus position again", () => {
  const source = readFileSync(new URL("./migrationFrontier.pure.ts", import.meta.url), "utf8");
  const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  it("the resolver is given readings and never a list of migration files", () => {
    // Structural, not a naming rule: `resolveMigrationFrontier` takes no
    // corpus, so there is nothing in scope for it to sort and take the last
    // of. That is what makes `[...snapshot.migrations].sort().at(-1)`
    // impossible here rather than merely discouraged.
    const bare = stripComments(source);
    expect(bare).not.toMatch(/snapshot\s*\.\s*migrations/);
    expect(bare).not.toMatch(/\.sort\s*\(/);
    expect(bare).not.toMatch(/\bat\s*\(\s*-1\s*\)/);
  });

  it("EVERY assignment of the provisioner's frontier is one of the three constructors", () => {
    // Stated as a rule about the shape of the assignment rather than as a ban
    // on one expression. The first draft of this test forbade
    // `latestApplied = [...snapshot.migrations]` and a planted
    // `latestApplied = { version: [...snapshot.migrations]... }` walked
    // straight past it — the corpus was one level deeper than the regex
    // looked. Three named constructors is the shape that has nowhere to hide:
    // a literal is not a call, and none of the three takes a file list.
    const provisioning = readFileSync(
      new URL("./backend-provisioning.server.ts", import.meta.url),
      "utf8",
    );
    const bare = stripComments(provisioning);
    const SANCTIONED = ["resolveMigrationFrontier(", "frontierFromReplay(", "frontierUnreadable("];

    const assignments: string[] = [];
    const re = /migrationFrontier(?:\s*:\s*MigrationFrontier)?\s*=\s*/g;
    for (let m = re.exec(bare); m; m = re.exec(bare)) {
      assignments.push(bare.slice(m.index + m[0].length, m.index + m[0].length + 60));
    }

    expect(assignments.length, "expected the declaration plus three branches").toBe(4);
    for (const rhs of assignments) {
      expect(
        SANCTIONED.some((c) => rhs.startsWith(c)),
        `frontier assigned from something other than a constructor: ${rhs.slice(0, 50)}`,
      ).toBe(true);
    }
  });

  it("and the corpus never reaches one of those constructors", () => {
    // The constructor rule alone is not enough: a planted
    // `frontierFromReplay([...snapshot.migrations].sort().at(-1)?.id)` is a
    // call to a sanctioned constructor and passed it. The shape of the
    // assignment and the provenance of its value are two questions, and this
    // is the second one — stated about the corpus rather than about any
    // spelling of the expression that reads it.
    const provisioning = readFileSync(
      new URL("./backend-provisioning.server.ts", import.meta.url),
      "utf8",
    );
    const bare = stripComments(provisioning);
    const re = /migrationFrontier(?:\s*:\s*MigrationFrontier)?\s*=\s*/g;
    for (let m = re.exec(bare); m; m = re.exec(bare)) {
      const rhs = bare.slice(m.index, m.index + m[0].length + 400);
      expect(
        rhs,
        "a migration frontier may not be derived from the prime's file list",
      ).not.toContain("snapshot.migrations");
    }
  });

  it("the column is written only where the reading says it may be", () => {
    const fns = readFileSync(
      new URL("../lib/backend-provisioning.functions.ts", import.meta.url),
      "utf8",
    );
    const bare = stripComments(fns);
    // `supabase` is untyped in that function, so `tsc` would not have caught
    // the whole reading object being poured into a text column. This is the
    // check that does.
    expect(bare).not.toMatch(/migration_version:\s*result\.latestMigration\s*,/);
    expect(bare).toContain("result.latestMigration.write");
    expect(bare).toContain("migration_version: result.latestMigration.version");
  });
});
