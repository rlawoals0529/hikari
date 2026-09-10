const { test } = require("node:test");
const assert = require("node:assert/strict");
const { V4_LINK_LOCAL, V6_LINK_LOCAL, familyOf, isRoutable, readInterfaces, routable } = require("../src/lib/network");

/**
 * Captured on this machine with `os.networkInterfaces()`. macOS 15, on Wi-Fi.
 *
 * The interesting half of this fixture is everything that is not `en0`. `awdl0` and `llw0`
 * are Apple's peer-to-peer interfaces and `utun0` is an idle VPN tunnel, and all three are
 * `internal: false` while holding nothing but an `fe80::` address. A check that only asked
 * about `internal` would count three of them.
 */
const REAL = {
  lo0: [
    { address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" },
    { address: "::1", netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", family: "IPv6", mac: "00:00:00:00:00:00", internal: true, cidr: "::1/128", scopeid: 0 },
    { address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "00:00:00:00:00:00", internal: true, cidr: "fe80::1/64", scopeid: 1 },
  ],
  en0: [
    { address: "fe80::14cb:fc65:656:a475", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "80:d1:ce:06:a7:c2", internal: false, cidr: "fe80::14cb:fc65:656:a475/64", scopeid: 14 },
    { address: "192.168.12.67", netmask: "255.255.255.0", family: "IPv4", mac: "80:d1:ce:06:a7:c2", internal: false, cidr: "192.168.12.67/24" },
  ],
  awdl0: [
    { address: "fe80::287e:b5ff:fe46:97f3", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "2a:7e:b5:46:97:f3", internal: false, cidr: "fe80::287e:b5ff:fe46:97f3/64", scopeid: 16 },
  ],
  llw0: [
    { address: "fe80::287e:b5ff:fe46:97f3", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "2a:7e:b5:46:97:f3", internal: false, cidr: "fe80::287e:b5ff:fe46:97f3/64", scopeid: 17 },
  ],
  utun0: [
    { address: "fe80::1aae:704f:3c80:b527", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "00:00:00:00:00:00", internal: false, cidr: "fe80::1aae:704f:3c80:b527/64", scopeid: 18 },
  ],
};

/** The same machine with the cable out and Wi-Fi off: loopback, and the peer-to-peer
 *  interfaces that exist whether or not anything is connected. */
const OFFLINE = { lo0: REAL.lo0, awdl0: REAL.awdl0, llw0: REAL.llw0 };

test("the real interface table off this machine reports the address a person recognises", () => {
  const n = readInterfaces(REAL);
  assert.equal(n.available, true);
  assert.equal(n.up, true);
  assert.equal(n.name, "en0");
  assert.equal(n.address, "192.168.12.67");
  assert.equal(n.family, "IPv4");
});

test("a machine with nothing but link-local addresses is down", () => {
  // The bug this rule exists for. `awdl0` and `llw0` hold an fe80:: address on every Mac,
  // connected or not, and they are `internal: false`. A check that only asked about
  // `internal` would call an offline machine up and name a peer-to-peer interface as the
  // one carrying it.
  const n = readInterfaces(OFFLINE);
  assert.equal(n.available, true);
  assert.equal(n.up, false);
  assert.equal(n.name, null);
  assert.equal(n.address, null);
  assert.deepEqual(n.interfaces, []);
});

test("only the interfaces that could carry traffic are listed", () => {
  // One entry from five interfaces and eight addresses, which is the whole point.
  const found = routable(REAL);
  assert.deepEqual(found.map((e) => e.name), ["en0"]);
  assert.equal(found[0].address, "192.168.12.67");
});

test("IPv6 link-local is the whole fe80 to febf block, not just fe80", () => {
  // A pattern anchored on `fe80:` alone misses the rest of /10, and those addresses have
  // nowhere to send anything either.
  for (const address of ["fe80::1", "fe90::1", "fea0::abcd", "febf::1", "FE80::1"]) {
    assert.equal(isRoutable({ address, family: "IPv6", internal: false }), false, address);
  }
  // fec0 is outside the block and is a real, if deprecated, address.
  assert.equal(isRoutable({ address: "fec0::1", family: "IPv6", internal: false }), true);
  assert.ok(V6_LINK_LOCAL.test("febf::1"));
});

test("an IPv4 address DHCP never handed out does not count as a network", () => {
  // 169.254/16 is what an interface self-assigns when it got no answer, so it is precisely
  // the state that must not read as up.
  assert.equal(isRoutable({ address: "169.254.14.2", family: "IPv4", internal: false }), false);
  assert.equal(isRoutable({ address: "169.253.14.2", family: "IPv4", internal: false }), true);
  assert.ok(V4_LINK_LOCAL.test("169.254.0.1"));
});

test("the unspecified address is not an address", () => {
  for (const address of ["0.0.0.0", "::"]) {
    assert.equal(isRoutable({ address, family: address.includes(":") ? "IPv6" : "IPv4", internal: false }), false, address);
  }
});

test("loopback is excluded however it is written", () => {
  for (const entry of REAL.lo0) assert.equal(isRoutable(entry), false, entry.address);
});

test("family as the number 4 is accepted, because Node used to report it that way", () => {
  // Node changed this field from 4 to "IPv4" in 18.0. Reading only one of them leaves the
  // family label silently blank on the other, which shows as an address with no kind.
  assert.equal(familyOf({ family: 4 }), "IPv4");
  assert.equal(familyOf({ family: 6 }), "IPv6");
  assert.equal(familyOf({ family: "IPv4" }), "IPv4");
  assert.equal(familyOf({ family: "inet" }), null);
  assert.equal(familyOf({}), null);
  assert.equal(isRoutable({ address: "10.0.0.4", family: 4, internal: false }), true);
});

test("an entry with no family is skipped rather than listed with a blank one", () => {
  assert.equal(isRoutable({ address: "10.0.0.4", internal: false }), false);
  assert.equal(readInterfaces({ en5: [{ address: "10.0.0.4", internal: false }] }).up, false);
});

test("the headline address is IPv4 even when IPv6 is listed first", () => {
  // Both are routable on a dual-stack machine, and the v4 one is what a person recognises as
  // theirs. On this machine's real table the v6 address is genuinely first.
  const n = readInterfaces({
    en0: [
      { address: "2001:db8::5", family: "IPv6", internal: false },
      { address: "192.168.1.9", family: "IPv4", internal: false },
    ],
  });
  assert.equal(n.address, "192.168.1.9");
  // The v6 one is still in the list for a widget that wants it.
  assert.equal(n.interfaces.length, 2);
});

test("an IPv6-only machine still reports up, and reports its v6 address", () => {
  const n = readInterfaces({ en0: [{ address: "2001:db8::5", family: "IPv6", internal: false }] });
  assert.equal(n.up, true);
  assert.equal(n.family, "IPv6");
  assert.equal(n.address, "2001:db8::5");
});

test("a provider that could not read anything is unavailable, which is not the same as down", () => {
  // Two different questions, kept apart on purpose. Collapsing them would make a broken
  // provider look exactly like an offline machine, and those need opposite responses.
  for (const bad of [null, undefined, "nope", 42, []]) {
    const n = readInterfaces(bad);
    assert.equal(n.available, false, JSON.stringify(bad));
    // Null, not false. False is a claim that the machine is offline, and a shape that could
    // not be read is not that claim.
    assert.equal(n.up, null, JSON.stringify(bad));
    assert.ok(n.reason, JSON.stringify(bad));
  }
});

test("an interface whose entries are not a list is skipped rather than throwing", () => {
  const n = readInterfaces({ en0: null, en1: "nope", en2: [{ address: "10.0.0.4", family: "IPv4", internal: false }] });
  assert.equal(n.up, true);
  assert.equal(n.name, "en2");
});

test("an empty table is down, and it is an answer rather than a failure", () => {
  const n = readInterfaces({});
  assert.equal(n.available, true);
  assert.equal(n.up, false);
});

test("throughput is unknown and never zero", () => {
  // Node exposes no byte counters, and the three platforms keep them in three unrelated
  // places, two of them behind a subprocess. A fabricated zero is indistinguishable from a
  // quiet link, which is the exact bug the cpu provider's null was written to avoid.
  const n = readInterfaces(REAL);
  assert.equal(n.rxPerSec, null);
  assert.equal(n.txPerSec, null);
  const offline = readInterfaces(OFFLINE);
  assert.equal(offline.rxPerSec, null);
  assert.equal(offline.txPerSec, null);
});
