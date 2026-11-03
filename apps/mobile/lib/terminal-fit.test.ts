import { describe, expect, it } from "vitest";
import {
  CHAR_RATIO,
  clampPinch,
  FIT_SLACK,
  focalScroll,
  MAX_PINCH,
  MIN_PANE_FONT,
  measuredRatio,
  overflows,
  paneFit,
  pinchScale,
  validPane,
} from "./terminal-fit";

describe("validPane", () => {
  it("accepts rows 1..500 and cols 1..1000 as integers only", () => {
    expect(validPane(24, 80)).toBe(true);
    expect(validPane(1, 1)).toBe(true);
    expect(validPane(500, 1000)).toBe(true);
    for (const [rows, cols] of [
      [0, 80],
      [501, 80],
      [24, 0],
      [24, 1001],
      [24.5, 80],
      [24, Number.NaN],
      ["24", 80],
      [undefined, 80],
    ]) {
      expect(validPane(rows, cols), `${rows}x${cols}`).toBe(false);
    }
  });
});

describe("paneFit", () => {
  it("keeps the user's font where the pane already fits", () => {
    // 80 columns at 13 px (7.8 px a cell) need 624 px.
    expect(paneFit(700, 80, 13, 1)).toEqual({ font: 13, pct: 100, pan: false });
  });

  it("shrinks the font so the width fits, keeping the aspect ratio", () => {
    const fit = paneFit(500, 120, 13, 1);
    expect(fit.font).toBeCloseTo(500 / (120 * CHAR_RATIO * FIT_SLACK), 5);
    expect(fit.pct).toBe(Math.round((fit.font / 13) * 100));
    expect(fit.pan).toBe(false);
  });

  it("never goes under the minimum font and pans instead", () => {
    const fit = paneFit(300, 200, 13, 1);
    expect(fit.font).toBe(MIN_PANE_FONT);
    expect(fit.pan).toBe(true);
  });

  it("multiplies by the pinch scale and pans once the pane is wider than the container", () => {
    const fit = paneFit(500, 120, 13, 2);
    expect(fit.font).toBeCloseTo((500 / (120 * CHAR_RATIO * FIT_SLACK)) * 2, 5);
    expect(fit.pan).toBe(true);
  });

  it("does not pan a narrow pane that stays inside the container when pinched", () => {
    expect(paneFit(700, 40, 13, 2)).toEqual({ font: 26, pct: 200, pan: false });
  });

  it("leaves 2% slack, so the last column is never clipped by rounding", () => {
    // 80 columns at 13 px need exactly 624 px: a container of exactly that is not enough.
    const fit = paneFit(624, 80, 13, 1);
    expect(fit.font).toBeLessThan(13);
    expect(fit.font * CHAR_RATIO * 80).toBeLessThanOrEqual(624);
    expect(fit.pan).toBe(false);
  });

  it("uses the measured character ratio when given one", () => {
    const fit = paneFit(300, 50, 13, 1, 0.7);
    expect(fit.font).toBeCloseTo(300 / (50 * 0.7 * FIT_SLACK), 5);
    expect(fit.font * 0.7 * 50).toBeLessThanOrEqual(300);
  });

  it("copes with a container with no width", () => {
    expect(paneFit(0, 80, 13, 1).font).toBe(MIN_PANE_FONT);
  });
});

describe("pinch", () => {
  it("clamps to 1x..4x", () => {
    expect(clampPinch(0.2)).toBe(1);
    expect(clampPinch(2.5)).toBe(2.5);
    expect(clampPinch(9)).toBe(MAX_PINCH);
    expect(clampPinch(Number.NaN)).toBe(1);
  });

  it("multiplies the scale at the start by how far the fingers moved apart", () => {
    expect(pinchScale(1, 100, 200)).toBe(2);
    expect(pinchScale(2, 100, 150)).toBe(3);
    expect(pinchScale(2, 100, 40)).toBe(1);
    expect(pinchScale(3, 100, 900)).toBe(MAX_PINCH);
    expect(pinchScale(2, 0, 50)).toBe(2);
  });
});

describe("measured cells", () => {
  it("turns a measured cell width into a ratio of the font, or falls back", () => {
    expect(measuredRatio(9.1, 13)).toBeCloseTo(0.7, 5);
    for (const [cell, font] of [
      [0, 13],
      [Number.NaN, 13],
      [9, 0],
      [100, 10],
      [1, 10],
      [undefined, 13],
    ]) {
      expect(measuredRatio(cell as number, font as number), `${cell}/${font}`).toBe(CHAR_RATIO);
    }
  });

  it("says when the measured columns are wider than the container", () => {
    expect(overflows(7.8, 80, 624)).toBe(false);
    expect(overflows(7.9, 80, 624)).toBe(true);
    expect(overflows(0, 80, 624)).toBe(false);
  });
});

describe("focalScroll", () => {
  it("keeps the content under the focal point where it was when the scale changes", () => {
    // The point 50 px into the view at scroll 100 is content at 150; at 2x it is at 300.
    expect(focalScroll(100, 50, 2)).toBe(250);
    expect(focalScroll(0, 0, 3)).toBe(0);
    expect(focalScroll(100, 50, 1)).toBe(100);
    expect(focalScroll(200, 60, 0.5)).toBe(70);
  });

  it("never scrolls to a negative place", () => {
    expect(focalScroll(0, 100, 0.25)).toBe(0);
  });
});
