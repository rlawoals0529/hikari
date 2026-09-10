const { test } = require("node:test");
const assert = require("node:assert/strict");
const { MAX_ITEMS, MAX_TEXT, add, clearDone, normalise, readItem, remove, toggle, view } = require("../src/lib/todo");

const AT = Date.UTC(2026, 8, 10, 12, 0);

test("an item reads into the shape the widget renders", () => {
  assert.deepEqual(readItem({ id: "a", text: "milk", done: false, at: AT }), {
    id: "a",
    text: "milk",
    done: false,
    at: AT,
  });
});

test("done is a real boolean, never a truthy value", () => {
  // A hand-edited "done": "false" is a string, and a truthy check would mark it done. Same
  // mistake as a permission that turns itself on when you write it off.
  assert.equal(readItem({ text: "x", done: "false" }).done, false);
  assert.equal(readItem({ text: "x", done: "true" }).done, false);
  assert.equal(readItem({ text: "x", done: 1 }).done, false);
  assert.equal(readItem({ text: "x", done: true }).done, true);
});

test("an item with no text is not an item", () => {
  // It would render as a blank row with a checkbox and no way to tell what it was for.
  for (const raw of [{ text: "" }, { text: "   " }, { text: 42 }, {}, null, "milk", []]) {
    assert.equal(readItem(raw), null, JSON.stringify(raw));
  }
});

test("text is trimmed and capped", () => {
  assert.equal(readItem({ text: "  milk  " }).text, "milk");
  assert.equal(readItem({ text: "x".repeat(500) }).text.length, MAX_TEXT);
});

test("a stored list comes back", () => {
  const list = normalise({ items: [{ id: "a", text: "milk" }, { id: "b", text: "eggs", done: true }] });
  assert.deepEqual(list.map((i) => [i.id, i.text, i.done]), [["a", "milk", false], ["b", "eggs", true]]);
});

test("a bare array is a list too, because that is what somebody would write by hand", () => {
  assert.equal(normalise([{ text: "milk" }]).length, 1);
});

test("items with no id get one, so a hand-written file works", () => {
  // Somebody adding three lines to the file should get three tasks, not an empty widget.
  const list = normalise([{ text: "a" }, { text: "b" }, { text: "c" }]);
  assert.equal(list.length, 3);
  assert.equal(new Set(list.map((i) => i.id)).size, 3);
});

test("duplicate ids are made unique, because a repeat makes one click toggle two rows", () => {
  const list = normalise([{ id: "same", text: "a" }, { id: "same", text: "b" }]);
  assert.equal(new Set(list.map((i) => i.id)).size, 2);
});

test("anything unreadable is dropped and costs the rest nothing", () => {
  const list = normalise([{ text: "keep" }, null, { text: "" }, 42, { text: "also keep" }]);
  assert.deepEqual(list.map((i) => i.text), ["keep", "also keep"]);
});

test("a file that is not a list at all reads as an empty one", () => {
  for (const stored of [null, undefined, 42, "milk", {}, { items: "milk" }, true]) {
    assert.deepEqual(normalise(stored), [], JSON.stringify(stored));
  }
});

test("a file with more items than the cap is truncated rather than rendered", () => {
  const many = Array.from({ length: MAX_ITEMS + 50 }, (_, i) => ({ text: `t${i}` }));
  assert.equal(normalise(many).length, MAX_ITEMS);
});

test("adding puts it at the top", () => {
  // A list you add to at the bottom needs scrolling to see what you just typed, which on a
  // widget this size looks like nothing happened.
  const list = add(add([], "first", "1", AT), "second", "2", AT);
  assert.deepEqual(list.map((i) => i.text), ["second", "first"]);
});

test("adding nothing adds nothing, and returns the same list", () => {
  const before = [{ id: "a", text: "milk", done: false, at: AT }];
  for (const text of ["", "   ", null, undefined, 42]) {
    assert.equal(add(before, text, "x", AT), before, JSON.stringify(text));
  }
});

test("adding past the cap is refused rather than growing forever", () => {
  const full = Array.from({ length: MAX_ITEMS }, (_, i) => ({ id: `i${i}`, text: `t${i}`, done: false, at: AT }));
  assert.equal(add(full, "one more", "x", AT).length, MAX_ITEMS);
});

test("toggling flips one item and leaves the others alone", () => {
  const list = [
    { id: "a", text: "milk", done: false, at: AT },
    { id: "b", text: "eggs", done: false, at: AT },
  ];
  const after = toggle(list, "a");
  assert.equal(after[0].done, true);
  assert.equal(after[1].done, false);
  assert.equal(toggle(after, "a")[0].done, false, "toggling twice returns to where it was");
});

test("toggling something that is not there is a no-op, not a throw", () => {
  const list = [{ id: "a", text: "milk", done: false, at: AT }];
  assert.deepEqual(toggle(list, "nope"), list);
  assert.deepEqual(toggle([], "a"), []);
});

test("nothing is mutated", () => {
  // The host writes whatever comes back, so an operation that edited in place would write
  // the same value it was handed and the file would never change.
  const list = [{ id: "a", text: "milk", done: false, at: AT }];
  const frozen = JSON.stringify(list);
  toggle(list, "a");
  remove(list, "a");
  add(list, "new", "n", AT);
  clearDone(list);
  assert.equal(JSON.stringify(list), frozen);
});

test("removing takes one out", () => {
  const list = [
    { id: "a", text: "milk", done: false, at: AT },
    { id: "b", text: "eggs", done: false, at: AT },
  ];
  assert.deepEqual(remove(list, "a").map((i) => i.id), ["b"]);
  assert.deepEqual(remove(list, "nope").map((i) => i.id), ["a", "b"]);
});

test("clearing done leaves the open ones", () => {
  const list = [
    { id: "a", text: "milk", done: true, at: AT },
    { id: "b", text: "eggs", done: false, at: AT },
    { id: "c", text: "bread", done: true, at: AT },
  ];
  assert.deepEqual(clearDone(list).map((i) => i.id), ["b"]);
});

test("done items sink rather than disappear", () => {
  // A list that hides what you finished gives you nothing for finishing it.
  const list = [
    { id: "a", text: "milk", done: true, at: AT },
    { id: "b", text: "eggs", done: false, at: AT },
    { id: "c", text: "bread", done: true, at: AT },
  ];
  const v = view(list);
  assert.deepEqual(v.items.map((i) => i.id), ["b", "a", "c"]);
  assert.equal(v.open, 1);
  assert.equal(v.done, 2);
  assert.equal(v.total, 3);
});

test("done items keep their order among themselves, so the list does not reshuffle", () => {
  const list = [
    { id: "a", text: "a", done: true, at: AT },
    { id: "b", text: "b", done: true, at: AT },
  ];
  assert.deepEqual(view(list).items.map((i) => i.id), ["a", "b"]);
});

test("an empty list counts as empty rather than as unknown", () => {
  assert.deepEqual(view([]), { items: [], open: 0, done: 0, total: 0 });
});
