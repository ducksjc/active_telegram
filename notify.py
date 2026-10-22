"""notify.py — sends progress notifications (pi → phone) over Telegram. Out-of-model harness: never embedded in the engine/model.

Run this file from its own directory (the package root). Inbound (pi extension telegram-steer.ts) and outbound (this file) read **the same state files in the same folder**.

Secret: the token and chat_id live only in telegram.json next to this file (excluded from git). This file holds no secret.

Usage (run from the package directory):
  python notify.py --discover   # pick chat_id out of the last message the bot received and store it
  python notify.py milestone "window 30 gate PASS"
  python notify.py bench   "wall 18,4xxms (baseline 9.5s)"
  python notify.py fail    "gates.py FAIL 2/57"
  python notify.py abort   "full load failed 3x — see log"
  python notify.py --file <log path> [--note "run log"]   # attach a file (sendDocument)
  python notify.py --test          # test send to the stored chat_id

level is one of milestone / bench / fail / abort / info / ok. abort and fail are always sent; the others are skipped when the same sentence repeats within 60 seconds.
(Defect measured 2026-10-19: `ok` was missing from ICON, so the level slot pushed the body out and **the body disappeared entirely** — `notify.py ok "…"` was silently truncated. Fixed by registering ok in ICON.)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

# 비밀 설정 좌표: TG_CONF(env) → 이 파일 옆 telegram.json. 옛 자리 폴백은 없다.
def _find_conf() -> Path:
    here = Path(__file__).resolve().parent
    env = os.environ.get("TG_CONF") or os.environ.get("ITP_TG_CONF")
    for c in (env, here / "telegram.json"):
        if c and Path(c).exists():
            return Path(c).resolve()
    return here / "telegram.json"


CONF = _find_conf()
try:    # 콘솔이 cp949 라 한글이 깨진다(함정). stdout 을 UTF-8 로 고정한다.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
ICON = {"milestone": "✅", "bench": "📊", "fail": "⚠️", "abort": "⛔", "info": "•", "ok": "👌"}
STATE = CONF.parent / "notify_state.json"   # 런마다 새로 뜨는 프로세스라 중복 제거는 파일로 해야 실제로 작동한다
OFFSET = CONF.parent / "notify_offset.json"  # 읽은 update_id. 이게 없으면 예전 메시지를 매번 다시 읽는다

# ── 단일 poller 계약 (2026-10-19 실측: 409 Conflict 재발 방지) ─────────────────────
# Telegram 은 같은 봇의 getUpdates 를 두 소비자가 동시에 읽으면 한쪽을 409 로 잘라버린다.
# pi 확장(telegram-steer.ts) 이 2초마다 poll 중이므로, 여기서 --poll 을 치면 **한쪽이 죽는다**.
# 확장 쪽이 쓰는 파일과 **같은 이름·같은 스키마**의 claim 을 공유한다(같은 폴더라 같은 파일을 본다):
#   telegram.claim.json = {"inst": str, "pid": int, "ts": ms}
# claim 이 8초 안에 갱신된 다른 inst 것이면 → getUpdates 를 **치지 않고** 물러난다(409 의 여지 자체를 없앤다).
CLAIM = CONF.parent / "telegram.claim.json"
CLAIM_TTL_MS = 8000                        # 확장 쪽 윈도우와 동일(telegram-steer.ts:83)
POLL_INST = f"notify-{os.getpid():08x}"    # 런마다 새로 뜨는 프로세스 → inst 는 pid 로 만든다


def load() -> dict:
    if not CONF.exists():
        sys.exit(f"no config file: {CONF}  — expected {{\"token\": \"...\", \"chat_id\": 123}}")
    return json.loads(CONF.read_text(encoding="utf-8"))


def api(token: str, method: str, payload: dict | None = None) -> dict:
    url = f"https://api.telegram.org/bot{token}/{method}"
    data = None
    if payload is not None:
        data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data,
                                 headers={"Content-Type": "application/json"} if data else {})
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        # 409 Conflict: 다른 소비자가 같은 offset 으로 getUpdates 를 돌리고 있다는 뜻이다(실측: --poll 이 409 로 죽었다).
        # 전송 경로(sendMessage) 는 409 를 쓰지 않으므로 영향 없다. 폴링은 **죽지 않고** 빈 결과를 돌려야 한다.
        body = ""
        try:
            body = e.read().decode(errors="replace")[:200]
        except Exception:
            pass
        return {"ok": False, "error_code": e.code, "description": e.reason, "raw": body, "result": []}


def discover(conf: dict, take: bool = False) -> int | None:
    if not defer_or_take(take):
        print("[discover] if a poller is alive the chat_id is already stored. Force it with: --discover --take")
        return None
    up = api(conf["token"], "getUpdates").get("result", [])
    if not up:
        print("getUpdates is empty — send any message to the bot (t.me/<bot>) in Telegram, then run this again")
        return None
    last = up[-1]
    msg = last.get("message") or last.get("channel_post") or {}
    chat = (msg.get("chat") or {})
    cid = chat.get("id")
    title = chat.get("title") or chat.get("first_name") or "?"
    if cid is None:
        print("could not find chat_id:", json.dumps(last, ensure_ascii=False)[:400])
        return None
    conf["chat_id"] = cid
    CONF.write_text(json.dumps(conf, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"chat_id = {cid}  (chat: {title})  → {CONF}")
    return cid


def claim_read() -> dict | None:
    try:
        j = json.loads(CLAIM.read_text(encoding="utf-8"))
    except Exception:
        return None
    return j if isinstance(j, dict) else None


def claim_live() -> dict | None:
    """다른 poller 가 8초 안에 살아있으면 그 레코드를, 아니면 None 을 돌려준다."""
    j = claim_read()
    if not j or j.get("inst") == POLL_INST:
        return None
    try:
        age = time.time() * 1000 - float(j.get("ts") or 0)
    except Exception:
        return None
    return j if age < CLAIM_TTL_MS else None


def claim_take() -> None:
    """내가 읽겠다는 heartbeat. 이걸 써야 확장 쪽이 다음 tick 에서 물러난다(확장도 같은 파일을 본다)."""
    try:
        CLAIM.write_text(json.dumps({"inst": POLL_INST, "pid": os.getpid(), "ts": int(time.time() * 1000)}),
                         encoding="utf-8")
    except Exception:
        pass


def defer_or_take(take: bool) -> bool:
    """True 면 읽어도 된다(claim 을 잡는다). False 면 물러난다. 409 는 추측이 아니라 claim 로 방지한다."""
    other = claim_live()
    if not other:
        claim_take()
        return True
    if take:
        claim_take()
        print(f"[poll] --take: pushing aside another poller (inst {other.get('inst')} pid {other.get('pid')}) and reading. "
              f"the extension backs off for 15s (measured telegram-steer.ts:112)")
        return True
    age = (time.time() * 1000 - float(other.get("ts") or 0)) / 1000.0
    print(f"[poll] another poller is reading → skipping getUpdates (409 prevention). "
          f"inst {other.get('inst')} pid {other.get('pid')} · heartbeat {age:.1f}s ago · TTL {CLAIM_TTL_MS}ms")
    print("[poll] in a pi session the reply is already injected into the context as [telegram …] — you do not need this path. "
          "read forcibly only with --take")
    return False


def poll(conf: dict, take: bool = False) -> int:
    """새 메시지(들)만 출력하고 offset 을 저장한다. 지시로 쓸 수 있게 채팅 주인 것만 보여준다."""
    if not defer_or_take(take):
        return 2                            # 0 이 아님 = "읽지 않았다". 조용한 실패를 구분한다
    try:
        off = int(json.loads(OFFSET.read_text(encoding="utf-8"))["offset"])
    except Exception:
        off = 0
    res = api(conf["token"], "getUpdates", {"offset": off + 1, "timeout": 3})
    if not res.get("ok", True):
        print(f"[poll] getUpdates failed {res.get('error_code')} {res.get('description')} — another consumer may be polling (409). not fatal")
        return 0
    up = res.get("result", [])
    mine = conf.get("chat_id")
    got = 0
    for u in up:
        off = max(off, int(u["update_id"]))
        m = u.get("message") or u.get("channel_post") or {}
        chat = m.get("chat") or {}
        frm = m.get("from") or {}
        who = frm.get("first_name") or frm.get("username") or "?"
        text = m.get("text") or m.get("caption") or ""
        ts = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(m.get("date", 0)))
        if mine is not None and chat.get("id") != mine:
            print(f"[skip] {ts} {who} (chat {chat.get('id')} — not the owner): {text}")
            continue
        got += 1
        print(f"[msg] {ts} {who}: {text}")
    OFFSET.write_text(json.dumps({"offset": off}), encoding="utf-8")
    if got == 0:
        print("[poll] no new message")
    return 0


def send(conf: dict, text: str) -> bool:
    r = api(conf["token"], "sendMessage",
            {"chat_id": conf["chat_id"], "text": text, "disable_web_page_preview": True})
    if not r.get("ok"):
        print("send failed:", json.dumps(r, ensure_ascii=False)[:400])
    return bool(r.get("ok"))


def send_file(conf: dict, path: Path, note: str | None) -> bool:
    # 이미지는 sendPhoto(캡션 지원), 그 외 파일은 sendDocument. sendDocument 에 caption 을 넣으면
    # 텔레그램이 400 Bad Request 로 거절한다(실측: PNG + caption → HTTP 400).
    image = path.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp", ".gif")
    method = "sendPhoto" if image else "sendDocument"
    field = "photo" if image else "document"
    url = f"https://api.telegram.org/bot{conf['token']}/{method}"
    boundary = "----pi-tg"
    body = b""
    # chat_id 는 multipart 필드로 넣어야 한다(실측: 없으면 텔레그램이 400 "chat_id is empty" 로 거절 —
    # 첨부가 예전부터 조용히 실패해 있었다). sendMessage 와 달리 URL 쿼리로도 안 붙는다.
    body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"chat_id\"\r\n\r\n"
             f"{conf['chat_id']}\r\n").encode()
    if note:
        if not image:
            note = None          # sendDocument 는 caption 미지원 → 본문은 따로 보내지 않고 생략
        else:
            body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"caption\"\r\n\r\n"
                     f"{note}\r\n").encode()
    ctype = ("image/png" if path.suffix.lower() == ".png" else
             "image/jpeg" if path.suffix.lower() in (".jpg", ".jpeg") else
             "image/webp" if path.suffix.lower() == ".webp" else
             "image/gif" if path.suffix.lower() == ".gif" else "application/octet-stream")
    body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; "
             f"filename=\"{path.name}\"\r\nContent-Type: {ctype}\r\n\r\n").encode()
    body += path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(url, data=body, headers={
        "Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            out = json.loads(r.read().decode())
    except Exception as e:                       # 400 류도 메시지를 남긴다(조용한 실패 금지)
        print("attach failed:", e)
        return False
    if not out.get("ok"):
        print("attach failed:", json.dumps(out, ensure_ascii=False)[:400])
    return bool(out.get("ok"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("level", nargs="?", default="info",
                    help="milestone | bench | fail | abort | info | ok")
    ap.add_argument("message", nargs="?")
    ap.add_argument("--discover", action="store_true",
                    help="read chat_id from the last message the bot received and store it")
    ap.add_argument("--test", action="store_true",
                    help="send a test message to the stored chat_id")
    ap.add_argument("--poll", action="store_true", help="print only new messages (for use as an instruction)")
    ap.add_argument("--file", help="path of the file to attach")
    ap.add_argument("--note", help="caption for the attachment")
    ap.add_argument("--force", action="store_true", help="ignore dedup")
    ap.add_argument("--take", action="store_true",
                    help="poll/discover pushes aside the live poller's claim and reads (default: stand down = 409 prevention)")
    a = ap.parse_args()

    conf = load()
    if a.discover:
        return 0 if discover(conf, a.take) else 1
    if a.poll:
        return poll(conf, a.take)

    if conf.get("chat_id") is None:
        print("no chat_id — run first:  python notify.py --discover")
        return 1

    if a.test:
        ok = send(conf, "🔔 telegram notification channel test (pi-active-telegram)")
        return 0 if ok else 1

    if a.file:
        p = Path(a.file)
        if not p.exists():
            sys.exit(f"no such file: {p}")
        return 0 if send_file(conf, p, a.note or p.name) else 1

    if not a.message:
        sys.exit("give me a message:  python notify.py milestone \"...\"")

    lvl = a.level if a.level in ICON else "info"
    if lvl == "info" and a.level not in ICON:      # notify.py "메시지" 만 준 경우
        a.message = f"{a.level}"
    text = f"{ICON[lvl]} [{lvl}] {a.message}" if lvl != "info" else f"{ICON['info']} {a.message}"

    key = text
    now = time.time()
    try:
        seen = json.loads(STATE.read_text(encoding="utf-8")) if STATE.exists() else {}
    except Exception:
        seen = {}
    if not a.force and lvl not in ("fail", "abort"):
        if now - float(seen.get(key, 0)) < 60:
            return 0                      # 60초 안 같은 문장은 조용히 생략 (spam 방지)
    seen[key] = now
    for k in [k for k, v in seen.items() if now - float(v) > 3600]:
        del seen[k]                       # 1시간 지난 키 정리
    try:
        STATE.write_text(json.dumps(seen, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass
    return 0 if send(conf, text) else 1


if __name__ == "__main__":
    sys.exit(main())
