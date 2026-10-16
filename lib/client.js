window.__ModuleLoader__.load({
	id: "@huanlin/dsh-plugin-komari",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region \0dsh-css:D:\Projects\deepseek-harness\dsh-plugin-komari\src\client\SettingsPage.module.css.mjs
		const css = ".vju6nw_section {\n  display: flex;\n  flex-direction: column;\n  gap: 12px;\n  max-width: 720px;\n  color: var(--dsw-alias-label-primary);\n}\n\n.vju6nw_error {\n  margin: 0;\n  padding: 8px 12px;\n  border: 1px solid var(--dsw-alias-state-error-primary);\n  border-radius: 8px;\n  background: var(--dsw-alias-interactive-bg-hover-danger);\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-state-error-primary);\n}\n\n.vju6nw_loading {\n  font-size: 14px;\n  line-height: 22px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.vju6nw_editor {\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 12px;\n  padding: 14px 16px;\n  display: flex;\n  flex-direction: column;\n  gap: 14px;\n  background: var(--dsw-alias-bg-module-platform);\n}\n\n.vju6nw_row {\n  display: flex;\n  gap: 12px;\n}\n\n.vju6nw_row > .vju6nw_field {\n  flex: 1;\n}\n\n.vju6nw_field {\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n}\n\n.vju6nw_fieldLabel {\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.vju6nw_hint {\n  margin: 0;\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.vju6nw_input {\n  height: 32px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 8px;\n  padding: 0 10px;\n  font-size: 14px;\n  line-height: 20px;\n  color: var(--dsw-alias-label-primary);\n  background: var(--dsw-alias-bg-layer-1);\n  outline: none;\n}\n\n.vju6nw_input:focus {\n  border-color: var(--dsw-alias-state-focus-primary);\n}\n\n.vju6nw_actions {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  flex-wrap: wrap;\n}\n\n.vju6nw_primaryButton {\n  height: 36px;\n  border: none;\n  border-radius: 18px;\n  padding: 0 18px;\n  font-size: 14px;\n  font-weight: 500;\n  color: var(--dsw-alias-text-on-primary);\n  background: var(--dsw-alias-interactive-bg-primary);\n  cursor: pointer;\n}\n\n.vju6nw_primaryButton:disabled {\n  opacity: 0.5;\n  cursor: not-allowed;\n}\n\n.vju6nw_secondaryButton {\n  height: 36px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 18px;\n  padding: 0 18px;\n  font-size: 14px;\n  color: var(--dsw-alias-label-primary);\n  background: var(--dsw-alias-bg-layer-1);\n  cursor: pointer;\n}\n\n.vju6nw_secondaryButton:disabled {\n  opacity: 0.5;\n  cursor: not-allowed;\n}\n\n.vju6nw_testOk {\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-state-success-primary);\n}\n\n.vju6nw_testWarn {\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-state-warning-primary);\n}\n\n.vju6nw_testErr {\n  font-size: 12px;\n  line-height: 18px;\n  color: var(--dsw-alias-state-error-primary);\n}\n";
		const classMap = {
			"section": "vju6nw_section",
			"error": "vju6nw_error",
			"loading": "vju6nw_loading",
			"editor": "vju6nw_editor",
			"row": "vju6nw_row",
			"field": "vju6nw_field",
			"fieldLabel": "vju6nw_fieldLabel",
			"hint": "vju6nw_hint",
			"input": "vju6nw_input",
			"actions": "vju6nw_actions",
			"primaryButton": "vju6nw_primaryButton",
			"secondaryButton": "vju6nw_secondaryButton",
			"testOk": "vju6nw_testOk",
			"testWarn": "vju6nw_testWarn",
			"testErr": "vju6nw_testErr"
		};
		const tagId = "@huanlin/dsh-plugin-komari/SettingsPage.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@huanlin/dsh-plugin-komari";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		} else if (typeof document !== "undefined") {
			const existing = document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]");
			if (existing) existing.textContent = css;
		}
		//#endregion
		//#region src/client/SettingsPage.tsx
		function SettingsPage(props) {
			const { t } = props;
			if (props.view === "summary") return t("page.summary");
			const state = props.useKomariSettings((snapshot) => snapshot);
			const [testStatus, setTestStatus] = (0, react.useState)("idle");
			const [testMessage, setTestMessage] = (0, react.useState)(void 0);
			const testConnection = (0, react.useCallback)(async () => {
				setTestStatus("testing");
				setTestMessage(void 0);
				try {
					const result = await props.probe();
					if (result.ok && result.node_count > 0) {
						setTestStatus("ok");
						setTestMessage(t("test.ok") + " — " + String(result.node_count) + " machine(s), " + String(result.online_count) + " online");
					} else if (result.ok) {
						setTestStatus("empty");
						setTestMessage(t("test.failed"));
					} else {
						setTestStatus("error");
						setTestMessage(result.message);
					}
				} catch (err) {
					setTestStatus("error");
					setTestMessage(err instanceof Error ? err.message : String(err));
				}
			}, [props, t]);
			if (state.status !== "ready") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("section", {
				className: classMap.section,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: classMap.loading,
					children: state.status === "loading" ? "…" : t("page.unavailable")
				})
			});
			const { values } = state;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: classMap.section,
				children: [
					!state.writable && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: classMap.loading,
						children: t("page.readOnly")
					}),
					state.failed && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: classMap.error,
						children: t("action.saveFailed")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: classMap.editor,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: classMap.field,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: classMap.fieldLabel,
									children: t("field.endpoint")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									className: classMap.input,
									value: values.endpoint,
									placeholder: t("field.endpoint.placeholder"),
									onChange: (e) => props.edit("endpoint", e.target.value)
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: classMap.row,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: classMap.field,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: classMap.fieldLabel,
											children: t("field.username")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											className: classMap.input,
											value: values.username,
											autoComplete: "off",
											onChange: (e) => props.edit("username", e.target.value)
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: classMap.field,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: classMap.fieldLabel,
											children: t("field.password")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											className: classMap.input,
											type: "password",
											value: values.password,
											autoComplete: "new-password",
											onChange: (e) => props.edit("password", e.target.value)
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: classMap.field,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: classMap.fieldLabel,
											children: t("field.requestTimeoutMs")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											className: classMap.input,
											type: "number",
											value: values.requestTimeoutMs,
											onChange: (e) => props.edit("requestTimeoutMs", Number(e.target.value))
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: classMap.field,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: classMap.fieldLabel,
											children: t("field.transferTimeoutMs")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											className: classMap.input,
											type: "number",
											value: values.transferTimeoutMs,
											onChange: (e) => props.edit("transferTimeoutMs", Number(e.target.value))
										})]
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: classMap.hint,
								children: t("hint.credentials")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: classMap.hint,
								children: t("hint.exec")
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: classMap.actions,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: classMap.primaryButton,
								onClick: props.save,
								disabled: !state.dirty || state.saving || !state.writable,
								children: state.saving ? "…" : state.saved ? t("action.saved") : t("action.save")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: classMap.secondaryButton,
								onClick: () => void testConnection(),
								disabled: testStatus === "testing",
								children: testStatus === "testing" ? t("action.testing") : t("action.test")
							}),
							testStatus === "ok" && testMessage !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: classMap.testOk,
								children: testMessage
							}),
							testStatus === "empty" && testMessage !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: classMap.testWarn,
								children: testMessage
							}),
							testStatus === "error" && testMessage !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: classMap.testErr,
								children: [
									t("test.error"),
									": ",
									testMessage
								]
							})
						]
					})
				]
			});
		}
		//#endregion
		//#region src/client/settings-form.ts
		/** A minimal snapshot store: a value + a listener set (no browser-bundle symbols). */
		var MiniSnapshotStore = class {
			snapshot;
			listeners = /* @__PURE__ */ new Set();
			constructor(initial) {
				this.snapshot = initial;
			}
			getSnapshot() {
				return this.snapshot;
			}
			set(value) {
				this.snapshot = value;
				for (const listener of [...this.listeners]) listener();
			}
			update(mutator) {
				const draft = { ...this.snapshot };
				mutator(draft);
				this.set(draft);
			}
			subscribe(listener) {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			}
		};
		/** Composition-layer defaults, mirroring the host Config schema exactly. */
		const KOMARI_FORM_DEFAULTS = {
			endpoint: "",
			username: "",
			password: "",
			requestTimeoutMs: 15e3,
			transferTimeoutMs: 6e5
		};
		/** How long the "Saved" confirmation stays visible after a landed save. */
		const SAVED_FLASH_MS = 2e3;
		/**
		* Bridges the \`dsh-komari\` entry's ConfigForm onto the page's staged form.
		*/
		var KomariSettingsController = class {
			form;
			store;
			staged = /* @__PURE__ */ new Map();
			saving = false;
			saved = false;
			failed = false;
			savedTimer;
			/** @param form - the bound config form for the \`dsh-komari\` entry. */
			constructor(form) {
				this.form = form;
				this.store = new MiniSnapshotStore(this.project());
				form.subscribe(() => {
					this.publish();
				});
			}
			/** @returns the store the page's slot registration injects. */
			get snapshot() {
				return this.store;
			}
			/** Stage one field edit; the draft overlays the accepted value until save. */
			edit(field, value) {
				this.staged.set(field, value);
				this.failed = false;
				this.publish();
			}
			/** Write every staged edit, then re-seed from what the Host accepted. */
			save() {
				this.commit();
			}
			async commit() {
				if (this.staged.size === 0 || this.saving) return;
				this.saving = true;
				this.failed = false;
				this.publish();
				let landed = true;
				for (const [field, value] of this.staged) try {
					if (!await this.form.set(field, value)) landed = false;
				} catch {
					landed = false;
				}
				this.saving = false;
				if (landed) {
					this.staged.clear();
					this.flashSaved();
				}
				this.failed = !landed;
				this.publish();
			}
			flashSaved() {
				this.saved = true;
				if (this.savedTimer !== void 0) clearTimeout(this.savedTimer);
				this.savedTimer = setTimeout(() => {
					this.savedTimer = void 0;
					this.saved = false;
					this.publish();
				}, SAVED_FLASH_MS);
			}
			publish() {
				this.store.set(this.project());
			}
			project() {
				const snapshot = this.form.getSnapshot();
				const values = { ...KOMARI_FORM_DEFAULTS };
				if (snapshot.status === "ready" && snapshot.value !== void 0) Object.assign(values, snapshot.value);
				for (const [field, value] of this.staged) values[field] = value;
				return {
					status: snapshot.status,
					writable: snapshot.writable,
					dirty: this.staged.size > 0,
					saving: this.saving,
					saved: this.saved,
					failed: this.failed,
					configured: values.endpoint.trim() !== "" && values.username.trim() !== "",
					values
				};
			}
		};
		//#endregion
		//#region src/client/locales.ts
		const NS = "dsh-komari";
		const en = {
			"page.summary": "Configure the Komari panel address and account; komari_list_nodes / komari_exec read these values live — no restart needed.",
			"page.unavailable": "Configuration is unavailable (this host does not serve the plugin entry).",
			"page.readOnly": "The active profile does not accept configuration edits.",
			"field.endpoint": "Panel address",
			"field.endpoint.placeholder": "https://status.example.com",
			"field.username": "Username",
			"field.password": "Password",
			"field.requestTimeoutMs": "Request timeout (ms)",
			"field.transferTimeoutMs": "Transfer timeout (ms)",
			"hint.credentials": "The account must be a panel administrator. Credentials are stored in the profile cordis.patch.yml in plain text; an account with 2FA enabled cannot be used here.",
			"hint.exec": "komari_exec runs real commands on the monitored machines with the agent privileges (root on most Linux nodes).",
			"action.save": "Save",
			"action.saved": "Saved",
			"action.saveFailed": "Save failed",
			"action.test": "Test connection",
			"action.testing": "Testing…",
			"test.ok": "Connected",
			"test.failed": "No machines reported",
			"test.error": "Connection failed"
		};
		const zh = {
			"page.summary": "配置 Komari 面板地址与账号；komari_list_nodes / komari_exec 每次调用都读取最新值，无需重启。",
			"page.unavailable": "配置暂不可用（当前 host 未提供此插件条目）。",
			"page.readOnly": "当前 profile 不接受配置修改。",
			"field.endpoint": "面板地址",
			"field.endpoint.placeholder": "https://status.example.com",
			"field.username": "用户名",
			"field.password": "密码",
			"field.requestTimeoutMs": "请求超时 (ms)",
			"field.transferTimeoutMs": "传输超时 (ms)",
			"hint.credentials": "账号需具备面板管理员权限。凭据以明文保存在 profile 的 cordis.patch.yml 中；开启 2FA 的账号无法在此使用。",
			"hint.exec": "komari_exec 会以目标机 agent 的权限执行真实命令（多数 Linux 节点即 root）。",
			"action.save": "保存",
			"action.saved": "已保存",
			"action.saveFailed": "保存失败",
			"action.test": "测试连接",
			"action.testing": "测试中…",
			"test.ok": "连接成功",
			"test.failed": "未取到机器",
			"test.error": "连接失败"
		};
		//#endregion
		//#region src/client/row-key.ts
		/**
		* The three constants that must agree for the configure card to appear.
		*
		* The Plugins page matches \`plugins.row.config\` registrations by the EXACT
		* string \`<package.json name>#<cordis.patch.yml row id>\`; a mismatch makes the
		* entry point vanish silently. tests/row-key.spec.ts pins them to the files
		* that define them.
		*/
		/** package.json \`name\` (also the \`name\` of the cordis.patch.yml row). */
		const PKG_NAME = "@huanlin/dsh-plugin-komari";
		/** cordis.patch.yml row id (= settings entry id = \`ctx.configForms.get()\` argument). */
		const ENTRY_ID = "dsh-komari";
		/** \`plugins.row.config\` key. */
		const ROW_KEY = `${PKG_NAME}#${ENTRY_ID}`;
		//#endregion
		//#region src/client/index.ts
		const inject = [
			"slots",
			"locale",
			"connection",
			"configForms"
		];
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-komari: dictionaries");
			const connection = ctx.connection;
			const controller = new KomariSettingsController(ctx.configForms.get(ENTRY_ID));
			const probe = async () => {
				const result = await connection.rpc.call("/api", "komari.probe", {});
				if (result.ok) return {
					ok: true,
					node_count: result.value.node_count,
					online_count: result.value.online_count
				};
				return {
					ok: false,
					message: result.error.message
				};
			};
			const settingsInjected = () => ({
				hooks: { komariSettings: controller.snapshot },
				edit: (field, value) => controller.edit(field, value),
				save: () => controller.save(),
				probe
			});
			ctx.effect(() => ctx.configForms.whileServed([ENTRY_ID], () => ctx.slots.inject("plugins.row.config", function* () {
				yield ctx.slots.register({
					name: "plugins.row.config",
					key: ROW_KEY,
					locale: NS,
					inject: settingsInjected
				}, SettingsPage);
			})), "dsh-komari: plugins row config card");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map