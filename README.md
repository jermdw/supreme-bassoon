# supreme-bassoon

Spotify **Now Playing** bridge + native **AWTRIX NG Berry** display plugin purpose-built for the **Ulanzi TC002 (`52×16`)** Smart Pixel Clock (and backward-compatible with `32×8` TC001 matrices).

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=flat-square)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D22-339933?style=flat-square&logo=node.js)
![AWTRIX NG](https://img.shields.io/badge/firmware-AWTRIX_NG-00AAFF?style=flat-square)

Unlike legacy AWTRIX 3 automations built for single-line `32×8` displays, this plugin takes full advantage of the TC002's `52×16` vertical height and physical controls—rendering **live `16×16` album cover art**, **dual-line `40 FPS` independent scrolling text** (Title + album-tinted Artist), an **interpolated progress bar**, and **physical button playback controls**.

---

## Architecture Overview

```mermaid
flowchart LR
    subgraph SpotifyCloud["Spotify Cloud (Account-Wide)"]
        Devices["Phone / Desktop / Speakers\n(Spotify Connect)"]
        WebAPI["Spotify Web API\n/v1/me/player"]
        CDN["Album Art CDN\n(64x64 JPEG)"]
    end

    subgraph Desktop["Always-On Desktop (Docker)"]
        Bridge["awtrix-spotify (:8765)\nNode 22 + sharp + awtrix-ng-api"]
        Store[("Docker volume: tokens.json\nOAuth Refresh Token")]
    end

    subgraph Clock["Ulanzi TC002 (52x16 AWTRIX NG)"]
        Berry["Berry App: spotify_now_playing.be\n(40 FPS Dual-Line + 16x16 Art + Progress)"]
        Buttons["Physical Select / Left / Right\nMedia Controls"]
    end

    Devices --> WebAPI
    Bridge -->|OAuth 2.0 Poll| WebAPI
    Bridge -->|Lanczos + LED Gamma| CDN
    Bridge <--> Store
    Bridge -->|"Auto-Install, Config,\nswitchTo on Track Change"| Clock
    Berry -->|"GET /api/now-playing?clock=1&art=id"| Bridge
    Buttons -->|"GET /api/action/play|pause|next?token=…"| Bridge
```

### Why a Hybrid Docker + Berry Design?

1. **Docker handles what microcontrollers shouldn't:** Spotify OAuth 2.0 refresh-token rotation, downloading JPEG cover art, `16×16` Lanczos3 downsampling, LED gamma black-floor clamping (so dark album shadows turn off cleanly instead of glowing muddy grey), and vibrant accent color extraction.
2. **Berry handles `40 FPS` rendering locally on the clock:** Instead of spamming 20+ HTTP draw payloads per second over Wi-Fi, [`berry/spotify_now_playing.be`](berry/spotify_now_playing.be) runs directly on the TC002's the clock, scrolling both text lines independently and interpolating the progress bar between 2-second polls.
3. **Delta Artwork Caching over Wi-Fi:** The clock passes `?art=<cover_id>` on each poll. When it already holds the current cover, the bridge omits the 256-pixel RGB array—shrinking poll responses to ~200 bytes.

---

## `52×16` Pixel Canvas Layout

```text
Columns: 0               15  16  17                                51
       ┌───────────────────┬───┬────────────────────────────────────┐
Row  0 │                   │   │                                    │
Row  1 │                   │   │  Instant Crush            (White)  │
  ..   │   16×16 Album     │ 1 │  ← independent smooth ticker       │
Row  5 │    Cover Art      │ p │                                    │
Row  6 │  (LED Gamma +     │ x │  (2px vertical breathing gap)      │
Row  9 │   Sat Boosted)    │   │  Daft Punk     (Album Accent Hue)  │
  ..   │                   │ G │  ← staggered smooth ticker         │
Row 13 │                   │ a │                                    │
Row 15 │                   │ p │  ████████████████████░░░░░░░░░░░░  │ ← 1px Progress Bar
       └───────────────────┴───┴────────────────────────────────────┘
```

---

## Step-by-Step Setup Guide

### 1. Create Your Spotify Developer App

> **Spotify Developer Mode Requirements:**
> 1. Your Spotify Developer account **must have an active Spotify Premium subscription**.
> 2. Spotify **bans `localhost`** in HTTP Redirect URIs—you **must** use the explicit IPv4 loopback literal `http://127.0.0.1:8765/callback`.

1. Open the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and click **Create app**.
2. Fill in the form:
   - **App name:** `TC002 Now Playing`
   - **App description:** `AWTRIX NG Now Playing display`
   - **Redirect URIs:** `http://127.0.0.1:8765/callback` *(click **Add**)*
   - **Which API/SDKs are you planning to use?** Check **only `Web API`** *(leave Web Playback SDK, Android, iOS, and Ads API unchecked)*.
   - Accept the Developer Terms and click **Save**.
3. Open your app's **Settings** page and copy your **Client ID** and **Client Secret**.
4. *(If prompted under **User Management**)* Ensure your Spotify account email is allowlisted on the app.

---

### 2. Configure `.env` & Launch Docker Compose

Clone the repository onto your always-on desktop and create your `.env` file:

```bash
git clone https://github.com/jermdw/supreme-bassoon.git
cd supreme-bassoon
cp .env.example .env
```

Edit `.env` with your Spotify credentials, your TC002's static LAN IP (`AWTRIX_HOST`), and your desktop's LAN IP (`SERVER_LAN_URL`):

```ini
SPOTIFY_CLIENT_ID=your_spotify_client_id_here
SPOTIFY_CLIENT_SECRET=your_spotify_client_secret_here
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8765/callback

# Static IP of your Ulanzi TC002 on your home LAN (preferred over .local inside Docker)
AWTRIX_HOST=192.168.1.50
AWTRIX_APP_NAME=spotify
AUTO_INSTALL_SCRIPT=true

# LAN IP of your always-on desktop so the TC002 can reach this container over Wi-Fi
PORT=8765
SERVER_LAN_URL=http://192.168.1.100:8765
```

Build and start the container in the background:

```bash
docker compose up -d --build
```

Verify the container started cleanly and deployed the Berry script to your clock:

```bash
docker compose logs -f
```

---

### 3. Authorize Spotify & Test the Live Simulator

1. On your always-on desktop, open **[http://127.0.0.1:8765](http://127.0.0.1:8765)**.
2. Click **Connect Spotify** and approve access.
   - **Headless / Remote Desktop Tip:** If you opened `http://<DESKTOP_LAN_IP>:8765` from another laptop, Spotify will redirect your browser to `http://127.0.0.1:8765/callback?code=...` after approving. Copy that full URL from your browser's address bar, expand **"Running on a headless machine?"** on the setup dashboard, and paste it in.
3. Start playing any song or podcast on your **phone**, **computer**, or **smart speaker**.
   - Within ~2 seconds, both the **`52×16` Matrix Simulator** in your browser and your physical **Ulanzi TC002** will display the album cover, song title, artist, and progress bar.

---

## Clock Behavior & Physical Controls

| Trigger / Input | Behavior |
| :--- | :--- |
| **Playback Starts** | Switches straight to `spotify` |
| **Track Changes** | Switches the display back to `spotify` immediately and wipes in the new cover |
| **Playing** | With `KEEP_ON_SCREEN=true`, the rotation stays on `spotify`. Pressing a button to change apps still works, and the app holds again on its next turn |
| **Playback Paused** | Shows a dimmed cover with a pause icon and stays in the rotation for `PAUSED_SCREEN_MS` (`5 min` default), so you can resume from the clock. After that, or when playback stops, it sits out the rotation while the script keeps checking in |
| **Bridge Unreachable** | After `15s` of failed requests, the clock shows `OFFLINE` on the artist line and freezes the progress bar until the bridge answers again |
| **Spotify Errors** | The current song stays up through brief errors. After `60s` of failures it counts as stopped, and the dashboard shows the error |
| **Middle / Knob Press (`select`)** | Toggles Spotify **Play / Pause** with an on-screen `PLAY` / `PAUSE` badge |
| **Left / Right Buttons** *(Optional)* | Enable **Left/Right Skip Tracks** in the AWTRIX NG Web UI (*Apps → spotify → Gear Icon*) to trigger **Prev / Next** track |

---

## Configuration Reference

| Variable | Default | Description |
| :--- | :--- | :--- |
| `SPOTIFY_CLIENT_ID` | *(required)* | Spotify Developer App Client ID |
| `SPOTIFY_CLIENT_SECRET` | *(required)* | Spotify Developer App Client Secret |
| `SPOTIFY_REDIRECT_URI` | `http://127.0.0.1:8765/callback` | Loopback OAuth callback URI |
| `AWTRIX_HOST` | *(required)* | Ulanzi TC002 LAN IP address |
| `AWTRIX_PORT` | `80` | AWTRIX NG HTTP port |
| `AWTRIX_USERNAME` / `AWTRIX_PASSWORD` | *(empty)* | Optional AWTRIX NG Web UI Basic Auth credentials |
| `AWTRIX_APP_NAME` | `spotify` | Script/app name on the clock |
| `AUTO_INSTALL_SCRIPT` | `true` | Auto-deploy & configure the Berry script on startup |
| `BRIDGE_BIND_IP` | *(all addresses)* | Publish the bridge only on this address and `127.0.0.1`. It must exist when the container starts, so reserve it on your router |
| `SERVER_LAN_URL` | `http://<detected-ip>:8765` | LAN URL the TC002 uses to poll this container |
| `POLL_ACTIVE_MS` | `2000` | Poll interval (ms) while music is playing |
| `POLL_IDLE_MS` | `5000` | Poll interval (ms) when paused/idle |
| `PAUSED_SCREEN_MS` | `300000` | How long (ms) a paused song stays in the rotation before the app sits out (`0` = straight away) |
| `KEEP_ON_SCREEN` | `false` | Stay on the `spotify` app while music plays instead of rotating away |
| `POLL_DEEP_IDLE_MS` | `30000` | Spotify poll interval (ms) once nothing has played for `DEEP_IDLE_AFTER_MS` |
| `DEEP_IDLE_AFTER_MS` | `600000` | How long (ms) without playback before switching to `POLL_DEEP_IDLE_MS` |
| `SWITCH_ON_TRACK_CHANGE` | `true` | Immediately switch clock view to `spotify` when a new track starts |
| `ASCII_TRANSLITERATE` | `true` | Transliterate accents & smart quotes for clean bitmap font rendering |
| `LED_GAMMA` | `1.55` | Gamma curve for `16×16` album art on physical RGB LEDs |
| `LED_SATURATION` | `1.25` | Saturation multiplier for `16×16` album art |

---

## Bridge HTTP Endpoints

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/` | `GET` | OAuth setup dashboard + live `52×16` `<canvas>` matrix simulator |
| `/api/now-playing?clock=1&art=<id>` | `GET` | Compact JSON polled by the TC002 Berry script (omits `art` when `art` matches the current cover; `clock=1` updates the dashboard's **Clock Last Polled** time) |
| `/api/preview` | `GET` | Full playback + `16×16` artwork snapshot for the browser preview |
| `/api/action/play\|pause\|toggle\|next\|previous` | `GET` / `POST` | Playback control endpoints. The TC002 buttons send `?token=<clock token>`; the web UI sends a same-origin `POST`. Anything else gets a `403` |
| `/berry/spotify_now_playing.be` | `GET` | Serves raw Berry script source for inspection or manual installation |
| `/healthz` | `GET` | Docker container healthcheck endpoint |

---

## Tuning & Troubleshooting

- **Album colors look too bright or dark shadows look grey:** Adjust `LED_GAMMA` (default `1.55`; higher values darken midtones/shadows) and `LED_SATURATION` (default `1.25`) in `.env`, then run `docker compose up -d`.
- **Clock never shows Spotify, or shows `OFFLINE`:** Check **Clock Last Polled** on the dashboard. The clock checks in at least every `10s` even when nothing is playing, so if this isn't updating, the clock can't reach the bridge:
  1. Ensure `SERVER_LAN_URL` in `.env` uses your desktop's actual LAN IP (e.g. `http://192.168.1.100:8765`, **not** `127.0.0.1`).
  2. Check that your desktop's firewall allows inbound TCP port `8765` from your local network.
- **Port 8765 won't publish or times out on Windows:** Another program or a leftover Windows `netsh interface portproxy` rule may already hold the port. Check with `netstat -ano | findstr 8765` and `netsh interface portproxy show v4tov4`, then recreate the container.
- **PC and clock on different subnets:** The bridge must reach `AWTRIX_HOST` to install the script and switch apps. If the clock's network is only reachable through one adapter, such as Wi-Fi, keep that adapter connected. Without it, the clock can still poll, but the bridge can't switch to the app.
- **Firmware updates on TC002 builds before 1.2.2:** These reject `.awup` packages over the web with `invalidImage`, and the USB installer stops on clocks that already run AWTRIX NG. The documented route is a full wipe: hold reset for 5 seconds to restore the Ulanzi firmware, then reinstall. The bridge works on 1.1.2, so you don't need the update for Spotify.
- **Manual Berry Script Installation:** If you set `AUTO_INSTALL_SCRIPT=false`, open your clock's Web UI → **Scripts**, create a script named `spotify`, paste the contents of [`berry/spotify_now_playing.be`](berry/spotify_now_playing.be), and set its **Bridge Server URL** config field to `http://<YOUR_DESKTOP_LAN_IP>:8765`. Also set its **Bridge Token** field to the value the bridge prints in `docker compose logs` at startup, or the clock's buttons will get a `403`.

---

## Local Development & Tests

```bash
npm install
npm test
```

## License

[MIT](LICENSE)
