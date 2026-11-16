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
