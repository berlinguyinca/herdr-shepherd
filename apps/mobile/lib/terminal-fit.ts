// fit:begin (the page inlines this block: see scripts/build-terminal-html.mjs)
const MIN_PANE_FONT = 6;
const MAX_PINCH = 4;
const CHAR_RATIO = 0.6;
/** The columns are fitted to 98% of the width: a measured cell is rounded, never exactly the font's. */
const FIT_SLACK = 1.02;

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

/** The font for a pane, with its measured cell width: ratio of the font, or the default. */
function measuredRatio(cellWidth: number, font: number): number {
  const ratio = cellWidth / font;
  return Number.isFinite(ratio) && ratio >= 0.3 && ratio <= 1 ? ratio : CHAR_RATIO;
}

/** True where `cols` measured cells are wider than the container. */
function overflows(cellWidth: number, cols: number, width: number): boolean {
  return cellWidth * cols > width + 0.5;
}

/** The scroll position that keeps the content under `focal` in place when the scale changes. */
function focalScroll(scroll: number, focal: number, scale: number): number {
  return Math.max(0, (scroll + focal) * scale - focal);
}

function paneFit(width: number, cols: number, userFont: number, pinch: number, ratio = CHAR_RATIO) {
  const fitted = Math.min(userFont, Math.max(MIN_PANE_FONT, width / (cols * ratio * FIT_SLACK)));
  const font = fitted * pinch;
  return {
    font,
    pct: Math.round((font / userFont) * 100),
    pan: font * ratio * cols > width + 0.5,
  };
}

// fit:end

export {
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
};
