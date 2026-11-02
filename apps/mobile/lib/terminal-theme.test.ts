import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(join(__dirname, "../scripts/terminal-page.js"), "utf8");

const channel = (value: number) => {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((at) => channel(Number.parseInt(hex.slice(at, at + 2), 16)));
  return 0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number);
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi as number) + 0.05) / ((lo as number) + 0.05);
};
/** The colours of one theme object in the page script. */
const theme = (name: "dark" | "light") => {
  const block = new RegExp(`${name}: \\{([^}]*)\\}`).exec(page)?.[1] ?? "";
  return Object.fromEntries(
    [...block.matchAll(/(\w+): "(#[0-9a-fA-F]{6})"/g)].map((m) => [m[1], m[2]]),
  ) as Record<string, string>;
};

describe.each(["dark", "light"] as const)("%s terminal theme", (name) => {
  const colors = theme(name);
  const dim = new Set(["black", "brightBlack"]);
  const text = [
    "foreground",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
    "brightBlack",
    "brightRed",
    "brightGreen",
    "brightYellow",
    "brightBlue",
    "brightMagenta",
    "brightCyan",
    "brightWhite",
    "black",
  ];

  it("defines the background and every ANSI colour", () => {
    expect(colors.background).toBeDefined();
    for (const key of text) expect(colors[key], key).toBeDefined();
  });

  it.each(text)("%s is readable on the background", (key) => {
    const ratio = contrast(colors[key] as string, colors.background as string);
    // Black and bright black are often used for dim text, so they only need to stay visible.
    expect(ratio, `${key} ${colors[key]} on ${colors.background}`).toBeGreaterThanOrEqual(
      dim.has(key) ? 3 : 4.5,
    );
  });
});
