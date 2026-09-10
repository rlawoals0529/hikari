const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  ALLOWED_SCHEMES,
  MAX_ENTRIES,
  readEntries,
  readEntry,
  resolveTarget,
  steamEntry,
} = require("../src/lib/launch");

// This file is almost entirely refusals, and that is the point. The happy path is one line;
// the refusals are the whole design, because this is the only part of hikari where being
// wrong is a security bug rather than a wrong number.

const one = (raw) => readEntry(raw, 0);
const refused = (raw) => {
  const r = one(raw);
  assert.ok(r.error, `${JSON.stringify(raw)} should be refused`);
  return r.error;
};
const allowed = (raw) => {
  const r = one(raw);
  assert.ok(!r.error, `${JSON.stringify(raw)} should be allowed, got: ${r.error}`);
  return r.entry;
};

test("a path entry and a uri entry both work", () => {
  assert.deepEqual(allowed({ id: "steam", label: "Steam", uri: "steam://open/games" }), {
    id: "steam",
    label: "Steam",
    kind: "uri",
    value: "steam://open/games",
  });
  assert.equal(allowed({ id: "code", path: "/Applications/Visual Studio Code.app" }).kind, "path");
});

test("a label defaults to the id rather than to nothing", () => {
  assert.equal(allowed({ id: "steam", uri: "steam://open/games" }).label, "steam");
});

test("only the allowed schemes are allowed", () => {
  for (const scheme of [...ALLOWED_SCHEMES]) {
    allowed({ id: "x", uri: `${scheme}//example.com/thing` });
  }
});

test("every other scheme is refused, and the message lists what is allowed", () => {
  // A denylist would be a list of the schemes somebody thought of. openExternal resolves a
  // scheme through whatever handler is registered, and that list on a real machine is long.
  for (const uri of [
    "ftp://example.com/x",
    "smb://server/share",
    "ssh://host",
    "chrome://settings",
    "ms-settings:privacy",
    "shell:startup",
    "app://thing",
    "custom-scheme://x",
  ]) {
    assert.match(refused({ id: "x", uri }), /not an allowed scheme/, uri);
  }
});

test("a file: uri is refused by name, pointing at the call that checks paths", () => {
  // Letting file: in through the URI path would mean two ways to reach the disk and only
  // one of them checked.
  const e = refused({ id: "x", uri: "file:///etc/passwd" });
  assert.match(e, /use "path" rather than a file: URI/);
});

test("a script scheme is refused as not a thing to launch", () => {
  for (const uri of ["javascript:alert(1)", "data:text/html,<script>x</script>", "vbscript:msgbox"]) {
    assert.match(refused({ id: "x", uri }), /not a thing to launch/, uri);
  }
});

test("a scheme is what a URL parser says it is, whatever its case", () => {
  // "HtTpS://x" has to get the same answer as "https://x", and a pattern match on the
  // literal text would not.
  assert.equal(allowed({ id: "x", uri: "HTTPS://example.com" }).kind, "uri");
  assert.equal(allowed({ id: "x", uri: "StEaM://open/games" }).kind, "uri");
});

test("something that is not a URI at all is refused rather than passed through", () => {
  for (const uri of ["not a uri", "example.com", "//example.com", "://x", "steam:"]) {
    const r = one({ id: "x", uri });
    assert.ok(r.error, uri);
  }
});

test("a relative path is refused, because it resolves against wherever the app started", () => {
  // The same config would launch different things depending on how hikari was started.
  for (const p of ["Steam.app", "./Steam.app", "../Steam.app", "~/Applications/Steam.app"]) {
    assert.match(refused({ id: "x", path: p }), /is not absolute/, p);
  }
});

test("an absolute path is accepted on every platform's spelling", () => {
  for (const p of ["/Applications/Steam.app", "C:\\Program Files\\Steam\\steam.exe", "\\\\server\\share\\x.exe"]) {
    assert.equal(allowed({ id: "x", path: p }).kind, "path", p);
  }
});

