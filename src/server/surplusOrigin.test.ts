/**
 * Classifying a surplus object: the prime's leftover, or the tenant's own.
 *
 * The rule this protects: dropping the prime's leftover is tidying, dropping
 * the tenant's own destroys their data, and the clone's live schema cannot
 * tell you which — both are "a table that is here and not there". The prime's
 * migration history can, and that is the only evidence admitted here.
 *
 * Nothing in this module drops anything. Every assertion below is about what
 * is CLAIMED.
 */
import { describe, expect, it } from "vitest";
import {
  classifySurplus,
  summariseSurplusOrigin,
  type MigrationObjectIndex,
} from "./surplusOrigin.pure";

const INDEX: MigrationObjectIndex = {
  schema_version: 1,
  migration_files: 1015,
  created: [
    "table:public.builder_design_images",
    "table:public.clients",
    "function:public.calculate_data_quality_score",
    "index:idx_clients_email",
  ],
  dropped: ["table:public.builder_design_images", "function:public.calculate_data_quality_score"],
};

describe("an object the prime created and no longer has is the prime's leftover", () => {
  it("names the case that started this", () => {
    const [c] = classifySurplus(["tables:public.builder_design_images"], INDEX);
    expect(c.verdict).toBe("prime_dropped");
    expect(c.explicitlyDropped).toBe(true);
    expect(c.detail).toContain("leftover");
  });

  it("separates an explicit DROP from mere absence", () => {
    // The prime created it and does not have it now, but no migration drops
    // it. Weaker evidence, and said so rather than rounded up.
    const [c] = classifySurplus(["tables:public.clients"], INDEX);
    expect(c.verdict).toBe("prime_dropped");
    expect(c.explicitlyDropped).toBe(false);
    expect(c.detail).toContain("confirm before acting");
  });

  it("matches an unqualified name in the index against a qualified surplus", () => {
    // The generator stores what the statement wrote: `create index idx_x`
    // records `idx_x`, while parity reports the qualified form.
    const [c] = classifySurplus(["indexes:public.idx_clients_email"], INDEX);
    expect(c.verdict).toBe("prime_dropped");
  });
});

describe("an object the prime never created is the TENANT'S, and is protected", () => {
  it("says so, and says it must not be removed", () => {
    const [c] = classifySurplus(["tables:public.tenant_invoices"], INDEX);
    expect(c.verdict).toBe("never_the_primes");
    expect(c.detail).toContain("must not be removed");
  });

  it("is reached only from a usable index, never from an empty one", () => {
    for (const bad of [
      null,
      undefined,
      { ...INDEX, created: [] },
      { ...INDEX, schema_version: 2 },
    ] as (MigrationObjectIndex | null | undefined)[]) {
      const [c] = classifySurplus(["tables:public.tenant_invoices"], bad);
      expect(c.verdict).toBe("undetermined");
    }
  });
});

describe("absent evidence is never permission", () => {
  it("an unreadable index makes everything undetermined, not clear", () => {
    const out = classifySurplus(
      ["tables:public.builder_design_images", "tables:public.tenant_invoices"],
      null,
    );
    expect(out.map((c) => c.verdict)).toEqual(["undetermined", "undetermined"]);
    expect(out[0].detail).toContain("Nothing is claimed");
  });

  it("a newer index schema is not assumed to be readable", () => {
    // Reading a v2 index with v1 rules is how a class this version cannot see
    // becomes "the prime never created it" — a tenant's object offered up for
    // removal on a misparse.
    const [c] = classifySurplus(["tables:public.builder_design_images"], {
      ...INDEX,
      schema_version: 99,
    });
    expect(c.verdict).toBe("undetermined");
  });

  it("a class the index does not cover is undetermined, not the tenant's", () => {
    for (const entry of ["edge_functions:some-fn", "constraints:public.clients_pkey"]) {
      expect(classifySurplus([entry], INDEX)[0].verdict).toBe("undetermined");
    }
  });
});

describe("the summary says what it is not", () => {
  it("counts each verdict and states that nothing is dropped", () => {
    const s = summariseSurplusOrigin(
      [
        "tables:public.builder_design_images",
        "tables:public.tenant_invoices",
        "edge_functions:x",
      ],
      INDEX,
    );
    expect(s.counts).toEqual({ prime_dropped: 1, never_the_primes: 1, undetermined: 1 });
    expect(s.line).toContain("nothing is dropped");
  });

  it("says nothing at all when there is no surplus", () => {
    expect(summariseSurplusOrigin([], INDEX).line).toBe("");
  });
});

describe("no verdict can be read as authorisation", () => {
  it("no detail line tells anybody to remove anything", () => {
    const all = classifySurplus(
      ["tables:public.builder_design_images", "tables:public.clients", "tables:public.tenant_x"],
      INDEX,
    );
    for (const c of all) {
      expect(c.detail.toLowerCase()).not.toMatch(/\b(safe to (drop|remove)|you may (drop|remove))\b/);
    }
  });

  it("the module contains no DDL and no delete", () => {
    // The whole point: it classifies, and something else — a person — decides.
    const src = readFileSync("src/server/surplusOrigin.pure.ts", "utf8");
    expect(src.toLowerCase()).not.toMatch(/\bdrop\s+(table|function|index|trigger|view)\b/);
    expect(src).not.toContain(".delete(");
  });
});

import { readFileSync } from "node:fs";
