import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { classifySecret } from "./prime-backend.server";
import {
  decideLlmKeyMint,
  llmProviderFor,
  LLM_PROVIDERS,
  LLM_SECRET_NAMES,
  MINTED_STATUS,
  mintedKeyLabel,
} from "./llmKeyProvisioning.pure";

const MIGRATION = "supabase/migrations/20260911020000_minted_llm_key_status.sql";
const read = (p: string) => readFileSync(p, "utf8");

const facts = (over: Partial<Parameters<typeof decideLlmKeyMint>[0]> = {}) => ({
  secretName: "OPENROUTER_API_KEY",
  ledgerStatus: null as string | null,
  credentialPresent: true,
  backendProvisioned: true,
  ...over,
});

describe("the five model credentials", () => {
  it("covers exactly the names a model call can spend", () => {
    // Mirrors the prime's `llmUsageBinding.pure.ts`. A name here that the
    // router never spends would mint a key nothing uses; one missing would
    // leave a provider on the undifferentiated fleet key with nothing saying
    // so.
    expect([...LLM_SECRET_NAMES].sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "GEMINI_API_KEY",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
      "PERPLEXITY_API_KEY",
    ]);
    expect(LLM_PROVIDERS.map((p) => p.secretName).sort()).toEqual([...LLM_SECRET_NAMES].sort());
  });

  it("Anthropic is console-only, and says the rule rather than a missing setting", () => {
    // Quoted from Anthropic's own documentation: "Can I create new API keys
    // through the Admin API? No." Reporting that as an absent credential
    // would send an operator to set one, and there is nothing to set.
    const anthropic = llmProviderFor("ANTHROPIC_API_KEY")!;
    expect(anthropic.mint).toBe("console_only");
    expect(anthropic.provisioningEnv).toBeNull();
    expect(anthropic.manualRemedy).toBeTruthy();
    expect(anthropic.manualRemedy).toMatch(/nothing here is missing or misconfigured/i);
  });

  it("every mintable provider names the credential that authorises it", () => {
    for (const p of LLM_PROVIDERS.filter((x) => x.mint === "api")) {
      expect(p.provisioningEnv, `${p.label} must name its provisioning credential`).toBeTruthy();
      expect(p.manualRemedy, `${p.label} mints, so it needs no manual remedy`).toBeNull();
    }
  });

  it("has an implementation for every provider it marks mintable", () => {
    // The server module's switch throws on an unmapped name. Marking a
    // provider `api` without a branch would turn a provisioning run into a
    // thrown error per clone, for ever.
    const server = read("src/server/llmKeyProvisioning.server.ts");
    for (const p of LLM_PROVIDERS.filter((x) => x.mint === "api")) {
      expect(server, `${p.secretName} needs a mint branch`).toContain(`case "${p.secretName}":`);
    }
    expect(server).not.toContain('case "ANTHROPIC_API_KEY":');
  });
});

