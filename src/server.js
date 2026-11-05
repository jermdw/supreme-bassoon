import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.resolve(__dirname, '../berry/spotify_now_playing.be');

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

async function readBody(req, maxBytes = 16384) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderDashboardHtml({ config, authorized, awtrixStatus, message = '', error = '' }) {
  const isLoopbackLan =
    config.serverLanUrl.includes('127.0.0.1') || config.serverLanUrl.includes('localhost');
  const usesLocalhostRedirect = config.spotify.redirectUri.includes('://localhost');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AWTRIX TC002 · Spotify Now Playing</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0d1117;
      --panel: #161b22;
      --border: #30363d;
      --text: #e6edf3;
      --muted: #8b949e;
      --green: #1db954;
      --warn: #d29922;
      --err: #f85149;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 2rem 1rem;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      max-width: 780px;
      margin-inline: auto;
      line-height: 1.5;
    }
    h1 { margin: 0 0 0.25rem; font-size: 1.5rem; display: flex; align-items: center; gap: 0.6rem; }
    .sub { color: var(--muted); margin-bottom: 1.5rem; font-size: 0.95rem; }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1.25rem;
      margin-bottom: 1rem;
    }
    .badge {
      display: inline-block;
      padding: 0.15rem 0.55rem;
      border-radius: 999px;
      font-size: 0.78rem;
      font-weight: 600;
    }
    .ok { background: rgba(29, 185, 84, 0.18); color: #3fb950; border: 1px solid rgba(63, 185, 80, 0.4); }
    .pending { background: rgba(210, 153, 34, 0.18); color: #e3b341; border: 1px solid rgba(210, 153, 34, 0.4); }
    .alert {
      padding: 0.75rem 1rem;
      border-radius: 8px;
      margin-bottom: 1rem;
      font-size: 0.9rem;
    }
    .alert.msg { background: rgba(29, 185, 84, 0.15); border: 1px solid var(--green); }
    .alert.err { background: rgba(248, 81, 73, 0.15); border: 1px solid var(--err); }
    .alert.warn { background: rgba(210, 153, 34, 0.15); border: 1px solid var(--warn); }
    .matrix-wrap {
      background: #050709;
      border: 2px solid #22272e;
      border-radius: 10px;
      padding: 14px;
      display: flex;
      justify-content: center;
      margin: 0.75rem 0;
    }
    canvas {
      width: 100%;
      max-width: 624px;
      aspect-ratio: 52 / 16;
      image-rendering: pixelated;
    }
    .btn {
      display: inline-block;
      background: var(--green);
      color: #000;
      font-weight: 700;
      text-decoration: none;
      border: none;
      border-radius: 6px;
      padding: 0.55rem 1rem;
      cursor: pointer;
      font-size: 0.9rem;
    }
    .btn.secondary {
      background: #21262d;
      color: var(--text);
      border: 1px solid var(--border);
      font-weight: 500;
    }
    .controls { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.75rem; }
    input[type="text"] {
      width: 100%;
      padding: 0.5rem 0.75rem;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: #0d1117;
      color: var(--text);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.85rem;
      margin: 0.4rem 0 0.6rem;
    }
    code {
      background: #0d1117;
      padding: 0.15rem 0.4rem;
      border-radius: 4px;
      font-size: 0.85em;
    }
    .kv { display: grid; grid-template-columns: 165px 1fr; gap: 0.35rem 0.75rem; font-size: 0.9rem; }
    .kv div:nth-child(odd) { color: var(--muted); }
    details { margin-top: 0.75rem; color: var(--muted); font-size: 0.88rem; }
    summary { cursor: pointer; color: var(--text); font-weight: 500; }
  </style>
</head>
<body>
  <h1>Ulanzi TC002 · Spotify Now Playing</h1>
  <div class="sub">52×16 AWTRIX NG Hybrid Bridge (16×16 Album Art + 40 FPS Dual-Line Berry Renderer)</div>

  ${message ? `<div class="alert msg">${escapeHtml(message)}</div>` : ''}
  ${error ? `<div class="alert err">${escapeHtml(error)}</div>` : ''}
  ${isLoopbackLan ? `<div class="alert warn"><strong>Warning:</strong> <code>SERVER_LAN_URL</code> is currently <code>${escapeHtml(config.serverLanUrl)}</code>. Set <code>SERVER_LAN_URL=http://&lt;YOUR_DESKTOP_LAN_IP&gt;:${config.port}</code> in <code>.env</code> so your TC002 clock can reach this container over Wi-Fi.</div>` : ''}
  ${usesLocalhostRedirect ? `<div class="alert err"><strong>Spotify Redirect URI Alert:</strong> Spotify disallows <code>localhost</code>. Use <code>http://127.0.0.1:${config.port}/callback</code> instead.</div>` : ''}

  <div class="card">
    <div style="display:flex; justify-content:space-between; align-items:center;">
      <strong>Live 52×16 Matrix Simulator</strong>
      <span id="trackMeta" style="color:var(--muted); font-size:0.85rem;">Idle</span>
    </div>
    <div class="matrix-wrap">
      <canvas id="matrix" width="520" height="160"></canvas>
    </div>
    <div class="controls">
      <button class="btn secondary" onclick="act('previous')">⏮ Prev</button>
      <button class="btn secondary" onclick="act('toggle')">⏯ Play / Pause</button>
      <button class="btn secondary" onclick="act('next')">⏭ Next</button>
      <a class="btn secondary" href="/berry/spotify_now_playing.be" target="_blank">View Berry Script (.be)</a>
    </div>
  </div>

  <div class="card">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
      <strong>1. Spotify Account</strong>
      ${authorized ? '<span class="badge ok">Connected</span>' : '<span class="badge pending">Not Connected</span>'}
    </div>
    <div class="kv">
      <div>Redirect URI:</div>
      <div><code>${escapeHtml(config.spotify.redirectUri)}</code></div>
      <div>Client Credentials:</div>
      <div>${config.spotify.clientId && config.spotify.clientId !== 'your_spotify_client_id_here' ? 'Configured' : '<span style="color:var(--err)">Missing in .env</span>'}</div>
    </div>
    <div class="controls" style="margin-top:1rem;">
      <div id="spotifyWarn" style="color:var(--warn); width:100%; font-size:0.9rem;"></div>
      <a class="btn" href="/auth/login">${authorized ? 'Reconnect Spotify' : 'Connect Spotify'}</a>
      ${authorized ? `<form method="POST" action="/auth/logout" style="margin:0;"><button class="btn secondary" type="submit">Disconnect</button></form>` : ''}
    </div>
    <details>
      <summary>Running on a headless machine? Paste callback URL manually</summary>
      <p style="margin:0.5rem 0;">If you opened this page from another computer and Spotify redirected your browser to <code>http://127.0.0.1:${config.port}/callback?code=...</code>, copy that full URL from your browser address bar and paste it below:</p>
      <form method="POST" action="/auth/manual-callback">
        <input type="text" name="callbackUrl" placeholder="http://127.0.0.1:${config.port}/callback?code=AQD..." required />
        <button class="btn secondary" type="submit">Complete Sign-In</button>
      </form>
    </details>
  </div>

  <div class="card">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
      <strong>2. Ulanzi TC002 (AWTRIX NG)</strong>
      ${awtrixStatus.configured ? `<span class="badge ${awtrixStatus.lastError ? 'pending' : 'ok'}">${awtrixStatus.lastError ? 'Retrying' : 'Ready'}</span>` : '<span class="badge pending">No Host Set</span>'}
    </div>
    <div class="kv">
      <div>Clock Host:</div>
      <div><code>${escapeHtml(config.awtrix.host || 'Not set')}</code></div>
      <div>Script App Name:</div>
      <div><code>${escapeHtml(config.awtrix.appName)}</code> (${awtrixStatus.scriptSynced ? 'Installed' : 'Pending sync'})</div>
      <div>Bridge Poll URL:</div>
      <div><code>${escapeHtml(config.serverLanUrl)}/api/now-playing</code></div>
      <div>Clock Last Polled:</div>
      <div id="clockPoll">Checking…</div>
      ${awtrixStatus.lastError ? `<div>Last Warning:</div><div style="color:var(--warn)">${escapeHtml(awtrixStatus.lastError)}</div>` : ''}
    </div>
  </div>

  <script>
    const canvas = document.getElementById('matrix');
    const ctx = canvas.getContext('2d');
    const metaEl = document.getElementById('trackMeta');
    let state = { playing: false, title: 'Spotify', artist: 'Idle', accent: 0x1db954, progressMs: 0, durationMs: 1, art: null, fetchedAt: performance.now() };

    const FONT_3X5 = {
      ' ': [0,0,0,0,0], '!': [2,2,2,0,2], "'": [2,2,0,0,0], '(': [1,2,2,2,1], ')': [4,2,2,2,4],
      '-': [0,0,7,0,0], '.': [0,0,0,0,2], '/': [1,1,2,4,4], ':': [0,2,0,2,0], '?': [6,1,2,0,2],
      '0': [7,5,5,5,7], '1': [2,6,2,2,7], '2': [7,1,7,4,7], '3': [7,1,7,1,7], '4': [5,5,7,1,1],
      '5': [7,4,7,1,7], '6': [7,4,7,5,7], '7': [7,1,1,2,2], '8': [7,5,7,5,7], '9': [7,5,7,1,7],
      'A': [2,5,7,5,5], 'B': [6,5,6,5,6], 'C': [3,4,4,4,3], 'D': [6,5,5,5,6], 'E': [7,4,6,4,7],
      'F': [7,4,6,4,4], 'G': [3,4,5,5,3], 'H': [5,5,7,5,5], 'I': [7,2,2,2,7], 'J': [1,1,1,5,2],
      'K': [5,5,6,5,5], 'L': [4,4,4,4,7], 'M': [5,7,7,5,5], 'N': [5,7,7,7,5], 'O': [2,5,5,5,2],
      'P': [6,5,6,4,4], 'Q': [2,5,5,7,3], 'R': [6,5,6,5,5], 'S': [3,4,2,1,6], 'T': [7,2,2,2,2],
      'U': [5,5,5,5,7], 'V': [5,5,5,5,2], 'W': [5,5,7,7,5], 'X': [5,5,2,5,5], 'Y': [5,5,2,2,2], 'Z': [7,1,2,4,7]
    };

    function hexColor(intVal) {
      return '#' + (intVal >>> 0).toString(16).padStart(6, '0');
    }

    function setLed(fb, x, y, colorInt) {
      if (x < 0 || x >= 52 || y < 0 || y >= 16) return;
      fb[y * 52 + x] = colorInt;
    }

    // baseline matches the clock's text(): the row just below the capitals.
    function drawText(fb, x0, baseline, str, colorInt) {
      const upper = String(str || '').toUpperCase();
      let cx = x0;
      for (const ch of upper) {
        const glyph = FONT_3X5[ch] || FONT_3X5['?'];
        const w = ch === ' ' ? 2 : 3;
        for (let r = 0; r < 5; r++) {
          const rowBits = glyph[r];
          for (let c = 0; c < w; c++) {
            if ((rowBits >> (2 - c)) & 1) setLed(fb, cx + c, baseline - 5 + r, colorInt);
          }
        }
        cx += w + 1;
      }
    }

    function measureText(str) {
      const upper = String(str || '').toUpperCase();
      if (!upper.length) return 0;
      let w = 0;
      for (const ch of upper) w += (ch === ' ' ? 2 : 3) + 1;
      return w - 1;
    }

    function drawScrolling(fb, xStart, yPos, availW, content, colorInt, phase) {
      const tw = measureText(content);
      if (tw <= availW) {
        drawText(fb, xStart, yPos, content, colorInt);
        return;
      }
      const gap = 14;
      const span = tw + gap;
      const holdMs = 1500;
      const cycle = holdMs + span * 45;
      const t = (performance.now() + phase) % cycle;
      const offset = t > holdMs ? Math.floor((t - holdMs) / 45) : 0;
      const x1 = xStart - offset;
      drawText(fb, x1, yPos, content, colorInt);
      if (x1 + span < xStart + availW) drawText(fb, x1 + span, yPos, content, colorInt);
    }

    function renderFrame() {
      const fb = new Int32Array(52 * 16).fill(0x090c10);
      drawScrolling(fb, 17, 6, 35, state.title || 'Spotify', 0xffffff, 0);
      drawScrolling(fb, 17, 14, 35, state.artist || 'Paused', state.accent || 0x1db954, 600);

      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 17; x++) setLed(fb, x, y, 0x090c10);
      }

      if (Array.isArray(state.art) && state.art.length === 256) {
        for (let y = 0; y < 16; y++) {
          for (let x = 0; x < 16; x++) {
            const c = state.art[y * 16 + x];
            setLed(fb, x, y, c > 0 ? c : 0x090c10);
          }
        }
      } else {
        for (let y = 3; y < 13; y++) for (let x = 3; x < 13; x++) setLed(fb, x, y, 0x1db954);
      }

      const elapsed = Math.min(state.durationMs || 1, (state.progressMs || 0) + (state.playing ? performance.now() - state.fetchedAt : 0));
      const fillW = Math.round((elapsed / Math.max(1, state.durationMs)) * 35);
      for (let x = 0; x < 35; x++) {
        setLed(fb, 17 + x, 15, x < fillW ? (state.accent || 0x1db954) : 0x1e242b);
      }

      ctx.fillStyle = '#050709';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const cell = 10;
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 52; x++) {
          ctx.fillStyle = hexColor(fb[y * 52 + x]);
          ctx.beginPath();
          ctx.roundRect(x * cell + 1, y * cell + 1, cell - 2, cell - 2, 2);
          ctx.fill();
        }
      }
      requestAnimationFrame(renderFrame);
    }

    function renderStatus(d) {
      const clockPollEl = document.getElementById('clockPoll');
      const ago = d.clockLastPollAgoMs;
      const seconds = ago === null ? null : Math.round(ago / 1000);
      // The clock pauses the script while the app is hidden, so silence is expected then.
      const late = !d.clockAppHidden && (seconds === null || seconds > 15);
      const when = seconds === null ? 'Not since the bridge started' : seconds + 's ago';
      if (d.clockAppHidden) {
        clockPollEl.textContent = when + ' (paused while nothing is playing)';
      } else {
        clockPollEl.textContent = late ? when + ' — check SERVER_LAN_URL, the published port, and your firewall' : when;
      }
      clockPollEl.style.color = late ? 'var(--warn)' : '';
      document.getElementById('spotifyWarn').textContent = d.spotifyError ? 'Spotify problem: ' + d.spotifyError : '';
    }

    async function pollPreview() {
      try {
        const r = await fetch('/api/preview');
        if (r.ok) {
          const d = await r.json();
          state = { ...d, fetchedAt: performance.now() };
          metaEl.textContent = d.playing ? (d.artist + ' — ' + d.title) : 'Paused / Idle';
          renderStatus(d);
        }
      } catch {}
    }

    async function act(name) {
      await fetch('/api/action/' + name, { method: 'POST' });
      setTimeout(pollPreview, 350);
    }

    pollPreview();
    setInterval(pollPreview, 2000);
    requestAnimationFrame(renderFrame);
  </script>
