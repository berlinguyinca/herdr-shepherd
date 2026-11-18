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

/** The classic app's field: Return inserts a line break, and a Send button sends. */
export const CLASSIC_RETURN_PROPS = {
  multiline: true,
  blurOnSubmit: false,
} as const satisfies TextInputProps;

/** Return sends only in single-chat; every other build keeps its line-break Return. */
export function composerReturnProps(singleChat: boolean): TextInputProps {
  return singleChat ? COMPOSER_RETURN_PROPS : CLASSIC_RETURN_PROPS;
}

/**
 * True when a key event comes from an IME that is still composing (react-native-web reports
 * `isComposing`, and browsers send keyCode 229). Native iOS and Android give JavaScript no such
 * signal; there the platform keyboard decides whether Return commits the composition or submits.
 */
export function isComposingKeyEvent(event: { isComposing?: boolean; keyCode?: number }): boolean {
  return event.isComposing === true || event.keyCode === 229;
}

export type ReturnKeyAction = "send" | "ignore";

/** What the Return key does for the current draft. */
export function returnKeyAction({
  canSend,
  sending,
  composing = false,
  inFlight = false,
}: {
  canSend: boolean;
  sending: boolean;
  /** An IME is composing: Return commits the composition, it does not send. */
  composing?: boolean;
  /** A Return-triggered send has started and not yet settled (guards a double Return). */
  inFlight?: boolean;
}): ReturnKeyAction {
  return canSend && !sending && !composing && !inFlight ? "send" : "ignore";
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
