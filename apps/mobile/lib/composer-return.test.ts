import { describe, expect, it } from "vitest";
import { COMPOSER_RETURN_PROPS, insertNewline, returnKeyAction } from "./composer-return";

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
