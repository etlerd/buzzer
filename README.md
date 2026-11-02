# Game Show Buzzer

Wireless buzzer system for up to 12 contestants. No internet or venue network needed.

- **Seat pods**: one per contestant. A big arcade button and an LED strip over the seat, battery powered, no wires to anything.
- **Hub**: one ESP32 that hears the pods by radio, decides who pressed first, runs the game, plays sounds and recorded names through an **aux jack**, and creates its own Wi-Fi for the host and TV screens.
- **Host console** and **studio display**: web pages stored on the hub. Any phone, tablet, laptop or smart-TV browser works.

```
 seat pods ──ESP-NOW radio──▶ hub ──aux jack──▶ mixer / recorder / speaker
 (button + light)              │
                               └─ own Wi-Fi "GameShow" ──▶ host console (phone/tablet/laptop)
                                                       └─▶ studio display (TV or laptop on HDMI)
```

ESP-NOW is direct ESP32-to-ESP32 radio: no router, no network login, about 1–3 ms per press. Pods resend until the hub confirms, and each press carries how long ago it really happened, so a press that needed a retry still wins if it came first.

## Parts

**Hub (one)**

| Part | Approx. | Notes |
|---|---|---|
| ESP32-S3 dev board, 16 MB flash (e.g. ESP32-S3-DevKitC-1 N16R8) | $10 | 16 MB is needed for web pages, voice clips and browser firmware updates |
| PCM5102A I2S audio board with 3.5 mm jack | $5 | Line-level aux out |
| USB wall adapter | — | Power the hub from its own adapter, not the laptop, to avoid hum (see Audio) |

**Per seat pod (up to 12)**

| Part | Approx. | Notes |
|---|---|---|
| ESP32-C3 SuperMini | $3 | Any ESP32 works; change pins in `config.h` |
| 60 mm arcade button with **5 V** LED | $4 | |
| NPN transistor (2N2222) + 1 kΩ resistor | — | Drives the button LED |
| WS2812B LED strip, 15 LEDs | $3 | Mount over the seat |
| 330 Ω resistor, 470–1000 µF capacitor | — | Resistor on strip data, capacitor across strip power |
| USB power bank, 5000–10000 mAh, **no auto-off** | $10–15 | Many power banks switch off at low current draw. Pick one with an "always on" / low-current mode |
| Small box | $3 | |

About $25 per pod plus about $15 for the hub: roughly $315 for 12 seats.

## Wiring

**Hub → PCM5102A**

| PCM5102A | ESP32-S3 |
|---|---|
| VIN | 5V |
| GND | GND |
| BCK | GPIO 4 |
| LCK (LRCK) | GPIO 5 |
| DIN | GPIO 6 |
| SCK | GND |
| XMT (mute) | 3.3V if your board does not already tie it high |

**Pod (ESP32-C3 SuperMini)**

| Connection | Pin |
|---|---|
| Arcade button switch | GPIO 3 and GND |
| Button LED | LED+ → 5V, LED− → transistor collector, emitter → GND, GPIO 4 → 1 kΩ → base |
| LED strip data | GPIO 5 → 330 Ω → DIN |
| LED strip power | 5V and GND from the power bank (same USB 5V as the board) |

If the strip flickers or shows wrong colors, its 5 V data input is not reading the ESP32's 3.3 V signal reliably: keep the data wire under 30 cm, or add a 74AHCT125 level shifter.

## Setup

### 1. Flash the hub (once, by USB)

1. Arduino IDE → Boards Manager → install **esp32 by Espressif, 3.x**.
2. Library Manager → install **ArduinoJson** (v7) and **WebSockets** (Markus Sattler).
3. Copy `firmware/hub/config.example.h` to `config.h` (git-ignored). Set the Wi-Fi name, password and radio channel.
4. Tools → Board **ESP32S3 Dev Module**, Flash Size **16MB**. The partition layout comes from `partitions.csv` in the sketch folder. If your IDE ignores it, choose *16M Flash (3MB APP/9.9MB FATFS)*.
5. Upload `firmware/hub/hub.ino`.

### 2. Upload the web pages (from a browser)

1. Join the **GameShow** Wi-Fi on a laptop.
2. Open **http://192.168.4.1/admin** (or http://buzzer.local/admin).
3. **Upload web folder** → choose the `web` folder from this project.

The admin page is built into the firmware, so it always works even if the uploaded pages are broken. Later firmware updates also go through it: in Arduino IDE use *Sketch → Export Compiled Binary*, then upload `hub.ino.bin`. Scores and pairings are kept.

### 3. Flash the pods

1. Library Manager → install **Adafruit NeoPixel**.
2. Copy `firmware/pod/config.example.h` to `config.h`. `RADIO_CHANNEL` must match the hub.
3. Upload `firmware/pod/pod.ino` to every pod. All pods get identical firmware.