describe("whether to mint", () => {
  it("mints where the credential is held and nothing is recorded", () => {
    const v = decideLlmKeyMint(facts());
    expect(v.act).toBe(true);
  });

  it("NEVER overwrites a key the tenant supplied", () => {
    // The reported requirement, inverted: a workspace that brought its own
    // key is charged nothing for it, and minting over that value puts those
    // calls back on Aurixa's account.
    const v = decideLlmKeyMint(facts({ ledgerStatus: "set" }));
    expect(v.act).toBe(false);
    if (v.act) return;
    expect(v.reason).toBe("tenant_supplied");
    expect(v.actionable).toBe(false);
  });

  it("the tenant's key outranks every other condition", () => {
    // Ordered first on purpose. No missing credential, no unprovisioned
    // backend and no console-only vendor may reach past it.
    for (const over of [
      { credentialPresent: false },
      { backendProvisioned: false },
      { secretName: "ANTHROPIC_API_KEY" },
    ]) {
      const v = decideLlmKeyMint(facts({ ledgerStatus: "set", ...over }));
      expect(v.act).toBe(false);
      if (v.act) return;
      expect(v.reason, JSON.stringify(over)).toBe("tenant_supplied");
    }
  });

  it("mints once, ever", () => {
    const v = decideLlmKeyMint(facts({ ledgerStatus: MINTED_STATUS }));
    expect(v.act).toBe(false);
    if (v.act) return;
    expect(v.reason).toBe("already_minted");
  });

  it("still mints over a forwarded key — that is the whole point", () => {
    // `inherited` is the state every clone is in today. If this refused, the
    // feature would only ever apply to clones provisioned after it shipped.
    expect(decideLlmKeyMint(facts({ ledgerStatus: "inherited" })).act).toBe(true);
    expect(decideLlmKeyMint(facts({ ledgerStatus: "missing" })).act).toBe(true);
    expect(decideLlmKeyMint(facts({ ledgerStatus: "authorised_no_value" })).act).toBe(true);
  });

  it("separates 'there is nothing to set' from 'you have not set it'", () => {
    // Two refusals that look alike and have opposite remedies: one is a
    // vendor's published limitation, the other is a credential an operator
    // adds to Mission Control.
    const anthropic = decideLlmKeyMint(facts({ secretName: "ANTHROPIC_API_KEY" }));
    const unset = decideLlmKeyMint(facts({ credentialPresent: false }));
    expect(anthropic.act).toBe(false);
    expect(unset.act).toBe(false);
    if (anthropic.act || unset.act) return;
    expect(anthropic.reason).toBe("no_provisioning_api");
    expect(anthropic.actionable).toBe(false);
    expect(unset.reason).toBe("no_credential");
    expect(unset.actionable).toBe(true);
    // And the actionable one names what to set, and says the fleet key still
    // works meanwhile — a workspace is not broken by this being unconfigured.
    expect(unset.message).toContain("OPENROUTER_PROVISIONING_KEY");
    expect(unset.message).toMatch(/keeps working/i);
  });

  it("refuses a name that is not a model credential", () => {
    const v = decideLlmKeyMint(facts({ secretName: "RESEND_API_KEY" }));
    expect(v.act).toBe(false);
    if (v.act) return;
    expect(v.reason).toBe("not_an_llm_secret");
  });
});

