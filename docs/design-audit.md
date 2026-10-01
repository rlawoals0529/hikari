# Design audit

Run with `impeccable`'s deterministic detectors (Apache-2.0, no model, no key), against the
widgets' own HTML. A design audit with no number is an opinion, so here is the number.

**16 findings before, 0 after**, across 15 widgets.

## What it found

| Widget | Finding | What was done |
| --- | --- | --- |
| settings | `low-contrast` x4, `undersized-ui-text` x4 | Both fixed, and the contrast one centrally: see below |
| calendar, weather, nowplaying | `low-contrast` | Fixed by the same theme change |
| todo, system | 10px and 10.5px text below the readable floor | Raised to 11px and 12px |
| stats | `layout-transition` x2 | `transition: width` became a composited `transform: scaleX` |
| dock | `cramped-padding` | The row had no vertical inset declared |

### The contrast finding was a theme bug, not a widget bug

`--dim` measured **2.4:1** against the panel, where WCAG AA asks for 4.5:1, and it showed up
in four widgets at once. The cause was not the text colour: `--panel` was
`rgba(14, 14, 20, 0.72)`, and a see-through panel composites with whatever wallpaper is
behind it, so the contrast of every word on the desktop depended on a picture nobody here
chose. Over a white wallpaper, the worst case, it was unreadable by the standard.

Raising the panel to `0.85` and lightening `--dim` to `#a8a8c4` puts the worst case at
**5.5:1**, and it is still see-through enough that the backdrop blur reads as glass. Four
widgets were fixed by one line each.

## What was not changed, and why

`decoder` reports one `side-tab` finding on `.caveats li`: a 2px left border at 45% opacity.
The rule is about a thick coloured border on a **card**, which is a recognisable tell. This is
a list item, the border is a callout marker rather than decoration, and the caveats are the
thing that tool is built around. Left as it is deliberately rather than left unexamined.

## Two things worth knowing about the tool

**It reads `.css` and `.html` and not `.tsx`.** A React app whose styles live in JSX
scans completely clean and means nothing by it. That was checked rather than assumed: a file
with a purple gradient, Inter, a card inside a card and an em dash reported zero findings as
`.tsx` and three as `.html`.

**So plant something before trusting a zero.** The first clean result here was a scan that
had not read anything at all.
