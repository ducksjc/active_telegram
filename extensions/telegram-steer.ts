/**
 * telegram-steer.ts — 텔레그램 연결은 **툴콜로만** 켠다 (2026-10-21 새 규정).
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

// 생존신고는 폰으로 (봇 토큰은 이미 가지고 있다). 실패해도 조용히 무시(통보 실패로 poll은 죽이지 않는다).
async function notifyPhone(conf: any, text: string) {
	try {
		await fetch(`https://api.telegram.org/bot${conf.token}/sendMessage`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chat_id: conf.chat_id, text }),
		});
	} catch {}
}

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
