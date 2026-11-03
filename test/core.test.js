import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { processRgb16x16, ArtworkProcessor } from '../src/artwork.js';
import { SpotifyClient, sanitizeMatrixText, pickSmallestCoverImage, buildSafeTrackId } from '../src/spotify.js';
import { TokenStore } from '../src/store.js';
import { AwtrixCoordinator } from '../src/awtrix.js';
import { createBridgeServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('sanitizeMatrixText cleans smart quotes, dashes, and diacritics for LED fonts', () => {
  assert.equal(
    sanitizeMatrixText('Sigur Rós — “Hoppípolla” (Don’t Stop…)'),
    'Sigur Ros - "Hoppipolla" (Don\'t Stop...)'
  );
  assert.equal(
    sanitizeMatrixText('Beyoncé', { asciiTransliterate: false }),
    'Beyoncé'
  );
});

test('pickSmallestCoverImage chooses compact >=64px Spotify cover over 640px', () => {
  const images = [
    { url: 'https://i.scdn.co/image/640', width: 640, height: 640 },
    { url: 'https://i.scdn.co/image/300', width: 300, height: 300 },
    { url: 'https://i.scdn.co/image/64', width: 64, height: 64 },
  ];
  assert.equal(pickSmallestCoverImage(images), 'https://i.scdn.co/image/64');
});

test('buildSafeTrackId preserves URL-safe Spotify IDs and hashes local files', () => {
  assert.equal(buildSafeTrackId({ id: '4cOdK2wGLETKBW3PvgPWqT' }), '4cOdK2wGLETKBW3PvgPWqT');
  const localId = buildSafeTrackId({ id: null, name: 'My Demo Song', uri: 'spotify:local:Artist:Album:Song:180' });
  assert.match(localId, /^local_[0-9a-f]{16}$/);
});

test('processRgb16x16 clamps near-black LED floor and extracts vibrant accent color', () => {
  const buf = Buffer.alloc(16 * 16 * 3, 0);
  // Top half near-black noise (3, 4, 2) -> should clamp to pure 0x000000
  for (let i = 0; i < 128; i++) {
    buf[i * 3] = 3;
    buf[i * 3 + 1] = 4;
    buf[i * 3 + 2] = 2;
  }
  // Bottom half vibrant cyan/blue cover art
  for (let i = 128; i < 256; i++) {
    buf[i * 3] = 15;
    buf[i * 3 + 1] = 180;
    buf[i * 3 + 2] = 240;
  }

  const { pixels, accent } = processRgb16x16(buf);
  assert.equal(pixels.length, 256);
  assert.equal(pixels[0], 0x000000);
  assert.ok(pixels[200] > 0);

  // Extracted accent should be dominated by blue/green over red
  const r = (accent >> 16) & 0xff;
  const g = (accent >> 8) & 0xff;
  const b = accent & 0xff;
  assert.ok(b > 200 && g > 140 && r < 120, `Unexpected accent RGB: ${r},${g},${b}`);
});

test('processRgb16x16 falls back to Spotify green on grayscale album covers', () => {
  const buf = Buffer.alloc(16 * 16 * 3, 120);
  const { accent } = processRgb16x16(buf);
  assert.equal(accent, 0x1db954);
});

test('ArtworkProcessor caches processed 16x16 covers by URL', async () => {
  let fetchCalls = 0;
  const processor = new ArtworkProcessor({
    fetchFn: async () => {
      fetchCalls++;
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(16) };
    },
    decodeToRgb16x16: async () => Buffer.alloc(16 * 16 * 3, 200),
  });

  const a1 = await processor.getArtwork('https://example.com/cover.jpg');
  const a2 = await processor.getArtwork('https://example.com/cover.jpg');
  assert.equal(fetchCalls, 1);
  assert.deepEqual(a1, a2);
});

