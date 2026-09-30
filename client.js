/**
 * dsh-balance-meter — browser half.
 *
 * 在输入框下方的状态行（conversation.composer.dock）常驻一个余额指示器：
 *   ● ¥ 46.15 ⟳
 *
 * - 圆点按三档变色：充足绿 / 快充值吧黄 / 要见底了红；加载中灰、出错红。
 *   档位由宿主下发（`level`），阈值也由宿主持久化。
 * - 点击金额：弹出详情卡片（余额构成、两档阈值设置、去充值）。
 * - 点击刷新图标：实时调用同源 /balance-meter/refresh。
 * - 每 5 分钟自动同步一次（服务端另有 15 秒缓存）。
 *
 * 只显示 **DeepSeek 官方 API** 的余额；其它提供方不查询也不展示。
 *
 * 该行是 flex 容器（gap 12px），且 dock 插槽的包装元素是 display:contents，
 * 因此本组件用 CSS order 把自身排到该行最后（即「上下文已用」之后）。
 */
window.__ModuleLoader__.load({
	id: "dsh-balance-meter",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const reactDom = require("react-dom");
		const { useCallback, useEffect, useRef, useState } = react;

		/** 阈值兜底值（元）；真实阈值由宿主持久化并通过接口回传。 */
		const FALLBACK_WARN = 10;
		const FALLBACK_LOW = 5;
		/** 自动同步间隔（毫秒）；服务端另有 15 秒缓存。 */
		const POLL_MS = 300_000;
		/** DeepSeek 开放平台充值入口。 */
		const TOPUP_URL = "https://platform.deepseek.com/top_up";
		/** 两档阈值输入框 id。 */
		const WARN_INPUT_ID = "bm-warn-input";
		const LOW_INPUT_ID = "bm-low-input";

		/** 档位文案。 */
		const LEVEL_TEXT = { ok: "余额充足", warn: "快充值吧", low: "要见底了" };
		/** 档位 → 用的 CSS 修饰类后缀。 */
		const LEVEL_CLASS = { ok: "ok", warn: "warn", low: "low" };

		const CSS = `
.bm-root{box-sizing:border-box;min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:inline-flex;order:9999}
.bm-trigger{box-sizing:border-box;corner-shape:round;max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;border-radius:999px;align-items:center;gap:4px;padding:1px 8px;display:inline-flex;cursor:pointer}
.bm-trigger:hover,.bm-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.bm-trigger:disabled{cursor:default}
.bm-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary);box-shadow:none;animation:none}
.bm-dot.ok{background:var(--dsw-alias-state-success-primary);animation:bm-pulse 2.4s ease-in-out infinite}
.bm-dot.warn{background:var(--dsw-alias-state-warn-primary);animation:bm-pulse 1.8s ease-in-out infinite}
.bm-dot.low{background:var(--dsw-alias-state-error-primary);animation:bm-pulse 1.2s ease-in-out infinite}
.bm-dot.loading{background:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-tertiary));animation:bm-pulse 1.4s ease-in-out infinite}
@keyframes bm-pulse{0%,100%{opacity:1}50%{opacity:.45}}
.bm-amount{font-variant-numeric:tabular-nums}
.bm-amount.warn{color:var(--dsw-alias-state-warn-primary)}
.bm-amount.low{color:var(--dsw-alias-state-error-primary)}
.bm-iconHost{flex:none;align-self:center;display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;line-height:0;color:inherit;opacity:.75;border-radius:4px}
.bm-iconHost:hover{opacity:1}
.bm-iconHost:focus-visible{outline:2px solid var(--dsw-alias-border-l3,currentColor);outline-offset:1px}
.bm-refresh{display:block;width:14px;height:14px;flex:none}
.bm-refresh.spin{animation:bm-spin .9s linear infinite}
@keyframes bm-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
.bm-panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);width:max-content;min-width:min(296px,100vw - 24px);max-width:min(440px,100vw - 24px);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:16px;font-size:12px;line-height:18px;position:fixed}
.bm-head{display:flex;align-items:baseline;justify-content:space-between;gap:16px;color:var(--dsw-alias-label-primary);font-weight:500}
.bm-headLabel{min-width:0}
.bm-hero{display:flex;align-items:baseline;gap:8px;margin-top:6px}
.bm-heroValue{color:var(--dsw-alias-label-primary);font-size:22px;line-height:28px;font-weight:600;font-variant-numeric:tabular-nums}
.bm-heroValue.warn{color:var(--dsw-alias-state-warn-primary)}
.bm-heroValue.low{color:var(--dsw-alias-state-error-primary)}
.bm-heroTag{color:var(--dsw-alias-label-tertiary)}
.bm-status{flex:none;font-variant-numeric:tabular-nums}
.bm-status.ok{color:var(--dsw-alias-state-success-primary)}
.bm-status.warn{color:var(--dsw-alias-state-warn-primary)}
.bm-status.low{color:var(--dsw-alias-state-error-primary)}
.bm-compose{margin-top:2px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.bm-rule{border-top:.5px solid var(--dsw-alias-border-l2);margin:10px 0}
.bm-field{margin-top:12px}
.bm-fieldRow{display:flex;align-items:center;gap:8px;margin-top:6px}
.bm-fieldLabel{color:var(--dsw-alias-label-tertiary);display:block}
.bm-tierLabel{color:var(--dsw-alias-label-tertiary);flex:none;min-width:52px}
.bm-tierLabel.warn{color:var(--dsw-alias-state-warn-primary)}
.bm-tierLabel.low{color:var(--dsw-alias-state-error-primary)}
.bm-input{box-sizing:border-box;flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base,transparent);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,6px);padding:4px 8px;font:inherit;font-variant-numeric:tabular-nums}
.bm-input:focus-visible{outline:none;border-color:var(--dsw-alias-border-l3)}
.bm-actions{display:flex;gap:8px;margin-top:14px}
.bm-btn{box-sizing:border-box;flex:none;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);border:1px solid transparent;border-radius:var(--dsw-radius-md,6px);padding:5px 12px;font:inherit;font-weight:500;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.bm-btn:hover{color:var(--dsw-alias-label-primary)}
.bm-btn:disabled{opacity:.55;cursor:default}
.bm-btn.primary{flex:1 1 auto;color:var(--dsw-alias-label-primary-contrast,#fff);background:var(--dsw-alias-brand-primary,#4d6bfe)}
.bm-btn.primary:hover{color:var(--dsw-alias-label-primary-contrast,#fff);filter:brightness(1.06)}
.bm-note{margin-top:10px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.bm-hint{margin-top:10px;color:var(--dsw-alias-label-tertiary)}
`;

		if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="dsh-balance-meter"]') === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-balance-meter";
			tag.dataset.pluginCss = "dsh-balance-meter";
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/** 保留两位小数的金额文本。 */
		function formatMoney(value, currency) {
			const symbol = currency === "USD" ? "$" : "¥";
			const n = Number.isFinite(value) ? value : 0;
			return symbol + " " + n.toFixed(2);
		}

		/** 本地时间。 */
		function formatTime(ms) {
			try {
				return new Date(ms).toLocaleString();
			} catch {
				return "—";
			}
		}

		/** 刷新图标（内联 SVG，避免依赖图标包）。 */
		function RefreshIcon({ spinning }) {
			return react.createElement(
				"svg",
				{
					viewBox: "0 0 16 16",
					width: 14,
					height: 14,
					className: "bm-refresh" + (spinning ? " spin" : ""),
					"aria-hidden": "true"
				},
				react.createElement("path", {
					fill: "currentColor",
					d: "M8 3.2c1.2 0 2.3.44 3.15 1.17l1.1-1.1c.3-.3.8-.09.8.33v3.1c0 .28-.22.5-.5.5h-3.1c-.42 0-.63-.5-.33-.8l1.03-1.03A3.6 3.6 0 0 0 8 4.4 3.6 3.6 0 0 0 4.4 8c0 1.99 1.61 3.6 3.6 3.6 1.42 0 2.64-.82 3.22-2.01.1-.2.34-.3.55-.2l.62.3c.2.1.29.34.19.55A4.9 4.9 0 0 1 8 12.9 4.9 4.9 0 0 1 3.1 8 4.9 4.9 0 0 1 8 3.2Z"
				})
			);
		}

		function BalanceMeter() {
			const [state, setState] = useState({ ok: false, loading: true });
			const [open, setOpen] = useState(false);
			const [busy, setBusy] = useState(false);
			const [saving, setSaving] = useState(false);
			const [draftWarn, setDraftWarn] = useState("");
			const [draftLow, setDraftLow] = useState("");
			const [pos, setPos] = useState(null);
			const rootRef = useRef(null);
			const triggerRef = useRef(null);
			const panelRef = useRef(null);

			const load = useCallback(async (force) => {
				if (force) setBusy(true);
				try {
					const response = await fetch(force ? "/balance-meter/refresh" : "/balance-meter/state", {
						method: force ? "POST" : "GET",
						credentials: "same-origin",
						headers: { accept: "application/json" }
					});
					const json = await response.json();
					setState({ loading: false, ...json });
				} catch (error) {
					setState({ ok: false, loading: false, error: String((error && error.message) || error) });
				} finally {
					if (force) setBusy(false);
				}
			}, []);

			useEffect(() => {
				void load(false);
			}, [load]);

			/** 每 5 分钟自动同步一次。 */
			useEffect(() => {
				const id = setInterval(() => void load(false), POLL_MS);
				return () => clearInterval(id);
			}, [load]);

			/** 打开卡片时把输入框同步成当前两档阈值。 */
			useEffect(() => {
				if (!open) return;
				const legacy = Number(state.threshold);
				const warn = state.thresholds?.warn !== void 0 ? Number(state.thresholds.warn) : legacy * 2;
				const low = state.thresholds?.low !== void 0 ? Number(state.thresholds.low) : legacy;
				setDraftWarn(String(Number.isFinite(warn) ? warn : FALLBACK_WARN));
				setDraftLow(String(Number.isFinite(low) ? low : FALLBACK_LOW));
			}, [open, state.thresholds?.warn, state.thresholds?.low, state.threshold]);

			/** 面板定位：显示在触发器上方。 */
			useEffect(() => {
				if (!open) return;
				const place = () => {
					const el = triggerRef.current;
					if (el === null) return;
					const r = el.getBoundingClientRect();
					setPos({ left: Math.max(12, r.left), bottom: Math.max(12, window.innerHeight - r.top + 8) });
				};
				place();
				window.addEventListener("resize", place);
				window.addEventListener("scroll", place, true);
				return () => {
					window.removeEventListener("resize", place);
					window.removeEventListener("scroll", place, true);
				};
			}, [open]);

			/** 点击外部关闭。 */
			useEffect(() => {
				if (!open) return;
				const onDown = (event) => {
					const t = event.target;
					if (rootRef.current !== null && rootRef.current.contains(t)) return;
					if (panelRef.current !== null && panelRef.current.contains(t)) return;
					setOpen(false);
				};
				document.addEventListener("mousedown", onDown);
				return () => document.removeEventListener("mousedown", onDown);
			}, [open]);

			/** 保存两档阈值到宿主（持久化），成功后用回传状态刷新界面。 */
			const saveThresholds = useCallback(async () => {
				const warn = Number(draftWarn);
				const low = Number(draftLow);
				if (!Number.isFinite(warn) || !Number.isFinite(low) || warn < 0 || low < 0) return;
				setSaving(true);
				try {
					const response = await fetch("/balance-meter/threshold", {
						method: "POST",
						credentials: "same-origin",
						headers: { accept: "application/json", "content-type": "application/json" },
						body: JSON.stringify({ warn, low })
					});
					const json = await response.json();
					setState({ loading: false, ...json });
				} catch (error) {
					setState((prev) => ({ ...prev, error: String((error && error.message) || error) }));
				} finally {
					setSaving(false);
				}
			}, [draftWarn, draftLow]);

			const ok = state.ok === true;
			const loading = state.loading === true;
			const total = Number(state.total);
			const currency = ok ? state.currency : "CNY";
			// 两档阈值由宿主持久化并下发；兼容旧宿主（扁平 threshold）与缺失字段。
			const legacyThreshold = Number(state.threshold);
			const rawWarn =
				state.thresholds?.warn !== void 0
					? Number(state.thresholds.warn)
					: Number.isFinite(legacyThreshold)
						? legacyThreshold * 2
						: NaN;
			const rawLow =
				state.thresholds?.low !== void 0
					? Number(state.thresholds.low)
					: Number.isFinite(legacyThreshold)
						? legacyThreshold
						: NaN;
			const warnThreshold = Number.isFinite(rawWarn) ? rawWarn : FALLBACK_WARN;
			const lowThreshold = Number.isFinite(rawLow) ? rawLow : FALLBACK_LOW;
			// 宿主下发 level；缺失时按两档阈值本地推导，保证离线也可用。
			const level = loading
				? "loading"
				: !ok
					? "low"
					: LEVEL_CLASS[state.level] !== void 0
						? state.level
						: Number.isFinite(total)
							? total < lowThreshold
								? "low"
								: total < warnThreshold
									? "warn"
									: "ok"
							: "ok";
			const levelClass = LEVEL_CLASS[level] ?? "";
			const dotClass = "bm-dot " + (loading ? "loading" : levelClass);
			const amountText = loading ? "…" : ok ? formatMoney(total, currency) : "—";
			const statusText = loading ? "读取中" : ok ? LEVEL_TEXT[level] ?? LEVEL_TEXT.ok : "读取失败";

			const title = loading
				? "DeepSeek 官方 API 余额 · 读取中"
				: ok
					? `DeepSeek 官方 API 余额 ${formatMoney(total, currency)} · ${statusText}`
					: "DeepSeek 官方 API 余额 · 读取失败";

			const warnValue = Number(draftWarn);
			const lowValue = Number(draftLow);
			const validDraft =
				Number.isFinite(warnValue) && Number.isFinite(lowValue) && warnValue >= 0 && lowValue >= 0;
			const dirty =
				validDraft && (warnValue !== warnThreshold || lowValue !== lowThreshold);

			return react.createElement(
				"span",
				{ className: "bm-root", ref: rootRef, "data-balance-meter": true },
				react.createElement(
					"button",
					{
						type: "button",
						ref: triggerRef,
						className: "bm-trigger",
						title,
						"aria-label": title,
						"aria-haspopup": "dialog",
						"aria-expanded": open,
						onClick: () => setOpen(!open)
					},
					react.createElement("span", { className: dotClass, "aria-hidden": "true" }),
					react.createElement("span", { className: "bm-amount" + (levelClass === "" ? "" : " " + levelClass) }, amountText),
					react.createElement(
						"span",
						{
							role: "button",
							tabIndex: 0,
							className: "bm-iconHost",
							title: "刷新余额",
							"aria-label": "刷新余额",
							onClick: (event) => {
								event.stopPropagation();
								if (!busy) void load(true);
							},
							onKeyDown: (event) => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									event.stopPropagation();
									if (!busy) void load(true);
								}
							}
						},
						react.createElement(RefreshIcon, { spinning: busy })
					)
				),
				open && reactDom.createPortal(
					react.createElement(
						"div",
						{
							ref: panelRef,
							className: "bm-panel",
							role: "dialog",
							"aria-label": title,
							style: pos === null ? { left: -9999, bottom: -9999 } : { left: pos.left, bottom: pos.bottom }
						},
						react.createElement(
							"div",
							{ className: "bm-head" },
							react.createElement("span", { className: "bm-headLabel" }, "余额详情 · DeepSeek 官方 API"),
							react.createElement(
								"span",
								{ className: "bm-status " + levelClass },
								loading ? "读取中" : ok ? statusText : "读取失败"
							)
						),
						react.createElement(
							"div",
							{ className: "bm-hero" },
							react.createElement("span", { className: "bm-heroValue" + (levelClass === "" ? "" : " " + levelClass) }, ok ? formatMoney(total, currency) : "—"),
							react.createElement("span", { className: "bm-heroTag" }, ok ? "总余额" : "")
						),
						ok &&
							react.createElement(
								"div",
								{ className: "bm-compose" },
								`充值 ${formatMoney(Number(state.toppedUp), currency)} · 赠送 ${formatMoney(Number(state.granted), currency)}`
							),
						react.createElement("div", { className: "bm-rule", "aria-hidden": "true" }),
						react.createElement(
							"div",
							{ className: "bm-compose" },
							ok && state.at !== void 0 ? `余额更新于 ${formatTime(Number(state.at))}` : ""
						),
						react.createElement("div", { className: "bm-rule", "aria-hidden": "true" }),
						react.createElement(
							"div",
							{ className: "bm-field" },
							react.createElement("div", { className: "bm-fieldLabel" }, "预警阈值（余额低于阈值时变色）"),
							react.createElement(
								"div",
								{ className: "bm-fieldRow" },
								react.createElement("label", { className: "bm-tierLabel warn", htmlFor: WARN_INPUT_ID }, "快充值吧"),
								react.createElement("input", {
									id: WARN_INPUT_ID,
									className: "bm-input",
									type: "number",
									min: 0,
									step: 1,
									inputMode: "decimal",
									value: draftWarn,
									disabled: saving,
									onChange: (event) => setDraftWarn(event.target.value),
									onKeyDown: (event) => {
										if (event.key === "Enter") {
											event.preventDefault();
											if (dirty && !saving) void saveThresholds();
										}
									}
								})
							),
							react.createElement(
								"div",
								{ className: "bm-fieldRow" },
								react.createElement("label", { className: "bm-tierLabel low", htmlFor: LOW_INPUT_ID }, "要见底了"),
								react.createElement("input", {
									id: LOW_INPUT_ID,
									className: "bm-input",
									type: "number",
									min: 0,
									step: 1,
									inputMode: "decimal",
									value: draftLow,
									disabled: saving,
									onChange: (event) => setDraftLow(event.target.value),
									onKeyDown: (event) => {
										if (event.key === "Enter") {
											event.preventDefault();
											if (dirty && !saving) void saveThresholds();
										}
									}
								}),
								react.createElement(
									"button",
									{
										type: "button",
										className: "bm-btn",
										disabled: saving || !dirty,
										onClick: () => void saveThresholds()
									},
									saving ? "保存中" : "保存"
								)
							)
						),
						!ok && !loading && state.error !== void 0 &&
							react.createElement("div", { className: "bm-note" }, String(state.error)),
						react.createElement(
							"div",
							{ className: "bm-actions" },
							react.createElement(
								"a",
								{
									className: "bm-btn primary",
									href: TOPUP_URL,
									target: "_blank",
									rel: "noreferrer noopener",
									title: "前往 DeepSeek 开放平台充值"
								},
								"去充值"
							),
							react.createElement(
								"button",
								{ type: "button", className: "bm-btn", disabled: busy, onClick: () => void load(true) },
								busy ? "刷新中" : "立即刷新"
							)
						),
						react.createElement(
							"div",
							{ className: "bm-hint" },
							"余额来自 DeepSeek 官方 API，每 5 分钟自动同步。"
						)
					),
					document.body
				)
			);
		}

		/**
		 * 把余额指示器注册进输入框下方的状态行。
		 * dock 是 list 插槽；order 取较大值，配合组件自身的 CSS order 排到最后。
		 */
		function apply(ctx) {
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "balance",
				order: 100
			}, BalanceMeter));
		}

		const inject = ["slots"];

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
