/**
 * Providers are the only place platform-specific code lives.
 *
 * Each is `{ name, intervalMs, read(config), defaults? }` returning a plain object. The
 * host polls them and broadcasts the merged result; a widget never learns which OS it is
 * on, which is what lets one widget run on Windows, macOS and Linux unchanged.
 *
 * `config` is the provider's `defaults` with the user's `providers.<name>` block from
 * `~/.hikari/config.json` over the top, and it is passed on every read rather than at
 * registration so a provider can never hold a setting the user has since changed. It has
 * to come from there rather than from a widget manifest, because one poll serves every
 * widget and there is no single widget to ask. `intervalMs` in that block overrides the
 * provider's own, floored so a typo cannot spin a core.
 *
 * `weather` is the first one that needs it: a latitude and a longitude, or a place name,
 * have nowhere else to arrive from. It also carries the pattern for the ones after it,
 * which is that the fetch lives in the provider and every decision about the response
 * lives in a pure module beside it.
 */
const os = require("node:os");
const { media } = require("./media");
const { weather } = require("./weather");

let lastCpu = null;

/** CPU load from the delta between two samples. Null until there are two. */
function cpuUsage() {
  const total = os.cpus().reduce((acc, c) => {
    for (const [k, v] of Object.entries(c.times)) acc[k] = (acc[k] ?? 0) + v;
    return acc;
  }, {});
  const busy = total.user + total.nice + total.sys + total.irq;
  const all = busy + total.idle;
  const prev = lastCpu;
  lastCpu = { busy, all };
  if (!prev) return null;
  const dAll = all - prev.all;
  // Two samples inside one tick give a zero delta. Report null, never 0: a fabricated
  // zero is indistinguishable from a genuinely idle machine.
  if (dAll <= 0) return null;
  return ((busy - prev.busy) / dAll) * 100;
}

const providers = [
  { name: "cpu", intervalMs: 2000, read: () => ({ usage: cpuUsage() }) },
  {
    name: "memory",
    intervalMs: 5000,
    read: () => {
      const total = os.totalmem();
      const free = os.freemem();
      return { total, free, usage: ((total - free) / total) * 100 };
    },
  },
  {
    name: "host",
    intervalMs: 60000,
    read: () => ({ hostname: os.hostname(), platform: process.platform, uptime: os.uptime() }),
  },
  {
    name: "date",
    intervalMs: 1000,
    read: () => {
      const d = new Date();
      return {
        time: d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
        seconds: d.getSeconds(),
        day: d.toLocaleDateString([], { weekday: "short" }),
        date: d.toLocaleDateString([], { day: "numeric", month: "short" }),
      };
    },
  },
  media,
  weather,
];

module.exports = { providers, cpuUsage };
