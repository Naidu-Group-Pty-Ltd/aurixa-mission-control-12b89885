import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  parseStoredSecretDigests,
  planSecretWrite,
  valueDigests,
  type SecretEntry,
} from "./secretWriteDiff.pure";

const REF = "abcdefghijklmnopqrst";
// sha256("bar") and hmac-sha256("abcdefghijklmnopqrst", "bar"), computed once
// with openssl-equivalent Node crypto and pinned, so a change to either form is
// a change somebody made on purpose.
const SHA256_BAR = "fcde2b2edba56bf408601fb721fe9b5c338d10ee429ea04fae5511b68fbf8fb9";
const HMAC_BAR = "064c15061536f418251dd40552831eceb73eaa530cddd8477a1fb403630853a3";

const stored = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe("valueDigests — the forms a stored value is recognised under", () => {
  it("is SHA-256 of the value, then HMAC-SHA256 keyed by the project ref, both hex", () => {
    expect(valueDigests(REF, "bar")).toEqual([SHA256_BAR, HMAC_BAR]);
  });

  it("depends on the ref only through the keyed form", () => {
    const other = valueDigests("tsrqponmlkjihgfedcba", "bar");
    expect(other[0]).toBe(SHA256_BAR);
    expect(other[1]).not.toBe(HMAC_BAR);
  });
});

describe("planSecretWrite — only a proof skips a write", () => {
  const entries: SecretEntry[] = [
    { name: "FOO", value: "bar" },
    { name: "BAZ", value: "qux" },
  ];

  it("leaves out a value whose SHA-256 is the one stored", () => {
    const plan = planSecretWrite(REF, [{ name: "FOO", value: "bar" }], stored({ FOO: SHA256_BAR }));
    expect(plan).toEqual({ write: [], unchanged: ["FOO"], uncompared: null });
  });

  it("leaves out a value whose ref-keyed HMAC is the one stored", () => {
    const plan = planSecretWrite(REF, [{ name: "FOO", value: "bar" }], stored({ FOO: HMAC_BAR }));
    expect(plan.write).toEqual([]);
    expect(plan.unchanged).toEqual(["FOO"]);
  });

  it("compares the stored digest without regard to case or surrounding space", () => {
    const listed = parseStoredSecretDigests([
      { name: "FOO", value: `  ${SHA256_BAR.toUpperCase()} ` },
    ]);
    expect(planSecretWrite(REF, [{ name: "FOO", value: "bar" }], listed).write).toEqual([]);
  });

  it("writes a value whose digest differs from the one stored", () => {
    const plan = planSecretWrite(REF, [{ name: "FOO", value: "baz" }], stored({ FOO: SHA256_BAR }));
    expect(plan).toEqual({
      write: [{ name: "FOO", value: "baz" }],
      unchanged: [],
      uncompared: null,
    });
  });

  it("writes a name the project does not hold", () => {
    const plan = planSecretWrite(REF, [{ name: "NEW", value: "bar" }], stored({ FOO: SHA256_BAR }));
    expect(plan.write).toEqual([{ name: "NEW", value: "bar" }]);
  });

  it("does not let one name's digest vouch for another name", () => {
    // BAZ is absent; FOO's digest equals sha256("bar"), which is BAZ's value
    // here. A digest is evidence about ITS name only.
    const plan = planSecretWrite(REF, [{ name: "BAZ", value: "bar" }], stored({ FOO: SHA256_BAR }));
    expect(plan.write).toEqual([{ name: "BAZ", value: "bar" }]);
  });

  it("writes everything asked when the list could not be read — the behaviour before this", () => {
    expect(planSecretWrite(REF, entries, null)).toEqual({
      write: entries,
      unchanged: [],
      uncompared: "list_unreadable",
    });
  });

  it("sends a batch that names one secret twice exactly as asked", () => {
    const twice = [
      { name: "FOO", value: "bar" },
      { name: "FOO", value: "baz" },
    ];
    expect(planSecretWrite(REF, twice, stored({ FOO: SHA256_BAR }))).toEqual({
      write: twice,
      unchanged: [],
      uncompared: "repeated_name",
    });
  });

  it("sends the WHOLE batch, in the caller's order, when any entry differs — never the differing ones alone", () => {
    const batch = [
      { name: "A", value: "changed-a" },
      { name: "FOO", value: "bar" },
      { name: "B", value: "changed-b" },
    ];
    const plan = planSecretWrite(
      REF,
      batch,
      stored({ FOO: SHA256_BAR, A: SHA256_BAR, B: HMAC_BAR }),
    );
    expect(plan).toEqual({ write: batch, unchanged: [], uncompared: null });
  });

  it("keeps a pair whole when a second writer moved the other half between the read and the write", () => {
    // Read: the address is the one stored, the key is not. A filtered write
    // would send the key alone — and if another caller had since replaced BOTH
    // halves, this key would land beside that caller's address. Sent whole,
    // the pair that stands is one writer's pair.
    const pair = [
      { name: "RESEND_API_KEY", value: "re_new" },
      { name: "RESEND_FROM", value: "bar" },
    ];
    const plan = planSecretWrite(REF, pair, stored({ RESEND_FROM: SHA256_BAR }));
    expect(plan.write).toEqual(pair);
  });

  it("skips a batch only when EVERY entry is proven held", () => {
    const batch = [
      { name: "FOO", value: "bar" },
      { name: "BAZ", value: "bar" },
    ];
    const plan = planSecretWrite(REF, batch, stored({ FOO: SHA256_BAR, BAZ: HMAC_BAR }));
    expect(plan).toEqual({ write: [], unchanged: ["FOO", "BAZ"], uncompared: null });
  });

  it("sends all or nothing, whatever the mix — a plan never carries part of its batch", () => {
    const names = ["A", "B", "C"];
    const values = ["bar", "other"];
    for (let mask = 0; mask < 27; mask++) {
      const entries = names.map((name, i) => ({
        name,
        value: values[Math.floor(mask / 3 ** i) % 3 === 0 ? 0 : 1],
      }));
      const held = Object.fromEntries(
        names
          .filter((_, i) => Math.floor(mask / 3 ** i) % 3 !== 2)
          .map((name) => [name, SHA256_BAR]),
      );
      const plan = planSecretWrite(REF, entries, stored(held));
      expect([0, entries.length]).toContain(plan.write.length);
      expect(plan.write.length + plan.unchanged.length).toBe(entries.length);
    }
  });

  it("returns copies, so a caller mutating the plan cannot mutate its input", () => {
    const plan = planSecretWrite(REF, entries, null);
    plan.write.pop();
    expect(entries).toHaveLength(2);
  });
});

