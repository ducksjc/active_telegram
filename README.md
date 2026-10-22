# pi-active-telegram

Two-way Telegram link for [pi](https://github.com/badlogic/pi-mono) coding agent: **phone → agent** messages injected into the running session, and **agent → phone** progress notifications. One poller at a time, with claim-based ownership so two sessions can never fight over `getUpdates`.

```
phone ──Telegram──▶ telegram-steer.ts ──steer──▶ pi session
pi session ──notify.py──▶ Telegram ──▶ phone
```

# 작동 방식과 왜 이렇게 만들어 진건지

에이전트를 초장시간 자율수행시켰을 때, 원거리에서 폰으로 에이전트에게 상황을 물어보거나, 제어하는 목적으로 만듦.

한 컴퓨터에서 에이전트창을 여러개 띄우거나, /reload, /new, 에이전트가 부리는 서브에이전트 등으로 인해 상황이 복잡해지기 쉽다.
그래서 여러가지 방법을 테스트해보다가, 에이전트가 직접 툴로 텔레그램을 연결하도록 하고, 그 툴이 발생하면 기존 연결이 모두 끊어지게 하였다.
이로 인해 안정화가 되었으며, 에이전트의 지능에 기반하긴 하지만 작동은 매끄러운 편이였으며, 현재 만족스럽게 사용중이다.
ducksjc/active_handoff 와 같이 사용할 때 handoff.md 나 agents.md에 탤래그램툴콜 지침을 적도록 하면 인계 이후에도 잘 연결하였음.


## What you get

| Direction | Mechanism | Trigger |
|---|---|---|
| **Inbound** phone → agent | `extensions/telegram-steer.ts` polls `getUpdates` every 2 s and injects the message with `deliverAs: "steer"` | the session calls the `telegram_connect` tool |
| **Outbound** agent → phone | `notify.py` (plain Python, stdlib only) | you or the agent runs `python notify.py <level> "text"` |
| **Delivery receipt** | the bot replies to your phone with the first 5 characters + `… received` the moment a message actually lands in the session | automatic |

Inbound is *steering*, not a new prompt: the message lands in the middle of the agent's work and redirects it.

## Requirements

- **pi** ≥ 0.x with package support (`pi install`, `pi list`)
- **Node.js** — the extension runs inside pi's own loader, no build step
- **Python 3.7+** — `notify.py` uses only the standard library (`urllib`, `json`, `argparse`). No `pip install` needed.
- Network access to `api.telegram.org`

## Setup

### 1. Create a bot

Open **[@BotFather](https://t.me/BotFather)** in Telegram:

```
/newbot
MyPiLink
mypilink_bot
```

BotFather answers with a token in the form `1234567890:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`. Keep it private — it is the only credential this package needs.

### 2. Message your bot from your phone

Send anything (e.g. `/start`) to the new bot. **Do this before step 4** — `--discover` reads the bot's update queue, and an empty queue yields nothing.

### 3. Create `telegram.json` in the package directory

```json
{
 "token": "1234567890:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
 "chat_id": 0
}
```

`chat_id` is your Telegram account's numeric id. Leave it `0` if you ran step 2 — the next command fills it in.

### 4. Fill in `chat_id` and verify outbound

```bash
cd <this package directory>
python notify.py --discover     # picks chat_id out of the last message the bot received
python notify.py --test         # you should see a message on your phone
```

If a live poller already stored a `chat_id` and you want to overwrite it: `python notify.py --discover --take`.

### 5. Install the package into pi

```bash

pi install git:github.com/ducksjc/active_telegram    # from git


pi list                                               # confirm it resolved
pi -e ./pi-active-telegram                            # try it for one run only
pi remove <the same source you installed>
```

Installs are written to `~/.pi/agent/settings.json` (`--local` writes `.pi/settings.json` instead).

> **Do not also copy `extensions/telegram-steer.ts` into `~/.pi/agent/extensions/`.** Then two copies of the extension load, both poll, and Telegram answers `409 Conflict`.

## Usage

### Inbound: connect a session

In a pi session, ask for it (or let the agent call it):

```
telegram_connect
```

- Only **one** session is connected at a time. Calling the tool overwrites the claim; the previous poller notices on its next tick and exits cleanly.
- Connected sessions receive phone messages as:
  ```
  [telegram 21:14:07 Joon] run the gate suite again
  ```
  (24-hour stamp, sender's first name or username.)
- The phone gets an instant receipt: `run t… received`.
- **The connection dies with the session.** No auto-reconnect, no session-id file. After `/new` or `pi --continue`, call the tool again.
- Unconnected sessions do not poll at all.

### Outbound: notify.py

```bash
python notify.py milestone "gate suite 57/57 PASS"
python notify.py bench     "wall 18.4s (baseline 9.5s)"
python notify.py fail      "gates.py FAIL 2/57"
python notify.py abort     "load failed 3x — see log"
python notify.py info      "still working"
python notify.py ok        "done"

python notify.py --file build.log --note "build log"   # attach a file
python notify.py --force "same sentence again"         # bypass dedup
python notify.py --help
```

| Level | Rendered as | Dedup |
|---|---|---|
| `milestone` | `✅ [milestone] …` | skipped if the identical sentence was sent within 60 s |
| `bench` | `📊 [bench] …` | same |
| `info` | `• …` | same |
| `ok` | `👌 [ok] …` | same |
| `fail` | `⚠️ [fail] …` | **always sent** |
| `abort` | `⛔ [abort] …` | **always sent** |

Attachments use `sendPhoto` for images and `sendDocument` for everything else (`sendDocument` + caption is rejected with 400 by Telegram — captions go in `--note` as part of the text).

## Configuration

Everything optional is an environment variable; everything required lives in `telegram.json`.

| Variable | Read by | Meaning | Default |
|---|---|---|---|
| `ITP_TG_CONF` | extension | path to `telegram.json` | next to the extension, then the package root |
| `TG_CONF` | `notify.py` | path to `telegram.json` | next to `notify.py` |
| `ITP_TG_MS` | extension | poll interval in ms | `2000` |

Point `ITP_TG_CONF` / `TG_CONF` at a scratch directory (e.g. a temp folder) to experiment without touching real state — all state files are written next to the config file that was found.

## Files on disk

State lives next to `telegram.json` and is gitignored. Both sides read the **same** files.

| File | Written by | Purpose |
|---|---|---|
| `telegram.json` | you | secret: bot token + `chat_id` |
| `telegram_offset.json` | extension, `notify.py --poll` | highest `update_id` already consumed |
| `telegram.claim.json` | whoever polls | ownership heartbeat: `{inst, pid, ts}` |
| `notify_state.json` | `notify.py` | dedup memory (1 h window) |
| `telegram_poll.log` | extension | verdict log — survives the session dying |

**Offsets only ever move forward** (`Math.max`). Restoring an older offset file means those updates are skipped forever.

## Design notes

- **Single poller by construction.** A poll loop takes `telegram.claim.json` and re-reads it every tick; if another session stole it, the old loop exits itself. `notify.py --poll` checks the same claim and stands down rather than provoking `409` (override with `--take`).
- **Ownership is re-read every tick**, never captured as a loop parameter — a captured owner makes takeover silently dead.
- **Stale messages are discarded, not injected.** A message older than 4 s at fetch time was sent while this pi was not connected; it is logged as `DISCARD` and the offset advances.
- **The loop is a raw async loop, not an event handler**, so it outlives the extension launcher that pi invalidates on session switch. That is why the claim heartbeat and the log file exist: they are the only honest liveness signals.

## Known limitations

- After a session switch (`/new`), the first phone message can arrive **~15 s late**. This is delay, not loss: the previous poller's backoff (`conflictUntil = now + 15000`) has to expire, and `getUpdates` is ack-based, so everything queued lands in order. Just wait.
- `/reload` leaves the old runtime's timers alive. Prefer restarting pi once when you change the extension.
- Only messages from `chat_id` are accepted; a second person messaging the bot is ignored by design.
- The test harness cannot simulate `/reload` (the module is evaluated once), so it covers `/new` only.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `401 Unauthorized` | bad/rotated token | re-check `telegram.json` |
| `403 Forbidden` | bot blocked, or `chat_id` wrong | unblock the bot; re-run `--discover --take` |
| `400 Bad Request` … `chat_id is empty` | `chat_id` missing/0 | run `python notify.py --discover` |
| `409 Conflict` | two pollers | you copied the extension into `~/.pi/agent/extensions/`, or an old pi process is alive. `Get-Process node` — the **oldest** pid is the zombie |
| tool says `telegram config file (telegram.json) not found` | no config found in the search path | create it (step 3) or set `ITP_TG_CONF` |
| phone messages never arrive | session not connected / connection died with the session | call `telegram_connect` again |
| is the poller alive? | — | `cat telegram.claim.json` and compare `ts` to now; fresh within 8 s means alive |
| outbound only is broken | — | `python notify.py --test` |

## Tests

The development harness (`tg_tool_test.mjs`, 13 assertions) is a dev tool, not part of the package, so it is not shipped here. It drives the extension against a fake `fetch` and a fake pi runtime — no network, no real state touched — and asserts: unconnected sessions poll zero · tool call → injection · backlog older than 4 s is discarded · discards produce no receipt · injection produces exactly one receipt · offset advances · lost claim ends the loop · no auto-reconnect after shutdown · re-connect works · own claim is released.

Smoke-test what you do have:

```bash
python notify.py --test    # rc 0 + a message on your phone = outbound is alive
```

## Security & privacy

- The bot token never leaves `telegram.json`; the agent and the model never read it. `notify.py` and the extension read it at process level only.
- No telemetry, no third-party endpoints — only `api.telegram.org`.
- `telegram.json`, offsets, claims, dedup state and logs are gitignored.
- Anyone reusing this code creates their **own** `telegram.json` with their own bot token.

## License

MIT — see [LICENSE](LICENSE).
