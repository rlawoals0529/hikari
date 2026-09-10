const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * The libraries in src/lib/ are loaded into a widget as plain <script> tags, so they all
 * share one global scope. Node hides this: `require` gives every module a scope of its own,
 * so a name two files both declare at the top level is invisible to every other test here
 * and is a SyntaxError in the browser -- one that discards the whole second file, leaving a
 * widget with an undefined `window.hikariGlsl` and a message naming a variable the widget
 * has never heard of.
 *
 * So this loads them the way a page does: concatenated, into one scope.
 */
const LIB = path.join(__dirname, "..", "src", "lib");

/** The ones a widget can load in a browser, which is what the collision hazard is about. */
function browserLibs() {
  return fs
    .readdirSync(LIB)
    .filter((f) => f.endsWith(".js"))
    .filter((f) => fs.readFileSync(path.join(LIB, f), "utf8").includes("typeof window"))
    .sort();
}

test("every browser-loadable library is present, so this test cannot pass by finding none", () => {
  const libs = browserLibs();
  assert.ok(libs.length >= 4, `expected at least 3 browser libs, found ${libs.join(", ")}`);
  for (const f of ["config.js", "glsl.js", "mood.js", "todo.js"]) assert.ok(libs.includes(f), `${f} missing`);
});

test("loading them all into one scope does not redeclare anything", () => {
  const libs = browserLibs();
  const source = libs.map((f) => fs.readFileSync(path.join(LIB, f), "utf8")).join("\n");
  // A Function body is one scope, which is the property under test. `module` and `window`
  // are both undefined in here, so each file's export tail is a no-op and only the
  // declarations matter.
  assert.doesNotThrow(() => new Function(source), `redeclaration across ${libs.join(" + ")}`);
});

test("each library still exports through window when there is one", () => {
  const libs = browserLibs();
  const source = libs.map((f) => fs.readFileSync(path.join(LIB, f), "utf8")).join("\n");
  const win = {};
  new Function("window", source)(win);
  assert.deepEqual(Object.keys(win).sort(), ["hikariConfig", "hikariGlsl", "hikariMood", "hikariTodo"]);
});
