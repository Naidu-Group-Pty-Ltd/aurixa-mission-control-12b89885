/**
 * The structural properties that keep a per-clone forward from becoming a
 * cross-tenant write or a credential leak.
 *
 * Asserted against the source, like the sibling target guard's own tests: a
 * Supabase double would agree with wrong code here, and the questions are
 * about WHERE a value comes from and WHERE it goes, which is a property of the
 * call sites rather than of a return value.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const server = stripComments(read("src/server/cloneSecretForward.server.ts"));
const pure = stripComments(read("src/server/cloneSecretForward.pure.ts"));
const functions = stripComments(read("src/lib/backend-provisioning.functions.ts"));
const cron = stripComments(read("src/routes/hooks.clone-secret-forward-reconcile.tsx"));

describe("the ref written to is the guard's, never a caller's", () => {
  it("resolves the target through resolveCloneSecretTarget", () => {
    /*
      The Management API token reaches every project this organisation owns —
      the prime's and Mission Control's included. The guard refuses both, and
      refuses when it cannot tell which is which. A ref from anywhere else is
      the difference between forwarding a vendor key to a clone and
      overwriting it on the prime.
    */
    expect(server).toContain("resolveCloneSecretTarget(supabase, cloneId)");
  });

  it("hands setCloneSecretValues nothing but that ref", () => {
    const calls = server.match(/setCloneSecretValues\(\s*[^,]+,/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toMatch(/setCloneSecretValues\(\s*projectRef\s*,/);
  });

  it("never reads a project ref off clone_backends itself", () => {
    // The guard already does that, and compares it against the prime's. A
    // second, ungated read here is how the comparison gets skipped.
    expect(server).not.toContain('from("clone_backends")');
  });
});

describe("a credential value never leaves the write", () => {
  it("the push result carries names and never values", () => {
    // `written` is string[] of NAMES. A value in a result reaches an audit
    // row, a toast and a log line — a prefix of a credential is still
    // credential material in a table more people can read than the project.
    expect(server).toMatch(/written:\s*string\[\]/);
    expect(server).not.toMatch(/value:\s*(?:res|secret|entries)/);
  });

  it("the audit row records names only", () => {
    const block = functions.slice(
      functions.indexOf("export const pushCloneSecretForwardsNow"),
      functions.indexOf("export const pushCloneSecretForwardsNow") + 2000,
    );
    expect(block).toContain("written: res.written");
    expect(block).not.toMatch(/process\.env/);
  });

  it("the env is read at the write and nowhere that returns", () => {
    // Exactly two reads: the presence test, and building the entries.
    const reads = server.match(/process\.env\[/g) ?? [];
    expect(reads.length).toBe(2);
  });
});

describe("the decision is the pure module's", () => {
  it("the server does not re-implement a refusal", () => {
    expect(server).toContain("planCloneForwards(");
    expect(server).toContain("namesToWrite(");
    // Any second spelling of the class rules here is a second standard.
    expect(server).not.toMatch(/tenant_scoped|TENANT_SCOPED/);
  });

  it("class is asked before fleet policy, which is the guarantee", () => {
    /*
      If fleet policy came first, a row marking JWT_SECRET `inherit = true`
      would answer `already_fleet_wide` and read as benign rather than being
      refused outright.
    */
    const fn = pure.slice(pure.indexOf("export function decideForward"));
    expect(fn.indexOf("CLASS_REFUSAL[")).toBeLessThan(fn.indexOf("fleetInherit === false"));
  });

  it("provisioning applies the same decision, not a looser copy", () => {
    /*
      Without the union a re-provision silently drops a clone's own forwards:
      it comes back holding every fleet key and none of its own, which reads
      as a healthy provision everywhere and fails only at the vendor. With a
      SEPARATE decision there, a class refusal could be unreachable in one
      path and reachable in the other.
    */
    expect(functions).toContain('from("clone_secret_forwards")');
    // The SAME planner, not a second loop that happens to agree today.
    expect(functions).toContain("planCloneForwards({");
    expect(functions).toContain("namesToWrite(planned)");
    expect(server).toContain("planCloneForwards({");
  });

  it("the provisioning union is gated on the rows, not on a constant", () => {
    /*
      Everything subtle about which names travel now lives in
      `planCloneForwards` and is tested against its inputs. What a source
      assertion still has to cover is the crude failure: the union sitting
      behind a condition that is never true, which leaves every string this
      file looks for present and the code dead.
    */
    const start = functions.indexOf("const { data: cloneForwardRows }");
    const end = functions.indexOf("const dedicatedSecretNames");
    // Both anchors must be real. A slice from -1 silently widens to most of
    // the file and every assertion below then passes over the wrong text —
    // the trap this suite already hit once.
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const union = functions.slice(start, end);
    expect(union).toMatch(/if \(cloneForwardRows\??\.length\)/);
    expect(union).not.toMatch(/if \(\s*(?:false|0)\s*\)/);
    // …and the planner's answer is actually applied.
    expect(union).toMatch(/inheritedSecrets\[name\] = process\.env\[name\]/);
  });

  it("provisioning reads the WHOLE fleet list so it can see a refusal", () => {
    // Filtered to `inherit = true`, a deliberate `false` would arrive as
    // "no fleet policy" and the per-clone row would win.
    const block = functions.slice(
      functions.indexOf("const { data: forwardAll }"),
      functions.indexOf("const dedicatedSecretNames"),
    );
    expect(block).toContain('.from("prime_secret_forwards")');
    // The read itself must carry no inherit filter; the true-half is derived
    // from it afterwards, so both questions are answerable from one query.
    expect(block.slice(0, block.indexOf("const forwardRows"))).not.toContain('.eq("inherit"');
    expect(block).toMatch(/const forwardRows = \(forwardAll \?\? \[\]\)\.filter/);
  });
});

describe("a failed read is not an absent policy", () => {
  it("an unreadable fleet list refuses rather than forwarding everything", () => {
    /*
      Treating a failed read as "no fleet rows" would turn every deliberate
      `inherit = false` — the management token, the payment keys — into a
      forwardable name for as long as the read stays broken.
    */
    const block = server.slice(
      server.indexOf('from("prime_secret_forwards")'),
      server.indexOf("const outcomes ="),
    );
    expect(block).toMatch(/if \(fleet\.error\) return \{ ok: false/);
  });
});

describe("the authorisation applies without anyone pressing a button", () => {
  it("a scheduled reconcile exists and is cron-authenticated", () => {
    expect(cron).toContain("verifyCronAuth(request)");
    expect(cron).toContain("reconcileCloneSecretForwards");
  });

  it("the reconcile retries a failed name and skips a settled one", () => {
    // `failed` is exactly the state a retry is for; filtering it out would
    // make one bad push permanent and silent.
    const fn = server.slice(server.indexOf("export async function reconcileCloneSecretForwards"));
    expect(fn).toMatch(/status === "inherited" \|\| r\.status === "set"/);
    expect(fn).not.toMatch(/status === "failed"/);
  });
});

describe("withdrawing an authorisation is not deleting a credential", () => {
  it("the removal says the clone still holds the value", () => {
    const block = functions.slice(
      functions.indexOf("export const removeCloneSecretForward"),
      functions.indexOf("export const pushCloneSecretForwardsNow"),
    );
    expect(block).toContain("the clone still holds the value");
    // It must not reach for the Management API — unsetting a secret a live
    // deployment is using is a much larger act than withdrawing a policy row.
    expect(block).not.toContain("setCloneSecretValue");
  });
});