test('SpotifyClient refreshes expired tokens, persists rotated refresh_token, and parses playback', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'awtrix-spotify-test-'));
  try {
    const store = new TokenStore(tmpDir);
    await store.save({
      accessToken: 'expired_token',
      refreshToken: 'initial_refresh_token',
      expiresAtMs: Date.now() - 5000,
    });

    const calls = [];
    const client = new SpotifyClient({
      clientId: 'cid',
      clientSecret: 'csecret',
      redirectUri: 'http://127.0.0.1:8765/callback',
      tokenStore: store,
      fetchFn: async (url, opts) => {
        calls.push({ url, method: opts?.method });
        if (url.includes('/api/token')) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                access_token: 'fresh_access_token',
                refresh_token: 'rotated_refresh_token',
                expires_in: 3600,
              }),
          };
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () =>
            JSON.stringify({
              is_playing: true,
              progress_ms: 42000,
              item: {
                id: 'track123',
                type: 'track',
                name: 'Instant Crush',
                duration_ms: 337000,
                artists: [{ name: 'Daft Punk' }, { name: 'Julian Casablancas' }],
                album: {
                  name: 'Random Access Memories',
                  images: [{ url: 'https://i.scdn.co/image/64', width: 64, height: 64 }],
                },
              },
            }),
        };
      },
    });

    const playing = await client.getCurrentlyPlaying();
    assert.equal(playing.playing, true);
    assert.equal(playing.id, 'track123');
    assert.equal(playing.title, 'Instant Crush');
    assert.equal(playing.artist, 'Daft Punk, Julian Casablancas');
    assert.equal(playing.imageUrl, 'https://i.scdn.co/image/64');

    const stored = await store.load();
    assert.equal(stored.refreshToken, 'rotated_refresh_token');
    assert.equal(stored.accessToken, 'fresh_access_token');
    assert.equal(calls.length, 2);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('AwtrixCoordinator enables app, switches on track change, and hides on pause', async () => {
  const actions = [];
  const mockClient = {
    scripts: {
      getSource: async () => null,
      install: async (name) => {
        actions.push(['install', name]);
        return {};
      },
      getConfig: async () => ({}),
      updateConfig: async (name, cfg) => {
        actions.push(['updateConfig', name, cfg.server_url]);
      },
    },
    apps: {
      setEnabled: async (name, enabled) => {
        actions.push(['setEnabled', name, enabled]);
      },
      switchTo: async (name) => {
        actions.push(['switchTo', name]);
      },
    },
  };

  const coord = new AwtrixCoordinator({
    host: '192.168.1.50',
    appName: 'spotify',
    pauseGraceMs: 0,
    serverLanUrl: 'http://192.168.1.100:8765',
    client: mockClient,
  });

  // Track 1 starts playing -> installs once, enables, switches
  await coord.onPlaybackState({ playing: true, id: 't1', title: 'Song 1', artist: 'Artist 1' });
  // Same track polled again -> no duplicate enable or switchTo
  await coord.onPlaybackState({ playing: true, id: 't1', title: 'Song 1', artist: 'Artist 1' });
  // Track 2 starts -> switches to app without re-enabling
  await coord.onPlaybackState({ playing: true, id: 't2', title: 'Song 2', artist: 'Artist 2' });
  // Paused -> disables app from rotation
  await coord.onPlaybackState({ playing: false, id: 't2', title: 'Song 2', artist: 'Artist 2' });

  assert.deepEqual(actions, [
    ['install', 'spotify'],
    ['updateConfig', 'spotify', 'http://192.168.1.100:8765'],
    ['setEnabled', 'spotify', true],
    ['switchTo', 'spotify'],
    ['switchTo', 'spotify'],
    ['setEnabled', 'spotify', false],
  ]);
  coord.dispose();
});

test('AwtrixCoordinator falls back to the order route on firmware without the enable route', async () => {
  const orders = [];
  let enableCalls = 0;
  const apps = [
    { name: 'spotify', enabled: true, slot: 1 },
    { name: 'Time', enabled: true, slot: 0 },
    { name: 'Date', enabled: false, slot: null },
  ];
  const mockClient = {
    apps: {
      setEnabled: async () => {
        enableCalls++;
        throw Object.assign(new Error('failed with 400 invalidName'), { status: 400, code: 'invalidName' });
      },
      list: async () => apps,
      setOrder: async (order) => {
        orders.push(order);
      },
    },
  };

  const coord = new AwtrixCoordinator({ host: '192.168.1.50', appName: 'spotify', client: mockClient });

  await coord._setAppEnabled(mockClient, false);
  await coord._setAppEnabled(mockClient, true);

  assert.equal(enableCalls, 1, 'should stop trying the missing route after the first failure');
  assert.deepEqual(orders, [
    { order: ['Time'], disabled: ['Date', 'spotify'] },
    { order: ['Time', 'spotify'], disabled: ['Date'] },
  ]);
});

