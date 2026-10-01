/**
 * Whether the machine has a network, from the addresses it already holds.
 *
 * `os.networkInterfaces()` needs no subprocess, no permission and no packet, so this is the
 * cheapest honest answer available: **the machine has an address that could carry traffic.**
 * That is not the same as "the internet works", and the difference matters enough to be
 * written down rather than implied. A captive portal, a dead router and an expired lease all
 * leave a routable address in place, and nothing short of sending a packet somewhere tells
 * them apart. This provider does not send one, so it does not claim to know.
 *
 * What it does do is refuse the two addresses that look like a network and are not.
 *
 * ## Throughput is reported as unknown, on purpose
 *
 * There are no byte counters here to report. Node exposes none, and the three platforms keep
 * them in three unrelated places: `/proc/net/dev` on Linux, `netstat -ib` on macOS,
 * `Get-NetAdapterStatistics` on Windows. Two of those are a subprocess on every poll, and a
 * rate needs two samples, so the cheapest correct version is two subprocesses a second on
 * the platforms a widget would most like to be quiet on.
 *
 * Doing it on Linux only would be worse than not doing it. The same widget would show a
 * number on one machine and a dash on another, and the dash would read as "no traffic"
 * rather than as "not measured here". So `rxPerSec` and `txPerSec` are null everywhere, and
 * a fabricated zero was never on the table: it is indistinguishable from a quiet link, which
 * is the exact bug the `cpu` provider's null was written to avoid.
 */

/**
 * IPv6 link local is **fe80::/10**, not just the fe80 prefix.
 *
 * The block runs to febf, so a pattern anchored on `fe80:` alone misses the rest of it. Also
 * covers the unique-local and unspecified forms below, because all of them are addresses an
 * interface can hold while having nowhere to send anything.
 */
const V6_LINK_LOCAL = /^fe[89ab][0-9a-f]:/i;

/** IPv4 link local, which is what an interface self-assigns when DHCP got no answer. */
const V4_LINK_LOCAL = /^169\.254\./;

const UNSPECIFIED = new Set(["0.0.0.0", "::"]);

/**
 * Node changed this field from the number 4 to the string "IPv4" in 18.0.
 *
 * Both are accepted rather than the widget rendering an empty family on whichever release it
 * was not written against, which is a silent gap: the address still shows and the label next
 * to it is simply blank.
 */
function familyOf(entry) {
  const f = entry?.family;
  if (f === "IPv4" || f === 4) return "IPv4";
  if (f === "IPv6" || f === 6) return "IPv6";
  return null;
}

/**
 * Whether one address could actually carry traffic off this machine.
 *
 * This is the rule the whole provider rests on, and the two exclusions are not pedantry.
 * Verified on this machine, macOS: `awdl0` and `llw0` are Apple's peer-to-peer interfaces
 * and they hold an `fe80::` address **whether or not Wi-Fi is connected to anything**, and
 * an idle `utun0` from a VPN client does the same. A check that only asked `internal !== true`
 * would report a machine with no network as up, and name a peer-to-peer interface as the one
 * carrying it.
 */
function isRoutable(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.internal === true) return false;
  const address = typeof entry.address === "string" ? entry.address.trim() : "";
  if (address === "" || UNSPECIFIED.has(address)) return false;
  const family = familyOf(entry);
  if (family === null) return false;
  if (family === "IPv4") return !V4_LINK_LOCAL.test(address);
  return !V6_LINK_LOCAL.test(address);
}

/**
 * Every routable address, in the order the OS listed its interfaces.
 *
 * The order is kept and not sorted, because it is the only signal available about which
 * interface matters, and it is a weak one. **This does not read the routing table.** Naming
 * the interface that actually carries the default route means `route -n get default`, `ip
 * route` or `Get-NetRoute`, one subprocess per poll on all three platforms, to label a line
 * of text. So the name is reported as what it is, an address the machine holds, and the
 * widget presents it that way rather than as "your connection".
 */
function routable(interfaces) {
  const out = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isRoutable(entry)) continue;
      out.push({ name, address: entry.address.trim(), family: familyOf(entry), mac: typeof entry.mac === "string" ? entry.mac : null });
    }
  }
  return out;
}

/**
 * `os.networkInterfaces()` output as the shape a widget reads.
 *
 * IPv4 is preferred for the headline address even when an IPv6 one is listed first, because
 * on a dual-stack machine both are routable and the v4 address is the one a person
 * recognises as theirs. The v6 address is still in the list for a widget that wants it.
 *
 * `available` and `up` are two different questions and are kept apart on purpose.
 * `available` is whether this provider got an answer; `up` is whether the machine has a
 * network. Collapsing them would make a provider that failed look exactly like a machine
 * that is offline, and those need opposite responses from you.
 */
function readInterfaces(interfaces) {
  if (!interfaces || typeof interfaces !== "object" || Array.isArray(interfaces)) {
    return { available: false, reason: "the operating system listed no network interfaces", up: null };
  }

  const found = routable(interfaces);
  const headline = found.find((e) => e.family === "IPv4") ?? found[0] ?? null;

  return {
    available: true,
    // False here is a real claim, and it is the one this function can support: no interface
    // holds an address that could carry traffic.
    up: found.length > 0,
    name: headline?.name ?? null,
    address: headline?.address ?? null,
    family: headline?.family ?? null,
    interfaces: found,
    // Not measured. See the note at the top of this file: a number here would have to be
    // invented, and an invented rate is worse than a missing one.
    rxPerSec: null,
    txPerSec: null,
  };
}

module.exports = { V4_LINK_LOCAL, V6_LINK_LOCAL, familyOf, isRoutable, readInterfaces, routable };
