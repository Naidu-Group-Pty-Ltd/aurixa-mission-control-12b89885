import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { secretLedgerBatches, type SecretLedgerInput } from "./secretLedger.pure";

const NOW = "2026-09-27T06:00:00.000Z";
const base: Omit<SecretLedgerInput, "result" | "names"> = {
  cloneId: "clone-1",
  status: "set",
  setBy: "user-1",
  now: NOW,
};

describe("secretLedgerBatches — what one write says about each name", () => {
  it("a SENT name moves its set time and records who set it", () => {
    const batches = secretLedgerBatches({
      ...base,
      names: ["A"],
      result: { ok: true, written: ["A"], unchanged: [] },
    });
    expect(batches).toEqual([
      [
        {
          clone_id: "clone-1",
          name: "A",
          status: "set",
          last_set_at: NOW,
          last_error: null,
          set_by: "user-1",
        },
      ],
    ]);
  });

  it("a name the project already HELD keeps its set time and setter: nobody set it now", () => {
    const [held] = secretLedgerBatches({
      ...base,
      names: ["A", "B"],
      result: { ok: true, written: [], unchanged: ["A", "B"] },
    });
    expect(held).toEqual([
      { clone_id: "clone-1", name: "A", status: "set", last_error: null },
      { clone_id: "clone-1", name: "B", status: "set", last_error: null },
    ]);
    // Not merely null — ABSENT, so the upsert never names the column and an
    // existing row keeps what it had.
    for (const row of held) {
      expect("last_set_at" in row).toBe(false);
      expect("set_by" in row).toBe(false);
    }
  });

  it("a held name clears a previous failure — the digest has just proved the value is there", () => {
    const [held] = secretLedgerBatches({
      ...base,
      names: ["A"],
      result: { ok: true, written: [], unchanged: ["A"] },
    });
    expect(held[0]).toMatchObject({ status: "set", last_error: null });
  });

  it("never mixes sent and held rows in one batch, because a bulk upsert NULLs a column one row omits", () => {
    // A write is whole or nothing, but the ledger must not depend on that.
    const batches = secretLedgerBatches({
      ...base,
      names: ["A", "B"],
      result: { ok: true, written: ["A"], unchanged: ["B"] },
    });
    expect(batches).toHaveLength(2);
    for (const batch of batches) {
      const shapes = new Set(batch.map((row) => Object.keys(row).sort().join(",")));
      expect(shapes.size).toBe(1);
    }
  });

  it("a failed write records every name it covered as failed, with the error and no set time", () => {
    const batches = secretLedgerBatches({
      ...base,
      names: ["A", "B"],
      result: { ok: false, error: "secrets API 500" },
    });
    expect(batches).toEqual([
      [
        {
          clone_id: "clone-1",
          name: "A",
          status: "failed",
          last_set_at: null,
          last_error: "secrets API 500",
          set_by: "user-1",
        },
        {
          clone_id: "clone-1",
          name: "B",
          status: "failed",
          last_set_at: null,
          last_error: "secrets API 500",
          set_by: "user-1",
        },
      ],
    ]);
  });

  it("writes no set_by column at all when the caller records none", () => {
    const { setBy: _omitted, ...withoutSetBy } = base;
    const batches = secretLedgerBatches({
      ...withoutSetBy,
      names: ["A"],
      result: { ok: true, written: ["A"], unchanged: [] },
    });
    expect("set_by" in batches[0][0]).toBe(false);
  });

  it("records the status the caller names — a forwarded value is `inherited`", () => {
    const [sent] = secretLedgerBatches({
      ...base,
      status: "inherited",
      names: ["A"],
      result: { ok: true, written: ["A"], unchanged: [] },
    });
    expect(sent[0].status).toBe("inherited");
  });

  it("returns no batch when there is nothing to record", () => {
    expect(
      secretLedgerBatches({ ...base, names: [], result: { ok: true, written: [], unchanged: [] } }),
    ).toEqual([]);
    expect(secretLedgerBatches({ ...base, names: [], result: { ok: false, error: "x" } })).toEqual(
      [],
    );
  });
});

describe("every caller of the secret writer records what was SENT, not what was asked", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) files.push(path);
    }
  };
  walk("src");
  const writers = files.filter((file) =>
    /\bsetCloneSecretValues?\(/.test(readFileSync(file, "utf8")),
  );

  it("finds the callers it is about", () => {
    expect(writers.length).toBeGreaterThan(5);
  });

  it("no caller stamps a set time from the write's success alone", () => {
    // `last_set_at: res.ok ? now : null` was the idiom when a successful write
    // meant everything asked for had been sent. It no longer does: a batch
    // the project already holds is not sent, and stamping it says a secret was
    // set moments ago when nothing was. `recordSecretLedger` is the record.
    for (const file of writers) {
      const source = readFileSync(file, "utf8");
      expect(source, `${file} stamps last_set_at from a write's success`).not.toMatch(
        /last_set_at:\s*\w+\.ok\s*\?/,
      );
    }
  });

  it("no caller reports the names it ASKED for as the names it wrote", () => {
    // The two forwards and the derived config returned `written: names` /
    // `written: toWrite`, so a pass that sent nothing still counted as a push.
    for (const file of writers) {
      const source = readFileSync(file, "utf8");
      expect(source, `${file} reports requested names as written`).not.toMatch(
        /written:\s*(names|toWrite)\b/,
      );
    }
  });
});

describe("the derived config records every value the clone holds", () => {
  const source = readFileSync("src/server/cloneDerivedConfig.server.ts", "utf8");

  it("builds the event's values from every derived name, not from the names this pass sent", () => {
    // Recording only the names written made "moved since my last write" read
    // every OTHER name as moved on the next pass — two sets alternating, a
    // write (and a redeploy) on every pass, for good.
    expect(source).toContain("values: Object.fromEntries(names.map((n) => [n, values[n]]))");
    expect(source).not.toContain("values: Object.fromEntries(toWrite.map(");
  });
});