test('AwtrixCoordinator does not hide other 400 errors behind the order route', async () => {
  const mockClient = {
    apps: {
      setEnabled: async () => {
        throw Object.assign(new Error('failed with 400 badJson'), { status: 400, code: 'badJson' });
      },
      list: async () => assert.fail('should not fall back'),
    },
  };

  const coord = new AwtrixCoordinator({ host: '192.168.1.50', appName: 'spotify', client: mockClient });

  await assert.rejects(coord._setAppEnabled(mockClient, true), /badJson/);
});

test('HTTP server omits 256-pixel art payload when ?track= matches cached track on clock', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'awtrix-srv-test-'));
  const config = loadConfig({ PORT: '0', DATA_DIR: tmpDir, SERVER_LAN_URL: 'http://192.168.1.100:8765' });
  const store = new TokenStore(tmpDir);
  const spotify = new SpotifyClient({
    clientId: 'cid',
    clientSecret: 'sec',
    redirectUri: 'http://127.0.0.1:8765/callback',
    tokenStore: store,
  });
  const awtrix = new AwtrixCoordinator({ host: '', serverLanUrl: config.serverLanUrl });

  const fakeArt = new Array(256).fill(0x1db954);
  const server = createBridgeServer({
    config,
    spotify,
    awtrix,
    getCurrentSnapshot: () => ({
      playing: true,
      id: 'abc123',
      title: 'Veridis Quo',
      artist: 'Daft Punk',
      progressMs: 10000,
      durationMs: 300000,
      accent: 0x1db954,
      art: fakeArt,
      updatedAtMs: Date.now(),
    }),
    triggerImmediatePoll: async () => {},
  });

  async function invokeGet(reqUrl) {
    return new Promise((resolve) => {
      const req = {
        url: reqUrl,
        method: 'GET',
        headers: { host: '127.0.0.1:8765' },
        [Symbol.asyncIterator]: async function* () {},
      };
      let statusCode = 200;
      const res = {
        writeHead(code) {
          statusCode = code;
        },
        end(body = '') {
          resolve({ status: statusCode, body: String(body) });
        },
      };
      server.emit('request', req, res);
    });
  }

  try {
    // 1st poll from clock (different or empty track id) -> includes 256-pixel art
    const r1 = await invokeGet('/api/now-playing?track=');
    const j1 = JSON.parse(r1.body);
    assert.equal(r1.status, 200);
    assert.equal(j1.id, 'abc123');
    assert.equal(j1.art.length, 256);

    // 2nd poll from clock (?track=abc123) -> omits art to save Wi-Fi & Berry GC
    const r2 = await invokeGet('/api/now-playing?track=abc123');
    const j2 = JSON.parse(r2.body);
    assert.equal(r2.status, 200);
    assert.equal(j2.id, 'abc123');
    assert.equal(j2.art, undefined);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Berry script passes structural balance & AWTRIX NG conventions check', async () => {
  const berryPath = path.resolve(__dirname, '../berry/spotify_now_playing.be');
  const src = await fs.readFile(berryPath, 'utf8');

  // Verify no C-style // comments outside strings (Berry uses # comments)
  for (const line of src.split('\n')) {
    const trimmed = line.trim();
    assert.ok(!trimmed.startsWith('//'), `Berry script must use # comments, found: ${trimmed}`);
  }

  // Verify balanced block keywords (class / def / if / for / while / try -> end)
  const stripped = src
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').replace(/"[^"]*"/g, '""'))
    .join('\n');

  const openers = (stripped.match(/\b(class|def|if|for|while|try)\b/g) || []).length;
  const closers = (stripped.match(/\bend\b/g) || []).length;
  assert.equal(openers, closers, `Unbalanced Berry blocks: ${openers} openers vs ${closers} 'end's`);
  assert.match(src, /return SpotifyNowPlaying\(\)/);
});
