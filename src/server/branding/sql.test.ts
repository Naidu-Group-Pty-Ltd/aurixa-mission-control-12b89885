import { describe, expect, it } from "vitest";
import { buildApplySql, primeContactPayload, WHITELABEL_COLUMN_SOURCES } from "./sql";

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

  it("does not write theme_config or logo_config", () => {
    // Structured columns the prime's BrandProvider and nine PDF renderers
    // parse. A bundle field with no column has no home here, and dropping it
    // is honest; writing it into one of these makes a column mean two things.
    const out = sql();
    expect(out).not.toContain("theme_config");
    expect(out).not.toContain("logo_config");
  });
});
