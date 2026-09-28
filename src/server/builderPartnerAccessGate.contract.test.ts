/**
 * The Builder Partner Agreement gate, held at the source.
 *
 * ## Why at the source
 *
 * An organisation reaches the Builder Portal by one network operation,
 * `approve_organisation`, and Mission Control is what calls it. So the gate
 * holds if and only if EVERY call site in this repository decides on an
 * agreement first — which is a property of the source, and one no unit test
 * of the decision can see. `decideBuilderAccessGate` can be perfect while a
 * third button calls the network without asking it.
 *
 * So the call sites are DERIVED rather than listed, for the reason
 * `serverExportsHaveCallers.contract.test.ts` gives: a hand-list cannot see
 * the call it does not mention. A new way to approve an organisation fails
 * here the day it is added, and the only way to make it pass is to say, in
 * this file, why it may.
 *
 * ## And the waitlist, pinned the other way
 *
 * The website's application route and its guard create the access request
 * and the pending organisation; that pipeline is not to be touched. These
 * assertions keep it that way structurally: the intake reaches nothing
 * agreement-shaped, nothing agreement-shaped submits an application, and the
 * agreement machinery's only write to the network is the approval itself.
 * The agreement sits at the point the pipeline already hands to a person —
 * approval — and nowhere upstream of it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "./sourceComments.pure";

const INTAKE_ROUTE = "src/routes/api.public.builders.apply.ts";
const INTAKE_GUARD = "src/server/builderApplyGuard.pure.ts";
const CONSOLE = "src/server/builders-network.functions.ts";
const ENGINE = "src/server/builder-partner-agreements.server.ts";

/** Every production module under `src/`, as code (comments removed, strings kept). */
function productionSources(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules") walk(p);
      } else if (/\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p)) {
        out.set(p, stripComments(readFileSync(p, "utf8")));
      }
    }
  };
  walk("src");
  return out;
}

const SOURCES = productionSources();

function source(file: string): string {
  const src = SOURCES.get(file);
  if (src === undefined) throw new Error(`${file} is not in the scanned sources`);
  return src;
}

/** A call to the network's admin operation `op`, however it is spaced or quoted. */
function networkCall(op: string): RegExp {
  return new RegExp(`callBuilderNetworkAdmin\\(\\s*["'\`]${op}["'\`]`, "g");
}

/**
 * The top-level declaration that encloses `at`: from its `function` or
 * `export const` to the next top-level declaration. A server function is an
 * `export const … = createServerFn(…)`, so both shapes are declarations.
 */
function enclosing(src: string, at: number): { name: string; body: string } {
  const decl = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*=/gm;
  let current = { name: "(module)", start: 0 };
  let end = src.length;
  for (const m of src.matchAll(decl)) {
    const index = m.index ?? 0;
    if (index <= at) {
      current = { name: m[1] ?? m[2] ?? "(anonymous)", start: index };
    } else {
      end = index;
      break;
    }
  }
  return { name: current.name, body: src.slice(current.start, end) };
}

/** Every place in production that calls network operation `op`, as `file:enclosing`. */
function callSites(op: string): string[] {
  const sites: string[] = [];
  for (const [file, src] of SOURCES) {
    for (const m of src.matchAll(networkCall(op))) {
      sites.push(`${file}:${enclosing(src, m.index ?? 0).name}`);
    }
  }
  return sites.sort();
}

function bodyOf(file: string, name: string): string {
  const src = source(file);
  const at = src.search(
    new RegExp(`^(?:export\\s+)?(?:async\\s+)?(?:function|const)\\s+${name}\\b`, "m"),
  );
  expect(at, `${name} is declared in ${file}`).toBeGreaterThan(-1);
  return enclosing(src, at).body;
}

describe("admitting an organisation to the Builder Portal", () => {
  it("happens in exactly two places, and nowhere else can call it", () => {
    expect(callSites("approve_organisation")).toEqual([
      `${ENGINE}:grantBuilderPortalAccess`,
      `${CONSOLE}:approveNetworkOrganisation`,
    ]);
  });

  it("from the console, only after the gate has been read and has allowed it", () => {
    const body = bodyOf(CONSOLE, "approveNetworkOrganisation");
    const gate = body.indexOf("assessBuilderAccessGate(");
    const refusal = body.indexOf("if (!decision.allow)");
    const call = body.search(networkCall("approve_organisation"));
    expect(gate).toBeGreaterThan(-1);
    expect(refusal).toBeGreaterThan(gate);
    expect(call).toBeGreaterThan(refusal);
    // A gate that cannot be read refuses; it never falls through to approve.
    const unreadable = body.indexOf('"agreement_gate_unreadable"');
    expect(unreadable).toBeGreaterThan(gate);
    expect(unreadable).toBeLessThan(call);
    // The basis travels with the approval, where the network logs it.
    expect(body.slice(call)).toContain("reason: approvalBasisReason(decision)");
  });

  it("the gate is decided on the server, from what it reads at that moment", () => {
    const body = bodyOf(ENGINE, "assessBuilderAccessGate");
    expect(body).toContain("decideBuilderAccessGate(");
    expect(body).toContain("readTermsInForce(");
  });

  it("from a signature, only for a signed agreement, claimed before the network is asked", () => {
    const body = bodyOf(ENGINE, "grantBuilderPortalAccess");
    const decide = body.indexOf("decideGrantAttempt(");
    const claim = body.indexOf('portal_access_status: "pending"');
    const call = body.search(networkCall("approve_organisation"));
    expect(decide).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(decide);
    expect(call).toBeGreaterThan(claim);
    // The claim is conditional on the agreement BEING signed, in the database,
    // so an agreement voided a moment ago cannot be granted on.
    expect(body.slice(claim, call)).toContain('.eq("status", "signed")');
    expect(body.slice(decide, call)).toContain('if (decision.action === "skip")');
  });

  it("reinstating a suspended organisation is not a way round the gate", () => {
    // It restores an organisation that was admitted — agreement and all —
    // before it was suspended, and it does not call the approval operation.
    const body = bodyOf(CONSOLE, "reinstateNetworkOrganisation");
    expect(body).toMatch(networkCall("reinstate_organisation"));
    expect(body).not.toMatch(networkCall("approve_organisation"));
  });
});

describe("the waitlist pipeline", () => {
  it("is the only thing that submits an application", () => {
    expect(callSites("submit_access_request")).toEqual([`${INTAKE_ROUTE}:Route`]);
  });

  it("reaches nothing agreement-shaped", () => {
    for (const file of [INTAKE_ROUTE, INTAKE_GUARD]) {
      const src = source(file);
      const imports = [...src.matchAll(/^import\b[\s\S]*?\bfrom\s+["']([^"']+)["']/gm)].map(
        (m) => m[1],
      );
      // The route imports plenty; the guard is pure and imports nothing. A
      // scan that found no imports in the route would be checking nothing.
      if (file === INTAKE_ROUTE) expect(imports.length).toBeGreaterThan(0);
      for (const specifier of imports) expect(specifier).not.toMatch(/agreement|builderPartner/i);
      expect(src).not.toMatch(/client_agreements|builder_partner|BuilderPartner/);
    }
  });

  it("is written to by the agreements only by approval — everything else they ask is a read", () => {
    const ops = new Set(
      [...source(ENGINE).matchAll(/callBuilderNetworkAdmin\(\s*["'`]([a-z_]+)["'`]/g)].map(
        (m) => m[1],
      ),
    );
    expect([...ops].sort()).toEqual([
      "approve_organisation",
      "list_access_requests",
      "list_organisations",
    ]);
  });
});
