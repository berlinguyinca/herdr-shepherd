/** The conversation's readable width in points; a wider pane centres it, a phone fills its width. */
export const CONVERSATION_MAX_WIDTH = 720;

/** Style for the column that holds the sub-row and every event, so they stay aligned. */
export const conversationColumn = {
  width: "100%",
  maxWidth: CONVERSATION_MAX_WIDTH,
  alignSelf: "center",
} as const;
