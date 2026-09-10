/**
 * Free space, for one or more paths.
 *
 *   { "providers": { "disk": { "paths": ["/", "~/Movies", "D:\\"] } } }
 *
 * With nothing set it reports the home directory's filesystem, which is the one that fills
 * up and the only one whose name this code can work out on all three platforms.
 *
 * There is no parser in here and no subprocess on any platform, because `fs.statfs` answers
 * this natively on Windows, macOS and Linux. Everything that is a decision is in
 * `src/lib/disk.js`: which paths, which of the two free-block counts to believe, and what a
 * percentage is when the total is zero.
 *
 * The one thing this file owns is not blocking. `fs.promises.statfs` runs on the libuv
 * threadpool, so a wedged SMB or NFS mount ties up a thread rather than the event loop, but
 * it never returns and the poll would sit on it forever. Hence the per-path deadline below:
 * one stalled mount reports as a stalled mount on its own row, and the other volumes are
 * still measured on time.
 */
const fs = require("node:fs");
const os = require("node:os");
const { explain, failedVolume, pathsFor, readVolume, view } = require("../lib/disk");

/** A minute. Free space changes when a person copies something, which is not often, and
 *  every extra poll is a syscall against every configured mount. */
const INTERVAL_MS = 60 * 1000;

/** Long enough for a spinning disk to answer, short enough that a dead network mount does
 *  not hold the poll past its own interval. */
const TIMEOUT_MS = 3000;

/**
 * Whether this Node can answer the question at all.
 *
 * `fs.statfs` arrived in 18.15. Checked rather than assumed, because the alternative is a
 * `TypeError` on every poll, and "not a function" in a log is a message about this code
 * rather than about the reader's Node, which is what actually needs changing.
 */
const SUPPORTED = typeof fs.promises?.statfs === "function";

/**
 * One path, measured, with a deadline.
 *
 * The timer is cleared on the happy path. Left running it would hold the event loop open
 * past a quit for as long as the deadline, which turns closing the app into a three second
 * pause with nothing on screen to explain it.
 */
async function measure(target) {
  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), TIMEOUT_MS);
  });
  try {
    // A rejection is an answer, and a specific one: ENOENT for a path that is not there,
    // EACCES for one that cannot be reached. Both are more use to a reader than "failed",
    // so the code travels through rather than being collapsed into one word.
    const measured = fs.promises.statfs(target).then((stat) => ({ stat }), (failed) => ({ failed }));
    const race = await Promise.race([measured, deadline]);

    if (race.timedOut) return failedVolume(target, `no answer in ${TIMEOUT_MS}ms, the mount may be unreachable`);
    if (race.failed) return failedVolume(target, explain(race.failed));
    return readVolume(target, race.stat);
  } finally {
    clearTimeout(timer);
  }
}

const disk = {
  name: "disk",
  intervalMs: INTERVAL_MS,
  /**
   * No default `paths`, and that is not the same as no default: the default is worked out
   * from the running machine in `pathsFor`, because the home directory is not a constant
   * that can be written here. Putting a literal `/` in this object would be wrong on a
   * Windows box with the user profile on another drive.
   */
  defaults: {},
  async read(config) {
    if (!SUPPORTED) {
      return view([], `fs.statfs needs Node 18.15 or newer, and this is ${process.version}`);
    }

    const chosen = pathsFor(config, os.homedir());
    if (chosen.error) return view([], chosen.error);

    // In parallel, because the deadline is per path and running them in series would let
    // three slow mounts add up to three deadlines.
    return view(await Promise.all(chosen.paths.map(measure)));
  },
};

module.exports = { disk, INTERVAL_MS, TIMEOUT_MS, SUPPORTED };
