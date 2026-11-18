import type { TextInputProps } from "react-native";

/**
 * Return sends; the field stays multiline so a long draft wraps and scrolls. React Native's
 * `submitBehavior: "submit"` keeps the key from inserting a line break and fires `onSubmitEditing`.
 */
export const COMPOSER_RETURN_PROPS = {
  multiline: true,
  submitBehavior: "submit",
  returnKeyType: "send",
} as const satisfies TextInputProps;

export type ReturnKeyAction = "send" | "ignore";

/** What the Return key does for the current draft. */
export function returnKeyAction({
  canSend,
  sending,
}: {
  canSend: boolean;
  sending: boolean;
}): ReturnKeyAction {
  return canSend && !sending ? "send" : "ignore";
}

export type TextSelection = { start: number; end: number };

/** Inserts a line break over the selection, the way Shift+Return does where the platform reports it. */
export function insertNewline(
  text: string,
  selection: TextSelection,
): { text: string; caret: number } {
  const start = Math.min(Math.max(0, Math.min(selection.start, selection.end)), text.length);
  const end = Math.min(Math.max(selection.start, selection.end), text.length);
  return { text: `${text.slice(0, start)}\n${text.slice(end)}`, caret: start + 1 };
}
