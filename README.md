# Game Show Buzzer

Phones are the buzzers. Runs on GitHub Pages; no hardware, server or accounts needed.

| Page | Who uses it |
|---|---|
| `play.html` | **Players**, on their phones: a big buzzer button |
| `admin.html` | **Admin** (the host): opens and locks buzzers, judges answers, shows the join QR code, uploads buzzer sounds |
| `display.html` | **Studio display**, on a TV or the recording computer: who buzzed in and who is playing. **Plays all sounds**, including each player's buzzer sound |
| `index.html` | Landing page linking the three |

## Set up GitHub Pages

1. Merge this branch to `main`.
2. Repository **Settings → Pages → Deploy from a branch → `main` / `(root)`**.
3. The site is at `https://<user>.github.io/buzzer/`.

## Running a game

1. Open **admin.html**. A room code is created and remembered by that browser.
2. Players scan the QR code (or open play.html and type the code) and enter their name.
3. On the admin page click **Open studio display**. Put that window on the TV, or open the same address on the recording computer, and click **Click to start** once (browsers need a click before they will play sound).
4. Run the game:

| Key | Action |
|---|---|
| Space | Open buzzers |
| C | Correct: green flash and sound, lock |
| W | Wrong: red flash and sound, lock that player out, reopen for everyone else |
| N | Wrong: lock that player out, hand the question to whoever buzzed next |

Scoring is not part of this system; keep score however your game does.
| L | Lock and clear |
| Q | Next question: clears lock-outs |

Phones that press **before** the buzzers open get a 1-second "TOO SOON" lockout. Once someone has buzzed in, the other phones show **GET IN LINE**: tapping it puts that player in line for **Wrong · pass to…**.

## Buzzer sounds and audio

Each player can have their own buzzer sound (their name, a catchphrase, a sound effect). It plays **instead of** the standard buzz when they buzz in; players without one get the standard buzz.

**Before players arrive:** on the admin page, under **Buzzer sounds**, click **Add sounds** and select all the files at once (WAV, MP3 or iPhone .m4a). Name each file after the player, e.g. `Alice.mp3` or `Mary Jo.wav`. A player who joins with that name gets it automatically; capitals, spaces and punctuation are ignored. If someone joins under a different name ("Bob" for `Robert.mp3`), pick them from that sound's **Assign to** menu.

**After players join:** **Add sound** next to a player uploads a sound for that player directly.

The admin page trims silence from both ends, evens out the volume, keeps at most 4 seconds, and stores each sound on the message server under the room code, where it is deleted automatically after 14 days (**Delete all** removes them sooner). Use the same room on show day: the admin page remembers its room, or set a fixed code under *Settings*. **▶** previews a sound on the admin device. On "wrong → next in line" the display plays the next person's sound. A display opened later still receives every sound.

**Getting the sound into your recording:** sounds come out of whatever computer runs the display page. Run the display on the recording computer and route its audio into the recording, or connect that computer's headphone output to a **line** input on your audio interface.

## Buzz-in modes (admin → Settings)

The question is what players react to.

- **First to arrive (default).** The first buzz to reach the admin page wins, instantly. Use when players react to your voice: you say "Go!", or they buzz while you read the question. On mixed connections (Wi-Fi vs mobile data), faster phones win very close calls, typically by 30–150 ms.
- **Reaction time.** Each phone times from when its own screen lights up to the tap; the fastest time wins after a short wait (default 400 ms, adjustable). Use when you open the buzzers silently and players race their screens, e.g. Jeopardy style: read the whole question, then open. Fair even on slow connections. Don't say "Go!" in this mode: a phone that gets the signal late would start its clock late and gain a head start. A tampered phone could fake its time.

## Limits

- **Venue networks.** All pages talk through a free public message broker (`broker.hivemq.com`, WebSocket port 8884). Managed Wi-Fi often blocks that port. Test from the venue Wi-Fi before the show. If it is blocked, players switch their phones to **mobile data**, and the admin and display computers use a phone hotspot.
- **Public broker.** No account is needed, but anyone on the public broker can find the room, see the game, send fake buzzes, or download the buzzer sounds. Fine for a party. Stored game state and sounds expire after 14 days (needs an MQTT 5 broker, which the default is). For more privacy, set up a free private broker (HiveMQ Cloud or EMQX) and enter its WebSocket address under the admin page's *Settings*.
- **One admin.** Run only one admin page per room; two would overwrite each other. Scores survive an admin page reload.
- **16 players** per room.
- **iPhones** don't vibrate on buzz (Safari has no vibration support).

## Updating the site

Script and stylesheet links carry a version tag, `?v=VERSION_DATE` (e.g. `?v=1.0.0_2026-11-05`). It is also what the small ⓘ button in each page's corner shows, so it is the only place to set the version and release date. Change it in all four HTML files whenever a `.js` or `.css` file changes (e.g. `sed -i 's/?v=1.0.0_2026-11-05/?v=1.0.1_2026-11-20/g' *.html`); otherwise browsers can mix a new page with old cached code for up to 10 minutes (GitHub Pages' cache time). The two libraries in `js/vendor/` carry their own tag (`?v=mqtt-5.16.1`, `?v=qrcode-2.0.4`): leave those alone unless the library itself is replaced, so browsers keep their cached copy across updates.

## Other games

The buzzer runs next to any game today: show the game on the main screen, players buzz on their phones, the host uses the admin page. Plans for deeper integration (drop-in script, OBS overlay, keyboard bridge) and the message contract to keep stable are in [docs/PLUGINS.md](docs/PLUGINS.md).

## Message layout (for reference)

Topics under `gsbuzz/v1/<ROOM>/`:

| Topic | From → to | Content |
|---|---|---|
| `state` (retained) | admin → all | full game state |
| `hello` | player → admin | join and heartbeat |
| `buzz` | player → admin | `{id, armId, rt}` |
| `voice/<name>` (retained) | admin → display | buzzer-sound manifest `{id, n, bytes, name}` |
| `voice/<name>/<id>/<i>` (retained) | admin → display | WAV data, 32 KB chunks |

The ESP32 hub and seat-pod version is in git history at commit `767cdd8`.
