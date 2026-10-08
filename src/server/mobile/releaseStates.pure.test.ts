import { describe, expect, it } from "vitest";
import { moveRelease } from "./releaseStates.pure";

describe("moveRelease", () => {
  it("approves an uploaded Android candidate and refuses one with no artefact", () => {
    expect(moveRelease("candidate", "approve", { platform: "android", uploaded: true })).toEqual({
      ok: true,
      to: "approved",
    });
    expect(moveRelease("candidate", "approve", { platform: "android", uploaded: false }).ok).toBe(
      false,
    );
    expect(moveRelease("candidate", "approve", { platform: "ios", uploaded: false }).ok).toBe(true);
  });
  it("promotion needs a percentage from 1 to 100", () => {
    const f = { platform: "android", uploaded: true };
    expect(moveRelease("approved", "promote", { ...f, percentage: 10 }).ok).toBe(true);
    expect(moveRelease("approved", "promote", { ...f, percentage: 0 }).ok).toBe(false);
    expect(moveRelease("approved", "promote", { ...f, percentage: 101 }).ok).toBe(false);
    expect(moveRelease("approved", "promote", f).ok).toBe(false);
    expect(moveRelease("promoted", "promote", { ...f, percentage: 50 }).ok).toBe(true);
  });
  it("pause and resume, and withdrawal is terminal", () => {
    const f = { platform: "android", uploaded: true };
    expect(moveRelease("promoted", "pause", f)).toEqual({ ok: true, to: "paused" });
    expect(moveRelease("paused", "resume", f)).toEqual({ ok: true, to: "promoted" });
    expect(moveRelease("withdrawn", "resume", f).ok).toBe(false);
    expect(moveRelease("candidate", "promote", { ...f, percentage: 5 }).ok).toBe(false);
  });
});
