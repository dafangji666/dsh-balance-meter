/**
 * dsh-balance-meter — Host half.
 *
 * 只查询 **DeepSeek 官方 API**（api.deepseek.com）的账户余额：
 *   GET https://api.deepseek.com/user/balance
 * 其它提供方（LevelUp / TKEN 等）一律不查询、不显示。
 *
 * 官方只开放余额接口，没有用量接口，因此「用量」由本插件自己观测：
 * 每次成功读到余额就记一条样本，据此算出今日消耗 / 较上次变化 / 观测起于。
 * 两档预警阈值同样保存在宿主侧（storages/dsh-balance-meter.json），多浏览器一致：
 *   余额 < 红色阈值 → low 「要见底了」
 *   余额 < 黄色阈值 → warn「快充值吧」（黄）
 *   否则            → ok  「余额充足」
 * 恒定满足 红色阈值 ≤ 黄色阈值。
 *
 * 浏览器半侧通过同源路由读写：
 *   GET  /balance-meter/state      读取缓存的余额（含阈值、档位与用量）
 *   POST /balance-meter/refresh    强制刷新
 *   POST /balance-meter/threshold  修改两档阈值（body: {"low": 5, "warn": 10}）
 *
 * @module dsh-balance-meter
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 插件名（Cordis row name）。 */
export const name = 'dsh-balance-meter'

/** 依赖 Web 路由注册表；credentials 按需惰性获取。 */
export const inject = ['webServer']

/** DeepSeek 官方接口基址。 */
const OFFICIAL_BASE = 'https://api.deepseek.com'
/** 官方余额端点。 */
const BALANCE_PATH = '/user/balance'
/** 凭据引用名（位于 ~/.dsh/.credentials.yaml 的 refs）。 */
const CREDENTIAL_REF = 'DEEPSEEK_API_KEY'
/** 默认阈值（人民币元）：低于 warn 变黄，低于 low 变红；用户可在卡片里改。 */
const DEFAULT_WARN_THRESHOLD = 10
const DEFAULT_LOW_THRESHOLD = 5
/** 路由前缀。 */
const ROUTE_PREFIX = '/balance-meter'
/** 成功结果的内存缓存时长：短时间内多次读取不重复打官方接口。 */
const CACHE_MS = 15_000
/** 最多保留多少条余额样本（5 分钟一条 ≈ 2.5 天）。 */
const MAX_SAMPLES = 720
/** 阈值允许范围。 */
const MIN_THRESHOLD = 0
const MAX_THRESHOLD = 1_000_000

/**
 * 由余额与两档阈值求档位。
 * @param total - 当前余额。
 * @param warn - 黄色阈值（余额低于它 → warn）。
 * @param low - 红色阈值（余额低于它 → low）。
 * @returns {'ok'|'warn'|'low'}
 */
function levelOf(total, warn, low) {
	if (!Number.isFinite(total)) return 'ok'
	if (total < low) return 'low'
	if (total < warn) return 'warn'
	return 'ok'
}
/** 宿主持久化文件。 */
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const STATE_PATH = join(DSH_HOME, 'storages', 'dsh-balance-meter.json')

/** 写一个 JSON 响应。 */
function sendJson(res, status, payload) {
	const body = JSON.stringify(payload)
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'content-length': Buffer.byteLength(body)
	})
	res.end(body)
}