describe("parseStoredSecretDigests — what the list says is held", () => {
  it("reads the documented array into name → digest", () => {
    const listed = parseStoredSecretDigests([
      { name: "FOO", value: SHA256_BAR, updated_at: "2026-09-27T00:00:00Z" },
      { name: "BAZ", value: HMAC_BAR },
    ]);
    expect(listed).toEqual(stored({ FOO: SHA256_BAR, BAZ: HMAC_BAR }));
  });

  it("answers null for anything that is not the array, so nothing is skipped on a body it cannot read", () => {
    for (const body of [null, undefined, {}, { secrets: [] }, "[]", 42]) {
      expect(parseStoredSecretDigests(body)).toBeNull();
    }
  });

  it("an empty list is a readable answer: nothing is held", () => {
    expect(parseStoredSecretDigests([])).toEqual(new Map());
  });

  it("leaves out a row without a string name and a string digest, so that name is written", () => {
    const listed = parseStoredSecretDigests([
      { name: "FOO" },
      { name: "", value: SHA256_BAR },
      { value: SHA256_BAR },
      { name: "BAR", value: 7 },
      { name: "EMPTY", value: "   " },
      null,
      "FOO",
    ]);
    expect(listed).toEqual(new Map());
  });

  it("drops a name listed twice with two digests — ambiguous is not proof", () => {
    const listed = parseStoredSecretDigests([
      { name: "FOO", value: SHA256_BAR },
      { name: "FOO", value: HMAC_BAR },
      { name: "BAZ", value: SHA256_BAR },
      { name: "BAZ", value: SHA256_BAR.toUpperCase() },
    ]);
    expect(listed).toEqual(stored({ BAZ: SHA256_BAR }));
  });
});