describe("the three edits that fail silently apart", () => {
  it("1. the column accepts `minted`", () => {
    // A value the CHECK refuses is rejected by the server while looking, from
    // the function that tried it, exactly like a write nobody attempted.
    const sql = read(MIGRATION);
    expect(sql).toMatch(/CHECK \(status IN \([^)]*'minted'/s);
  });

  it("2. the rating charges for it, because it is Aurixa's money", () => {
    // `resolve_api_key_billability`'s fallthrough is `ELSE 'no_key'`, which is
    // NOT billable. Adding the status without this arm would have Aurixa pay
    // the vendor and recharge nobody, with every reading green throughout.
    const sql = read(MIGRATION);
    expect(sql).toMatch(/WHEN 'minted'\s+THEN 'inherited'/);
    // And the arm it maps onto is one the rating actually bills.
    const rating = read("supabase/migrations/20260908110000_absorbed_vendor_cost.sql");
    expect(rating).toMatch(/_reason IN\('inherited','brokered'\)\s*THEN _billable:=true/);
  });

  it("3. the fleet sweep leaves it alone", () => {
    // Otherwise the half-hourly reconcile writes the shared fleet key over the
    // minted one and the ledger flips back to `inherited` — the minting
    // undoing itself within thirty minutes, silently.
    const sweep = read("src/server/fleetSecretForward.server.ts");
    expect(sweep).toMatch(/const SETTLED = new Set\(\["inherited", "set", "minted"\]\)/);
  });

  it("`minted` is neither of the two statuses whose consequences it must not inherit", () => {
    expect(MINTED_STATUS).toBe("minted");
    expect(MINTED_STATUS).not.toBe("set");
    expect(MINTED_STATUS).not.toBe("inherited");
  });
});

describe("it is actually called", () => {
  it("runs on the half-hourly clone-secrets sweep", () => {
    // A pure module nothing calls is a rule that does not exist — and a
    // minting step wired only into provisioning would apply to none of the
    // clones that exist today, every one of which runs on the forwarded key.
    const hook = read("src/routes/hooks.clone-secrets-reconcile.tsx");
    expect(hook).toContain("reconcileLlmKeys");
  });

  it("cannot fail the sweep it rides on", () => {
    // The other three repairs fix things a clone is BROKEN without. Minting
    // improves attribution on a workspace that already works, so a vendor
    // being unreachable must not cost the other three their run.
    const hook = read("src/routes/hooks.clone-secrets-reconcile.tsx");
    const call = hook.indexOf("await reconcileLlmKeys(supabaseAdmin)");
    const guard = hook.lastIndexOf("try {", call);
    const catchAfter = hook.indexOf("} catch", call);
    expect(call).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(-1);
    expect(catchAfter).toBeGreaterThan(call);
    expect(hook).toContain('console.error("LLM key reconcile failed:"');
  });

  it("leaves the five names forwarding as the floor", () => {
    // Deliberately NOT reclassified as tenant_scoped or brokered. If
    // provisioning stopped forwarding the fleet key, a clone whose minting
    // failed would hold no model key at all — worse than today. Minting
    // UPGRADES `inherited` to `minted`, which is why the decision returns
    // act:true on `inherited`, and why a minting outage degrades to exactly
    // today's behaviour rather than to a workspace that cannot think.
    for (const name of LLM_SECRET_NAMES) {
      expect(classifySecret(name), `${name} must still forward`).toBe("vendor");
    }
  });
});

describe("an operator can see which key a clone is spending", () => {
  it("the secrets page carries every status the column accepts", () => {
    // `STATUS_META[row.status]` is read straight into `meta.variant`, so a
    // status the map does not carry is `undefined` and the row throws. The map
    // listed four while the column accepted six — `withheld` and
    // `authorised_no_value` are both live today — so the page was crashing on
    // exactly the clones whose secrets most needed looking at.
    const page = read("src/routes/clones.$cloneId.secrets.tsx");
    const migration = read(MIGRATION);
    const accepted = [...migration.matchAll(/'([a-z_]+)'/g)]
      .map((m) => m[1])
      .filter((v) =>
        [
          "missing",
          "set",
          "failed",
          "inherited",
          "authorised_no_value",
          "withheld",
          "minted",
        ].includes(v),
      );
    expect(new Set(accepted).size).toBe(7);
    for (const status of new Set(accepted)) {
      expect(page, `the page must render ${status}`).toMatch(
        new RegExp(`(^|\\s)${status}: \\{`, "m"),
      );
    }
  });

  it("an unrecognised status degrades to a readable row, never a blank page", () => {
    // The eighth status will be added by somebody who is not looking at this
    // file. It must cost them a row that says "unknown", not a page that
    // throws.
    const page = read("src/routes/clones.$cloneId.secrets.tsx");
    expect(page).toContain("function statusMeta(");
    expect(page).toContain("const meta = statusMeta(row.status);");
    // Judged over CODE lines only: the header above quotes the old expression
    // while explaining why it was wrong, and a prose mention is not a call.
    const codeLines = page
      .split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    expect(codeLines).not.toContain("STATUS_META[row.status]");
  });
});

describe("what the vendor's dashboard shows", () => {
  it("leads with the clone, because that is what it exists to answer", () => {
    expect(mintedKeyLabel("NPC Test")).toBe("aurixa-npc-test");
    expect(mintedKeyLabel("Preflight Property Group")).toBe("aurixa-preflight-property-group");
  });

  it("survives a name a vendor would reject", () => {
    const label = mintedKeyLabel("Acme & Co. (AU)/Pty");
    expect(label).toMatch(/^[a-z0-9._-]+$/);
    expect(label).not.toMatch(/--/);
  });

  it("is bounded, and never ends on a separator", () => {
    const label = mintedKeyLabel("x".repeat(200));
    expect(label.length).toBeLessThanOrEqual(64);
    expect(label.endsWith("-")).toBe(false);
  });
});

describe("minting never costs a workspace its boot", () => {
  it("a failed read is never treated as an empty ledger", () => {
    // Treating it as empty would decide every name looks unminted — and then
    // overwrite a tenant's own key on the very next line.
    const server = read("src/server/llmKeyProvisioning.server.ts");
    expect(server).toContain("if (ledger.error)");
    expect(server).toMatch(/A read that FAILED is not a ledger that is EMPTY/i);
  });

  it("reports each name separately, so one vendor cannot stop the others", () => {
    const server = read("src/server/llmKeyProvisioning.server.ts");
    // Every failure path continues the loop rather than returning.
    for (const reason of ["mint_failed", "write_failed", "ledger_failed"]) {
      expect(server).toContain(`reason: "${reason}"`);
    }
    expect(server).toContain("for (const provider of LLM_PROVIDERS)");
  });

  it("tells a key that exists at the vendor from one that does not", () => {
    // The two need different remedies: a `write_failed` key is real and
    // orphaned, where `mint_failed` created nothing. Reporting both as one
    // would either strand a live credential or scare an operator off a safe
    // retry.
    const server = read("src/server/llmKeyProvisioning.server.ts");
    expect(server).toMatch(/minted a key and it could not be written/);
  });
});
