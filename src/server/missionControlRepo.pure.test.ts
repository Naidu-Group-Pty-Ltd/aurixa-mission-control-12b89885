// Which repository is Mission Control's own — and the refusal when it is Prime's.
import { describe, expect, it } from "vitest";
import {
  MISSION_CONTROL_REPO_DEFAULT,
  isPrimeRepo,
  missionControlRepo,
  parseRepoName,
} from "./missionControlRepo.pure";

describe("missionControlRepo", () => {
  it("is this repository unless told otherwise", () => {
    expect(missionControlRepo(undefined).fullName).toBe(MISSION_CONTROL_REPO_DEFAULT);
    expect(missionControlRepo("acme/control")).toEqual({
      owner: "acme",
      repo: "control",
      fullName: "acme/control",
    });
  });

  it("ignores an override that is not a repository name", () => {
    for (const bad of [
      "",
      "acme",
      "acme/",
      "/x",
      "acme/control/extra",
      "a b/c",
      "acme/..",
      "-acme/x",
    ]) {
      expect(missionControlRepo(bad).fullName, bad).toBe(MISSION_CONTROL_REPO_DEFAULT);
    }
  });

  it("is not the repository prime_config names", () => {
    // The two are different repositories; the default must never be Prime's.
    expect(MISSION_CONTROL_REPO_DEFAULT).not.toMatch(/npc-property-dashbord/);
  });
});

describe("isPrimeRepo", () => {
  const prime = { github_owner: "Naidu-Group-Pty-Ltd", github_repo: "npc-property-dashbord" };

  it("matches Prime's repository whatever its case", () => {
    expect(isPrimeRepo(parseRepoName("naidu-group-pty-ltd/NPC-property-dashbord")!, prime)).toBe(
      true,
    );
    expect(isPrimeRepo(missionControlRepo(undefined), prime)).toBe(false);
  });

  it("is false when no Prime is configured", () => {
    expect(isPrimeRepo(missionControlRepo(undefined), null)).toBe(false);
    expect(isPrimeRepo(missionControlRepo(undefined), { github_owner: null })).toBe(false);
  });
});