describe("every per-pass secret write goes through the digest check", () => {
  const provisioning = readFileSync("src/server/backend-provisioning.server.ts", "utf8");

  const bodyOf = (source: string, signature: string): string => {
    const at = source.indexOf(signature);
    expect(at, `${signature} not found`).toBeGreaterThan(-1);
    const next = source.indexOf("\nexport ", at + signature.length);
    return source.slice(at, next === -1 ? undefined : next);
  };

  it("setCloneSecretValues reads the stored digests and sends the PLAN, never the raw entries", () => {
    const fn = bodyOf(provisioning, "export async function setCloneSecretValues(");
    const read = fn.indexOf(
      "planSecretWrite(projectRef, entries, await readStoredSecretDigests(projectRef))",
    );
    const post = fn.indexOf('method: "POST"');
    expect(read).toBeGreaterThan(-1);
    expect(post).toBeGreaterThan(read);
    expect(fn).toContain("body: JSON.stringify(plan.write)");
    expect(fn).not.toContain("JSON.stringify(entries)");
    // Nothing to send is a success that sent nothing — not a request with an
    // empty array, which would redeploy every function for no change at all.
    expect(fn).toMatch(/if \(plan\.write\.length === 0\) return \{ ok: true, written: \[\]/);
  });

  it("the digest read is bounded and can never fail a write", () => {
    const fn = bodyOf(provisioning, "async function readStoredSecretDigests(");
    expect(fn).toContain("signal: AbortSignal.timeout(STORED_DIGEST_READ_TIMEOUT_MS)");
    expect(fn).toMatch(/if \(!res\.ok\) return null;/);
    expect(fn).toMatch(/catch \{\s*return null;\s*\}/);
  });

  it("reports names only — never a value or a digest", () => {
    const fn = bodyOf(provisioning, "export async function setCloneSecretValues(");
    const returns = fn.match(/return \{ ok: true[^}]*\}/g) ?? [];
    expect(returns.length).toBeGreaterThan(0);
    for (const r of returns) expect(r).not.toMatch(/value|digest/i);
  });

  it("no other code POSTs to the secrets endpoint except the named exceptions", () => {
    // Every POST to `/secrets` redeploys every function on the project, so a
    // writer that bypasses the check is how the redeploy-per-pass comes back.
    // The exceptions each write once, on an event, never on a schedule:
    const allowed = new Set([
      // the check itself
      "src/server/backend-provisioning.server.ts#setCloneSecretValues",
      // provisioning's first batch, onto a project that holds nothing yet
      "src/server/backend-provisioning.server.ts#syncCloneSecrets",
      // an operator-approved rotation (and its rollback) on a CLIENT's own
      // project, through the client's own token
      "src/server/handoff-rotations.server.ts#executeEdgeFunctionEnv",
      "src/server/handoff-rotations.server.ts#rollbackEdgeFunctionEnv",
    ]);
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) files.push(path);
      }
    };
    walk("src");

    const found: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      // The options object may put `headers: { … }` before `method`, so the
      // method is looked for in the call's next few hundred characters rather
      // than up to the first closing brace.
      const re = /fetch\(\s*`[^`]*\/secrets`\s*,/g;
      for (const match of source.matchAll(re)) {
        const call = source.slice(match.index, match.index + 600);
        const end = call.indexOf("});");
        if (!/method:\s*["']POST["']/.test(end === -1 ? call : call.slice(0, end))) continue;
        const before = source.slice(0, match.index);
        const fnName =
          [...before.matchAll(/(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g)].pop()?.[1] ?? "?";
        found.push(`${file.replace(/\\/g, "/")}#${fnName}`);
      }
    }
    expect(found.length).toBeGreaterThan(0);
    for (const site of found)
      expect(allowed, `${site} POSTs secrets without the digest check`).toContain(site);
  });
});
