import { describe, expect, it } from "vitest";
import { composeAccessEmail, lifetimeWords } from "./accessEmail.pure";

describe("composeAccessEmail", () => {
  it("escapes the workspace name and states the lifetime", () => {
    const m = composeAccessEmail({
      workspaceName: `<script>"x"</script>`,
      appLabel: "Command Centre",
      link: "https://mobile.aurixasystems.com.au/a/mga_x#t=mgt_y",
      kind: "magic_link",
    });
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("&lt;script&gt;");
    expect(m.text).toContain("15 minutes");
    expect(m.text).toContain("#t=mgt_y");
  });
  it("words both lifetimes", () => {
    expect(lifetimeWords("magic_link")).toBe("15 minutes");
    expect(lifetimeWords("provisioned_url")).toBe("48 hours");
  });
});
