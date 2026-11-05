import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { processRgb16x16, ArtworkProcessor, buildArtId } from '../src/artwork.js';
import { SpotifyClient, sanitizeMatrixText, pickSmallestCoverImage, buildSafeTrackId, parseRetryAfterSeconds } from '../src/spotify.js';
import { TokenStore, loadOrCreateClockToken } from '../src/store.js';
import { AwtrixCoordinator } from '../src/awtrix.js';
import { createBridgeServer, isUnreachableLanUrl } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { RepeatLimiter } from '../src/logging.js';
import { isClockVisible, nextPollDelay } from '../src/playback.js';

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

test('AwtrixCoordinator enables the app before installing and switches only when needed', async () => {
  const actions = [];
  let appOn = false;
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
      list: async () => [{ name: 'spotify', enabled: appOn }],
      setEnabled: async (name, enabled) => {
        appOn = enabled;
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
    pausedScreenMs: 60_000,
    serverLanUrl: 'http://192.168.1.100:8765',
    client: mockClient,
  });
  const song = (id, extra = {}) => ({ playing: true, id, title: 'Song', artist: 'Artist', ...extra });

  // Nothing playing yet -> installs and enables, so the script can poll, without switching
  await coord.onPlaybackState({ playing: false, id: '' });
  // Starts playing -> switches
  await coord.onPlaybackState(song('t1'));
  // Same track polled again -> no duplicate
  await coord.onPlaybackState(song('t1'));
  // Next track -> switches
  await coord.onPlaybackState(song('t2'));
  // Paused, then resumed while still on show -> no switch
  await coord.onPlaybackState(song('t2', { playing: false, pausedAtMs: Date.now() }));
  await coord.onPlaybackState(song('t2'));
  // Paused too long, then resumed -> switches again
  await coord.onPlaybackState(song('t2', { playing: false, pausedAtMs: Date.now() - 120_000 }));
  await coord.onPlaybackState(song('t2'));

  assert.deepEqual(actions, [
    ['setEnabled', 'spotify', true], // Must come before install: see _syncScript
    ['install', 'spotify'],
    ['updateConfig', 'spotify', 'http://192.168.1.100:8765'],
    ['switchTo', 'spotify'],
    ['switchTo', 'spotify'],
    ['switchTo', 'spotify'],
  ]);
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

test('SpotifyClient reports API errors instead of treating them as nothing playing', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'awtrix-spotify-err-'));
  try {
    const store = new TokenStore(tmpDir);
    await store.save({ accessToken: 'token', refreshToken: 'refresh', expiresAtMs: Date.now() + 3_600_000 });
    let status = 500;
    const client = new SpotifyClient({
      clientId: 'cid',
      clientSecret: 'sec',
      redirectUri: 'http://127.0.0.1:8765/callback',
      tokenStore: store,
      fetchFn: async () => ({ ok: status < 400, status, headers: new Headers(), text: async () => '' }),
    });

    for (status of [403, 500, 502, 503]) {
      await assert.rejects(client.getCurrentlyPlaying(), new RegExp(`HTTP ${status}`));
    }

    status = 204;
    const idle = await client.getCurrentlyPlaying();
    assert.equal(idle.playing, false);
    assert.equal(idle.id, '');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('AwtrixCoordinator applies playback state in the background and keeps only the newest', async () => {
  const switched = [];
  let releaseClock;
  const clockBlocked = new Promise((resolve) => {
    releaseClock = resolve;
  });
  const mockClient = {
    apps: {
      list: async () => {
        await clockBlocked;
        return [{ name: 'spotify', enabled: true }];
      },
      switchTo: async () => {},
    },
  };
  const coord = new AwtrixCoordinator({ host: '192.168.1.50', autoInstallScript: false, client: mockClient });
  const realApply = coord.onPlaybackState.bind(coord);
  coord.onPlaybackState = async (state) => {
    switched.push(state.id);
    await realApply(state);
  };

  const done = coord.requestPlaybackSync({ playing: true, id: 't1' });
  coord.requestPlaybackSync({ playing: true, id: 't2' });
  coord.requestPlaybackSync({ playing: true, id: 't3' });
  assert.deepEqual(switched, ['t1'], 'later states must wait for the clock without blocking the caller');

  releaseClock();
  await done;
  assert.deepEqual(switched, ['t1', 't3']);
});

test('AwtrixCoordinator runs only one script install at a time', async () => {
  let installs = 0;
  const mockClient = {
    apps: { list: async () => [] },
    scripts: {
      getSource: async () => null,
      install: async () => {
        installs++;
        return {};
      },
      getConfig: async () => ({}),
      updateConfig: async () => {},
    },
  };
  const coord = new AwtrixCoordinator({ host: '192.168.1.50', serverLanUrl: 'http://x:1', client: mockClient });

  await Promise.all([coord.ensureScriptInstalled(), coord.ensureScriptInstalled()]);
  assert.equal(installs, 1);
  assert.equal(coord.scriptSynced, true);
});

test('Dashboard preview reports when the clock itself last polled', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'awtrix-poll-test-'));
  const config = loadConfig({ DATA_DIR: tmpDir, SERVER_LAN_URL: 'http://192.168.1.100:8765' });
  const awtrix = {};
  const server = createBridgeServer({
    config,
    spotify: {},
    awtrix,
    getCurrentSnapshot: () => ({ playing: false, id: '', progressMs: 0, durationMs: 1, updatedAtMs: Date.now() }),
    triggerImmediatePoll: async () => {},
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const preview = async () => (await fetch(`${base}/api/preview`)).json();

  try {
    assert.equal((await preview()).clockLastPollAgoMs, null);

    await fetch(`${base}/api/now-playing?art=`);
    assert.equal((await preview()).clockLastPollAgoMs, null, 'other callers must not count as the clock');

    await fetch(`${base}/api/now-playing?clock=1&art=`);
    const ago = (await preview()).clockLastPollAgoMs;
    assert.ok(ago >= 0 && ago < 5000, `Unexpected poll age: ${ago}`);

  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('HTTP server sends art only when the clock does not already hold that cover', async () => {
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
  const coverId = buildArtId('https://i.scdn.co/image/cover');
  let snapshot = {
    playing: true,
    id: 'abc123',
    title: 'Veridis Quo',
    artist: 'Daft Punk',
    progressMs: 10000,
    durationMs: 300000,
    accent: 0x1db954,
    art: fakeArt,
    artId: coverId,
    updatedAtMs: Date.now(),
  };
  const server = createBridgeServer({
    config,
    spotify,
    awtrix,
    getCurrentSnapshot: () => snapshot,
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
    // Clock holds no cover -> includes 256-pixel art
    const r1 = await invokeGet('/api/now-playing?art=');
    const j1 = JSON.parse(r1.body);
    assert.equal(r1.status, 200);
    assert.equal(j1.id, 'abc123');
    assert.equal(j1.artId, coverId);
    assert.equal(j1.art.length, 256);

    // Clock holds this cover -> omits art to save Wi-Fi & Berry GC
    const r2 = await invokeGet(`/api/now-playing?art=${coverId}`);
    const j2 = JSON.parse(r2.body);
    assert.equal(r2.status, 200);
    assert.equal(j2.id, 'abc123');
    assert.equal(j2.artId, coverId);
    assert.equal(j2.art, undefined);

    // New track whose cover failed to download -> no art, empty id tells the clock to drop the old cover
    snapshot = { ...snapshot, id: 'next456', art: null, artId: '' };
    const r3 = JSON.parse((await invokeGet(`/api/now-playing?art=${coverId}`)).body);
    assert.equal(r3.id, 'next456');
    assert.equal(r3.artId, '');
    assert.equal(r3.art, undefined);

    // Download succeeds on a later poll -> the clock still gets the cover for that same track
    const retriedId = buildArtId('https://i.scdn.co/image/next');
    snapshot = { ...snapshot, art: fakeArt, artId: retriedId };
    const r4 = JSON.parse((await invokeGet('/api/now-playing?art=')).body);
    assert.equal(r4.artId, retriedId);
    assert.equal(r4.art.length, 256);
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

test('Clock and simulator draw the two text lines on the same baselines', async () => {
  const berry = await fs.readFile(path.resolve(__dirname, '../berry/spotify_now_playing.be'), 'utf8');
  assert.match(berry, /draw_scrolling_line\(text_x, 6, avail_w, self\.title,/);
  assert.match(berry, /draw_scrolling_line\(text_x, 14, avail_w, self\.artist,/);

  const server = await fs.readFile(path.resolve(__dirname, '../src/server.js'), 'utf8');
  assert.match(server, /drawScrolling\(fb, 17, 6, 35, state\.title/);
  assert.match(server, /drawScrolling\(fb, 17, 14, 35, state\.artist/);
  assert.match(server, /baseline - 5 \+ r/);
});

async function withSecurityServer(run) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'awtrix-sec-test-'));
  const actions = [];
  const exchanges = [];
  let cleared = 0;
  const server = createBridgeServer({
    config: loadConfig({ DATA_DIR: tmpDir, SERVER_LAN_URL: 'http://192.168.1.100:8765' }),
    spotify: {
      controlPlayback: async (action) => {
        actions.push(action);
        return { status: 204, data: null };
      },
      exchangeCode: async (...args) => exchanges.push(args),
      tokenStore: { clear: async () => cleared++ },
    },
    awtrix: {},
    getCurrentSnapshot: () => ({ playing: true, id: '', progressMs: 0, durationMs: 1, updatedAtMs: Date.now() }),
    triggerImmediatePoll: async () => {},
    clockToken: 'secret-token',
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ base, actions, exchanges, getCleared: () => cleared });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

test('Playback commands need the clock token or a same-origin POST', async () => {
  await withSecurityServer(async ({ base, actions }) => {
    const status = async (urlPath, init) => (await fetch(base + urlPath, { redirect: 'manual', ...init })).status;

    assert.equal(await status('/api/action/next'), 403);
    assert.equal(await status('/api/action/next?token=wrong'), 403);
    assert.equal(await status('/api/action/next?token='), 403);
    assert.equal(await status('/api/action/next', { method: 'POST' }), 403);
    assert.equal(await status('/api/action/next', { method: 'POST', headers: { Origin: 'https://evil.example' } }), 403);
    assert.equal(await status('/api/action/next', { method: 'POST', headers: { Origin: 'null' } }), 403);
    assert.deepEqual(actions, [], 'rejected requests must not reach Spotify');

    assert.equal(await status('/api/action/next?token=secret-token'), 200);
    assert.equal(await status('/api/action/toggle', { method: 'POST', headers: { Origin: base } }), 200);
    assert.deepEqual(actions, ['next', 'pause']);
  });
});

test('Playback commands are refused when the server has no clock token', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'awtrix-sec-test-'));
  const server = createBridgeServer({
    config: loadConfig({ DATA_DIR: tmpDir }),
    spotify: { controlPlayback: async () => assert.fail('must not reach Spotify') },
    awtrix: {},
    getCurrentSnapshot: () => ({ playing: false }),
    triggerImmediatePoll: async () => {},
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/action/next?token=`);
    assert.equal(res.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Sign-in forms reject posts from other sites', async () => {
  await withSecurityServer(async ({ base, exchanges, getCleared }) => {
    const post = (urlPath, origin) =>
      fetch(base + urlPath, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(origin ? { Origin: origin } : {}) },
        body: 'callbackUrl=attacker-code',
      });

    assert.equal((await post('/auth/logout', 'https://evil.example')).status, 403);
    assert.equal((await post('/auth/manual-callback', 'https://evil.example')).status, 403);
    assert.equal(getCleared(), 0);
    assert.deepEqual(exchanges, []);

    assert.equal((await post('/auth/manual-callback', base)).status, 302);
    assert.deepEqual(exchanges, [['attacker-code', null]]);
    assert.equal((await post('/auth/logout', base)).status, 302);
    assert.equal(getCleared(), 1);
  });
});

test('Browser sign-in callback passes state and requires it', async () => {
  await withSecurityServer(async ({ base, exchanges }) => {
    await fetch(`${base}/callback?code=c1&state=s1`, { redirect: 'manual' });
    assert.deepEqual(exchanges, [['c1', 's1', { requireState: true }]]);
  });

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'awtrix-state-test-'));
  try {
    let tokenRequests = 0;
    const client = new SpotifyClient({
      clientId: 'cid',
      clientSecret: 'sec',
      redirectUri: 'http://127.0.0.1:8765/callback',
      tokenStore: new TokenStore(tmpDir),
      fetchFn: async () => {
        tokenRequests++;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }),
        };
      },
    });
    const opts = { requireState: true };

    await assert.rejects(client.exchangeCode('code', 'anything', opts), /state mismatch/, 'no sign-in was started');
    const state = new URL(client.createAuthorizeUrl()).searchParams.get('state');
    await assert.rejects(client.exchangeCode('code', null, opts), /state mismatch/);
    await assert.rejects(client.exchangeCode('code', 'wrong', opts), /state mismatch/);
    assert.equal(tokenRequests, 0);

    await client.exchangeCode('code', state, opts);
    assert.equal(tokenRequests, 1);
    await assert.rejects(client.exchangeCode('code', state, opts), /state mismatch/, 'state is single use');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Clock token persists across restarts and reaches the clock', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'awtrix-token-test-'));
  try {
    const dataDir = path.join(tmpDir, 'nested');
    const token = await loadOrCreateClockToken(dataDir);
    assert.match(token, /^[0-9a-f]{32}$/);
    assert.equal(await loadOrCreateClockToken(dataDir), token);

    const updates = [];
    let configToken = 'old';
    const makeCoord = () => new AwtrixCoordinator({
      host: '192.168.1.50',
      serverLanUrl: 'http://x:1',
      clockToken: token,
      client: {
        apps: { list: async () => [] },
        scripts: {
          getSource: async () => null,
          install: async () => ({}),
          getConfig: async () => ({
            fields: [
              { key: 'server_url', value: 'http://x:1' },
              { key: 'poll_ms', value: 2000 },
              { key: 'token', value: configToken },
              { key: 'keep_on_screen', value: false },
            ],
          }),
          updateConfig: async (_name, cfg) => updates.push(cfg),
        },
      },
    });
    await makeCoord().ensureScriptInstalled();
    assert.equal(updates.length, 1, 'a stale token must trigger a config update');
    assert.equal(updates[0].token, token);

    configToken = token;
    await makeCoord().ensureScriptInstalled();
    assert.equal(updates.length, 1, 'a matching config must not restart the script');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Berry script sends the token with button commands', async () => {
  const script = await fs.readFile(new URL('../berry/spotify_now_playing.be', import.meta.url), 'utf8');
  assert.match(script, /# @config token text/);
  assert.match(script, /"\/api\/action\/" \+ action \+ "\?token=" \+ self\.token/);
});

test('Clock stays visible while playing and for the paused window only', () => {
  const now = 1_000_000;
  assert.equal(isClockVisible({ playing: true }, now, 5000), true);
  assert.equal(isClockVisible({ playing: false, pausedAtMs: null }, now, 5000), false);
  assert.equal(isClockVisible({ playing: false, pausedAtMs: now - 4999 }, now, 5000), true);
  assert.equal(isClockVisible({ playing: false, pausedAtMs: now - 5000 }, now, 5000), false);
  assert.equal(isClockVisible({ playing: false, pausedAtMs: now }, now, 0), false);
});

test('Now-playing response tells the clock when to take a turn', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'awtrix-visible-test-'));
  let snap = { playing: false, id: 't1', progressMs: 0, durationMs: 1, updatedAtMs: Date.now(), pausedAtMs: Date.now() };
  const server = createBridgeServer({
    config: loadConfig({ DATA_DIR: tmpDir, PAUSED_SCREEN_MS: '60000' }),
    spotify: {},
    awtrix: {},
    getCurrentSnapshot: () => snap,
    triggerImmediatePoll: async () => {},
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const nowPlaying = async () => (await fetch(`http://127.0.0.1:${server.address().port}/api/now-playing`)).json();
  try {
    let d = await nowPlaying();
    assert.deepEqual([d.playing, d.paused, d.visible], [false, true, true]);
    snap = { ...snap, pausedAtMs: Date.now() - 120_000 };
    d = await nowPlaying();
    assert.equal(d.visible, false);
    snap = { ...snap, pausedAtMs: null, playing: true };
    d = await nowPlaying();
    assert.deepEqual([d.playing, d.paused, d.visible], [true, false, true]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Spotify polling slows down only after a long idle', () => {
  const polling = { activeMs: 2000, idleMs: 5000, deepIdleMs: 30_000, deepIdleAfterMs: 600_000 };
  const delay = (playing, idleFor) => nextPollDelay({ playing, lastPlayingMs: 0, nowMs: idleFor, polling });
  assert.equal(delay(true, 9_000_000), 2000);
  assert.equal(delay(false, 599_999), 5000);
  assert.equal(delay(false, 600_000), 30_000);
});

test('RepeatLimiter logs a repeating warning once, then a count per interval', () => {
  const lines = [];
  let nowMs = 0;
  const limiter = new RepeatLimiter({ log: (l) => lines.push(l), intervalMs: 1000, now: () => nowMs });

  limiter.warn('a', 'down');
  limiter.warn('a', 'down');
  limiter.warn('a', 'down');
  assert.deepEqual(lines, ['down']);

  nowMs = 1000;
  limiter.warn('a', 'down');
  assert.equal(lines[1], 'down (repeated 3 more times)');

  limiter.warn('a', 'other');
  assert.equal(lines[2], 'other', 'a new message is logged straight away');
  limiter.warn('b', 'down');
  assert.equal(lines[3], 'down', 'keys are independent');

  limiter.recovered('a', 'back');
  assert.equal(lines[4], 'back (after 1 failed attempts)');
  limiter.recovered('a', 'back');
  assert.equal(lines.length, 5, 'recovery is reported once');
});

test('Berry script sits out the rotation through should_show and holds it while playing', async () => {
  const script = await fs.readFile(new URL('../berry/spotify_now_playing.be', import.meta.url), 'utf8');
  assert.match(script, /def should_show\(\)\n\s+return self\.visible && !self\.is_offline\(\)/);
  assert.match(script, /self\.keep_on_screen && self\.shown && self\.playing && !self\.is_offline\(\)/);
  assert.match(script, /def init\(\)[\s\S]*rotation\.resume\(\)[\s\S]*def tick\(\)/);
});

test('AwtrixCoordinator leaves an app that is already on alone', async () => {
  const calls = [];
  const coord = new AwtrixCoordinator({
    host: '192.168.1.50',
    autoInstallScript: false,
    client: {
      apps: {
        list: async () => [{ name: 'spotify', enabled: true }],
        setEnabled: async () => calls.push('setEnabled'),
        setOrder: async () => calls.push('setOrder'),
      },
    },
  });
  await coord.onPlaybackState({ playing: false, id: '' });
  await coord.onPlaybackState({ playing: false, id: '' });
  assert.deepEqual(calls, []);
  assert.equal(coord.appEnabled, true);
});

test('sanitizeMatrixText keeps Hangul and kana whole', () => {
  assert.equal(sanitizeMatrixText('방탄소년단'), '방탄소년단');
  assert.equal(sanitizeMatrixText('ガラス'), 'ガラス');
  assert.equal(sanitizeMatrixText('Rosé'), 'Rose');
});

test('parseRetryAfterSeconds keeps backoff working on any header', () => {
  assert.equal(parseRetryAfterSeconds('30'), 30);
  assert.equal(parseRetryAfterSeconds(null), 5);
  assert.equal(parseRetryAfterSeconds('soon'), 5);
  assert.equal(parseRetryAfterSeconds('-4'), 0);
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(parseRetryAfterSeconds('Thu, 01 Jan 2026 00:00:20 GMT', now), 20);
});

test('A malformed Retry-After still stops requests during a rate limit', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'awtrix-429-test-'));
  try {
    const store = new TokenStore(tmpDir);
    await store.save({ accessToken: 'token', refreshToken: 'refresh', expiresAtMs: Date.now() + 3_600_000 });
    let requests = 0;
    const client = new SpotifyClient({
      clientId: 'cid',
      clientSecret: 'sec',
      redirectUri: 'http://127.0.0.1:8765/callback',
      tokenStore: store,
      fetchFn: async () => {
        requests++;
        return { ok: false, status: 429, headers: new Headers({ 'retry-after': 'soon' }), text: async () => '' };
      },
    });
    assert.equal(await client.getCurrentlyPlaying(), null);
    assert.equal(await client.getCurrentlyPlaying(), null);
    assert.equal(requests, 1);
    assert.ok(Number.isFinite(client.rateLimitedUntilMs));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Playback commands report what Spotify answered', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'awtrix-action-test-'));
  let result = { status: 404, data: { error: { message: 'Player command failed' } } };
  let polls = 0;
  const server = createBridgeServer({
    config: loadConfig({ DATA_DIR: tmpDir }),
    spotify: { controlPlayback: async () => result },
    awtrix: {},
    getCurrentSnapshot: () => ({ playing: false }),
    triggerImmediatePoll: async () => polls++,
    clockToken: 'secret',
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const send = () => fetch(`http://127.0.0.1:${server.address().port}/api/action/play?token=secret`);
  try {
    let res = await send();
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /No active Spotify device/);

    result = { status: 403, data: { error: { message: 'Premium required' } } };
    res = await send();
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'Premium required');

    result = { status: 429, data: null };
    res = await send();
    assert.equal(res.status, 429);
    assert.match((await res.json()).error, /HTTP 429/);

    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(polls, 0, 'failed commands change nothing worth polling for');

    result = { status: 204, data: null };
    res = await send();
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(polls, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('isUnreachableLanUrl flags loopback and Docker addresses only', () => {
  for (const url of ['http://127.0.0.1:8765', 'http://localhost:8765', 'http://172.22.0.2:8765', 'http://0.0.0.0:8765', 'nonsense']) {
    assert.equal(isUnreachableLanUrl(url), true, url);
  }
  for (const url of ['http://192.168.1.110:8765', 'http://10.0.0.5:8765', 'http://172.32.0.1:8765', 'http://clock-bridge.lan:8765']) {
    assert.equal(isUnreachableLanUrl(url), false, url);
  }
});

test('Dashboard does not claim a pending sync when the script is installed by hand', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'awtrix-dash-test-'));
  const server = createBridgeServer({
    config: loadConfig({ DATA_DIR: tmpDir, AUTO_INSTALL_SCRIPT: 'false', SERVER_LAN_URL: 'http://172.22.0.2:8765' }),
    spotify: { isAuthorized: async () => false },
    awtrix: { isConfigured: () => true, scriptSynced: false },
    getCurrentSnapshot: () => ({ playing: false }),
    triggerImmediatePoll: async () => {},
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const html = await (await fetch(`http://127.0.0.1:${server.address().port}/`)).text();
    assert.match(html, /Installed manually/);
    assert.doesNotMatch(html, /Pending sync/);
    assert.match(html, /alert warn"><strong>Warning:<\/strong> <code>SERVER_LAN_URL/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('AwtrixCoordinator notices a wiped clock without disturbing a healthy one', async () => {
  const scriptPath = fileURLToPath(new URL('../berry/spotify_now_playing.be', import.meta.url));
  const source = await fs.readFile(scriptPath, 'utf8');
  const calls = [];
  const fields = [
    { key: 'server_url', value: 'http://x:1' },
    { key: 'poll_ms', value: 2000 },
    { key: 'token', value: 'tok' },
    { key: 'keep_on_screen', value: false },
  ];
  const missing = () => Object.assign(new Error('no such script'), { status: 404 });
  let getSource = async () => source;
  let getConfig = async () => ({ fields });
  let appOn = true;
  const coord = new AwtrixCoordinator({
    host: '192.168.1.50',
    serverLanUrl: 'http://x:1',
    clockToken: 'tok',
    scriptRecheckMs: 0,
    client: {
      apps: {
        list: async () => [{ name: 'spotify', enabled: appOn }],
        setEnabled: async () => calls.push('setEnabled'),
      },
      scripts: {
        getSource: () => getSource(),
        getConfig: () => getConfig(),
        install: async () => {
          calls.push('install');
          return {};
        },
        updateConfig: async () => calls.push('updateConfig'),
      },
    },
  });

  await coord.ensureScriptInstalled();
  await new Promise((resolve) => setTimeout(resolve, 2));
  assert.deepEqual(calls, [], 'a matching script is left alone');

  appOn = false;
  await coord.ensureScriptInstalled();
  await new Promise((resolve) => setTimeout(resolve, 2));
  assert.deepEqual(calls, [], 'an app the user switched off stays off');
  appOn = true;

  getSource = async () => {
    throw Object.assign(new Error('timeout'), { status: undefined });
  };
  await coord.ensureScriptInstalled();
  await new Promise((resolve) => setTimeout(resolve, 2));
  assert.deepEqual(calls, [], 'a blip must not reinstall');
  assert.match(coord.lastError, /timeout/);

  getSource = async () => {
    throw missing();
  };
  getConfig = async () => {
    throw missing();
  };
  await coord.ensureScriptInstalled();
  assert.deepEqual(calls, ['install', 'updateConfig'], 'a wiped clock gets the script back');
});

test('AwtrixCoordinator rechecks the script only once per interval', async () => {
  let checks = 0;
  const coord = new AwtrixCoordinator({
    host: '192.168.1.50',
    serverLanUrl: 'http://x:1',
    client: {
      apps: { list: async () => [] },
      scripts: {
        getSource: async () => {
          checks++;
          return null;
        },
        install: async () => ({}),
        getConfig: async () => ({}),
        updateConfig: async () => {},
      },
    },
  });
  await coord.ensureScriptInstalled();
  await coord.ensureScriptInstalled();
  assert.equal(checks, 1);
  coord.lastScriptCheckMs = Date.now() - coord.scriptRecheckMs;
  await coord.ensureScriptInstalled();
  assert.equal(checks, 2);
});

test('Berry script reports failed commands and rides out Spotify lag', async () => {
  const script = await fs.readFile(new URL('../berry/spotify_now_playing.be', import.meta.url), 'utf8');
  assert.match(script, /self\.on_action_response\(a, b\)/);
  assert.match(script, /self\.badge_text = "FAILED"/);
  assert.match(script, /if now_ms\(\) >= self\.state_hold_until\n\s+self\.playing = /);
});