test("a path is never inspected for shell metacharacters, because it never reaches a shell", () => {
  // Deliberate. openPath takes a value rather than a command line, so quoting and argument
  // splitting are not a category of bug here. A path full of metacharacters is passed
  // through unmodified and the OS treats it as a filename, which is what it is.
  const nasty = '/Applications/a; rm -rf ~/`whoami`$(id) "quoted" \'single\'.app';
  assert.equal(allowed({ id: "x", path: nasty }).value, nasty);
});

test("both path and uri is refused rather than one being guessed", () => {
  const e = refused({ id: "x", path: "/Applications/A.app", uri: "steam://open/games" });
  assert.match(e, /Keep one, because there is no right way to guess/);
});

test("neither path nor uri is refused", () => {
  assert.match(refused({ id: "x", label: "Nothing" }), /has neither/);
});

test("an id must be a name, not a path", () => {
  // The id is what a renderer sends. It has to be something a message can carry and nothing
  // more, so no separators and no dots.
  for (const id of ["a/b", "../x", "a.b", "A", "", "  ", "a b", "a:b", "\u0000x", "a".repeat(80)]) {
    assert.ok(one({ id, uri: "steam://x" }).error, JSON.stringify(id));
  }
});

test("an entry that is not an object is refused", () => {
  for (const raw of [null, undefined, "steam", 42, [], true]) {
    assert.ok(one(raw).error, JSON.stringify(raw));
  }
});

test("a bad entry is reported and costs the good ones nothing", () => {
  // A refused entry that vanishes silently is a dock with a missing button and no way to
  // find out why.
  const { entries, problems } = readEntries({
    entries: [
      { id: "good", uri: "steam://open/games" },
      { id: "bad", uri: "ftp://x/y" },
      { id: "alsogood", path: "/Applications/A.app" },
    ],
  });
  assert.deepEqual(entries.map((e) => e.id), ["good", "alsogood"]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /ftp:/);
});

test("a duplicate id is reported, because one of the two could never be reached", () => {
  const { entries, problems } = readEntries({
    entries: [
      { id: "steam", uri: "steam://open/games" },
      { id: "steam", path: "/Applications/Other.app" },
    ],
  });
  assert.equal(entries.length, 1);
  assert.match(problems[0], /repeats the id/);
});

test("a config that is not a list of entries is an empty dock, not a throw", () => {
  for (const config of [null, undefined, {}, 42, "steam", { entries: "steam" }, { entries: 5 }]) {
    assert.deepEqual(readEntries(config).entries, [], JSON.stringify(config));
  }
});

test("a bare array is a list of entries too", () => {
  assert.equal(readEntries([{ id: "x", uri: "steam://y" }]).entries.length, 1);
});

test("more entries than the cap are dropped and said so", () => {
  const many = Array.from({ length: MAX_ENTRIES + 5 }, (_, i) => ({ id: `e${i}`, uri: "steam://x" }));
  const { entries, problems } = readEntries({ entries: many });
  assert.equal(entries.length, MAX_ENTRIES);
  assert.match(problems.join(" "), new RegExp(`more than ${MAX_ENTRIES}`));
});

// --- resolveTarget: the call the renderer actually reaches -------------------------------

const ENTRIES = readEntries({
  entries: [
    { id: "steam", label: "Steam", uri: "steam://open/games" },
    { id: "code", label: "Code", path: "/Applications/Visual Studio Code.app" },
  ],
}).entries;

test("a known id resolves to what the user wrote down", () => {
  assert.deepEqual(resolveTarget(ENTRIES, "steam"), {
    kind: "uri",
    value: "steam://open/games",
    label: "Steam",
  });
});

test("an unknown id is refused loudly and lists what does exist", () => {
  // Never a no-op. A dock button that silently does nothing is indistinguishable from a
  // broken app, and the config missing an entry is what nobody thinks to look at.
  const e = resolveTarget(ENTRIES, "notathing").error;
  assert.match(e, /no dock entry called "notathing"/);
  assert.match(e, /Known: steam, code/);
});

test("an empty dock says it is empty rather than listing nothing", () => {
  assert.match(resolveTarget([], "steam").error, /the dock is empty/);
});

