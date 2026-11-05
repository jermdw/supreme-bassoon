import crypto from 'node:crypto';

const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';

export const SPOTIFY_SCOPES = [
  'user-read-currently-playing',
  'user-read-playback-state',
  'user-modify-playback-state',
].join(' ');

const PUNCTUATION_MAP = {
  '\u2018': "'",
  '\u2019': "'",
  '\u201C': '"',
  '\u201D': '"',
  '\u2013': '-',
  '\u2014': '-',
  '\u2026': '...',
  '\u00A0': ' ',
};

export function sanitizeMatrixText(input, { asciiTransliterate = true } = {}) {
  if (!input) return '';
  let text = String(input);
  for (const [src, dst] of Object.entries(PUNCTUATION_MAP)) {
    text = text.replaceAll(src, dst);
  }
  if (asciiTransliterate) {
    text = text
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/ß/g, 'ss')
      .replace(/Æ/g, 'AE')
      .replace(/æ/g, 'ae')
      .replace(/Ø/g, 'O')
      .replace(/ø/g, 'o');
  }
  // NFKD above splits Hangul and kana into parts that the mark removal leaves behind.
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** Retry-After is seconds or an HTTP date. Anything else falls back so backoff still applies. */
export function parseRetryAfterSeconds(header, nowMs = Date.now()) {
  const fallback = 5;
  if (!header) return fallback;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const dateMs = Date.parse(header);
  return Number.isNaN(dateMs) ? fallback : Math.max(0, (dateMs - nowMs) / 1000);
}

export function pickSmallestCoverImage(images) {
  if (!Array.isArray(images) || images.length === 0) return null;
  // Prefer ~64x64 or ~300x300 cover over 640x640 to minimize bandwidth
  const sorted = [...images]
    .filter((img) => img && typeof img.url === 'string')
    .sort((a, b) => (a.width || 9999) - (b.width || 9999));
  const preferred = sorted.find((img) => (img.width || 0) >= 64) || sorted[0];
  return preferred ? preferred.url : null;
}

export function buildSafeTrackId(item) {
  if (item?.id && /^[A-Za-z0-9_-]+$/.test(item.id)) {
    return item.id;
  }
  const basis = `${item?.name || 'unknown'}:${item?.uri || ''}`;
  return 'local_' + crypto.createHash('sha1').update(basis).digest('hex').slice(0, 16);
}

export class SpotifyClient {
  constructor({ clientId, clientSecret, redirectUri, asciiTransliterate = true, tokenStore, fetchFn = fetch }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
    this.asciiTransliterate = asciiTransliterate;
    this.tokenStore = tokenStore;
    this.fetchFn = fetchFn;

    this.pendingOAuthState = null;
    this.rateLimitedUntilMs = 0;
    this.refreshPromise = null;
  }

  isConfigured() {
    return Boolean(
      this.clientId &&
      this.clientSecret &&
      this.clientId !== 'your_spotify_client_id_here' &&
      this.clientSecret !== 'your_spotify_client_secret_here'
    );
  }

  async isAuthorized() {
    const tokens = await this.tokenStore.load();
    return Boolean(tokens.refreshToken);
  }

