const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { MAX_BYTES, RESERVED, statePath, readState, writable } = require("../src/lib/store");

const HOME = "/Users/someone/.hikari";
const ok = (id) => {
  const r = statePath(HOME, id);
  assert.ok(!r.error, `${id} should be allowed, got: ${r.error}`);
  return r;
};
const refused = (id) => {
  const r = statePath(HOME, id);
  assert.ok(r.error, `${id} should be refused`);
  return r.error;
};

// The refusals are the design here. A widget never names a file, so the only thing that can
// go wrong is a widget id, and these are what stop it going anywhere.

test("a widget's state lives under state/, named for the widget", () => {
  assert.equal(ok("todo").path, path.resolve("/Users/someone/.hikari/state/todo.json"));
});

test("dashes and digits are fine, because real widget names have them", () => {
  for (const id of ["todo", "audio-visualizer", "todo2", "a", "x-y-z", "9lives"]) ok(id);
});

test("a separator is refused, whichever kind", () => {
  // The whole point. Without this an id is a path and the store writes wherever it says.
  for (const id of ["a/b", "a\\b", "/etc/passwd", "C:\\x", "\\\\server\\share"]) {
    assert.ok(refused(id).length > 0, id);
  }
});

test("traversal is refused rather than resolved", () => {
  for (const id of ["..", "../x", "../../.ssh/authorized_keys", "a/../../b", "./x"]) {
    assert.ok(refused(id).length > 0, id);
  }
});

test("a null byte is refused, because it truncates a path in a C library", () => {
  assert.ok(refused("todo\0.png"));
});

test("an id that is not a string is refused rather than coerced", () => {
  for (const id of [null, undefined, 42, {}, [], true, ""]) {
    assert.ok(statePath(HOME, id).error, JSON.stringify(id));
  }
});

test("an absurdly long id is refused", () => {
  // A 5000-character name is a filesystem error on every platform, and the error names the
  // syscall rather than the widget.
  assert.ok(refused("a".repeat(200)));
});

test("uppercase and unicode are refused, because case folding differs per filesystem", () => {
  // "Todo" and "todo" are the same file on macOS and different on Linux, so allowing both
  // means a widget's state follows it to one machine and not another.
  for (const id of ["Todo", "TODO", "todo\u0301", "tôdo", "todo ", " todo"]) {
    assert.ok(refused(id).length > 0, id);
  }
});

test("a Windows device name is refused, and says why", () => {
  // con.json cannot exist on Windows, and the failure is a permission error from the
  // filesystem that nobody would connect to a widget called con.
  for (const id of [...RESERVED].slice(0, 4)) {
    assert.match(statePath(HOME, id).error, /reserved device name/);
  }
});

test("every refusal names the id, so the folder to rename is obvious", () => {
  for (const id of ["a/b", "..", "Todo", "con"]) {
    const { error } = statePath(HOME, id);
    // Asserted in two steps on purpose. A guard that stops refusing then reads as a failed
    // refusal, rather than as assert.match crashing on undefined: a crash aborts the run
    // before the summary line, so a mutation that removed a guard looked like a broken
    // suite instead of a caught mutation.
    assert.ok(error, `${id} was not refused at all`);
    assert.match(error, new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("a resolved path is always inside the state directory", () => {
  // The property, rather than a list of cases. Anything that gets past the pattern still
  // cannot land outside.
  for (const id of ["todo", "a", "x-y", "9", "a".repeat(63)]) {
    const r = ok(id);
    assert.equal(path.dirname(r.path), r.dir);
    assert.ok(r.path.startsWith(path.resolve(HOME)), r.path);
  }
});

test("a stored value comes back", () => {
  assert.deepEqual(readState('{"items":[{"text":"milk"}]}'), { items: [{ text: "milk" }] });
});

test("a hand-edited file that is no longer JSON reads as nothing, not as a failure", () => {
  // The widget starts empty, which is recoverable. Not starting looks like the app is
  // broken and sends the reader to the wrong place.
  for (const text of ["", "   ", "{oops", "undefined", null, undefined, 42]) {
    assert.equal(readState(text), null, JSON.stringify(text));
  }
});

test("a stored false or zero is not mistaken for nothing", () => {
  // The one place a falsy check would lose real data.
  assert.equal(readState("false"), false);
  assert.equal(readState("0"), 0);
  assert.deepEqual(readState("[]"), []);
});

test("a value that can be written comes back as its bytes", () => {
  const r = writable({ items: ["a"] });
  assert.equal(r.text, '{"items":["a"]}');
});

test("undefined is refused rather than written as the word undefined", () => {
  // JSON.stringify(undefined) is undefined, not a string, and writing it leaves the four
  // characters "undefined" in the file, which then fails to parse on the way back.
  assert.match(writable(undefined).error, /nothing to store/);
});

test("a value that cannot be serialised is refused with the reason", () => {
  const cycle = { name: "a" };
  cycle.self = cycle;
  assert.ok(writable(cycle).error);
  assert.ok(writable({ n: 1n }).error);
});

test("a value over the limit is refused, and the message says how big it was", () => {
  const big = { blob: "x".repeat(MAX_BYTES + 1) };
  const e = writable(big).error;
  assert.match(e, /KB and the limit is 256 KB/);
});

test("the size is measured in bytes on disk, not characters", () => {
  // A multi-byte character counts for what it costs. Measuring length would let a value
  // three times the limit through.
  const justUnder = { blob: "e".repeat(MAX_BYTES - 20) };
  assert.ok(writable(justUnder).text, "an ASCII value just under the limit should pass");
  const multibyte = { blob: "\u3042".repeat(MAX_BYTES / 2) };
  assert.ok(writable(multibyte).error, "a value whose characters are 3 bytes each should be refused");
});

test("the limit is what it is", () => {
  assert.equal(MAX_BYTES, 256 * 1024);
});
