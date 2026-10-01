/**
 * Whether the machine has a network, from the addresses it already holds.
 *
 * The cheapest provider in the repo: one synchronous call into `os`, no subprocess, no
 * permission and no packet on the wire. That last one is the reason it is also the most
 * carefully worded, and the wording lives in `src/lib/network.js` along with every decision
 * about which addresses count.
 *
 * **No cached reading and no staleness rule here, unlike weather and the battery.**
 * `os.networkInterfaces()` reads a table the kernel already holds; there is no request to
 * fail and nothing to ride out, so a window in which a kept answer stays worth showing would
 * be a window that never opens. Keeping the shared rule for its own sake would be ceremony,
 * and worse, it would suggest to the next reader that this provider can go stale.
 *
 * Throughput is reported as unknown. The reason is at the top of the lib module, and it is
 * the same rule as everywhere else in this repo: an invented number is worse than a missing
 * one, and a fabricated zero here is indistinguishable from a quiet link.
 */
const os = require("node:os");
const { readInterfaces } = require("../lib/network");

/** Five seconds. An address changes when a lease renews or a cable moves, and the call is
 *  cheap enough that the interval is set by how fast a person wants to see that, not by
 *  cost. */
const INTERVAL_MS = 5000;

const network = {
  name: "network",
  intervalMs: INTERVAL_MS,
  read() {
    // Wrapped, because a synchronous throw from a provider is caught by the host and logged
    // as a failed provider, which leaves the widget with no state at all rather than with a
    // reason. `readInterfaces` reads garbage as unavailable-with-a-reason, so handing it the
    // failure is better than letting it escape.
    try {
      return readInterfaces(os.networkInterfaces());
    } catch (e) {
      return { available: false, reason: e.message ?? String(e), up: null };
    }
  },
};

module.exports = { network, INTERVAL_MS };
