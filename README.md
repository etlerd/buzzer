# Game Show Buzzer

Phones are the buzzers. Runs on GitHub Pages; no hardware, server or accounts needed.

| Page | Who uses it |
|---|---|
| `play.html` | **Players**, on their phones: a big buzzer button |
| `admin.html` | **Admin** (the host): opens and locks buzzers, judges answers, keeps score, shows the join QR code, uploads name recordings |
| `display.html` | **Studio display**, on a TV or the recording computer: who buzzed in, question, scoreboard. **Plays all sounds**, including recorded names |
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
| C | Correct: add points, lock |
| W | Wrong: subtract penalty, lock that player out, reopen for everyone else |
| N | Wrong: lock that player out, hand the question to whoever buzzed next |
| L | Lock and clear |
| Q | New question: clears lock-outs and the question text |

Phones that press **before** the buzzers open get a 1-second "TOO SOON" lockout.

## Buzzer sounds and audio

Each player can have their own buzzer sound (their name, a catchphrase, a sound effect). It plays **instead of** the standard buzz when they buzz in; players without one get the standard buzz.

**Before players arrive:** on the admin page, under **Buzzer sounds**, click **Add sounds** and select all the files at once (WAV, MP3 or iPhone .m4a). Name each file after the player, e.g. `Alice.mp3` or `Mary Jo.wav`. A player who joins with that name gets it automatically; capitals, spaces and punctuation are ignored. If someone joins under a different name ("Bob" for `Robert.mp3`), pick them from that sound's **Assign to** menu.

**After players join:** **Add sound** next to a player uploads a sound for that player directly.

The admin page trims silence from both ends, evens out the volume, keeps at most 4 seconds, and stores each sound on the message server under the room code. Use the same room on show day: the admin page remembers its room, or set a fixed code under *Room & broker settings*. **▶** previews a sound on the admin device. On "wrong → next in line" the display plays the next person's sound. A display opened later still receives every sound.

**Getting the sound into your recording:** sounds come out of whatever computer runs the display page. Run the display on the recording computer and route its audio into the recording, or connect that computer's headphone output to a **line** input on your audio interface.

## Who wins: two modes (admin settings)

- **Reaction time (default).** Each phone measures the time from when *it* saw the buzzers open to the tap. Network delay does not count against anyone. The admin waits a short window (default 400 ms) after the first buzz to collect the others. Weakness: a phone running modified code could fake its time.
- **First to arrive.** Whoever's buzz reaches the admin first wins. Cannot be faked, but phones on slower connections lose close calls.

## Limits

- **Venue networks.** All pages talk through a free public message broker (`broker.hivemq.com`, WebSocket port 8884). Managed Wi-Fi often blocks that port. Test from the venue Wi-Fi before the show. If it is blocked, players switch their phones to **mobile data**, and the admin and display computers use a phone hotspot.
- **Public broker.** No account is needed, but anyone who guesses the room code can see the game, send fake buzzes, or download the name recordings. Fine for a party. For more privacy, set up a free private broker (HiveMQ Cloud or EMQX) and enter its WebSocket address under the admin page's *Room & broker settings*.
- **One admin.** Run only one admin page per room; two would overwrite each other. Scores survive an admin page reload.
- **16 players** per room.
- **iPhones** don't vibrate on buzz (Safari has no vibration support).

## Updating the site

Script and stylesheet links carry a version tag (`?v=20261102e`). Change it in all four HTML files whenever a `.js` or `.css` file changes; otherwise browsers can mix a new page with old cached code for up to 10 minutes (GitHub Pages' cache time).

## Message layout (for reference)

Topics under `gsbuzz/v1/<ROOM>/`:

| Topic | From → to | Content |
|---|---|---|
| `state` (retained) | admin → all | full game state |
| `hello` | player → admin | join and heartbeat |
| `buzz` | player → admin | `{id, armId, rt}` |
| `voice/<name>` (retained) | admin → display | recording manifest `{id, n, bytes}` |
| `voice/<name>/<id>/<i>` (retained) | admin → display | WAV data, 32 KB chunks |
| `say` | admin → display | play a name now |

The ESP32 hub and seat-pod version is in git history at commit `767cdd8`.
