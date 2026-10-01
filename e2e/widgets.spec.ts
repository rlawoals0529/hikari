import { expect, test } from "@playwright/test";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describeFailures, probeContrast } from "./contrast-probe.js";

/**
 * Every widget, over a wallpaper this repo does not own.
 *
 * widgets/theme.css already argues this case in a comment: the panels are translucent so the
 * blur behind them reads as glass, which means the contrast of every word on one depends on
 * what is behind it. The comment picks 0.85 by working out the white-wallpaper case by hand.
 * This checks it instead, on both extremes, for every widget and every palette.
 *
 * White and black rather than a sample of wallpapers: a real desktop is somewhere between
 * them, and a colour that clears AA on both clears it on anything in between.
 */

const WIDGETS = readdirSync("widgets").filter((d) => existsSync(join("widgets", d, "index.html")));

/** The palettes on disk, so one added later is checked without anybody listing it here. */
const THEMES = readdirSync("widgets/palettes")
  .filter((f) => f.endsWith(".css"))
  .map((f) => ({ id: f.replace(/\.css$/, ""), css: readFileSync(join("widgets/palettes", f), "utf8") }));

const CSS_OF = new Map(THEMES.map((t) => [t.id, t.css]));

/**
 * Apply a palette the way the host does: by loading that palette's stylesheet.
 *
 * Not by setting `data-theme`. These palettes are one file each, written at `:root`, and the
 * host loads one - so there is no attribute to set, and the probe's default did nothing at
 * all here. Every palette measured identical numbers and the sweep was the default theme
 * fifteen times, reported as fifteen palettes.
 */
const loadPalette = async (page: import("@playwright/test").Page, theme: string) => {
  await page.evaluate((css) => {
    let tag = document.getElementById("palette-under-test");
    if (!tag) {
      tag = document.createElement("style");
      tag.id = "palette-under-test";
      // Last in <head>, so it wins over theme.css the way the host's own load order does.
      document.head.append(tag);
    }
    tag.textContent = css;
  }, CSS_OF.get(theme) ?? "");
};

test("there are widgets and palettes to check", () => {
  // A glob that stopped matching would make every test below pass by measuring nothing.
  expect(WIDGETS.length).toBeGreaterThan(10);
  expect(THEMES.length).toBeGreaterThan(10);
});

for (const widget of WIDGETS) {
  for (const backdrop of ["#ffffff", "#000000"]) {
    test(`${widget} is legible over ${backdrop === "#ffffff" ? "a white" : "a black"} wallpaper`, async ({ page }) => {
      await page.goto(`/widgets/${widget}/index.html`);
      // The widget itself is transparent, so the backdrop stands in for the desktop.
      await page.addStyleTag({ content: `html { background: ${backdrop} !important; }` });
      // These draw from a mock bridge that pushes a first state asynchronously, so the widget
      // is empty for a moment after load and measuring then measures nothing.
      await page.waitForFunction(() => document.body.children.length > 0, null, { timeout: 15_000 });
      await page.waitForTimeout(700);

      const probe = await probeContrast(page, THEMES, { backdrop, apply: loadPalette });

      if (probe.styles === 0) {
        /*
         * A widget can legitimately have no text - one of these is a shader and draws to a
         * canvas. That is not the same as a widget that failed to render, and the difference
         * matters: without this, a broken widget passes for having nothing to measure.
         */
        const shape = await page.evaluate(() => ({
          text: document.body.innerText.trim().length,
          painted: document.querySelectorAll("canvas, svg, img").length,
        }));
        expect(shape.text, `${widget} has text but the probe measured none`).toBe(0);
        expect(shape.painted, `${widget} rendered neither text nor anything else`).toBeGreaterThan(0);
        return;
      }

      // The sweep has to have actually swept. Fewer distinct paintings than palettes means
      // some never applied, and those numbers are another palette measured twice.
      expect(probe.distinctPalettes, "some palettes painted nothing of their own").toBe(THEMES.length);
      expect(probe.failures, describeFailures(probe.failures)).toEqual([]);
    });
  }
}

/* The "does applying a palette do anything" question is answered inside the sweep itself now,
   by probe.distinctGrounds. A separate test that called loadPalette by hand proved the helper
   works and said nothing about whether the sweep is using it - which was the actual hole. */
