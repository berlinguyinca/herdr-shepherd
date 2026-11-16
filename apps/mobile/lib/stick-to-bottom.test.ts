import { expect, it } from "vitest";
import { shouldStickToBottom } from "./stick-to-bottom";

const base = { contentHeight: 2000, viewportHeight: 600, threshold: 80 };

it("sticks when exactly at the end", () => {
  expect(shouldStickToBottom({ ...base, offset: 1400 })).toBe(true);
});
it("sticks within the threshold and releases beyond it", () => {
  expect(shouldStickToBottom({ ...base, offset: 1320 })).toBe(true);
  expect(shouldStickToBottom({ ...base, offset: 1319 })).toBe(false);
});
it("sticks when content is shorter than the viewport", () => {
  expect(shouldStickToBottom({ ...base, contentHeight: 300, offset: 0 })).toBe(true);
});
it("releases once the user scrolled up", () => {
  expect(shouldStickToBottom({ ...base, offset: 0 })).toBe(false);
});
it("sticks on overscroll past the end", () => {
  expect(shouldStickToBottom({ ...base, offset: 1500 })).toBe(true);
});
