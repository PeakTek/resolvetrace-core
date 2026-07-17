import { describe, expect, it } from "vitest";
import { computeReplayFit } from "./replay-fit";

const base = { frameH: 0, fullscreen: false, viewportH: 1000 };

describe("computeReplayFit", () => {
  it("panel: fits the frame width exactly when the height is not capped", () => {
    // 16:9 recording, wide-enough viewport → natural height (540) < 0.8*1000.
    const { scale, panelHeight } = computeReplayFit({
      ...base,
      recW: 1440,
      recH: 810,
      frameW: 960,
    });
    expect(scale).toBeCloseTo(960 / 1440, 5); // 0.6667
    expect(panelHeight).toBe(540); // 810 * 960/1440
  });

  it("panel: caps a tall (portrait) recording at 0.8 viewport height (letterboxed)", () => {
    // 800x1600 → natural height 1920 > 800 cap → fit the capped height instead.
    const { scale, panelHeight } = computeReplayFit({
      ...base,
      recW: 800,
      recH: 1600,
      frameW: 960,
      viewportH: 1000,
    });
    expect(panelHeight).toBe(800); // 0.8 * 1000
    expect(scale).toBeCloseTo(800 / 1600, 5); // 0.5 (fit height; width letterboxed)
  });

  it("panel: never upscales a recording smaller than the frame", () => {
    const { scale, panelHeight } = computeReplayFit({
      ...base,
      recW: 400,
      recH: 300,
      frameW: 960,
    });
    expect(scale).toBe(1); // frameW/recW = 2.4, clamped to 1
    expect(panelHeight).toBe(720); // 300 * 960/400
  });

  it("fullscreen: fits both axes (contain), never upscaling", () => {
    // Big screen, 1440x900 recording → both scales > 1 → clamped to 1.
    expect(
      computeReplayFit({
        recW: 1440,
        recH: 900,
        frameW: 1920,
        frameH: 1000,
        fullscreen: true,
        viewportH: 1080,
      }),
    ).toEqual({ scale: 1, panelHeight: null });
  });

  it("fullscreen: the shorter screen axis bounds the scale", () => {
    const { scale, panelHeight } = computeReplayFit({
      recW: 1440,
      recH: 900,
      frameW: 1920,
      frameH: 700, // height-bound
      fullscreen: true,
      viewportH: 800,
    });
    expect(scale).toBeCloseTo(700 / 900, 5); // 0.7778
    expect(panelHeight).toBeNull();
  });

  it("falls back to { scale: 1, panelHeight: null } for unusable dimensions", () => {
    expect(computeReplayFit({ ...base, recW: 0, recH: 900, frameW: 960 })).toEqual({
      scale: 1,
      panelHeight: null,
    });
    expect(
      computeReplayFit({ ...base, recW: NaN, recH: 900, frameW: 960 }),
    ).toEqual({ scale: 1, panelHeight: null });
    expect(computeReplayFit({ ...base, recW: 1440, recH: 900, frameW: 0 })).toEqual({
      scale: 1,
      panelHeight: null,
    });
  });
});
