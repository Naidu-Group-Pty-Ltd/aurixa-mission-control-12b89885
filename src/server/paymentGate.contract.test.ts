/**
 * Source-level guards on the activation gate.
 *
 * The gate's whole risk is that it locks somebody it should not. Every
 * assertion here is about an absence — a backfill that must not exist, a
 * second place that must not decide a status — and an absence is exactly what
 * a behavioural test cannot see.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = "supabase/migrations";
const SRC = "src";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const sources = walk(SRC).map((f) => ({ file: f, text: readFileSync(f, "utf8") }));
const migrations = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => ({ file: f, text: readFileSync(join(MIGRATIONS, f), "utf8") }));

describe("nothing backfills a gate", () => {
  it("no migration inserts into clone_payment_gates", () => {
    // A backfill would gate the entire existing fleet and the prime at once,
    // and it would do it on deploy with nobody watching. The absence IS the
    // guarantee that current clones are unaffected.
    const offenders = migrations
      .filter((m) => /insert\s+into\s+(public\.)?clone_payment_gates/i.test(m.text))
      .map((m) => m.file);
    expect(offenders).toEqual([]);
  });

  it("no migration derives gates from the clones table", () => {
    const offenders = migrations
      .filter((m) =>
        /clone_payment_gates[\s\S]{0,400}?select[\s\S]{0,200}?from\s+(public\.)?clones\b/i.test(
          m.text,
        ),
      )
      .map((m) => m.file);
    expect(offenders).toEqual([]);
  });
});

describe("a gate is created in exactly two places", () => {
  it("armGate is called only from the provisioning pipeline and the operator RPC", () => {
    const callers = sources
      .filter(
        (s) =>
          !s.file.endsWith("payment-gate.server.ts") &&
          !s.file.endsWith("paymentGate.contract.test.ts") &&
          /\barmGate\s*\(/.test(s.text),
      )
      .map((s) => s.file.replace(/\\/g, "/"))
      .sort();
    expect(callers).toEqual([
      "src/server/clone-provisioning.server.ts",
      "src/server/payment-gate.functions.ts",
    ]);
  });

  it("it arms in the shared PIPELINE, so an agreement-provisioned clone is gated too", () => {
    // `provisionCloneCore` has two callers — the operator wizard and the
    // signed-agreement flow. Arming in the wizard's own server function would
    // leave every clone created by a signed agreement ungated, which is the
    // half of the fleet that most certainly has a paid plan.
    const core = readFileSync("src/server/clone-provisioning.server.ts", "utf8");
    expect(core).toMatch(/\barmGate\s*\(/);
    const wizard = readFileSync("src/server/clone-provisioning.functions.ts", "utf8");
    expect(wizard).not.toMatch(/\barmGate\s*\(/);
    const agreement = readFileSync("src/server/agreement-provisioning.server.ts", "utf8");
    expect(agreement).toMatch(/provisionCloneCore\(/);
  });
});

describe("one module decides the status", () => {
  it("nothing outside the pure module maps gate facts to a status", () => {
    // A second implementation of "is this locked" is how Mission Control and a
    // clone come to disagree about whether a customer may work.
    const offenders = sources
      .filter((s) => !s.file.endsWith("clonePaymentGate.pure.ts"))
      .filter((s) => !s.file.includes("clonePaymentGate.pure.test"))
      .filter((s) => /manual_override\s*===\s*["']locked["']/.test(s.text))
      .map((s) => s.file);
    expect(offenders).toEqual([]);
  });

  it("the gates table has no status column to store one in", () => {
    const create = migrations.find((m) => /create table[\s\S]*clone_payment_gates/i.test(m.text));
    expect(create).toBeDefined();
    const body = /create table[^(]*clone_payment_gates\s*\(([\s\S]*?)\n\);/i.exec(create!.text)?.[1];
    expect(body).toBeDefined();
    expect(/^\s*status\s+text/im.test(body!)).toBe(false);
  });
});

describe("enforcement", () => {
  const guarded = [
    "src/routes/api.public.tokens.reserve.ts",
    "src/routes/api.public.seats.reserve.ts",
  ];

  it.each(guarded)("%s refuses a locked workspace with 402", (file) => {
    const text = readFileSync(file, "utf8");
    expect(text).toMatch(/assertGateOpen\(/);
    // 402 Payment Required, and the shared body — so a clone recognises the
    // refusal by shape rather than by which endpoint it hit.
    expect(text).toMatch(/gateLockedBody\(gate\),\s*402/);
  });

  it("release and commit stay open on a locked workspace", () => {
    // A locked workspace must still be able to unwind an in-flight signup and
    // finish work it already reserved; blocking those strands rows nobody can
    // clear.
    for (const file of [
      "src/routes/api.public.seats.release.ts",
      "src/routes/api.public.seats.commit.ts",
      "src/routes/api.public.tokens.commit.ts",
      "src/routes/api.public.tokens.cancel.ts",
    ]) {
      expect(readFileSync(file, "utf8")).not.toMatch(/assertGateOpen/);
    }
  });
});

describe("the public gate endpoint", () => {
  const text = readFileSync("src/routes/api.public.clones.gate.ts", "utf8");

  it("answers 503 on a failed read, never open", () => {
    // A read that FAILED is not a row that is ABSENT. Reporting a failure as
    // "not gated" would unlock the fleet on a database blip.
    expect(text).toMatch(/gate_read_failed/);
    expect(text).toMatch(/503/);
  });

  it("always carries a fallback pricing URL beside the one-click path", () => {
    // A CTA that can fail to mint a session must still lead somewhere a
    // customer can pay.
    expect(text).toMatch(/pricing_url/);
    expect(text).toMatch(/start_path/);
  });
});

describe("Stripe settles the gate on every route money can arrive by", () => {
  const webhook = readFileSync("src/routes/api.public.stripe.webhook.ts", "utf8");

  it("settles from the session, the subscription and the invoice", () => {
    expect(webhook).toMatch(/source: "stripe_checkout"/);
    expect(webhook).toMatch(/source: "stripe_subscription"/);
    expect(webhook).toMatch(/source: "stripe_invoice"/);
  });

  it("a credit top-up does not activate a workspace", () => {
    // A $50 pack must not open a $2,015/month plan.
    const set = /GATE_OPENING_MODES = new Set\(\[([^\]]*)\]\)/.exec(webhook)?.[1] ?? "";
    expect(set).toContain("seat_plan");
    expect(set).toContain("setup_package");
    expect(set).not.toContain("topup");
  });

  it("a refund records and warns but never re-locks by itself", () => {
    expect(webhook).toMatch(/payment_reversed/);
    // The only writes a refund makes are the event and the notification.
    const fn = /async function noteGateRefund[\s\S]*?\n}\n/.exec(webhook)?.[0] ?? "";
    expect(fn).not.toMatch(/manual_override/);
  });
});