### 4. Pair pods to seats

1. Open the host console: **http://192.168.4.1**.
2. Set **Seats in use**.
3. New pods blink blue. On a seat card click **Pair pod**, then press that seat's button. Repeat for each seat.
4. **Find** blinks a pod to check which seat it's on. Pairings are saved on the hub.

### 5. Record contestant names

1. Record each name as a voice memo on any phone, e.g. "Alice!".
2. On the host console, type the contestant's name, then **Add voice** and pick the recording.
3. The browser trims silence, evens out the volume, converts it to the hub's format, uploads it and plays it on the aux output.

Clips are matched by **name**, not seat, so they follow a contestant to any seat. If you rename someone, upload a new clip. iPhone `.m4a`, `.mp3` and `.wav` all work. Recording directly in the page is not possible: browsers block the microphone on plain `http://` pages like the hub's.

## Running the show

Open the **host console** on a phone, tablet or laptop, and **Studio display** on the TV. Both join the GameShow Wi-Fi.

| Key | Button | Action |
|---|---|---|
| Space | Open buzzers | Pods breathe white, contestants may press |
| C | Correct | Adds points, green flash, locks |
| W | Wrong → reopen | Subtracts penalty, red flash, that contestant is out for this question, reopens for the others after 1.2 s |
| N | Wrong → next in line | Same, but hands the question to whoever pressed second (their name is announced) |
| L | Lock / clear | Lock without judging |
| Q | New question | Clears lock-outs and the question text |

Pressing **before** the buzzers open gives that contestant a 1-second lockout (dim red light), so mashing early does not pay.

| Moment | Seat light | Button LED | Aux jack |
|---|---|---|---|
| Buzzers open | dim white breathing | pulsing | rising chime |
| Buzzed first | full seat color | on | buzzer sound + recorded name |
| Correct | green flash | on | rising tones |
| Wrong | red flash | off | low buzz |
| Pressed too early | dim red | off | — |
| Not paired / Find | blinking | blinking | — |

Optional: replace any built-in sound by uploading `/sfx/armed.wav`, `/sfx/buzz.wav`, `/sfx/correct.wav` or `/sfx/wrong.wav` (16-bit mono 22050 Hz WAV) through the admin page.

## Backup: USB instead of Wi-Fi

If the venue's network equipment interferes with the hub's Wi-Fi (see Limits), run the host console over a USB cable:

1. Plug the hub into the host laptop.
2. Open `web/index.html` **as a file** in Chrome or Edge.
3. Click **Connect hub by USB** and pick the hub's port.
4. Open `web/display.html` the same way in another window and drag it to the TV. It mirrors the host window.

Pods, lights and audio work the same. Voice uploads need the Wi-Fi connection, so do them beforehand. The hub may restart when the USB connection opens; scores and pairings survive.

## Try it without hardware

`tools/sim` runs the hub's real game logic on a computer, with on-screen pods.

```
cd tools/sim
npm install
npm run build     # needs g++ and git
npm start
```

Open http://localhost:8080 (host), http://localhost:8080/display.html, and http://localhost:8080/pods.html (virtual buttons; keys 1–9, 0, -, = press pods 1–12).

## Limits

- **Not yet run on real hardware.** The game logic has automated tests and the web pages were tested in browsers against it. The firmware was checked against the current ESP32 core's library signatures but not compiled with the ESP32 compiler. Expect small fixes on first flash.
- **Managed networks.** Some enterprise Wi-Fi systems actively disconnect devices from Wi-Fi networks they don't recognize, such as the hub's. The pods are not affected because ESP-NOW is not a Wi-Fi connection; only the host and display screens could drop. Use the USB backup, or ask IT. If phone hotspots work in that room, this will too.
- **Radio channel.** Pick a `RADIO_CHANNEL` (1, 6 or 11 are typical) that the venue Wi-Fi uses least. Hub and pods must match.
- **Audio hum.** A hub powered from a laptop's USB while plugged into a mixer often hums. Power the hub from its own wall adapter, or add a ground-loop isolator on the aux cable.
- **Screens.** The hub's Wi-Fi handles about 8 connected devices: enough for host, TV and spares.
- **Battery life.** Pods keep their radio on to receive light changes: roughly 100 mA, plus the strip when lit. A 10000 mAh power bank lasts well beyond a recording day.

## Files

| Path | What |
|---|---|
| `firmware/hub/` | Hub sketch. `game.h` holds all game rules, `audio.h` the aux output, `admin_page.h` the built-in admin page |
| `firmware/pod/` | Seat pod sketch |
| `firmware/*/protocol.h` | Radio packet format (identical copies; keep them in sync) |
| `web/` | Host console and studio display, uploaded to the hub |
| `tools/sim/` | Computer simulator of the hub |
