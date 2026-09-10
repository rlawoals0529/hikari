#!/usr/bin/env node
/**
 * Pull a tool's built output into the widget that hosts it.
 *
 * The tools stay their own repositories with their own tests, their own CI and their own
 * Pages demo. This is the desktop suite that hosts them, so what lands here is the *built*
 * output and nothing else: no source, no config, and above all no second copy of the logic.
 *
 * A script rather than a hand copy, for one reason. The alternative that keeps getting
 * reached for is reimplementing the tool as a plain script for hikari's no-bundler world,
 * and that produces exactly the hand-synced mirror this repo's own notes warn about: two
 * implementations of one thing, drifting, with no test that they agree.
 *
 * Usage:
 *   node scripts/sync-tool.mjs decoder ../decoder
 *   node scripts/sync-tool.mjs decoder ../decoder --check
 *
 * `--check` reports whether the copy is current without writing, which is what CI wants.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";

const HERE = resolve(import.meta.dirname, "..");

function die(msg) {
  console.error(`sync-tool: ${msg}`);
  process.exit(1);
}

/** Every file under a directory, relative and sorted, so a hash is stable. */
function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p));
  }
  return out;
}

/**
 * A hash of the whole tree: names and contents.
 *
 * Names as well as contents, because a file being *removed* upstream has to count as a
 * change. Hashing contents alone would leave a deleted asset in the widget forever and
 * report the copy as current.
 */
function fingerprint(dir) {
  const h = createHash("sha256");
  for (const rel of walk(dir)) {
    h.update(rel);
    h.update("\0");
    h.update(readFileSync(join(dir, rel)));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

const [name, source, ...flags] = process.argv.slice(2);
const check = flags.includes("--check");

if (!name || !source) die("usage: sync-tool.mjs <widget-name> <tool-repo> [--check]");
if (!/^[a-z][a-z0-9-]*$/.test(name)) die(`"${name}" is not a widget name. Use letters, digits and dashes.`);

const dist = resolve(source, "dist");
if (!existsSync(dist)) die(`${dist} does not exist. Run \`npm run build\` in ${source} first.`);
// An empty dist is the shape this fails silently-clean in: it would happily copy nothing
// and report success, and the widget would be a blank window with no error anywhere.
if (!existsSync(join(dist, "index.html"))) die(`${dist} has no index.html, so it is not a built app.`);

const widget = join(HERE, "widgets", name);
if (!existsSync(join(widget, "widget.json"))) {
  die(`widgets/${name}/widget.json does not exist. Create the widget before syncing into it.`);
}

const target = join(widget, "app");
const incoming = fingerprint(dist);
const current = existsSync(target) ? fingerprint(target) : null;

if (check) {
  if (current === incoming) {
    console.log(`sync-tool: widgets/${name}/app is current (${incoming})`);
    process.exit(0);
  }
  console.error(
    `sync-tool: widgets/${name}/app is ${current === null ? "missing" : `stale (${current}, upstream is ${incoming})`}.\n` +
      `Run: node scripts/sync-tool.mjs ${name} ${source}`,
  );
  process.exit(1);
}

if (current === incoming) {
  console.log(`sync-tool: widgets/${name}/app already current (${incoming})`);
  process.exit(0);
}

// Replaced rather than merged. Merging leaves last build's hashed assets behind, and they
// accumulate: the widget grows every build and nothing ever says which files are live.
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(dist, target, { recursive: true });

console.log(`sync-tool: widgets/${name}/app <- ${dist} (${incoming})`);
console.log(`  ${walk(target).length} files`);
