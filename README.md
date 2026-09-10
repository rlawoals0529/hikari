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

## Media, GIF and video

A widget can be a **GIF, APNG, WebP, MP4 or WebM**, local file or URL. The `media` widget
picks `<video>` or `<img>` by extension, because a `<video>` cannot play a GIF and an `<img>`
cannot loop or rate-control a video.

```json
{
  "name": "media",
  "source": "C:/wallpapers/rain.mp4",
  "fit": "cover",
  "opacity": 0.9,
  "loop": true,
  "muted": true,
  "playbackRate": 0.75,
  "radius": 16
}
```

`muted` defaults to true and that is load-bearing: a browser refuses to autoplay audio, so
an unmuted video silently never starts.

### As a live wallpaper

```json
{ "name": "wallpaper", "fill": "screen", "layer": "wallpaper", "source": "loop.webm" }
```

`fill: "screen"` covers the display's **bounds** rather than its work area, because a
wallpaper belongs behind the taskbar rather than beside it. `layer: "wallpaper"` drops the
window behind everything and makes it click-through.

## Audio-reactive

A widget that draws whatever the machine is playing.

![The spectrum visualiser, 48 logarithmic bands](docs/audio.png)

```json
{ "name": "audio-visualizer", "mode": "spectrum", "bands": 48, "source": "microphone" }
```

`mode` is `spectrum` or `radial`. Colours come from the theme's custom properties, so it
inherits whatever palette the rest of the desktop uses rather than hard-coding one.

Bands are **logarithmic**, because hearing is. A linear split hands almost every bucket to
the treble and squeezes all the bass anyone actually watches into the first bar or two.
Smoothing is asymmetric: fast attack so a beat lands on the frame it happened, slow release
so the bar has something to fall from.

Two things a desktop widget forces you to get right:

- **An `AudioContext` starts suspended without a user gesture**, and a widget never receives
  one. The host sets `autoplayPolicy: "no-user-gesture-required"` so it can start at all.
- **`resume()` can hang rather than reject** when there is no device, so it is raced against
  a timeout. Rendering never waits on audio setup either - one unsettled promise would
  otherwise leave a permanently blank widget with no error anywhere.

With no input it draws a slow ambient wave and says why. Unknown must never render as flat
silence: the two look identical and mean opposite things.

`?demo=1` in the preview drives it from an oscillator, so it can be seen and screenshot
without a microphone.

## Shader wallpapers

A fragment shader as the desktop background, running behind everything else.

![Four shaders: aurora, contours, rain and starfield](docs/shaders.png)

```json
{ "name": "shader", "layer": "wallpaper", "fill": "screen", "shader": "contours", "fps": 30 }
```

Four ship: `aurora`, `starfield`, `rain` and `contours`. Drop a `.frag` into
`widgets/shader/shaders/` and name it in the config to add your own.

Every shader gets the same prelude, so a new one starts at `void main()` and has these
already declared:

| Uniform | |
| --- | --- |
| `u_time`, `u_resolution` | seconds since start, and the surface in pixels |
| `u_mouse` | 0..1 across the surface, and `(-1,-1)` until the pointer has actually moved |
| `u_bass`, `u_level` | smoothed loudness, both 0 when there is no audio |
| `u_cpu` | 0..1, from the same provider the stats widget reads |
| `u_bg`, `u_accent`, `u_accent2` | the palette, read off the stylesheet |

Colours are not written into the shaders. They are read from the theme's custom properties
at startup, which is why the same four files look like whichever palette the desktop is
wearing rather than like themselves.

**A shader that will not compile says where.** Drivers count lines against the source they
were handed, and that includes the prelude, so a mistake on line 4 of your file gets
reported as line 18. The log is remapped onto the file you actually edit before it is
shown, and it is shown on the canvas rather than only in a console nobody has open behind
a wallpaper. A missing file, a bad name and a build with no WebGL2 each say so too. None
of them render black and leave you guessing.

