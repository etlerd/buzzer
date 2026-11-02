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

## Name recordings and audio

1. Once a player has joined, click **Add voice** next to their name on the admin page and choose a WAV or MP3 (an iPhone voice memo works too).
2. The admin page trims the silence, evens out the volume, and sends it to the display. The display plays it once as a check. **▶** replays it.
3. During the game the display plays the buzzer sound, then the name of whoever buzzed in. On "wrong → next in line" it announces the next person.

Recordings are matched by **name**, so a player who rejoins under the same name keeps theirs. A display opened later still receives them.

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
