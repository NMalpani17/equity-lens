/**
 * WCAG contrast for the design tokens in index.css: text pairs must reach AA
 * (4.5:1), non-text marks (input borders, focus ring, accent line) 3:1.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Read from disk: Vitest stubs CSS imports (even ?raw) to an empty string.
const css = readFileSync(path.join(__dirname, "index.css"), "utf8");
const rootBlock = css.slice(css.indexOf(":root"), css.indexOf("@theme"));
const tokens = Object.fromEntries(
  [...rootBlock.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [
    m[1],
    m[2],
  ]),
);

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string): number {
  const a = luminance(token(foreground));
  const b = luminance(token(background));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function token(name: string): string {
  const value = tokens[name];
  if (!value) throw new Error(`--${name} is not a hex token in :root`);
  return value;
}

const SURFACES = ["background", "card", "muted"];

const TEXT_PAIRS: [string, string[]][] = [
  ["foreground", SURFACES],
  ["muted-foreground", SURFACES],
  ["gain", SURFACES],
  ["loss", SURFACES],
  ["destructive", SURFACES],
  ["brand-strong", SURFACES],
  ["primary-foreground", ["primary", "primary-hover"]],
  ["info-foreground", ["info"]],
  ["warning-foreground", ["warning"]],
];

const NON_TEXT_PAIRS: [string, string[]][] = [
  ["input", ["card", "background"]],
  ["ring", SURFACES],
  ["brand", SURFACES],
  ["chart-1", ["card"]],
  ["chart-benchmark", ["card"]],
];

describe("design token contrast", () => {
  it.each(TEXT_PAIRS.flatMap(([fg, bgs]) => bgs.map((bg) => [fg, bg])))(
    "text --%s on --%s meets AA (4.5:1)",
    (fg, bg) => {
      expect(contrast(fg!, bg!)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each(NON_TEXT_PAIRS.flatMap(([fg, bgs]) => bgs.map((bg) => [fg, bg])))(
    "mark --%s on --%s meets 3:1",
    (fg, bg) => {
      expect(contrast(fg!, bg!)).toBeGreaterThanOrEqual(3);
    },
  );
});
