// fit:begin (the page inlines this block: see scripts/build-terminal-html.mjs)
const MIN_PANE_FONT = 6;
const MAX_PINCH = 4;
const CHAR_RATIO = 0.6;

/** Rows 1..500 and columns 1..1000, whole numbers: what the bridge and the page both accept. */
function validPane(rows: unknown, cols: unknown): boolean {
  const whole = (value: unknown, max: number) =>
    typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max;
  return whole(rows, 500) && whole(cols, 1000);
}

/** The pinch scale stays between 1x and 4x. */
function clampPinch(scale: number): number {
  return Number.isFinite(scale) ? Math.min(MAX_PINCH, Math.max(1, scale)) : 1;
}

/** The scale after two fingers moved from `startDistance` apart to `distance`. */
function pinchScale(start: number, startDistance: number, distance: number): number {
  return clampPinch(startDistance > 0 ? start * (distance / startDistance) : start);
}

/**
 * The font for a pane `cols` wide in `width` px: as large as the user's font allows while the
 * columns fit, never under the minimum, times the pinch scale. `pan` is true where the pane
 * still is wider than the container. `pct` is the font as a share of the user's.
 */
function paneFit(width: number, cols: number, userFont: number, pinch: number) {
  const fitted = Math.min(userFont, Math.max(MIN_PANE_FONT, width / (cols * CHAR_RATIO)));
  const font = fitted * pinch;
  return {
    font,
    pct: Math.round((font / userFont) * 100),
    pan: font * CHAR_RATIO * cols > width + 0.5,
  };
}

// fit:end

export { CHAR_RATIO, clampPinch, MAX_PINCH, MIN_PANE_FONT, paneFit, pinchScale, validPane };