/** 本地日期键（YYYY-MM-DD），用于按天统计消耗。 */
function dateKey(ms) {
	const d = new Date(ms)
	const pad = (n) => String(n).padStart(2, '0')
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 读取并解析请求体（上限 8KB）。 */
async function readJsonBody(req) {
	const chunks = []
	let size = 0
	for await (const chunk of req) {
		size += chunk.length
		if (size > 8_192) return void 0
		chunks.push(chunk)
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8'))
	} catch {
		return void 0
	}
}

/** 把官方响应折成前端要用的形状；无法解析时返回 undefined。 */
function parseBalance(json) {
	const infos = Array.isArray(json?.balance_infos) ? json.balance_infos : []
	const info = infos.find((entry) => String(entry?.currency).toUpperCase() === 'CNY') ?? infos[0]
	if (info === undefined) return void 0
	const total = Number.parseFloat(info.total_balance)
	if (!Number.isFinite(total)) return void 0
	return {
		currency: String(info.currency ?? 'CNY').toUpperCase(),
		total,
		granted: Number.parseFloat(info.granted_balance) || 0,
		toppedUp: Number.parseFloat(info.topped_up_balance) || 0,
		available: json?.is_available !== false
	}
}

/**
 * Mount the balance routes.
 * @param ctx - host plugin context carrying webServer.
 */
export function apply(ctx) {
	/** 最近一次成功读取（含时间戳），避免频繁打官方接口。 */
	let cache = { at: 0, data: void 0 }
	/** 串行化刷新，避免并发重复请求。 */
	let inflight
	/** 持久化状态：两档阈值 + 余额样本 + 当天基准。 */
	let state = { warn: DEFAULT_WARN_THRESHOLD, low: DEFAULT_LOW_THRESHOLD, samples: [], anchor: void 0 }
	/** 串行化落盘。 */
	let writes = Promise.resolve()

	/** 落盘（原子替换）；失败只告警，不影响读取。 */
	function persist() {
		const snapshot = JSON.stringify(state)
		writes = writes
			.then(async () => {
				await mkdir(dirname(STATE_PATH), { recursive: true })
				const tmp = `${STATE_PATH}.tmp`
				await writeFile(tmp, snapshot, 'utf8')
				await rename(tmp, STATE_PATH)
			})
			.catch((error) => {
				ctx.logger?.warn?.(error)
			})
		return writes
	}

	/** 启动时载入历史状态。 */
	const ready = (async () => {
		try {
			const parsed = JSON.parse(await readFile(STATE_PATH, 'utf8'))
			const inRange = (v) => Number.isFinite(v) && v >= MIN_THRESHOLD && v <= MAX_THRESHOLD
			// 旧格式只有一个 threshold：把它当作红色阈值，黄色阈值取两倍（至少为红色）。
			const legacy = Number(parsed?.threshold)
			let warn = Number(parsed?.warn)
			let low = Number(parsed?.low)
			if (!inRange(warn) && inRange(legacy)) warn = legacy * 2
			if (!inRange(low) && inRange(legacy)) low = legacy
			if (inRange(warn)) state.warn = warn
			if (inRange(low)) state.low = low
			// 恒定满足 low ≤ warn，避免出现「红色阈值高于黄色阈值」的倒置。
			if (state.low > state.warn) state.warn = state.low
			if (Array.isArray(parsed?.samples)) {
				state.samples = parsed.samples
					.filter((s) => Number.isFinite(Number(s?.at)) && Number.isFinite(Number(s?.total)))
					.map((s) => ({ at: Number(s.at), total: Number(s.total) }))
					.slice(-MAX_SAMPLES)
			}
			if (Number.isFinite(Number(parsed?.anchor?.total)) && typeof parsed?.anchor?.date === 'string') {
				state.anchor = { date: parsed.anchor.date, total: Number(parsed.anchor.total) }
			}
		} catch {
			// 首次运行或文件损坏：用默认值继续。
		}
	})()

	/** 记录一条余额样本，并维护「当天基准」。 */
	function recordSample(balance) {
		const at = Date.now()
		if (state.anchor === void 0 || state.anchor.date !== dateKey(at)) {
			state.anchor = { date: dateKey(at), total: balance.total }
		}
		state.samples.push({ at, total: balance.total })
		if (state.samples.length > MAX_SAMPLES) {
			state.samples.splice(0, state.samples.length - MAX_SAMPLES)
		}
	}

	/** 由余额样本推导出的用量信息。 */
	function usage() {
		const samples = state.samples
		if (samples.length === 0) return void 0
		const last = samples[samples.length - 1]
		const previous = samples.length > 1 ? samples[samples.length - 2] : void 0
		const anchor = state.anchor
		const spentToday = anchor === void 0 ? void 0 : anchor.total - last.total
		return {
			spentToday,
			/** 余额比当天基准还高 → 期间充过值。 */
			recharged: anchor !== void 0 && last.total > anchor.total,
			delta: previous === void 0 ? void 0 : last.total - previous.total,
			lastAt: last.at,
			sinceAt: samples[0].at,
			samples: samples.length
		}
	}

	/** 在（可能来自缓存的）余额结果上叠加两档阈值、档位与用量。 */
	function decorate(result) {
		const { warn, low } = state
		const usageInfo = usage()
		// 阈值放在 thresholds 下，避免与旧版布尔字段 low 同名冲突。
		const thresholds = { warn, low }
		if (result.ok !== true) return { ...result, thresholds, level: 'low', usage: usageInfo }
		return {
			...result,
			thresholds,
			level: levelOf(result.total, warn, low),
			usage: usageInfo
		}
	}

	/**
	 * 读取官方余额。
	 * @param force - true 时跳过缓存。
	 * @returns 前端可直接消费的结果对象。
	 */
	async function readBalance(force) {
		await ready
		const now = Date.now()
		if (!force && cache.data !== void 0 && now - cache.at < CACHE_MS) {
			return { ok: true, cached: true, ...cache.data }
		}
		if (inflight !== void 0) return inflight

		inflight = (async () => {
			let apiKey
			try {
				const resolved = await ctx.get('credentials')?.resolve(CREDENTIAL_REF)
				apiKey = resolved?.value
			} catch (error) {
				ctx.logger?.warn?.(error)
			}
			if (typeof apiKey !== 'string' || apiKey === '') {
				return {
					ok: false,
					code: 'no-credential',
					error: `未配置 ${CREDENTIAL_REF}，无法查询 DeepSeek 官方余额`
				}
			}

			let response
			try {
				response = await fetch(`${OFFICIAL_BASE}${BALANCE_PATH}`, {
					headers: {
						authorization: `Bearer ${apiKey}`,
						accept: 'application/json'
					},
					signal: AbortSignal.timeout(15_000)
				})
			} catch (error) {
				return {
					ok: false,
					code: 'network',
					error: `连接 DeepSeek 官方接口失败：${error instanceof Error ? error.message : String(error)}`
				}
			}

			const text = await response.text()
			let json
			try {
				json = JSON.parse(text)
			} catch {
				json = void 0
			}
			if (!response.ok) {
				return {
					ok: false,
					code: 'http',
					status: response.status,
					error: json?.error?.message ?? `DeepSeek 官方接口返回 HTTP ${response.status}`
				}
			}
			const balance = parseBalance(json)
			if (balance === void 0) {
				return { ok: false, code: 'shape', error: '无法解析 DeepSeek 官方余额响应' }
			}

			recordSample(balance)
			const data = { ...balance, at: Date.now() }
			cache = { at: data.at, data }
			await persist()
			return { ok: true, cached: false, ...data }
		})()

		try {
			return await inflight
		} finally {
			inflight = void 0
		}
	}

	ctx.effect(() => ctx.webServer.register({
		kind: 'prefix',
		path: ROUTE_PREFIX,
		handler: async (req, res) => {
			const url = new URL(req.url ?? '/', 'http://dsh.internal')
			const action = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+|\/+$/g, '')
			if (action === 'state' && (req.method === 'GET' || req.method === 'HEAD')) {
				sendJson(res, 200, decorate(await readBalance(false)))
				return
			}
			if (action === 'refresh' && req.method === 'POST') {
				sendJson(res, 200, decorate(await readBalance(true)))
				return
			}
			if (action === 'threshold' && req.method === 'POST') {
				const body = await readJsonBody(req)
				const inRange = (v) => Number.isFinite(v) && v >= MIN_THRESHOLD && v <= MAX_THRESHOLD
				// 兼容旧客户端：只传 threshold 时视为红色阈值，黄色阈值取两倍。
				const legacy = Number(body?.threshold)
				let warn = Number(body?.warn)
				let low = Number(body?.low)
				if (!inRange(warn) && inRange(legacy)) warn = legacy * 2
				if (!inRange(low) && inRange(legacy)) low = legacy
				if (!inRange(warn) || !inRange(low)) {
					sendJson(res, 400, { ok: false, error: '阈值必须是 0 ~ 1000000 之间的数字' })
					return
				}
				// 归一化为 红色阈值 ≤ 黄色阈值 且保留两位小数。
				const round2 = (v) => Math.round(v * 100) / 100
				const lowValue = round2(low)
				const warnValue = round2(Math.max(warn, low))
				state.low = lowValue
				state.warn = warnValue
				await persist()
				sendJson(res, 200, decorate(await readBalance(false)))
				return
			}
			sendJson(res, 404, { ok: false, error: `unknown balance-meter route: ${action}` })
		}
	}), 'dsh-balance-meter: /balance-meter routes')
}

