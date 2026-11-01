# Game Show Buzzer

Phones are the buzzers, a host console picks the winner, and a studio screen and/or an ESP32 light rig shows who buzzed in. Runs entirely on GitHub Pages. No server to run.

| Page | Who uses it |
|---|---|
| `index.html` | Landing page |
| `host.html` | Host laptop: opens/locks buzzers, judges answers, keeps score, shows join QR code |
| `play.html` | Contestant phones: big buzzer button |
| `display.html` | Studio TV/projector: who buzzed in, question, scoreboard, join QR |
| `firmware/studio_light/` | ESP32: lights a LED segment or lamp over the contestant who buzzed in, optional OLED name display |

## How it works

GitHub Pages only serves static files, so devices talk through an **MQTT broker** over WebSockets. MQTT was chosen because the ESP32 speaks it natively; phones, host, display and lights all share one channel.

```
 phones ──hello/buzz──▶  MQTT broker  ◀──state (retained)── host console
                            │
             state ─────────┼──────────▶ studio display (browser)
             iot (slim) ────┴──────────▶ ESP32 studio light
```

The host browser is the only authority: it decides the winner and publishes a retained `state` message. Every other device just renders it, so a phone or display that reconnects instantly shows the current state.

Topics (`ROOM` = room code):

| Topic | Direction | Content |
|---|---|---|
| `gsbuzz/v1/ROOM/state` | host → all, retained | full game state JSON |
| `gsbuzz/v1/ROOM/iot` | host → devices, retained | slim JSON: `p` phase, `s`/`n`/`c` slot/name/color of who buzzed, `r`/`rs`/`rn` last correct/wrong call, `k` call counter, `x` locked-out slots |
| `gsbuzz/v1/ROOM/hello` | player → host | join + heartbeat every 4 s, `{id, name}`; `{id, bye:true}` on leave |
| `gsbuzz/v1/ROOM/buzz` | player → host | `{id, armId, rt}` |
| `gsbuzz/v1/ROOM/device/ID` | device → host, retained | `{online}`; host shows "Studio lights: N online" |

## Set up GitHub Pages

1. Merge this branch to `main`.
2. Repository **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)`**.
3. Site appears at `https://<user>.github.io/buzzer/`.

## Running a game

1. Open `host.html` on the host laptop. A room code is generated and remembered by that browser.
2. Contestants scan the QR code (or open `play.html` and type the code) and enter a name. Each gets a color and a slot number (#1, #2…), assigned in join order. **Slot numbers are what the light rig uses**, so seat contestants in slot order, or kick/rejoin to fix.
3. Click **Open studio display** and drag that window to the TV, or open `display.html?room=CODE` on any other machine. Click once to enable sound and full screen. Add `&qr=0` to hide the join code during the show.
4. Host keys:

| Key | Action |
|---|---|
| Space | Open buzzers |
| C | Correct: add points, lock |
| W | Wrong: subtract penalty, lock that player out, reopen for everyone else |
| N | Wrong: lock that player out, hand the question to the next person who buzzed |
| L | Lock and clear |
| Q | New question: clears lock-outs and the question text |

Phones that press **before** the buzzers open get a 1-second "TOO SOON" lockout, so mashing early does not pay.

### Who wins: two modes

- **Reaction time (default, latency-fair).** Each phone measures time from when *it* saw the buzzers open to the tap. The host collects buzzes for a short window (default 400 ms) after the first one, then picks the lowest reaction time. Network delay does not count against anyone. Weakness: a phone running modified code could lie about its time. Fine for friends, not for prize money.
- **First to arrive at host.** Whoever's message reaches the host first wins. Cannot be faked, but a phone on slow cellular data loses to one on studio Wi-Fi even with a faster thumb (typically 30–150 ms difference).

## Studio light (ESP32)

### Recommended hardware

| Part | Notes |
|---|---|
| ESP32 dev board (any) | ~$6 |
| WS2812B LED strip, 5 V | One segment per contestant, mounted above each seat. 10 LEDs per segment by default |
| 5 V power supply | ~60 mA per LED at full white; 8 × 10 LEDs at the default brightness fits a 5 V 4 A supply |
| 330 Ω resistor + 1000 µF capacitor | Resistor on the data line, capacitor across strip power. Standard NeoPixel practice |
| Optional SSD1306 128×64 I2C OLED | Shows the name. SDA 21, SCL 22 |
| Optional relay board | One relay per contestant, for lamps instead of LEDs |
| Optional piezo | Beep on buzz |

**About "a lightbulb over their heads":** an LED strip segment per seat gives the same effect at 5 V, can show each contestant's color, and can flash green/red on correct/wrong. Switching mains-voltage bulbs with bare relay boards near people and props is a shock and fire risk. If you want real bulbs, use an enclosed, rated relay module or smart plugs, or 12 V lamps.

### Wiring (defaults)

- LED strip data → GPIO 5 (through 330 Ω), strip GND ↔ ESP32 GND, strip 5 V from the power supply (not from the ESP32's pin).
- Relays (if `USE_RELAYS 1`) → GPIO 16, 17, 18, 19, 23, 25, 26, 27 for slots 1–8.

### Flashing

1. Arduino IDE → install the **esp32** board package (Espressif).
2. Library Manager: **PubSubClient** (Nick O'Leary), **ArduinoJson** (v7), **Adafruit NeoPixel**, and if using the OLED **Adafruit SSD1306** + **Adafruit GFX**.
3. Copy `firmware/studio_light/config.example.h` to `config.h` in the same folder (git-ignored) and set WiFi, room code, and which outputs you have.
4. Upload `studio_light.ino`.
5. Serial monitor at 115200 baud:
   - `room ABCDE`: change room without reflashing (saved to flash)
   - `test`: lights each slot in turn to check wiring
   - `status`: WiFi/broker/room state

Tip: set a **fixed room code** in the host console (Room & broker settings) so the light never needs reconfiguring between games.

### What the lights do

| Game state | LEDs | Relays | OLED |
|---|---|---|---|
| Locked | off | off | READY |
| Buzzers open | dim white breathing over everyone not locked out | off | OPEN |
| Buzzed in | that contestant's segment in their color | that contestant's lamp on | name |
| Correct / wrong | green / red flash over who answered, 2.5 s | lamp on during flash | CORRECT / WRONG + name |

## Limits and security

- **The default broker (`broker.hivemq.com`) is public.** No account needed, but anyone who knows or guesses the room code can watch traffic or send fake buzzes, and the broker has no uptime guarantee. Fine for parties and rehearsals. For anything that matters, create a free private broker (HiveMQ Cloud or EMQX Serverless), then in the host console set its WebSocket URL under *Room & broker settings*. Username/password can be supplied as `?user=…&pass=…` URL parameters. Credentials in a web page are readable by anyone who has the page, so this keeps out strangers, not your own players.
- Run only **one host tab** per room. Two hosts will overwrite each other.
- Host state (players, scores) is saved in the host browser's local storage and survives reloads.
- Max 16 players per room.
- iOS Safari does not support vibration, so phones there give no haptic feedback.

## Ideas not built yet

- Physical arcade buttons wired to ESP32s (ESP-NOW to the studio box) for contestants who should not be holding phones on camera.
- Answer countdown timer shown on the display and lights.
- Teams mode (shared score, one buzz per team).
- Control the lights through [WLED](https://kno.wled.ge/) instead of this firmware, if you already run WLED.
