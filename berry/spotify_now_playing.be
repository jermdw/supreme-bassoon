# @config server_url text "Bridge Server URL" default="http://192.168.1.100:8765" help="LAN URL of your awtrix-spotify Docker container"
# @config token text "Bridge Token" default="" help="Set automatically by the bridge; lets the clock's buttons send playback commands"
# @config keep_on_screen bool "Keep On Screen" default=false help="Stay on this app while music plays instead of rotating away"
# @config poll_ms number "Poll Interval (ms)" default=2000 min=1000 max=10000
# @config scroll_speed number "Scroll Speed (ms/px)" default=45 min=20 max=120
# @config lr_controls bool "Left/Right Skip Tracks" default=false help="Use clock Left/Right buttons for Prev/Next track instead of switching apps"

import json

class SpotifyNowPlaying
  var server_url
  var token
  var poll_ms
  var scroll_speed
  var lr_controls
  var keep_on_screen

  var in_flight
  var playing
  var track_id
  var title
  var artist
  var accent
  var progress_ms
  var duration_ms
  var sync_at_ms
  var scroll_started_ms
  var wipe_started_ms
  var visible
  var paused
  var shown
  var holding
  var state_hold_until
  var idle_ticks
  var art
  var art_id
  var fail_since_ms

  var badge_text
  var badge_until

  def init()
    self.server_url = store.get("server_url", "http://192.168.1.100:8765")
    self.token = store.get("token", "")
    self.poll_ms = store.get("poll_ms", 2000)
    self.scroll_speed = store.get("scroll_speed", 45)
    self.lr_controls = store.get("lr_controls", false)
    self.keep_on_screen = store.get("keep_on_screen", false)

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
    self.scroll_started_ms = now_ms()
    self.wipe_started_ms = 0
    self.visible = false
    self.paused = false
    self.shown = false
    self.holding = false
    self.state_hold_until = 0
    self.idle_ticks = 0
    self.art = nil
    self.art_id = ""
    self.fail_since_ms = nil

    self.badge_text = ""
    self.badge_until = 0

    # A pause outlives the script that set it, so clear one left by an earlier install.
    rotation.resume()

    self.poll()
    timer.every(self.poll_ms, def () self.tick() end)
  end

  def tick()
    if self.visible || self.shown
      self.poll()
      return
    end
    # Nothing to show: check in less often. The bridge switches to this app when music starts.
    self.idle_ticks += 1
    if self.idle_ticks >= 5
      self.idle_ticks = 0
      self.poll()
    end
  end

  def is_offline()
    return self.fail_since_ms != nil && now_ms() - self.fail_since_ms > 15000
  end

  def should_show()
    return self.visible && !self.is_offline()
  end

  def on_show()
    self.shown = true
    self.scroll_started_ms = now_ms()
    self.update_hold()
    self.poll()
  end

  def on_hide()
    self.shown = false
    self.update_hold()
  end

  # Any move through the API or buttons ends a pause, so this runs again on every poll.
  def update_hold()
    if self.keep_on_screen && self.shown && self.playing && !self.is_offline()
      rotation.pause()
      self.holding = true
    elif self.holding
      rotation.resume()
      self.holding = false
    end
  end

  def poll()
    if self.in_flight || self.server_url == nil || size(self.server_url) == 0
      return
    end
    self.in_flight = true

    var url = self.server_url + "/api/now-playing?clock=1&art=" + self.art_id
    http.get(url, def (a, b) self.on_poll_response(a, b) end, {"timeout": 5})
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
      if self.fail_since_ms == nil
        self.fail_since_ms = now_ms()
      end
      self.update_hold()
      return
    end
    self.fail_since_ms = nil

    try
      var d = json.load(body)
      if d == nil
        return
      end

      self.visible = d.find("visible", false)
      # Spotify takes a moment to report a button press, so don't flip back in the meantime.
      if now_ms() >= self.state_hold_until
        self.playing = d.find("playing", false)
        self.paused = d.find("paused", false)
      end
      var new_id = str(d.find("id", ""))
      if new_id != self.track_id
        self.track_id = new_id
        self.scroll_started_ms = now_ms()
        self.wipe_started_ms = now_ms()
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

      var new_art_id = str(d.find("artId", ""))
      var incoming_art = d.find("art", nil)
      if size(new_art_id) == 0
        self.art = nil
        self.art_id = ""
      elif incoming_art != nil && size(incoming_art) == 256
        self.art = incoming_art
        self.art_id = new_art_id
        self.wipe_started_ms = now_ms()
      end
    except ..
      # Ignore malformed transient network payloads
    end
    self.update_hold()
  end

  def trigger_action(action, label)
    if self.server_url == nil || size(self.server_url) == 0
      return
    end
    self.badge_text = label
    self.badge_until = now_ms() + 1000
    self.state_hold_until = now_ms() + 1500
    var url = self.server_url + "/api/action/" + action + "?token=" + self.token
    http.get(url, def (a, b) self.on_action_response(a, b) end, {"timeout": 5})
  end

  def on_action_response(a, b)
    var status = b
    if type(a) == "int"
      status = a
    end
    if status < 200 || status >= 300
      self.badge_text = "FAILED"
      self.badge_until = now_ms() + 1500
      self.state_hold_until = 0
    end
    self.poll()
  end

  def on_button(btn)
    if btn == "select"
      if self.playing
        self.playing = false
        self.paused = true
        self.update_hold()
        self.trigger_action("pause", "PAUSE")
      else
        self.playing = true
        self.paused = false
        self.update_hold()
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
    var age_ms = now_ms() - self.scroll_started_ms
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
    var offline = self.is_offline()
    var text_x = 17
    var avail_w = w - text_x
    if avail_w < 8
      avail_w = w
      text_x = 0
    end

    # 1. Draw Title (top line) and Artist (second line) first.
    # The y of text() is the baseline: 6 puts capitals on rows 1-5, 14 on rows 9-13.
    if now_ms() < self.badge_until && size(self.badge_text) > 0
      var bw = text_ink_width(self.badge_text)
      var bx = text_x + (avail_w - bw) / 2
      var by = 6
      if h >= 16
        by = 10
      end
      text(bx, by, self.badge_text, 0xFFFFFF)
    else
      if h >= 16
        self.draw_scrolling_line(text_x, 6, avail_w, self.title, 0xFFFFFF, 0)
        if offline
          text(text_x, 14, "OFFLINE", 0xFFA500)
        else
          self.draw_scrolling_line(text_x, 14, avail_w, self.artist, self.accent, 600)
        end
      elif offline
        text(text_x, 6, "OFFLINE", 0xFFA500)
      else
        self.draw_scrolling_line(text_x, 6, avail_w, self.title + " - " + self.artist, 0xFFFFFF, 0)
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
              if self.paused
                c = (c >> 1) & 0x7F7F7F
              end
              pixel(px, py, c)
            end
            idx += 1
          end
        end
      else
        self.draw_fallback_icon()
      end

      # Track change: reveal the new cover from the left over 400ms.
      var reveal = (now_ms() - self.wipe_started_ms) / 25
      if reveal >= 0 && reveal < 16
        rect_fill(reveal, 0, 16 - reveal, 16, 0x000000)
      end

      if self.paused
        rect_fill(5, 4, 2, 8, 0xFFFFFF)
        rect_fill(9, 4, 2, 8, 0xFFFFFF)
      end
    end

    # 3. Interpolated 1px bottom progress bar across text column
    if h >= 16
      var elapsed = self.progress_ms
      if self.playing && !offline
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
