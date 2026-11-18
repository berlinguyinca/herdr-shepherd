import { describe, expect, it } from "vitest";
import {
  CLASSIC_RETURN_PROPS,
  COMPOSER_RETURN_PROPS,
  composerReturnProps,
  insertNewline,
  isComposingKeyEvent,
  returnKeyAction,
} from "./composer-return";

describe("returnKeyAction", () => {
  it("sends on Return when there is something to send", () => {
    expect(returnKeyAction({ canSend: true, sending: false })).toBe("send");
  });

  it("does nothing for an empty draft, so Return never adds a blank line or a blank message", () => {
    expect(returnKeyAction({ canSend: false, sending: false })).toBe("ignore");
  });

  it("does nothing while a send is in flight, so a double Return sends once", () => {
    expect(returnKeyAction({ canSend: true, sending: true })).toBe("ignore");
  });
});

describe("COMPOSER_RETURN_PROPS", () => {
  it("makes Return submit while the field stays multiline", () => {
    expect(COMPOSER_RETURN_PROPS).toMatchObject({
      multiline: true,
      submitBehavior: "submit",
      returnKeyType: "send",
    });
  });
});

describe("insertNewline", () => {
  it("adds a line break at the caret and moves the caret past it", () => {
    expect(insertNewline("hello world", { start: 5, end: 5 })).toEqual({
      text: "hello\n world",
      caret: 6,
    });
  });

  it("replaces a selection", () => {
    expect(insertNewline("hello world", { start: 5, end: 6 })).toEqual({
      text: "hello\nworld",
      caret: 6,
    });
  });

  it("appends when the caret is at the end", () => {
    expect(insertNewline("hi", { start: 2, end: 2 })).toEqual({ text: "hi\n", caret: 3 });
  });

  it("clamps a stale selection to the text", () => {
    expect(insertNewline("hi", { start: 9, end: 12 })).toEqual({ text: "hi\n", caret: 3 });
  });
});

describe("item C guards", () => {
  it("ignores Return while composing or already in flight", () => {
    expect(returnKeyAction({ canSend: true, sending: false, composing: true })).toBe("ignore");
    expect(returnKeyAction({ canSend: true, sending: false, inFlight: true })).toBe("ignore");
  });

  it("detects composition from isComposing or keyCode 229 only", () => {
    expect(isComposingKeyEvent({ isComposing: true })).toBe(true);
    expect(isComposingKeyEvent({ keyCode: 229 })).toBe(true);
    expect(isComposingKeyEvent({ keyCode: 13 })).toBe(false);
    expect(isComposingKeyEvent({})).toBe(false);
  });

  it("picks submit props only for single-chat", () => {
    expect(composerReturnProps(true)).toEqual(COMPOSER_RETURN_PROPS);
    expect(composerReturnProps(false)).toEqual(CLASSIC_RETURN_PROPS);
  });
});