  createAuthorizeUrl() {
    this.pendingOAuthState = crypto.randomBytes(16).toString('hex');
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      scope: SPOTIFY_SCOPES,
      redirect_uri: this.redirectUri,
      state: this.pendingOAuthState,
      show_dialog: 'false',
    });
    return `${SPOTIFY_AUTH_URL}?${params.toString()}`;
  }

  /**
   * requireState is for browser redirects, which anyone can forge. A pasted bare code has no
   * state to check, so that route relies on the server's same-origin check instead.
   */
  async exchangeCode(code, state = null, { requireState = false } = {}) {
    if (!code) throw new Error('Missing authorization code');
    const stateMissing = requireState && (!state || !this.pendingOAuthState);
    if (stateMissing || (this.pendingOAuthState && state && state !== this.pendingOAuthState)) {
      throw new Error('OAuth state mismatch; please start sign-in again.');
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
    });

    const data = await this._tokenRequest(body);
    this.pendingOAuthState = null;

    await this.tokenStore.save({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAtMs: Date.now() + (Number(data.expires_in) || 3600) * 1000,
      scope: data.scope || SPOTIFY_SCOPES,
    });
  }

  async _tokenRequest(formParams) {
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const res = await this.fetchFn(SPOTIFY_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formParams.toString(),
      signal: AbortSignal.timeout(8000),
    });

    const text = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // non-json response
    }

    if (!res.ok) {
      const detail = parsed?.error_description || parsed?.error || text || `HTTP ${res.status}`;
      throw new Error(`Spotify token request failed (${res.status}): ${detail}`);
    }
    return parsed;
  }

  async getValidAccessToken({ forceRefresh = false } = {}) {
    const tokens = await this.tokenStore.load();
    if (!tokens.refreshToken) {
      throw new Error('Spotify account not connected yet.');
    }

    const now = Date.now();
    if (!forceRefresh && tokens.accessToken && tokens.expiresAtMs && now < tokens.expiresAtMs - 60_000) {
      return tokens.accessToken;
    }

    if (!this.refreshPromise) {
      this.refreshPromise = (async () => {
        const body = new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: tokens.refreshToken,
        });
        const refreshed = await this._tokenRequest(body);

        // Immediately persist any rotated refresh_token before further API calls
        const saved = await this.tokenStore.save({
          accessToken: refreshed.access_token,
          refreshToken: refreshed.refresh_token || tokens.refreshToken,
          expiresAtMs: Date.now() + (Number(refreshed.expires_in) || 3600) * 1000,
          scope: refreshed.scope || tokens.scope,
        });
        return saved.accessToken;
      })().finally(() => {
        this.refreshPromise = null;
      });
    }

    return this.refreshPromise;
  }

  async _apiRequest(endpointPath, { method = 'GET', retryOn401 = true } = {}) {
    if (Date.now() < this.rateLimitedUntilMs) {
      return { status: 429, data: null };
    }

    const token = await this.getValidAccessToken();
    const res = await this.fetchFn(`${SPOTIFY_API_BASE}${endpointPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(7000),
    });

    if (res.status === 401 && retryOn401) {
      await this.getValidAccessToken({ forceRefresh: true });
      return this._apiRequest(endpointPath, { method, retryOn401: false });
    }

    if (res.status === 429) {
      const retryAfterSec = parseRetryAfterSeconds(res.headers.get('retry-after'));
      this.rateLimitedUntilMs = Date.now() + Math.max(2, retryAfterSec) * 1000;
      console.warn(`[spotify] Rate limited (429); backing off for ${retryAfterSec}s`);
      return { status: 429, data: null };
    }

    if (res.status === 204 || res.headers.get('content-length') === '0') {
      return { status: res.status, data: null };
    }

    const text = await res.text();
    if (!text) return { status: res.status, data: null };

    try {
      return { status: res.status, data: JSON.parse(text) };
    } catch {
      return { status: res.status, data: null };
    }
  }

  async getCurrentlyPlaying() {
    const { status, data } = await this._apiRequest('/me/player/currently-playing?additional_types=track,episode');

    if (status === 429) {
      return null; // Caller keeps existing state during rate-limit backoff
    }

    if (status !== 200 && status !== 204) {
      throw new Error(`Spotify currently-playing request failed with HTTP ${status}`);
    }

    if (status === 204 || !data || !data.item) {
      return {
        playing: false,
        id: '',
        title: '',
        artist: '',
        album: '',
        imageUrl: null,
        progressMs: 0,
        durationMs: 0,
      };
    }

    const item = data.item;
    const isEpisode = item.type === 'episode';

    const rawTitle = item.name || 'Unknown Title';
    const rawArtist = isEpisode
      ? item.show?.name || 'Podcast'
      : Array.isArray(item.artists)
        ? item.artists.map((a) => a.name).filter(Boolean).join(', ')
        : 'Unknown Artist';
    const rawAlbum = isEpisode ? item.show?.name || '' : item.album?.name || '';
    const images = isEpisode ? item.images || item.show?.images : item.album?.images;

    return {
      playing: Boolean(data.is_playing),
      id: buildSafeTrackId(item),
      title: sanitizeMatrixText(rawTitle, { asciiTransliterate: this.asciiTransliterate }),
      artist: sanitizeMatrixText(rawArtist, { asciiTransliterate: this.asciiTransliterate }),
      album: sanitizeMatrixText(rawAlbum, { asciiTransliterate: this.asciiTransliterate }),
      imageUrl: pickSmallestCoverImage(images),
      progressMs: Math.max(0, Number(data.progress_ms) || 0),
      durationMs: Math.max(1, Number(item.duration_ms) || 1),
    };
  }

  async controlPlayback(action) {
    switch (action) {
      case 'play':
        return this._apiRequest('/me/player/play', { method: 'PUT' });
      case 'pause':
        return this._apiRequest('/me/player/pause', { method: 'PUT' });
      case 'next':
        return this._apiRequest('/me/player/next', { method: 'POST' });
      case 'previous':
        return this._apiRequest('/me/player/previous', { method: 'POST' });
      default:
        throw new Error(`Unsupported playback action: ${action}`);
    }
  }
}