test("a prototype key resolves to nothing, not to something inherited", () => {
  // The reason this is a strict find over an array rather than a lookup on an object keyed
  // by id. A map would answer "__proto__" and "constructor" with an inherited value, and
  // that value would then be handed to a shell call.
  for (const id of ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "valueOf"]) {
    assert.ok(resolveTarget(ENTRIES, id).error, id);
  }
});

test("an id that is not a string is refused rather than coerced", () => {
  for (const id of [null, undefined, 0, 42, {}, [], true, ["steam"]]) {
    assert.ok(resolveTarget(ENTRIES, id).error, JSON.stringify(id));
  }
});

test("a target is only ever a path or a uri, never anything else", () => {
  // The property. Whatever a config says, what comes out is one of two kinds, and the
  // caller has exactly two branches to write.
  for (const entry of ENTRIES) {
    const t = resolveTarget(ENTRIES, entry.id);
    assert.ok(t.kind === "path" || t.kind === "uri", t.kind);
    assert.equal(typeof t.value, "string");
  }
});

// --- Steam ------------------------------------------------------------------------------

test("a Steam appid becomes a rungameid entry", () => {
  // No new parser: the appid comes out of appmanifest_*.acf, which is already read for the
  // shelf visualiser, and this is the URI Steam expects for one specific game.
  assert.deepEqual(steamEntry("440", "Team Fortress 2"), {
    id: "steam-440",
    label: "Team Fortress 2",
    kind: "uri",
    value: "steam://rungameid/440",
  });
});

test("an appid that is not a number is refused, because it becomes part of a URI", () => {
  for (const appid of ["4a40", "../x", "", "440; rm", null, undefined, {}, "4 4 0"]) {
    assert.equal(steamEntry(appid, "x"), null, JSON.stringify(appid));
  }
});

test("a game with no name still gets a label", () => {
  assert.match(steamEntry("440", "").label, /Steam 440/);
  assert.match(steamEntry("440", null).label, /Steam 440/);
});

test("a Steam entry survives the same checks as a hand-written one", () => {
  // It goes through readEntry rather than round the side of it, so a change to the scheme
  // allowlist applies to games too.
  const e = steamEntry("440", "Team Fortress 2");
  assert.equal(allowed({ id: e.id, label: e.label, uri: e.value }).kind, "uri");
});

test("a scheme with nothing after it is refused, though it parses as a URI", () => {
  // `new URL("steam:")` parses and its protocol is allowed, so the scheme check alone let
  // it through. Asking the OS to open an empty steam URI does nothing useful.
  assert.match(refused({ id: "x", uri: "steam:" }), /scheme with nothing after it/);
});

test("a special scheme with nothing after it is refused by the parser instead", () => {
  // Worth pinning because the two are refused by different branches, and somebody reading
  // one message would reasonably expect the other. The URL parser requires a host for the
  // special schemes, http, https, ws, wss, ftp and file, so `https:` throws outright while
  // the non-special `steam:` parses happily and needs the check above.
  assert.match(refused({ id: "x", uri: "https:" }), /is not a URI/);
  assert.match(refused({ id: "x", uri: "http:" }), /is not a URI/);
});

test("what gets launched is the parser's canonical form, not the text as written", () => {
  // This closes the gap between what was checked and what runs. "https:/x" was validated as
  // https and would have been handed to the OS as "https:/x", leaving the OS to interpret a
  // string this code had already decided about.
  assert.equal(allowed({ id: "x", uri: "https:/x" }).value, "https://x/");
  assert.equal(allowed({ id: "x", uri: "HTTPS://Example.COM/A" }).value, "https://example.com/A");
});

test("canonicalising does not disturb a steam URI", () => {
  // The one that would matter if href rewrote it. Verified against the parser rather than
  // assumed, because a mangled rungameid launches the wrong game or none.
  for (const uri of ["steam://rungameid/440", "steam://open/games", "steam://rungameid/440?x=1"]) {
    assert.equal(allowed({ id: "x", uri }).value, uri, uri);
  }
});
