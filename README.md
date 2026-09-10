# hikari

Desktop widgets written in HTML, CSS and JavaScript. Transparent, always on top, driven by
live system data. **No window manager required.**

![The bundled clock, stats and now-playing widgets](docs/preview.png)

Linux has [AGS](https://aylur.github.io/astal/) and [eww](https://github.com/elkowar/eww),
where a widget is a few lines of code and the whole desktop is themeable. Windows has
Rainmeter, where a widget is INI and Lua. This is the first shape, for any OS.

## A widget is a folder

```
widgets/clock/
  widget.json    where it goes
  index.html     what it is
```

```json
{ "name": "clock", "anchor": "top_right", "width": 230, "height": 108, "margin": 20 }
```

```html
<script>
  hikari.subscribe((state) => {
    document.querySelector("#t").textContent = state.date.time;
  });
</script>
```

That is the whole API. `anchor` is one of `top`/`middle`/`bottom` crossed with
`left`/`center`/`right`, resolved against the **work area**, so a taskbar never covers a
widget. `offsetX` and `offsetY` stack on top, which is how two widgets share an anchor.

Set `"interactive": true` for a widget with buttons. Anything else is click-through, so it
never eats a click meant for the desktop behind it.

## Media control without an API key

The now-playing widget has working transport buttons and **no Spotify account, no OAuth and
no API key**.

Every desktop already knows what is playing, because the OS owns the media keys. Reading
that is better than a music service's web API in four ways: nothing to register, nothing to
refresh, it works offline, and it covers **every** player rather than one — Spotify, a
browser tab, VLC.

| | |
| --- | --- |
| Windows | SMTC, via `GlobalSystemMediaTransportControlsSessionManager` |
| macOS | AppleScript against the running player |
| Linux | MPRIS over D-Bus, via `playerctl` |

## Providers

`cpu` · `memory` · `host` · `date` · `media`

A provider is `{ name, intervalMs, read() }` returning a plain object. The host polls them
and broadcasts the merged result. **A widget never learns which OS it is on**, which is what
lets the same widget run on Windows, macOS and Linux unchanged.

Adding one is a file in `src/providers/` and a line in the list.

## Unknown is never zero

`cpu.usage` is `null` until there are two samples to compare, and `null` again if two
samples land inside one tick. The widgets render `--` for that.

A fabricated `0%` is indistinguishable from a genuinely idle machine, and it is the reading
a person acts on.

## Run it

```bash
npm install
npm start
```

Widgets are loaded from `widgets/` and from `~/.hikari/widgets/`, so your own live outside
the repo and survive a pull.

## Build widgets without running the host

```bash
npm run preview   # then open http://localhost:8910/preview/
```

Each widget falls back to a mocked bridge when the real one is absent, so the same
`index.html` opens in a plain browser with drifting CPU, a rotating track and a running
clock. Iterating on how a widget looks should not require restarting a desktop shell.

## Tests

```bash
npm test
```

Seven tests over the placement geometry and widget discovery: work-area anchoring against a
taskbar, every anchor, stacked offsets, a second monitor's origin, and manifest defaults.
The host imports Electron at load, so the tests stub it — which is possible only because
the geometry is a pure function.

## Status

Providers, placement geometry, discovery and all three widgets are verified: 7 passing
tests, and the widgets render and update live in the browser preview above.

**The Electron host itself has not been run.** Electron's binary would not install in the
environment this was written in, so `src/main.js` is verified by reading and by its unit
tests rather than by launching. Expect first-run adjustments around window flags.

MIT
