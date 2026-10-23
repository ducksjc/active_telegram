/**
 * telegram-steer.ts — 텔레그램 연결은 **툴콜로만** 켠다 (2026-10-21 새 규정).
 *
 * 이 확장 하나가 툴을 둘 등록한다 (2026-10-23):
 *   · telegram_connect  = 수신 (폰 → pi). poller 는 프로세스 싱글톤 하나.
 *   · telegram_notify   = 발신 (pi → 폰). notify.py 의 TS 이식. shell 을 중간에서 제거한다.
 * 파일을 나누지 **않는** 이유: findConf/dir()/claim 이 모듈 스코프 싱글톤 P 에 붙어있다. 둘로 나누면
 * 모듈 스코프가 두 개가 되어 **P(=poller 상태)가 복제될 여지**가 생긴다 = 409 의 재발.
 * 발신은 claim/offset 을 전혀 건드리지 않는다(sendMessage 는 poller 와 경합하지 않는다).
 *
 *   세션이 `telegram_connect` 툴(인자 없음)을 부르면:
 *     1. 기존 연결 전부 해제 — claim 파일을 내 inst로 무조건 덮어쓴다.
 *        다른 프로세스의 옛 poller는 다음 틱에 claim 상실을 감지하고 루프를 영구 종료한다.
 *     2. 이 세션이 폰 메시지를 주입받는 유일한 세션이 된다 (2초 poll, deliverAs: "steer").
 *        단 **send 시각으로부터 4초 넘게 지난 메시지는 조용히 폐기**(log만, offset 전진).
 *        대신 **주입 성공한 그 순간** 봇 sendMessage로 폰에 생존신고: "<앞 5자>… received".
 *     3. 세션 종료 시 claim 반납 + 루프 종료. 연결도 같이 끝난다 — `pi --continue`로 돌아온 뒤
 *        쓰려면 툴을 다시 부르면 된다 (자동 재연결 없음 · 세션ID 파일 없음).
 *   연결되지 않은 세션은 poll 을 전혀 하지 않는다. /tg 커맨드 없음. session_start 핸들러 없음.
 *
 * 설정(비밀은 git 밖): ITP_TG_CONF → 이 파일 옆 telegram.json → 패키지 루트(../) telegram.json
 *   { "token": "1234567890:AAA...", "chat_id": 1234567890 }
 *   상태 파일은 이 설정 파일이 있는 폴더에 떨어진다 (실험은 ITP_TG_CONF 로 다른 폴더를 가리키게 빼면 된다).
 * 상태 파일(설정 파일과 같은 자리): telegram_offset.json(앞쪽으로만 전진) · telegram.claim.json({inst,pid,ts})
 *   · telegram_poll.log(판정 로그)
 *
 * 보존한 불변식:
 *   ① poller 상태 전부는 모듈 스코프 P (팩토리는 pi/INSTANCE 만 쥔다)
 *   ② 루프는 owner를 파라미터로 받지 않고 매 틱 P.owner 를 다시 읽는다 (가로채기가 실제로 작동)
 *   ③ offset 은 앞쪽으로만 — 되감기 = 메시지 영구 스킵
 *   ④ 판정 로그는 파일 (ctx 는 죽어도 로그는 남는다)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type Owner = { pi: ExtensionAPI; ctx: any };

// ── poller = 프로세스 싱글톤. 팩토리(세션 런타임)가 몇 개든 이 객체 하나가 상태를 산다.
const P = {
	gen: 0, // 루프 세대. 재시작 마다 ++ → 옛 루프는 자기 세대가 아니게 되면 빠져나온다.
	stop: false,
	owner: null as Owner | null, // 현재 주입 대상 = 연결된 세션. 매 틱 여기서 읽는다.
	ownerInst: "-",
	conflictUntil: 0,
	injected: 0,
	lastInject: 0,
	confPath: null as string | null,
	offset: -1, // -1 = 아직 파일에서 안 읽음
	okOnce: false,
};

const loopAlive = () => P.gen > 0 && !P.stop;

// pi 로더는 __dirname 을 주지만(CJS 변환), 순수 ESM 스코프에서는 ReferenceError 다.
const SELF_DIR = typeof __dirname !== "undefined" ? __dirname : ".";

// 패키지 안에서만 산다. 확장 파일 옆 → 패키지 루트 순서로 찾는다 (옛 폴백은 없다).
const CANDIDATES = [
	process.env.ITP_TG_CONF,
	path.join(SELF_DIR, "telegram.json"),
	path.join(SELF_DIR, "..", "telegram.json"),
].filter(Boolean) as string[];

function findConf(): string | null {
	for (const p of CANDIDATES) {
		try {
			if (fs.existsSync(p)) return p;
		} catch {}
	}
	return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const readJson = (p: string) => {
	try {
		return JSON.parse(fs.readFileSync(p, "utf-8"));
	} catch {
		return null;
	}
};
const dir = () => (P.confPath ? path.dirname(P.confPath) : ".");
const offsetFile = () => path.join(dir(), "telegram_offset.json");
const legacyOffsetFile = () => path.join(dir(), "notify_offset.json"); // 옛 확장/notify.py 의 오프셋 → 첫 회 시드만
const claimFile = () => path.join(dir(), "telegram.claim.json");

function log(msg: string) {
	try {
		fs.appendFileSync(path.join(dir(), "telegram_poll.log"), `${new Date().toISOString()} inst ${P.ownerInst} pid ${process.pid} ${msg}\n`);
	} catch {}
}

const loadOffset = () => {
	for (const f of [offsetFile(), legacyOffsetFile()]) {
		const j = readJson(f);
		if (j && typeof j.offset === "number") return j.offset;
	}
	return 0;
};
// 저장 직전 파일 값과 max 를 취한다 → 되감기 금지.
function saveOffset() {
	try {
		const onDisk = loadOffset();
		if (onDisk > P.offset) P.offset = onDisk;
		fs.writeFileSync(offsetFile(), JSON.stringify({ offset: P.offset }));
	} catch {}
}

// ── 소유권: 툴콜 = 무조건 훔치기. 옛 poller 는 매 틱의 claim 확인으로 스스로 죽는다.
function stealClaim() {
	try {
		fs.writeFileSync(claimFile(), JSON.stringify({ inst: P.ownerInst, pid: process.pid, ts: Date.now() }));
	} catch {}
}
const claimMine = () => readJson(claimFile())?.inst === P.ownerInst;
function releaseClaim() {
	try {
		if (claimMine()) fs.unlinkSync(claimFile());
	} catch {}
}

// ── 발신 (pi → 폰) ──────────────────────────────────────────────────────────
// notify.py 의 TS 이식 (2026-10-23). shell 을 중간에서 없애면 실패 모드 7종이 줄어든다:
//   ① 따옴표/한글/`&` 깨짐 ② level 자리 누락 ③ level 오타의 조용한 강등 ④ dedup 무음(rc 0)
//   ⑤ 캡션 조용히 폐기 ⑥ telegram.json 못 찾음 ⑦ python 런처(python vs py)
// ①②⑥⑦ 은 파라미터 타입과 절대 경로 해석으로 원천 소멸, ③④⑤ 는 **결과 문자열에 명시**해서 없앤다.
// ★ 발신은 claim/offset 을 건드리지 않는다. 연결되지 않은 세션도 발신만은 할 수 있다.
const ICON: Record<string, string> = { milestone: "✅", bench: "📊", fail: "⚠️", abort: "⛔", info: "", ok: "👌" };
const LEVELS = Object.keys(ICON) as ("milestone" | "bench" | "fail" | "abort" | "info" | "ok")[];
const DEDUP_S = 60; // notify.py 와 같은 창·같은 키(본문 문자열)·같은 파일 → 두 구현이 서로의 dedup 을 본다
const STATE_TTL_S = 3600;
const PHOTO_MAX = 10 * 1024 * 1024; // sendPhoto 한도. 넘기면 sendDocument 로 내린다(그쪽엔 캡션이 없다).
const DOC_MAX = 50 * 1024 * 1024; // Bot API 파일 한도
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
const stateFile = () => path.join(dir(), "notify_state.json");

// 연결 없이도 발신한다: conf 경로는 여기서 처음 확정한다 (dir() = 상태 파일 폴더).
function ensureConf(): any | null {
	if (!P.confPath) P.confPath = findConf();
	if (!P.confPath) return null;
	const j = readJson(P.confPath);
	return j?.token ? j : null;
}

const apiErr = (r: any) => `${r?.error_code ?? "?"} ${r?.description ?? ""}`.trim();
const kb = (n: number) => `${(n / 1024).toFixed(0)}KB`;
const mb = (n: number) => `${(n / 1048576).toFixed(1)}MB`;

// sendMessage 본문. 실패해도 던지지 않고 {ok, detail} 로 돌려준다(통보 실패로 세션을 죽이지 않는다).
async function tgSendText(conf: any, text: string): Promise<{ ok: boolean; id?: number; detail: string }> {
	let r: any;
	try {
		const resp = await fetch(`https://api.telegram.org/bot${conf.token}/sendMessage`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chat_id: conf.chat_id, text, disable_web_page_preview: true }),
			signal: AbortSignal.timeout(25000),
		});
		r = await resp.json();
	} catch (e: any) {
		return { ok: false, detail: `fetch ${String(e?.message || e)}` };
	}
	if (!r?.ok) return { ok: false, detail: apiErr(r) };
	return { ok: true, id: r.result?.message_id, detail: `message_id ${r.result?.message_id}` };
}

// 생존신고는 폰으로 (봇 토큰은 이미 가지고 있다). 실패해도 조용히 무시(통보 실패로 poll은 죽이지 않는다).
async function notifyPhone(conf: any, text: string) {
	try {
		await tgSendText(conf, text);
	} catch {}
}

function mimeOf(name: string): string {
	const e = path.extname(name).toLowerCase();
	const m: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
	return m[e] || "application/octet-stream";
}

// 첨부: 이미지는 sendPhoto(캡션 지원), 그 외는 sendDocument.
// 함정(실측): sendDocument 에 caption 을 넣으면 400. chat_id 는 multipart 필드로 필수(없으면 400 "chat_id is empty").
async function tgSendFile(
	conf: any,
	file: string,
	caption: string | null,
): Promise<{ ok: boolean; id?: number; method?: string; bytes?: number; detail: string }> {
	let size = -1;
	try {
		size = fs.statSync(file).size;
	} catch {
		return { ok: false, detail: `no such file: ${file}` };
	}
	const name = path.basename(file);
	const photo = IMAGE_EXT.test(name) && size <= PHOTO_MAX;
	if (size > DOC_MAX) return { ok: false, detail: `${name} is ${mb(size)} — over the 50MB Bot API limit` };
	const method = photo ? "sendPhoto" : "sendDocument";
	const field = photo ? "photo" : "document";
	const B = `----pi-tg-${randomUUID().slice(0, 8)}`;
	const fd = (k: string, v: string) => Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, "utf-8");
	const parts: Buffer[] = [fd("chat_id", String(conf.chat_id))]; // ← 필수로 넣어야 한다(위 함정)
	if (photo && caption) parts.push(fd("caption", caption));
	parts.push(
		Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${field}"; filename="${name}"\r\nContent-Type: ${mimeOf(name)}\r\n\r\n`, "utf-8"),
	);
	parts.push(fs.readFileSync(file));
	parts.push(Buffer.from(`\r\n--${B}--\r\n`, "utf-8"));
	let r: any;
	try {
		const resp = await fetch(`https://api.telegram.org/bot${conf.token}/${method}`, {
			method: "POST",
			headers: { "Content-Type": `multipart/form-data; boundary=${B}` },
			body: Buffer.concat(parts),
			signal: AbortSignal.timeout(120000),
		});
		r = await resp.json();
	} catch (e: any) {
		return { ok: false, detail: `fetch ${String(e?.message || e)}` };
	}
	if (!r?.ok) return { ok: false, detail: apiErr(r) };
	return { ok: true, id: r.result?.message_id, method, bytes: size, detail: `${method} ${name} (${kb(size)}) message_id ${r.result?.message_id}` };
}

// 본문 문자열은 notify.py 와 **바이트 단위로 동일**해야 dedup 이 서로 통한다.
// info 는 접두사를 붙이지 않는다 — LLM 이 쓴 문자 그대로 나간다 (2026-10-23 user 결정).
const bodyText = (level: string, msg: string) => (level === "info" ? msg : `${ICON[level]} [${level}] ${msg}`);

// 60초 안 같은 문장은 생략(spam 방지). fail/abort 는 항상 보낸다. 스킨 때는 **반드시 알린다**(④ 제거).
function dedup(text: string, level: string, force?: boolean): { skip: boolean; ageS?: number } {
	const now = Date.now() / 1000;
	let seen: Record<string, number> = {};
	try {
		const j = JSON.parse(fs.readFileSync(stateFile(), "utf-8"));
		if (j && typeof j === "object") seen = j;
	} catch {}
	const prev = Number(seen[text] || 0);
	if (!force && level !== "fail" && level !== "abort" && now - prev < DEDUP_S) return { skip: true, ageS: Math.round(now - prev) };
	seen[text] = now;
	for (const k of Object.keys(seen)) if (now - Number(seen[k] || 0) > STATE_TTL_S) delete seen[k];
	try {
		fs.writeFileSync(stateFile(), JSON.stringify(seen));
	} catch {}
	return { skip: false };
}

// level 을 빠뜨리거나 오타내면 여기서 고쳐준다 — 스키마가 통째로 거부되면 에이전트가 한 턱을 더 쓴다.
// 알려지지 않은 키는 버린다(없는 인자를 지어내는 실수도 여기서 막힌다). ②③ 제거.
function fixNotifyArgs(raw: unknown) {
	const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const s = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : undefined);
	const a: Record<string, unknown> = {};
	const msg = s(src.message);
	const file = s(src.file);
	const note = s(src.note);
	let level = s(src.level);
	if (level !== undefined && !(level in ICON)) {
		// level 자리로 메시지 한 줄만 들어온 경우 (notify.py 의 구조 구제와 동일) + 오타는 info 로 강등.
		if (msg === undefined && file === undefined) a.message = level;
		level = "info";
	}
	if (msg !== undefined) a.message = msg;
	if (file !== undefined) a.file = file;
	if (note !== undefined) a.note = note;
	if (level !== undefined) a.level = level;
	if (src.force !== undefined) a.force = !!src.force;
	return a;
}

const errResult = (text: string) => ({ content: [{ type: "text" as const, text }], details: { error: text }, isError: true });

async function tickOnce(self: Owner) {
	const conf = readJson(P.confPath || "");
	if (!conf?.token || conf.chat_id === undefined) return;
	let res: any;
	try {
		const r = await fetch(`https://api.telegram.org/bot${conf.token}/getUpdates`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ offset: P.offset + 1, timeout: 0 }),
		});
		res = await r.json();
	} catch (e: any) {
		log(`FETCH-ERR ${String(e?.message || e)}`);
		return;
	}
	if (!res?.ok) {
		const d = String(res?.description || "");
		if (d.includes("Conflict")) {
			// 다른 poller 가 아직 살아있던 틱과 겹쳤다는 뜻. 15초 쉬면 그쪽이 claim 상실로 죽는다.
			P.conflictUntil = Date.now() + 15000;
			log("CONFLICT 409 → backing off 15s");
		} else {
			log(`API-ERR ${d}`);
		}
		return;
	}
	if (!P.okOnce) {
		P.okOnce = true;
		try {
			if (self.ctx?.hasUI) self.ctx.ui.notify(`telegram: poll ok (inst ${P.ownerInst})`, "info");
		} catch {}
	}
	for (const u of res.result || []) {
		P.offset = Math.max(P.offset, Number(u.update_id) || P.offset);
		const m = u.message || u.channel_post;
		if (!m) continue;
		if (m.chat?.id !== conf.chat_id) continue; // 주인 것만
		const text = (m.text || m.caption || "").trim();
		if (!text) continue;
		// 4초 초과 = 이 pi가 연결돼 있지 않을 때 온 문자. 주입 대신 폐기 통보로 알린다.
		const age = Date.now() - (m.date || 0) * 1000;
		if (age > 4000) {
			log(`DISCARD update ${u.update_id} age ${Math.round(age / 1000)}s "${text.slice(0, 40)}"`);
			continue; // 폐기는 조용히 (log만). 알림은 수신 성공 때만 보낸다.
		}
		const who = m.from?.first_name || m.from?.username || "phone";
		const stamp = new Date((m.date || 0) * 1000).toLocaleTimeString("en-GB"); // 24h 고정 — 로케일 AM/PM 이 주입 문자에 섞이면 안 된다
		try {
			await self.pi.sendUserMessage(`[telegram ${stamp} ${who}] ${text}`, { deliverAs: "steer" });
			P.injected++;
			P.lastInject = Date.now();
			log(`INJECT ok update ${u.update_id} "${text.slice(0, 40)}"`);
			await notifyPhone(conf, `${text.slice(0, 5)}… received`); // steer로 들어간 그 순간 즉시
			try {
				if (self.ctx?.hasUI) self.ctx.ui.notify(`← phone: ${text.slice(0, 60)}`, "info");
			} catch {}
		} catch (e: any) {
			const msg = String(e?.message || e);
			// stale = 이 주입 대상 세션이 죽었다(agent-session.js invalidate).
			// owner 가 그 사이에 교체됐다면 옛 세션에 쫓아가 실패한 것뿐 → 다음 틱의 새 owner 를 쓴다.
			if (!msg.includes("stale")) {
				log(`INJECT-ERR ${msg}`);
				continue;
			}
			if (P.owner && P.owner.pi !== self.pi) {
				log("stale but owner replaced → keep polling");
				continue;
			}
			log("stale owner (no replacement) → loop exit, claim released");
			P.stop = true;
			releaseClaim();
			return;
		}
	}
	saveOffset();
}

// owner를 파라미터로 받지 않는다 — 매 틱 P.owner 를 읽는다.
// 매 틱 claim 을 확인한다: 남이 훔쳤으면(= 다른 세션이 telegram_connect 를 불렀으면) 나는 exit 한다.
async function runLoop(gen: number) {
	const ms = Number(process.env.ITP_TG_MS || 2000);
	await sleep(Math.floor(Math.random() * 800));
	while (P.gen === gen && !P.stop) {
		try {
			if (!claimMine()) {
				log("claim lost (another session connected) → loop exit");
				P.stop = true;
				break;
			}
			stealClaim(); // 하트비트: 내가 poll 중임을 갱신 (notify.py 의 8초 가드가 이 ts 를 본다)
			const self = P.owner;
			if (self && Date.now() >= P.conflictUntil) await tickOnce(self);
		} catch (e: any) {
			log(`LOOP-ERR ${String(e?.message || e)}`);
		}
		if (P.gen !== gen || P.stop) break;
		await sleep(ms);
	}
	log(`loop exit gen ${gen}`);
}

// 이 세션을 연결한다: owner 교체(같은 프로세스) + claim 무조건 훔치기(다른 프로세스 죽이기).
function connect(self: Owner, inst: string) {
	if (!P.confPath) P.confPath = findConf();
	if (!P.confPath) return false;
	P.owner = self;
	P.ownerInst = inst;
	P.okOnce = false;
	stealClaim();
	if (P.offset < 0) P.offset = loadOffset();
	if (loopAlive()) {
		log(`takeover (loop gen ${P.gen})`);
	} else {
		P.stop = false;
		P.gen++;
		void runLoop(P.gen);
	}
	log(`connected offset ${P.offset}`);
	return true;
}

const statusLine = () =>
	`telegram ${loopAlive() ? "connected" : "not connected"} · inst ${P.ownerInst} / pid ${process.pid} · offset ${P.offset} · injected ${P.injected} (last ${P.lastInject ? Math.round((Date.now() - P.lastInject) / 1000) + "s ago" : "none"}) · conf ${P.confPath || "(none)"}`;

export default function (pi: ExtensionAPI) {
	// 팩토리(= 세션 런타임)마다 하나. 상태는 P 에 있고, 연결된 세션만 owner 가 된다.
	const INSTANCE = randomUUID().slice(0, 8);

	pi.registerTool({
		name: "telegram_connect",
		label: "Telegram connect",
		description:
			"Connects this session to the user's Telegram (no parameters). Calling it releases every other Telegram connection (other sessions and processes); only this session then receives phone messages prefixed with [telegram …]. If already connected it just re-confirms.",
		promptSnippet: "telegram_connect — connect this session to Telegram (phone→PC inbound)",
		parameters: Type.Object({}),
		execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
			const ok = connect({ pi, ctx }, INSTANCE);
			const text = ok ? statusLine() : "telegram config file (telegram.json) not found";
			return { content: [{ type: "text", text }], details: { connected: ok, status: text } };
		},
	});

	pi.registerTool({
		name: "telegram_notify",
		label: "Telegram notify",
		description:
			"Send a sentence and/or a file from pi to the user's phone over Telegram. Works whether or not this session is connected (sending never touches the poller). level picks the icon/prefix; level info sends the text exactly as written, with no prefix. fail and abort always send, the other levels are skipped when the identical sentence was sent within 60s (pass force to override) — a skip is always reported, never silent. Attachments: png/jpg/webp/gif go as photos and note (or message) becomes the caption; any other file goes as a document, which has no caption, so its text is sent as a separate message. The result states exactly what went out.",
		promptSnippet: "telegram_notify — send progress notes and files to the user's phone (pi→Telegram outbound)",
		promptGuidelines: ["Anything that must reach the user's phone goes through telegram_notify, never through a shell call to notify.py."],
		parameters: Type.Object({
			level: Type.Optional(
				Type.Union(LEVELS.map((l) => Type.Literal(l)), {
					description: "milestone | bench | fail | abort | info | ok (default info). fail/abort bypass the 60s duplicate guard.",
				}),
			),
			message: Type.Optional(Type.String({ description: "one sentence of body text (English recommended)" })),
			file: Type.Optional(Type.String({ description: "path of a file to attach (absolute path is safest)" })),
			note: Type.Optional(Type.String({ description: "caption for an image attachment; for other files it becomes the message body" })),
			force: Type.Optional(Type.Boolean({ description: "send even if the identical sentence went out within 60s" })),
		}),
		prepareArguments: fixNotifyArgs,
		execute: async (_toolCallId, args, _signal, _onUpdate, ctx) => {
			const conf = ensureConf();
			if (!conf) return errResult(`telegram.json not found — looked at: ${CANDIDATES.join(" | ")}`);
			if (conf.chat_id === undefined || conf.chat_id === null)
				return errResult(`chat_id is missing in ${P.confPath} — send any message to the bot, then run: python notify.py --discover`);

			const level = (args.level as string) || "info";
			const msg = (args.message || "").trim();
			const file = (args.file || "").trim();
			const note = (args.note || "").trim();
			if (!msg && !file && !note) return errResult("nothing to send — give message and/or file");

			const out: string[] = [];
			// details 는 모델에게 안 가지만 세션 기록/HTML export 에 남는다 → chat_id 는 넣지 않는다 (message_id 로 충분).
			const det: any = { level };
			let failed = false;

			// 첨부 먼저 보낸다(첨부가 죽으면 본문도 보내지 않고 알려준다 — 반쪽 성공의 조용한 성공 금지).
			// 이미지가 아니면 캡션 자리가 없으므로 본문을 **별도 메시지로** 보낸다(⑤ 제거).
			let body: string | null = msg || null;
			if (file) {
				const isImg = IMAGE_EXT.test(path.basename(file));
				const caption = isImg ? note || msg || null : null;
				const r = await tgSendFile(conf, file, caption);
				if (!r.ok) {
					log(`SEND-ERR file ${file} — ${r.detail}`);
					return errResult(`attach failed — ${r.detail}`);
				}
				det.attach = { file, method: r.method, bytes: r.bytes, message_id: r.id, caption: caption || null };
				out.push(`attached ${r.detail}${caption ? ` (caption: "${caption.slice(0, 40)}")` : ""}`);
				if (isImg) body = note && msg ? msg : null; // 캡션은 note 가 먹었다. message 도 따로 있으면 본문으로 보낸다.
				else {
					body = msg || note || null;
					if (note) out.push("sendDocument has no caption — the note went as a separate message below");
				}
			}

			if (body) {
				const text = bodyText(level, body);
				const d = dedup(text, level, args.force);
				if (d.skip) {
					det.deduped = true;
					out.push(`text NOT sent — the identical sentence went out ${d.ageS}s ago (60s guard). pass force:true to send it again`);
				} else {
					const r = await tgSendText(conf, text);
					if (!r.ok) {
						failed = true;
						log(`SEND-ERR [${level}] ${r.detail}`);
						out.push(`text NOT sent — sendMessage failed: ${r.detail}`);
					} else {
						det.text_message_id = r.id;
						out.push(`sent [${level}] "${body}" → ${r.detail}`);
						log(`SEND ok [${level}] "${body.slice(0, 60)}"`);
					}
				}
			}
			if (det.deduped) log(`SEND dedup [${level}] "${(body || "").slice(0, 60)}"`);

			const text = out.join("\n");
			try {
				if (ctx?.hasUI) ctx.ui.notify(det.attach ? `→ phone: ${det.attach.method}` : `→ phone: [${level}]`, failed ? "error" : "info");
			} catch {}
			return { content: [{ type: "text" as const, text }], details: det, isError: failed || undefined };
		},
	});

	pi.on("session_shutdown", async () => {
		// 내 연결이면 반납하고 루프를 세운다. 재연결 마법은 없다 — 돌아와서 툴을 다시 부르면 된다.
		if (claimMine()) {
			releaseClaim();
			P.stop = true;
			P.gen++; // 잠들어 있던 루프도 깨서 빠져나오게 한다
			log("session_shutdown → claim released, loop stopped");
		}
	});
}
