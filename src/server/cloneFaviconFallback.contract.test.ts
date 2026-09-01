/**
 * A clone with no brand of its own must paint the Aurixa mark in its tab.
 *
 * That guarantee is split across two repositories and neither half can see the
 * other. The clone template owns the fallback itself — `platformBrand.ts`, with
 * its own spec asserting the asset is an Aurixa file that exists and is not
 * shared with the notification icon or the apple-touch tile. This file owns
 * Mission Control's half, which is the quieter one: **do not put something else
 * there.**
 *
 * Both rules below are true today and neither is obvious from reading the code
 * that depends on them, which is exactly why they are pinned. The failure they
 * prevent is silent: a clone boots, looks healthy, and shows somebody else's
 * artwork — or the browser's blank-page glyph — in every operator's tab strip.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { WHITELABEL_COLUMN_SOURCES } from "./branding/sql";
import { buildApplySql } from "./branding/sql";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("provisioning leaves the favicon alone", () => {
  it("writes no branding of any kind into a new clone", () => {
    /*
      There is no branding step in provisioning, and that is what makes the
      template's fallback the thing a fresh clone paints. Add one that seeds a
      favicon and every future clone silently stops using the platform mark —
      with nothing failing, because a written favicon is indistinguishable from
      a tenant's own.

      Asserted against the source rather than by running it: the write would be
      a Management API call or an `execute_sql`, and either is far cheaper to
      forbid by name here than to catch on a provisioned tenant.
    */
    const source = read("src/server/backend-provisioning.server.ts");
    const code = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
      .join("\n");

    expect(code).not.toMatch(/favicon/i);
    expect(code).not.toMatch(/whitelabel_settings/i);
    expect(code).not.toMatch(/buildApplySql/);
  });
});

describe("the white-label cascade cannot blank a favicon", () => {
  const sql = buildApplySql({
    brand_config: { brand_name: "Example" } as never,
    report_contact: {} as never,
    config_hash: "hash",
  });

  it("maps the favicon column from favicon_url and nowhere else", () => {
    const favicon = WHITELABEL_COLUMN_SOURCES.filter((c) => c.column === "favicon");
    expect(favicon).toHaveLength(1);
    expect(favicon[0]!.from).toBe("favicon_url");
  });

  it("writes the column only when the bundle carries a non-empty value", () => {
    /*
      The guard is what makes "an unbranded clone" a real state rather than an
      accident. Without it a brand profile with no favicon would UPDATE the
      column to null or to an empty string, and `faviconFor` reads the stored
      value: a blank string is falsy and still resolves to the platform mark,
      but a write is a write, and the next reader to add `?? ''` semantics
      inherits a column that says a tenant chose emptiness rather than one that
      says a tenant never chose.
    */
    const clause = sql.slice(sql.indexOf("'favicon'"));
    expect(clause).toContain("nullif(trim(_wl->>'favicon_url'), '') IS NOT NULL");
  });

  it("binds the value rather than interpolating it into the statement", () => {
    // A favicon is a URL an operator types. Interpolating it would make the
    // branding cascade an injection surface reachable from a text field.
    expect(sql).not.toMatch(/SET favicon = '/);
    expect(sql).toContain("USING trim(_wl->>'favicon_url')");
  });
});
