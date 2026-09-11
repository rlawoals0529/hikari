# hikari

Desktop widgets written in HTML, CSS and JavaScript. Transparent, always on top, driven by
live system data. **No window manager required.**

![The bundled clock, stats and now-playing widgets](docs/preview.png)

Linux has [AGS](https://aylur.github.io/astal/) and [eww](https://github.com/elkowar/eww),
where a widget is a few lines of code and the whole desktop is themeable. Windows has
Rainmeter, where a widget is INI and Lua. This is the first shape, for any OS.

## Install

```bash
npm install
npm start
```

Widgets load from `widgets/` and from `~/.hikari/widgets/`, so your own live outside the
repo and survive a pull.

## What comes with it

| Widget | |
| --- | --- |
| `clock` | date and time |
| `stats` | CPU and memory |
| `system` | battery, disk and network, read from what the OS already reports. No dependency, no elevated permission |
| `nowplaying` | current track with working transport buttons. No Spotify account, no OAuth, no API key |
| `weather` | forecast from [Open-Meteo](https://open-meteo.com), which needs no account and no key |
| `calendar` | upcoming events from any `.ics` feed or local file |
| `companion` | an SVG character with six states, driven by what the machine is doing |
| `media` | a GIF, APNG, WebP, MP4 or WebM, from a local file or a URL |
| `audio-visualizer` | draws whatever is currently playing |
| `shader` | a fragment shader as the desktop background |
| `todo` | a list that persists across restarts |
| `dock` | launch the applications and links you pin to it |
| `settings` | change any widget's placement, palette and on/off state from a panel, on `Alt+Shift+H` |
| `notepad` | a scratch buffer on `Alt+Shift+N`, from [notepad](https://github.com/rlawoals0529/notepad) |
| `decoder` | paste-and-identify on `Alt+Space`, from [decoder](https://github.com/rlawoals0529/decoder) |

Readings that are not available come back as `null` and render as `--`, never as `0`. A
fabricated zero is indistinguishable from a genuinely idle machine, and it is the number a
person acts on. Stale readings are dimmed with their age, and dropped entirely past three
hours.

## Writing a widget

A widget is a folder with two files.

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

Editing `index.html` reloads that window. Editing `widget.json` or `~/.hikari/config.json`
applies immediately, including opening and closing widgets.

## Overlays

Three keys turn a widget into something you summon rather than something that sits there.

```json
{ "name": "decoder", "hotkey": "Alt+Space", "startHidden": true, "interactive": true,
  "clipboard": true, "anchor": "middle_center", "width": 720, "height": 460 }
```

| | |
| --- | --- |
| `hotkey` | a global shortcut that shows and hides this widget |
| `startHidden` | built and loaded at startup, but not on screen until summoned |
| `clipboard` | this widget may read the clipboard. Nothing else may |

A shortcut with no modifier is refused: `"hotkey": "K"` would take that key away from every
application on the machine. Any shortcut that cannot be bound is reported at startup with
the reason, rather than silently doing nothing.

A tool with its own repository can be hosted here as an overlay. The first is
[decoder](https://github.com/rlawoals0529/decoder): copy a token, press `Alt+Space`, and it
is already decoded, because the host reads the clipboard and pushes it in as the window
shows.

```bash
node scripts/sync-tool.mjs decoder ../decoder
node scripts/sync-tool.mjs decoder ../decoder --check   # is the copy current?
```

## Storage

A widget that needs to remember something asks for one capability.

```json
{ "name": "todo", "interactive": true, "storage": true }
```

```js
const list = await hikari.store.get();      // null the first time
await hikari.store.set({ items: list });    // replaces the whole value
```

There is no filename and no way to supply one. The host resolves the asking widget's own id
to a single file under `~/.hikari/state/`, so a widget cannot write anywhere else and cannot
read another widget's data. Writes go to a temporary file and are renamed over the target,
so a crash leaves either the whole old file or the whole new one.

## Settings

`widget.json` holds the author's defaults. Yours go in `~/.hikari/config.json`, keyed by
widget name, and they win.

```json
{
  "widgets": {
    "clock": { "anchor": "top_left", "offsetX": 40 },
    "shader": { "enabled": false }
  }
}
```

Theme tokens live in `~/.hikari/theme.css` and are readable by every widget, including ones
outside the repo.

## Providers

`cpu` · `memory` · `host` · `date` · `media` · `weather` · `calendar` · `battery` · `disk` · `network`

A provider is `{ name, intervalMs, read() }` returning a plain object. The host polls them
and broadcasts the merged result. **A widget never learns which OS it is on**, which is what
lets the same widget run on Windows, macOS and Linux unchanged.

Adding one is a file in `src/providers/` and a line in the list.

A widget reads its own manifest with `hikari.config()`, which is how the media widget gets
its `source` without the host knowing anything about video.

## Development

```bash
npm run preview   # then open http://localhost:8910/preview/
npm test
```

Each widget falls back to a mocked bridge when the real one is absent, so the same
`index.html` opens in a plain browser with drifting CPU, a rotating track and a running
clock. Iterating on how a widget looks does not require restarting a desktop shell. The
mock's `config()` reads the query string, so `?shader=starfield&fps=24` in the preview is
the same setting as `{"shader": "starfield", "fps": 24}` on the desktop.

350 tests cover the pure half: placement geometry, provider parsing, the audio band maths,
the shader prelude, the settings merge, the accelerator grammar, and the capability checks.
The capability tests are all refusals, on purpose. The grant is one line; the refusals are
why that line is safe.

## Status

Widgets render live in the browser preview, and the host has been run against a throwaway
`HIKARI_HOME` with extra widgets dropped in. Two things remain unverified: a hotkey actually
toggling a window needs a real keypress, and the window flags (click-through, the wallpaper
layer, always-on-top against a fullscreen app) need eyes on a desktop.

MIT
