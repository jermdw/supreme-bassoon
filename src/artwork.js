import crypto from 'node:crypto';

const SPOTIFY_GREEN = 0x1db954;
const ART_SIZE = 16;
const PIXEL_COUNT = ART_SIZE * ART_SIZE;

/** Identifies a cover so the clock can tell whether it already holds it. */
export function buildArtId(imageUrl) {
  return crypto.createHash('sha1').update(imageUrl).digest('hex').slice(0, 12);
}

export function rgbToHsv(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;

  let h = 0;
  if (d > 0) {
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
    else if (max === gn) h = ((bn - rn) / d + 2) / 6;
    else h = ((rn - gn) / d + 4) / 6;
  }
  const s = max === 0 ? 0 : d / max;
  return [h, s, max];
}

export function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);

  let r = 0;
  let g = 0;
  let b = 0;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  return [
    Math.round(Math.min(1, Math.max(0, r)) * 255),
    Math.round(Math.min(1, Math.max(0, g)) * 255),
    Math.round(Math.min(1, Math.max(0, b)) * 255),
  ];
}

function applyGammaChannel(byteVal, gamma, blackFloor = 5) {
  if (byteVal <= blackFloor) return 0;
  const normalized = byteVal / 255;
  const corrected = Math.pow(normalized, gamma);
  const out = Math.round(corrected * 255);
  return out <= 2 ? 0 : Math.min(255, out);
}

/**
 * Converts a 16x16x3 raw RGB buffer into 256 24-bit integer colors tuned for LED matrices,
 * and extracts a high-contrast vibrant accent color for artist text & progress bar.
 */
export function processRgb16x16(rgbBuffer, { gamma = 1.55, saturation = 1.25 } = {}) {
  if (!rgbBuffer || rgbBuffer.length < PIXEL_COUNT * 3) {
    throw new Error(`Expected at least ${PIXEL_COUNT * 3} RGB bytes, got ${rgbBuffer?.length ?? 0}`);
  }

  const pixels = new Array(PIXEL_COUNT);
  const hueBuckets = new Array(24).fill(0);
  const hueSums = new Array(24).fill(0);
  const satSums = new Array(24).fill(0);

  for (let i = 0; i < PIXEL_COUNT; i++) {
    const offset = i * 3;
    const r0 = rgbBuffer[offset];
    const g0 = rgbBuffer[offset + 1];
    const b0 = rgbBuffer[offset + 2];

    const [h, s, v] = rgbToHsv(r0, g0, b0);

    // Track vibrant pixels for accent color extraction
    if (s >= 0.22 && v >= 0.2) {
      const bucket = Math.min(23, Math.floor(h * 24));
      const weight = s * s * v;
      hueBuckets[bucket] += weight;
      hueSums[bucket] += h * weight;
      satSums[bucket] += s * weight;
    }

    const boostedS = Math.min(1, s * saturation);
    const [r1, g1, b1] = hsvToRgb(h, boostedS, v);

    const rf = applyGammaChannel(r1, gamma);
    const gf = applyGammaChannel(g1, gamma);
    const bf = applyGammaChannel(b1, gamma);

    pixels[i] = (rf << 16) | (gf << 8) | bf;
  }

  let bestBucket = -1;
  let bestWeight = 0;
  for (let b = 0; b < 24; b++) {
    if (hueBuckets[b] > bestWeight) {
      bestWeight = hueBuckets[b];
      bestBucket = b;
    }
  }

  let accent = SPOTIFY_GREEN;
  if (bestBucket !== -1 && bestWeight > 0.35) {
    const avgHue = hueSums[bestBucket] / bestWeight;
    const avgSat = satSums[bestBucket] / bestWeight;
    const legibleSat = Math.min(0.95, Math.max(0.55, avgSat * 1.15));
    const [ar, ag, ab] = hsvToRgb(avgHue, legibleSat, 0.95);
    accent = (ar << 16) | (ag << 8) | ab;
  }

  return { pixels, accent };
}

export class ArtworkProcessor {
  constructor({ gamma = 1.55, saturation = 1.25, maxCacheEntries = 64, decodeToRgb16x16 = null, fetchFn = fetch } = {}) {
    this.gamma = gamma;
    this.saturation = saturation;
    this.maxCacheEntries = maxCacheEntries;
    this.fetchFn = fetchFn;
    this.decodeFn = decodeToRgb16x16;
    this.cache = new Map();
  }

  async _getDecoder() {
    if (this.decodeFn) return this.decodeFn;
    const sharpMod = await import('sharp');
    const sharp = sharpMod.default || sharpMod;
    this.decodeFn = async (imageBuffer) => {
      const { data } = await sharp(imageBuffer)
        .resize(ART_SIZE, ART_SIZE, { fit: 'cover', kernel: 'lanczos3' })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      return data;
    };
    return this.decodeFn;
  }

  async getArtwork(imageUrl) {
    if (!imageUrl) {
      return { pixels: null, accent: SPOTIFY_GREEN };
    }

    if (this.cache.has(imageUrl)) {
      const cached = this.cache.get(imageUrl);
      this.cache.delete(imageUrl);
      this.cache.set(imageUrl, cached);
      return cached;
    }

    const res = await this.fetchFn(imageUrl, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) {
      throw new Error(`Album art HTTP ${res.status} for ${imageUrl}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    const decode = await this._getDecoder();
    const rawRgb = await decode(Buffer.from(arrayBuffer));
    const processed = processRgb16x16(rawRgb, {
      gamma: this.gamma,
      saturation: this.saturation,
    });

    if (this.cache.size >= this.maxCacheEntries) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.set(imageUrl, processed);
    return processed;
  }
}
