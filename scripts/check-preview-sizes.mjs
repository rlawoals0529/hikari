#!/usr/bin/env node
/**
 * Every iframe in the preview must be the size its widget declares.
 *
 * The preview hardcodes a width and height per iframe, and each widget declares its own in
 * `widget.json`. Nothing kept the two in step, and the failure is quiet: the clock's manifest
 * said 230 while the widest 12-hour time needed 239, so "PM" wrapped to a second line and the
 * panel clipped it. It looked like a design problem and it was an arithmetic one.
 *
 * A widget shown at the wrong size in the preview is showing something the desktop will not do,
 * which is the one thing a preview must not do.
 */
import { readFileSync, existsSync } from "node:fs";

const html = readFileSync("preview/index.html", "utf8");
const iframes = [...html.matchAll(/<iframe src="\.\.\/widgets\/([\w-]+)\/index\.html[^"]*"\s+width="(\d+)"\s+height="(\d+)"/g)];

if (iframes.length === 0) {
  console.error("no iframes matched, so this check is reading nothing");
  process.exit(2);
}

let bad = 0;
const seen = new Map();
for (const [, name, w, h] of iframes) {
  const manifest = `widgets/${name}/widget.json`;
  if (!existsSync(manifest)) {
    console.error(`${name}: previewed but has no widget.json`);
    bad++;
    continue;
  }
  const m = JSON.parse(readFileSync(manifest, "utf8"));
  if (m.width === undefined && m.height === undefined) {
    // A wallpaper fills the display and declares no size, so there is nothing to match. It is
    // still previewed at some size, and that size is a framing choice rather than a claim.
    console.log(`  ${name}: no declared size (wallpaper), preview framing not checked`);
    continue;
  }
  // A widget can legitimately be previewed at several sizes only if the manifest says so; it
  // does not, so every instance must match.
  if (Number(w) !== m.width || Number(h) !== m.height) {
    console.error(`${name}: preview shows ${w}x${h}, widget.json declares ${m.width}x${m.height}`);
    bad++;
  }
  seen.set(name, (seen.get(name) ?? 0) + 1);
}

console.log(`${iframes.length} previews across ${seen.size} widgets checked against their manifests.`);
process.exit(bad > 0 ? 1 : 0);
