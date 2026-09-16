/**
 * The rate limiter's key is a KEY. Its bucket is a bucket.
 *
 * `check_api_rate_limit(_key_id uuid, …)` and
 * `token_api_rate_limits.key_id uuid REFERENCES clone_api_keys(id)` mean a
 * composed key id cannot be stored and cannot even be cast. The activation
 * gate composed one anyway, to give itself a separate allowance:
 *
 *     checkRateLimit(`gate:${key.id}`, 120)
 *
 * Postgres answered `22P02 invalid input syntax for type uuid` on every call,
 * `checkRateLimit` fails CLOSED on a DB error, and both gate routes therefore
 * returned 429 to every request ever made of them — 1,185 of 1,185 measured
 * across two production deployments on 2026-09-16, a 100% failure rate that
 * was invisible because the clone renders the dashboard on any error.
 *
 * The storefront's two purchase routes did the same thing with a value that
 * is not even a key (`storefront:checkout:${uid}`), and were found by the
 * first run of this test rather than by the investigation that prompted it.
 * They take `checkPublicRateLimit` now, which counts in a table with no
 * foreign key, because an anonymous caller is genuinely not a key.
 *
 * Nothing in the type system can see this: the argument is a `string` and
 * `gate:<uuid>` is a perfectly good string. So it is checked here, at the
 * source, which is the only place the composition is still visible.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = "src";
const MIGRATIONS = "supabase/migrations";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const sources = walk(SRC).map((f) => ({ file: f, text: readFileSync(f, "utf8") }));

/**
 * Only files that import the SHARED helper. `support-tickets.server.ts`
 * declares a private function of the same name over an IP hash, which is a
 * different thing with a different contract and is none of this test's
 * business.
 */
const callers = sources.filter(
  (s) =>
    /import\s*\{[^}]*\bcheckRateLimit\b[^}]*\}\s*from\s*["']@\/server\/token-rate-limit\.server["']/.test(
      s.text,
    ),
);

describe("no call site composes a rate-limit key id", () => {
  it("finds the call sites at all", () => {
    // A guard that matches nothing passes forever. This is the canary: if the
    // import path or the helper's name changes, this fails rather than the
    // whole file quietly becoming a no-op.
    expect(callers.length).toBeGreaterThan(20);
  });

  it("every first argument is a plain reference, never a template or concatenation", () => {
    const offenders: string[] = [];
    for (const { file, text } of callers) {
      for (const m of text.matchAll(/\bcheckRateLimit\s*\(\s*([^,)]+)/g)) {
        const arg = m[1].trim();
        if (arg.includes("`") || arg.includes('"') || arg.includes("'") || arg.includes("+")) {
          offenders.push(`${file}: checkRateLimit(${arg}…`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the bucket is a parameter the schema actually has", () => {
  const definitions = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ file: f, text: readFileSync(join(MIGRATIONS, f), "utf8") }))
    .filter((m) => /function\s+public\.check_api_rate_limit\s*\(/i.test(m.text));

  it("the newest definition accepts _bucket", () => {
    // Code passing `_bucket` to a two-parameter function is a PostgREST 404,
    // which `checkRateLimit` turns into a fail-closed 429 — the same outage
    // in the opposite direction. The last migration to define the function
    // wins, so that is the one that has to carry the parameter.
    const newest = definitions.at(-1);
    expect(newest).toBeDefined();
    expect(newest!.text).toMatch(/_bucket\s+text/i);
  });

  it("leaves _key_id typed as uuid", () => {
    // The whole point. If this ever widens to text, the composed-key defect
    // becomes expressible again and the test above becomes decorative.
    const newest = definitions.at(-1)!;
    expect(newest.text).toMatch(/_key_id\s+uuid/i);
  });

  it("is defined exactly once at the newest version, so a 2-arg call is not ambiguous", () => {
    // Two live overloads make `check_api_rate_limit(uuid, integer)` match both
    // the exact 2-arg function and the 3-arg one via its default —
    // `42725 function is not unique` — which would break all ~30 call sites.
    const newest = definitions.at(-1)!;
    const creates = newest.text.match(/create\s+(or\s+replace\s+)?function\s+public\.check_api_rate_limit/gi);
    expect(creates).toHaveLength(1);
    expect(newest.text).toMatch(/drop\s+function\s+if\s+exists\s+public\.check_api_rate_limit\s*\(\s*uuid\s*,\s*integer\s*\)/i);
  });
});

describe("keyless callers use the keyless limiter", () => {
  const storefront = [
    "src/routes/api.public.storefront.checkout.ts",
    "src/routes/api.public.storefront.setup.ts",
  ].map((f) => ({ file: f, text: readFileSync(f, "utf8") }));

  it("the storefront purchase routes do not touch the keyed limiter", () => {
    // `h` is a handoff uuid and `uid` an arbitrary pricing-page string. Neither
    // is a `clone_api_keys.id`, so the keyed limiter's foreign key can never be
    // satisfied by one — it would fail closed at the column instead of at the
    // cast, which is the same outage wearing a different error code.
    const offenders = storefront
      .filter((s) => /\bcheckRateLimit\s*\(/.test(s.text))
      .map((s) => s.file);
    expect(offenders).toEqual([]);
  });

  it("they call checkPublicRateLimit with a literal scope", () => {
    for (const { file, text } of storefront) {
      const m = /checkPublicRateLimit\(\s*["']([^"']+)["']/.exec(text);
      expect(m, `${file} has no literal-scope checkPublicRateLimit call`).toBeTruthy();
    }
  });

  it("the keyless counter carries no foreign key", () => {
    // The point of the second table. A FK here would re-create the defect it
    // exists to fix, and it would do it silently — a failed insert becomes a
    // fail-closed 429 on a public purchase route.
    const mig = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
      .filter((t) => /create\s+table[^;]*public_rate_limits/i.test(t))
      .at(-1);
    expect(mig).toBeDefined();
    const ddl = /create\s+table[^;]*public\.public_rate_limits\s*\(([\s\S]*?)\);/i.exec(mig!);
    expect(ddl).toBeTruthy();
    expect(/references/i.test(ddl![1])).toBe(false);
  });
});

describe("the gate's two routes keep separate allowances", () => {
  const read = readFileSync("src/routes/api.public.clones.gate.ts", "utf8");
  const checkout = readFileSync("src/routes/api.public.clones.gate.checkout.ts", "utf8");

  const bucketOf = (text: string) =>
    /checkRateLimit\(\s*key\.id\s*,\s*\d+\s*,\s*["']([^"']+)["']\s*\)/.exec(text)?.[1] ?? null;

  it("both name a bucket", () => {
    expect(bucketOf(read)).not.toBeNull();
    expect(bucketOf(checkout)).not.toBeNull();
  });

  it("and the buckets differ", () => {
    // A browser polls the verdict every five minutes; minting a Stripe session
    // is held to 12/min. Sharing one counter would let ordinary polling spend
    // the allowance a paying customer needs to check out.
    expect(bucketOf(read)).not.toEqual(bucketOf(checkout));
  });

  it("neither shares the default bucket with the metered endpoints", () => {
    // The default bucket is what tokens/reserve and seats/reserve count in.
    expect(bucketOf(read)).not.toEqual("");
    expect(bucketOf(checkout)).not.toEqual("");
  });
});
