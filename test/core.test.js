import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { processRgb16x16, ArtworkProcessor, buildArtId } from '../src/artwork.js';
import { SpotifyClient, sanitizeMatrixText, pickSmallestCoverImage, buildSafeTrackId } from '../src/spotify.js';
import { TokenStore, loadOrCreateClockToken } from '../src/store.js';
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
      setEnabled: async () => {
        await clockBlocked;
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
  coord.dispose();
});

test('AwtrixCoordinator runs only one script install at a time', async () => {
  let installs = 0;
  const mockClient = {
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
  const awtrix = { appEnabled: true };
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

    assert.equal((await preview()).clockAppHidden, false);
    awtrix.appEnabled = false;
    assert.equal((await preview()).clockAppHidden, true);
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
      controlPlayback: async (action) => actions.push(action),
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
    const coord = new AwtrixCoordinator({
      host: '192.168.1.50',
      serverLanUrl: 'http://x:1',
      clockToken: token,
      client: {
        scripts: {
          getSource: async () => null,
          install: async () => ({}),
          getConfig: async () => ({ server_url: 'http://x:1', poll_ms: 2000, token: 'old' }),
          updateConfig: async (_name, cfg) => updates.push(cfg),
        },
      },
    });
    await coord.ensureScriptInstalled();
    assert.equal(updates.length, 1, 'a stale token must trigger a config update');
    assert.equal(updates[0].token, token);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Berry script sends the token with button commands', async () => {
  const script = await fs.readFile(new URL('../berry/spotify_now_playing.be', import.meta.url), 'utf8');
  assert.match(script, /# @config token text/);
  assert.match(script, /"\/api\/action\/" \+ action \+ "\?token=" \+ self\.token/);
});
