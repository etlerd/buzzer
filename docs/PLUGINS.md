# Plugin plan

Not built yet. This records how the buzzer is meant to work with other games (Blechardy, future trivia games), and what to protect in the meantime so that stays possible.

## Today: side by side, no integration

Any game works with the buzzer right now when run next to it:

- the game shows on the main screen as usual;
- players buzz on their phones (`play.html`);
- the host runs the buzzers from `admin.html`, on a phone or tablet;
- `display.html` runs on the recording computer for sounds, or in a corner of the screen.

This is the recommended setup for Blechardy, which is a single-screen Claude chat artifact.

## Future plugin forms

| Game type | Plugin form | Notes |
|---|---|---|
| Web page whose code we control | **Drop-in script** `buzzer-kit.js`: `open()`, `lock()`, `correct()`, `wrong({next})`, `on('buzz', …)`, `on('state', …)` | Needs the referee logic moved out of `admin.js` (below). The game then shows the winner on its own board. |
| Anything shown through OBS (slides, apps, any website) | **Overlay page**: transparent "Alice buzzed in" banner as an OBS browser source | No changes to the game; host still uses `admin.html`. Cheapest next step. |
| Desktop app expecting key presses | **Keyboard bridge**: small installed helper that turns buzz-ins into key presses (player 1 → "1") | A web page cannot press keys in other apps. Only if such a game is actually used. |
| Code in another language (Python, Node-RED, Unity) | **Message API**: subscribe/publish the topics below | Works today; the contract below is what it relies on. |
| Claude chat artifact (e.g. Blechardy) | **Side by side** | Chat artifacts restrict network access and load scripts only from a few CDNs; connecting to the message server may be blocked. Re-test before promising more. |

## Structural change needed first

`js/admin.js` currently mixes two jobs:

1. **Referee:** players joining, opening/locking, collecting buzzes, deciding the winner (reaction-time or arrival), lock-outs, next in line, publishing state.
2. **Admin screen:** buttons, player list, QR code, buzzer-sound uploads.

Move (1) into `js/referee.js` with no DOM access, and have `admin.html` use it like any plugin would. Then `buzzer-kit.js` = `common.js` + `referee.js`. Rule: **one referee per room**. A game that embeds the kit replaces `admin.html` for that room; it does not run alongside it.

## Transport

All pages talk through MQTT over WebSockets (`broker.hivemq.com:8884` by default). For a plugin inside a game that already has its own real-time backend (Blechardy's repo version used Firebase), consider a second transport behind the same interface:

- managed networks often block port 8884 but allow 443 (Firebase, most hosted services);
- one backend instead of two is simpler and private.

Keep transport details inside `common.js` (`BZ.connect`, `BZ.topic`) so a second transport can be added without touching the pages.

## Message contract (keep stable)

Topics under `gsbuzz/v1/<ROOM>/`. Breaking changes go to `gsbuzz/v2/`; adding fields within v1 is fine, and readers must ignore fields they don't know.

| Topic | Retained | From → to | Payload |
|---|---|---|---|
| `state` | yes | referee → all | `{v:1, room, phase:"locked"\|"armed"\|"buzzed", armId, winner:id\|null, queue:[{id, rt}], excluded:[id], kicked:[id], result:{id, ok, n}\|null, players:[{id, name, slot, color, online, voice}], ts}` |
| `hello` | no | player → referee | `{id, name}` every 4 s; `{id, bye:true}` on leave (also the connection's last will) |
| `buzz` | no | player → referee | `{id, armId, rt}`: `rt` = ms from when that phone saw `armed` to the tap |
| `voice/<slug>` | yes | admin → display | `{id, n, bytes, name}`: buzzer-sound manifest; empty payload = deleted |
| `voice/<slug>/<id>/<i>` | yes | admin → display | WAV bytes, chunk `i` of `n` (32 KB each) |
| `say` | no | admin → display | `{slug}`: play that sound now |

Meanings a plugin can rely on:

- A buzz-in happened when `state.phase` becomes `"buzzed"` or `state.winner` changes.
- A judgment happened when `state.result.n` changes (`ok` true/false, `id` = who answered).
- `slot` is stable per player for the session (1, 2, 3…) and suits mapping to keys, lights or seats.
- `slug` = player name lower-cased, letters and digits only, max 24 (`BZ.voiceSlug`); `players[].voice` is the slug to play for that player.