</body>
</html>`;
}

/** Browsers always send Origin on POST, so a page on another site can't pass this. */
function isSameOriginPost(req) {
  if (req.method !== 'POST' || !req.headers.origin) return false;
  try {
    return new URL(req.headers.origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function tokenMatches(candidate, expected) {
  if (!candidate || !expected) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createBridgeServer({ config, spotify, awtrix, getCurrentSnapshot, triggerImmediatePoll, onAuthorized, clockToken = '' }) {
  let lastClockPollMs = null;

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      const pathname = url.pathname;

      if (pathname === '/healthz') {
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === '/api/now-playing' && req.method === 'GET') {
        if (url.searchParams.has('clock')) {
          lastClockPollMs = Date.now();
        }
        const clientArtId = url.searchParams.get('art') || '';
        const snap = getCurrentSnapshot();
        const artId = snap.artId || '';
        const includeArt = Boolean(snap.art && artId && artId !== clientArtId);
        const payload = {
          playing: snap.playing,
          id: snap.id,
          title: snap.title,
          artist: snap.artist,
          progressMs: snap.playing
            ? Math.min(snap.durationMs, snap.progressMs + Math.max(0, Date.now() - snap.updatedAtMs))
            : snap.progressMs,
          durationMs: snap.durationMs,
          accent: snap.accent,
          artId,
        };
        if (includeArt) {
          payload.art = snap.art;
        }
        return sendJson(res, 200, payload);
      }

      if (pathname === '/api/preview' && req.method === 'GET') {
        const snap = getCurrentSnapshot();
        return sendJson(res, 200, {
          ...snap,
          progressMs: snap.playing
            ? Math.min(snap.durationMs, snap.progressMs + Math.max(0, Date.now() - snap.updatedAtMs))
            : snap.progressMs,
          clockLastPollAgoMs: lastClockPollMs === null ? null : Date.now() - lastClockPollMs,
          clockAppHidden: awtrix.appEnabled === false,
        });
      }

      if (pathname.startsWith('/api/action/')) {
        // The clock can only send plain GETs, which any web page can trigger, so it needs the token.
        if (!isSameOriginPost(req) && !tokenMatches(url.searchParams.get('token'), clockToken)) {
          return sendJson(res, 403, { error: 'Forbidden' });
        }
        const rawAction = pathname.slice('/api/action/'.length);
        const snap = getCurrentSnapshot();
        const resolvedAction =
          rawAction === 'toggle' ? (snap.playing ? 'pause' : 'play') : rawAction;

        if (!['play', 'pause', 'next', 'previous'].includes(resolvedAction)) {
          return sendJson(res, 400, { error: 'Invalid action' });
        }

        await spotify.controlPlayback(resolvedAction);
        setTimeout(() => {
          triggerImmediatePoll().catch(() => {});
        }, 250);
        return sendJson(res, 200, { ok: true, action: resolvedAction });
      }

      if (pathname === '/berry/spotify_now_playing.be' && req.method === 'GET') {
        const content = await fs.readFile(SCRIPT_PATH, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(content);
      }

      if (pathname === '/auth/login' && req.method === 'GET') {
        if (!spotify.isConfigured()) {
          return redirect(res, '/?error=' + encodeURIComponent('Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env first.'));
        }
        return redirect(res, spotify.createAuthorizeUrl());
      }

      if (pathname === '/callback' && req.method === 'GET') {
        const errParam = url.searchParams.get('error');
        if (errParam) {
          return redirect(res, '/?error=' + encodeURIComponent(`Spotify authorization declined: ${errParam}`));
        }
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        await spotify.exchangeCode(code, state, { requireState: true });
        if (onAuthorized) onAuthorized();
        return redirect(res, '/?msg=' + encodeURIComponent('Spotify connected! Play a song to see it on your TC002.'));
      }

      if (pathname === '/auth/manual-callback' && req.method === 'POST') {
        if (!isSameOriginPost(req)) {
          return sendJson(res, 403, { error: 'Forbidden' });
        }
        const raw = await readBody(req);
        const form = new URLSearchParams(raw);
        const input = (form.get('callbackUrl') || '').trim();
        let code = input;
        let state = null;
        if (input.includes('?')) {
          const parsedUrl = new URL(input);
          code = parsedUrl.searchParams.get('code') || '';
          state = parsedUrl.searchParams.get('state');
        }
        await spotify.exchangeCode(code, state);
        if (onAuthorized) onAuthorized();
        return redirect(res, '/?msg=' + encodeURIComponent('Spotify connected via manual callback!'));
      }

      if (pathname === '/auth/logout' && req.method === 'POST') {
        if (!isSameOriginPost(req)) {
          return sendJson(res, 403, { error: 'Forbidden' });
        }
        await spotify.tokenStore.clear();
        return redirect(res, '/?msg=' + encodeURIComponent('Disconnected Spotify tokens.'));
      }

      if (pathname === '/' && req.method === 'GET') {
        const authorized = await spotify.isAuthorized();
        const html = renderDashboardHtml({
          config,
          authorized,
          awtrixStatus: {
            configured: awtrix.isConfigured(),
            scriptSynced: awtrix.scriptSynced,
            lastError: awtrix.lastError,
          },
          message: url.searchParams.get('msg') || '',
          error: url.searchParams.get('error') || '',
        });
        return sendHtml(res, 200, html);
      }

      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      console.error('[server] Request error:', err.message);
      if (req.url?.startsWith('/callback') || req.url?.startsWith('/auth/')) {
        return redirect(res, '/?error=' + encodeURIComponent(err.message));
      }
      return sendJson(res, 500, { error: err.message });
    }
  });
}
