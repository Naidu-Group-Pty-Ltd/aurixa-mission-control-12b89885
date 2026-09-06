import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildApplySql, primeContactPayload, WHITELABEL_COLUMN_SOURCES } from "./sql";
import { BRAND_MARK_SLOTS, markLogoConfigSources, missingMarks } from "@/lib/brand/marks";
import { CLONE_BRAND_BUCKET } from "./mirror";

describe("primeContactPayload", () => {
  it("maps the bundle's contact_* keys onto the keys the prime reads", () => {
    const payload = primeContactPayload({
      contact_name: "Sam Owner",
      contact_email: "hello@acme.example",
      contact_phone: "02 9000 0000",
      contact_address: "1 Quay St, Sydney NSW",
      contact_website: "acme.example",
      legal_name: "Acme Property Co Pty Ltd",
      abn: "12 345 678 901",
      licence_number: "RE 12345",
    });
    // The prime's `contact_details` keys (snapshot.pure.ts).
    expect(payload.name).toBe("Acme Property Co Pty Ltd");
    expect(payload.company_name).toBe("Acme Property Co Pty Ltd");
    expect(payload.abn).toBe("12 345 678 901");
    expect(payload.licence_number).toBe("RE 12345");
    expect(payload.email).toBe("hello@acme.example");
    expect(payload.phone).toBe("02 9000 0000");
    expect(payload.address).toBe("1 Quay St, Sydney NSW");
    expect(payload.website).toBe("acme.example");
    // The original keys survive for anything that learned to read them.
    expect(payload.contact_name).toBe("Sam Owner");
  });

  it("falls back to the contact name when no legal name is set, and drops blanks", () => {
    const payload = primeContactPayload({
      contact_name: "Sam Owner",
      contact_email: "  ",
      abn: "",
    });
    expect(payload.name).toBe("Sam Owner");
    expect("email" in payload).toBe(false);
    expect("abn" in payload).toBe(false);
  });

  it("is inlined into the apply SQL", () => {
    const sql = buildApplySql({
      brand_config: { brand_name: "Acme" },
      report_contact: { legal_name: "Acme Pty Ltd", abn: "12 345 678 901" },
      config_hash: "abc123",
    });
    expect(sql).toContain('"abn":"12 345 678 901"');
    expect(sql).toContain('"name":"Acme Pty Ltd"');
  });
});

