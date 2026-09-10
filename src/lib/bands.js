/**
 * Pure audio maths, so it can be tested without a microphone or a browser.
 */

/**
 * Bucket an FFT magnitude array into `count` logarithmic bands.
 *
 * Logarithmic because hearing is: a linear split gives almost every bucket to the treble and
 * squeezes all the bass people actually watch into the first bar or two.
 */
function logBands(bins, count, sampleRate = 48000, minHz = 30, maxHz = 16000) {
  if (count <= 0) return [];
  if (bins.length === 0) return new Array(count).fill(0);

  const hzPerBin = sampleRate / 2 / bins.length;
  const out = new Array(count).fill(0);

  for (let b = 0; b < count; b++) {
    const lo = minHz * Math.pow(maxHz / minHz, b / count);
    const hi = minHz * Math.pow(maxHz / minHz, (b + 1) / count);
    let start = Math.floor(lo / hzPerBin);
    let end = Math.ceil(hi / hzPerBin);
    // Every band must own at least one bin, or the low bands read as silence on a small FFT.
    if (end <= start) end = start + 1;
    start = Math.max(0, Math.min(start, bins.length - 1));
    end = Math.max(start + 1, Math.min(end, bins.length));

    let sum = 0;
    for (let i = start; i < end; i++) sum += bins[i];
    out[b] = sum / (end - start) / 255;
  }
  return out;
}

/**
 * Exponential smoothing, asymmetric on purpose.
 *
 * Rising and falling at the same rate looks like mush. Attack fast so a beat lands on the
 * frame it happened; release slowly so the bar has something to fall from.
 */
function smooth(previous, next, attack = 0.55, release = 0.12) {
  const out = new Array(next.length);
  for (let i = 0; i < next.length; i++) {
    const prev = previous[i] ?? 0;
    out[i] = prev + (next[i] - prev) * (next[i] > prev ? attack : release);
  }
  return out;
}

/** Mean level of the lowest bands, which is what a beat actually moves. */
function bassLevel(bands, n = 3) {
  if (bands.length === 0) return 0;
  const take = Math.min(n, bands.length);
  let sum = 0;
  for (let i = 0; i < take; i++) sum += bands[i];
  return sum / take;
}

module.exports = { logBands, smooth, bassLevel };
