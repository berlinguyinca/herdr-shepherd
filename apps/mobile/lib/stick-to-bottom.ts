export type ScrollMetrics = {
  offset: number;
  contentHeight: number;
  viewportHeight: number;
  /** Within this many points of the end still counts as at the bottom. */
  threshold: number;
};

/** True when the viewport sits at (or within the threshold of) the end of the content. */
export function shouldStickToBottom({
  offset,
  contentHeight,
  viewportHeight,
  threshold,
}: ScrollMetrics): boolean {
  return contentHeight - (offset + viewportHeight) <= threshold;
}

/**
 * The pin state after a scroll event. Away from the bottom unpins, unless the event is part of our
 * own scrollToEnd (content just grew, the jump has not landed yet), which leaves the state alone.
 * Back at the bottom always pins again.
 */
export function nextStick(
  previous: boolean,
  metrics: ScrollMetrics,
  programmatic: boolean,
): boolean {
  if (shouldStickToBottom(metrics)) return true;
  return programmatic ? previous : false;
}
