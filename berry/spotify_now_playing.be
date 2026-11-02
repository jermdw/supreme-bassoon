# @config server_url text "Bridge Server URL" default="http://192.168.1.100:8765" help="LAN URL of your awtrix-spotify Docker container"
# @config poll_ms number "Poll Interval (ms)" default=2000 min=1000 max=10000
# @config scroll_speed number "Scroll Speed (ms/px)" default=45 min=20 max=120
# @config lr_controls bool "Left/Right Skip Tracks" default=false help="Use clock Left/Right buttons for Prev/Next track instead of switching apps"

import json

class SpotifyNowPlaying
  var server_url
  var poll_ms
  var scroll_speed
  var lr_controls

  var in_flight
  var playing
  var track_id
  var title
  var artist
  var accent
  var progress_ms
  var duration_ms
  var sync_at_ms
  var track_started_ms
  var art

  var badge_text
  var badge_until

  def init()
    self.server_url = store.get("server_url", "http://192.168.1.100:8765")
    self.poll_ms = store.get("poll_ms", 2000)
    self.scroll_speed = store.get("scroll_speed", 45)
    self.lr_controls = store.get("lr_controls", false)

    if self.poll_ms == nil || self.poll_ms < 1000
      self.poll_ms = 2000
    end
    if self.scroll_speed == nil || self.scroll_speed < 15
      self.scroll_speed = 45
    end

    self.in_flight = false
    self.playing = false
    self.track_id = ""
    self.title = "Spotify"
    self.artist = "Waiting..."
    self.accent = 0x1DB954
    self.progress_ms = 0
    self.duration_ms = 1
    self.sync_at_ms = now_ms()
    self.track_started_ms = now_ms()
    self.art = nil

    self.badge_text = ""
    self.badge_until = 0

    self.poll()
    timer.every(self.poll_ms, def () self.poll() end)
  end

  def poll()
    if self.in_flight || self.server_url == nil || size(self.server_url) == 0
      return
    end
    self.in_flight = true

    var q_track = ""
    if self.art != nil && size(self.art) == 256 && size(self.track_id) > 0
      q_track = self.track_id
    end

    var url = self.server_url + "/api/now-playing?track=" + q_track
    http.get(url, def (a, b) self.on_poll_response(a, b) end)
  end

  def on_poll_response(a, b)
    self.in_flight = false

    var status = 0
    var body = nil
    if type(a) == "int"
      status = a
      body = b
    else
      body = a
      status = b
    end

    if status != 200 || body == nil || size(body) == 0
      return
    end

    try
      var d = json.load(body)
      if d == nil
        return
      end

      self.playing = d.find("playing", false)
      var new_id = str(d.find("id", ""))
      if new_id != self.track_id
        self.track_id = new_id
        self.track_started_ms = now_ms()
      end

      self.title = str(d.find("title", "Spotify"))
      self.artist = str(d.find("artist", ""))
      self.accent = int(d.find("accent", 0x1DB954))
      self.progress_ms = int(d.find("progressMs", 0))
      self.duration_ms = int(d.find("durationMs", 1))
      if self.duration_ms <= 0
        self.duration_ms = 1
      end
      self.sync_at_ms = now_ms()

      var incoming_art = d.find("art", nil)
      if incoming_art != nil && size(incoming_art) == 256
        self.art = incoming_art
      end
    except ..
      # Ignore malformed transient network payloads
    end
  end

  def trigger_action(action, label)
    if self.server_url == nil || size(self.server_url) == 0
      return
    end
    self.badge_text = label
    self.badge_until = now_ms() + 1000
    var url = self.server_url + "/api/action/" + action
    http.get(url, def (a, b) self.poll() end)
  end

  def on_button(btn)
    if btn == "select"
      if self.playing
        self.playing = false
        self.trigger_action("pause", "PAUSE")
      else
        self.playing = true
        self.trigger_action("play", "PLAY")
      end
      return true
    end

    if self.lr_controls
      if btn == "right"
        self.trigger_action("next", "NEXT")
        return true
      elif btn == "left"
        self.trigger_action("previous", "PREV")
        return true
      end
    end

    return false
  end

  def draw_scrolling_line(x_start, y_pos, avail_w, content, color, phase_offset)
    if content == nil || size(content) == 0
      return
    end

    var tw = text_ink_width(content)
    if tw <= avail_w
      text(x_start, y_pos, content, color)
      return
    end

    var gap = 14
    var span = tw + gap
    var hold_ms = 1500 + phase_offset
    var move_ms = span * self.scroll_speed
    var cycle_ms = hold_ms + move_ms
    var age_ms = now_ms() - self.track_started_ms
    if age_ms < 0
      age_ms = 0
    end
    var t = age_ms % cycle_ms

    var offset = 0
    if t > hold_ms
      offset = (t - hold_ms) / self.scroll_speed
    end

    var x1 = x_start - offset
    text(x1, y_pos, content, color)
    if x1 + span < x_start + avail_w
      text(x1 + span, y_pos, content, color)
    end
  end

  def draw_fallback_icon()
    rect_fill(0, 0, 16, 16, 0x0B2E18)
    rect_fill(3, 3, 10, 10, 0x1DB954)
    rect_fill(5, 6, 6, 1, 0x000000)
    rect_fill(5, 8, 6, 1, 0x000000)
    rect_fill(6, 10, 4, 1, 0x000000)
  end

  def draw()
    clear()

    var w = width()
    var h = height()
    var text_x = 17
    var avail_w = w - text_x
    if avail_w < 8
      avail_w = w
      text_x = 0
    end

    # 1. Draw Title (top line) and Artist (second line) first
    if now_ms() < self.badge_until && size(self.badge_text) > 0
      var bw = text_ink_width(self.badge_text)
      var bx = text_x + (avail_w - bw) / 2
      text(bx, 4, self.badge_text, 0xFFFFFF)
    else
      if h >= 16
        self.draw_scrolling_line(text_x, 1, avail_w, self.title, 0xFFFFFF, 0)
        self.draw_scrolling_line(text_x, 8, avail_w, self.artist, self.accent, 600)
      else
        self.draw_scrolling_line(text_x, 1, avail_w, self.title + " - " + self.artist, 0xFFFFFF, 0)
      end
    end

    # 2. Mask left 17 columns & render 16x16 album art on top (clips scrolled text cleanly)
    if text_x == 17 && h >= 16
      rect_fill(0, 0, 17, h, 0x000000)
      if self.art != nil && size(self.art) == 256
        var idx = 0
        for py : 0 .. 15
          for px : 0 .. 15
            var c = self.art[idx]
            if c > 0
              pixel(px, py, c)
            end
            idx += 1
          end
        end
      else
        self.draw_fallback_icon()
      end
    end

    # 3. Interpolated 1px bottom progress bar across text column
    if h >= 16
      var elapsed = self.progress_ms
      if self.playing
        elapsed += now_ms() - self.sync_at_ms
      end
      if elapsed < 0
        elapsed = 0
      end
      if elapsed > self.duration_ms
        elapsed = self.duration_ms
      end

      rect_fill(text_x, 15, avail_w, 1, 0x1E1E1E)
      var fill_w = (elapsed * avail_w) / self.duration_ms
      if fill_w > 0
        rect_fill(text_x, 15, fill_w, 1, self.accent)
      end
    end
  end
end

return SpotifyNowPlaying()