describe("buildApplySql — against the schema that actually exists", () => {
  const sql = () =>
    buildApplySql({
      brand_config: {
        brand_name: "Acme Property Co",
        primary_color: "#0B1F3A",
        favicon_url: "https://cdn.example/fav.ico",
      },
      report_contact: {
        legal_name: "Acme Property Co Pty Ltd",
        contact_email: "notifications@send.acme.example",
      },
      config_hash: "h1",
    });

  /** The same bundle, carrying every mark a workspace can hold. */
  const marked = () =>
    buildApplySql({
      brand_config: {
        brand_name: "Acme Property Co",
        logo_light_url: "https://cdn.example/logo.png",
        logo_dark_url: "https://cdn.example/logo-dark.png",
        icon_url: "https://cdn.example/icon.png",
        favicon_url: "https://cdn.example/fav.ico",
        report_logo_url: "https://cdn.example/report.png",
        report_logo_mono_url: "https://cdn.example/report-mono.png",
      },
      report_contact: { legal_name: "Acme Property Co Pty Ltd" },
      config_hash: "h2",
    });

  it("writes global_report_settings as the KEY/VALUE table it is", () => {
    // `(setting_key unique, setting_value jsonb)` in the prime's own first
    // migration and in every clone built from it. The previous version wrote a
    // `contact_details` COLUMN, which answers 42703 and aborts the whole DO
    // block — so the cascade could never write anything, which is why a
    // provisioned clone's settings table was empty and its from-header fell
    // back to the prime's legacy address.
    const out = sql();
    expect(out).toContain("INSERT INTO public.global_report_settings (setting_key, setting_value)");
    expect(out).toContain("ON CONFLICT (setting_key) DO UPDATE");
  });

  it("never writes a bare `SET contact_details =` or `SET settings =` unguarded", () => {
    const out = sql();
    // Both legacy shapes may still be written, but only inside an
    // information_schema guard — never as the only path.
    for (const legacy of ["contact_details", "settings"]) {
      const idx = out.indexOf(`SET ${legacy} =`);
      if (idx === -1) continue;
      expect(out.slice(0, idx)).toContain(`column_name='${legacy}'`);
    }
  });

  it("guards every whitelabel column on information_schema", () => {
    const out = sql();
    for (const { column } of WHITELABEL_COLUMN_SOURCES) {
      expect(out).toContain(`column_name='${column}'`);
    }
  });

  it("establishes the whitelabel row before updating it", () => {
    // A clone is provisioned with this table EMPTY, so "update the newest row"
    // updated nothing at all even where the column names were right.
    const out = sql();
    const insertAt = out.indexOf("INSERT INTO public.whitelabel_settings DEFAULT VALUES");
    const selectAt = out.indexOf("SELECT id INTO _wl_id");
    expect(insertAt).toBeGreaterThan(-1);
    expect(selectAt).toBeGreaterThan(insertAt);
  });

  it("binds values as parameters rather than interpolating them", () => {
    const out = buildApplySql({
      brand_config: { brand_name: "O'Brien & Co -- DROP" },
      report_contact: {},
      config_hash: "h2",
    });
    // The name reaches the database inside the dollar-quoted jsonb payload and
    // is read back out with `->>` into a bound parameter; it never appears as
    // a bare SQL string literal in an UPDATE.
    expect(out).not.toContain("SET company_name = 'O''Brien");
    expect(out).toContain("USING trim(_wl->>'brand_name'), _wl_id");
  });

  it("still does not write theme_config", () => {
    // A structured column the prime's BrandProvider parses. A bundle field
    // with no column has no home here, and dropping it is honest; writing it
    // into this one makes a column mean two things.
    expect(sql()).not.toContain("theme_config");
  });

  it("writes logo_config as a MERGE of named keys, never a replacement", () => {
    // The rule that let this column be written at all: only the keys named in
    // marks.ts, one at a time, merged into whatever the workspace already
    // holds. A key this platform has never heard of survives.
    const out = marked();
    expect(out).toContain("SET logo_config = COALESCE(logo_config, ''{}''::jsonb) || $1");
    expect(out).not.toMatch(/SET logo_config\s*=\s*\$1/);
    // Every key comes from the map, and no other.
    for (const { key } of markLogoConfigSources()) {
      expect(out).toContain(`jsonb_build_object('${key}'`);
    }
    const emitted = [...out.matchAll(/jsonb_build_object\('([A-Za-z]+)'/g)].map((m) => m[1]);
    expect(new Set(emitted)).toEqual(new Set(markLogoConfigSources().map((s) => s.key)));
  });

  it("leaves logo_config alone when the bundle carries no mark", () => {
    // An unbranded workspace must come out of a cascade exactly as it went in.
    // The guard is in the SQL rather than in the generator, because the values
    // are read inside the block.
    expect(sql()).toContain("IF _marks <> '{}'::jsonb THEN");
  });

  it("fills the interface columns AND the map, because they are read separately", () => {
    // The defect this closes: the columns dress the sign-in page and the
    // sidebar, while every generated document reads logo_config. Filling one
    // and not the other is a workspace that looks branded and prints unmarked.
    const out = marked();
    expect(out).toContain("'auth_logo'");
    expect(out).toContain("'sidebar_logo'");
    expect(out).toContain("'sidebar_icon'");
    expect(out).toContain("'favicon'");
    expect(out).toContain("jsonb_build_object('report'");
    expect(out).toContain("jsonb_build_object('reportMono'");
  });

  it("never interpolates a mark URL into the SQL", () => {
    // Same rule as every other value here: the payload is dollar-quoted once
    // and every write binds out of it.
    const out = marked();
    const body = out.slice(out.indexOf("BEGIN"));
    expect(body).not.toContain("https://cdn.example/report.png");
  });
});

describe("BRAND_MARK_SLOTS", () => {
  it("covers every logo_config key the workspace's renderers read", () => {
    // assets.pure.ts: 'report' | 'reportMono' | 'sidebar' | 'auth' |
    // 'sidebarIcon' | 'cover'. `cover` is a photograph a report supplies per
    // document, not a brand mark, so it is deliberately not here.
    expect(new Set(markLogoConfigSources().map((s) => s.key))).toEqual(
      new Set(["auth", "sidebar", "sidebarIcon", "favicon", "report", "reportMono"]),
    );
  });

  it("maps the ambiguous dark logo to nothing at all", () => {
    // "Logo (dark)" means the dark lockup for a light ground in half the brand
    // kits that ship one and the knockout for a dark ground in the other half.
    // Guessing puts an invisible mark on a client's cover, so the knockout has
    // a slot of its own and this one is cascaded nowhere.
    const dark = BRAND_MARK_SLOTS.find((s) => s.field === "logo_dark_url");
    expect(dark).toBeDefined();
    expect(dark?.columns).toEqual([]);
    expect(dark?.logoKeys).toEqual([]);
  });

  it("names each mark once", () => {
    const fields = BRAND_MARK_SLOTS.map((s) => s.field);
    expect(new Set(fields).size).toBe(fields.length);
    const keys = markLogoConfigSources().map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("reports what a workspace is missing without calling it broken", () => {
    const missing = missingMarks({ logo_light_url: "https://cdn.example/logo.png" });
    expect(missing.map((s) => s.field)).not.toContain("logo_light_url");
    expect(missing.map((s) => s.field)).toContain("report_logo_url");
    expect(missingMarks(null)).toHaveLength(BRAND_MARK_SLOTS.length);
  });
});

describe("CLONE_BRAND_BUCKET", () => {
  it("is the bucket a workspace actually has", () => {
    // It was "branding". No deployment of this platform has ever had a bucket
    // by that name — the prime's is branding-assets, public, and so is every
    // clone's, because a clone is built from the prime's schema. Storage
    // answers 404, mirroring is best-effort, and the cascade reported success
    // with every asset dropped.
    expect(CLONE_BRAND_BUCKET).toBe("branding-assets");
  });

  it("is what the apply pipeline passes, rather than a literal beside it", () => {
    const src = readFileSync(new URL("../branding.server.ts", import.meta.url), "utf8");
    expect(src).toContain("cloneBucket: CLONE_BRAND_BUCKET");
    expect(src).not.toContain('cloneBucket: "');
  });
});