Two things worth knowing if you write one:

- **Dither near-black gradients.** Between two dark colours an 8-bit display has only a
  handful of levels, and without a little noise the gradient posterises into visible
  bands. All four do it, in one line.
- **`fps` defaults to 30 and `scale` to 1.** A wallpaper is seen in peripheral vision;
  spending 60 frames and every pixel on it is a poor trade for the machine that is also
  running your game. `scale: 0.5` is most of the look for a quarter of the work.

## A companion that reads the machine

![Six states: idle, working, busy, listening, asleep, and no reading](docs/companion.png)

```json
{ "name": "companion", "anchor": "bottom_right", "showLabel": true }
```

A cat drawn in SVG, no sprites and no image files, whose state comes from the providers
rather than from a timer. Load decides most of it: idle, then busy, then working hard.
Music playing beats the clock, because a machine playing something at 2am is listening
rather than asleep, and strain beats music, because 90% load is the thing worth noticing.

**Its most important state is not knowing.** `cpuUsage()` returns null when two samples
land inside one tick, and a companion that sits there looking calm on a null is lying in
the one place you will believe it, because a glance is all it gets. So there is a sixth
face: a question mark, in the warning colour, with `no reading  cpu unread` written
underneath. Calm and unmeasured must never look the same.

The label is the honest half. The drawing is a mood; the line under it is the number that
produced the mood, so you can tell a sleeping cat from a broken provider.

One phase drives the breathing, the ears and the tail, so they cannot drift apart the way
three timers would, and blinks are scheduled from the elapsed time rather than at random,
so two companions do not blink in unison and a screenshot is reproducible.

`?mood=busy` forces a state for the gallery. The host never passes it.

### Two SVG traps this walked into

- **`hidden` is an HTML attribute.** The UA rule that turns it into `display: none` does
  not reach SVG, and `el.hidden = false` on an `SVGElement` sets a JavaScript property
  that changes nothing on screen. Every eye state was drawing at once, and only the group
  that happened to carry the attribute in the markup was ever hidden.
- **An invalid `fill` falls back to black; an invalid `stroke` falls back to none.**
  `--bg` was never defined in `widgets/theme.css`, so `fill="var(--bg)"` looked correct
  by luck while `stroke="var(--bg)"` drew nothing at all. The token exists now, and the
  shader widget's `u_bg` reads the theme rather than the fallback it had been using.

## Media control without an API key

The now-playing widget has working transport buttons and **no Spotify account, no OAuth and
no API key**.

Every desktop already knows what is playing, because the OS owns the media keys. Reading
that is better than a music service's web API in four ways: nothing to register, nothing to
refresh, it works offline, and it covers **every** player rather than one - Spotify, a
browser tab, VLC.

| | |
| --- | --- |
| Windows | SMTC, via `GlobalSystemMediaTransportControlsSessionManager` |
| macOS | AppleScript against the running player |
| Linux | MPRIS over D-Bus, via `playerctl` |

## Providers

`cpu` · `memory` · `host` · `date` · `media`

A widget reads its own manifest with `hikari.config()`, which is how the media widget gets
its `source` without the host knowing anything about video.

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

Twenty-one tests: placement geometry and widget discovery: work-area anchoring against a
taskbar, every anchor, stacked offsets, a second monitor's origin, manifest defaults, a screen-filling wallpaper ignoring the work-area inset on any monitor, and the audio band maths - logarithmic bucketing, every band owning a bin on a small transform, asymmetric smoothing, and silence reading as zero rather than noise.
The host imports Electron at load, so the tests stub it - which is possible only because
the geometry is a pure function.

## Status

Providers, placement geometry, discovery and all three widgets are verified: 7 passing
tests, and the widgets render and update live in the browser preview above.

**The Electron host itself has not been run.** Electron's binary would not install in the
environment this was written in, so `src/main.js` is verified by reading and by its unit
tests rather than by launching. Expect first-run adjustments around window flags.

MIT
