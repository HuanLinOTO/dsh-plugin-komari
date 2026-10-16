import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createWriteStream } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import { once } from "node:events";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { API_PATH } from "@deepseek-ai/dsh-client-connection";
//#region src/komari.ts
/** Raised for transport / protocol failures (as opposed to a panel-level error body). */
var KomariError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "KomariError";
	}
};
/** Raised when the panel rejects the credentials or the session. */
var KomariAuthError = class extends KomariError {
	constructor(message) {
		super(message);
		this.name = "KomariAuthError";
	}
};
/**
* Normalize a user-typed panel address.
* Accepts `status.example.com`, `https://status.example.com/`,
* `https://status.example.com/api/v1` and reduces all to the origin.
* @param raw - address as typed on the settings page.
* @returns the normalized origin, or `''` for blank input.
*/
function normalizeEndpoint(raw) {
	let s = raw.trim();
	if (s === "") return "";
	if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
	s = s.replace(/\/+$/, "");
	s = s.replace(/\/api(\/v1)?$/i, "");
	return s.replace(/\/+$/, "");
}
function asRecord(value) {
	return typeof value === "object" && value !== null ? value : {};
}
function asString(value, fallback = "") {
	return typeof value === "string" ? value : fallback;
}
function asNumber(value, fallback = 0) {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
/** Komari sends `tags` as a `;`-separated string. */
function tagList(value) {
	return asString(value).split(";").map((t) => t.trim()).filter(Boolean);
}
/** Whitelist one admin client entry; drops `token` and every other unknown field. */
function pickNode(raw) {
	const c = asRecord(raw);
	return {
		uuid: asString(c.uuid),
		name: asString(c.name),
		region: asString(c.region),
		group: asString(c.group),
		tags: tagList(c.tags),
		hidden: c.hidden === true,
		weight: asNumber(c.weight),
		cpu: {
			name: asString(c.cpu_name),
			cores: asNumber(c.cpu_cores),
			physical_cores: asNumber(c.cpu_physical_cores)
		},
		gpu_name: asString(c.gpu_name),
		arch: asString(c.arch),
		os: asString(c.os),
		kernel_version: asString(c.kernel_version),
		virtualization: asString(c.virtualization),
		mem_total: asNumber(c.mem_total),
		swap_total: asNumber(c.swap_total),
		disk_total: asNumber(c.disk_total),
		billing: {
			price: asNumber(c.price),
			currency: asString(c.currency),
			cycle_days: asNumber(c.billing_cycle),
			auto_renewal: c.auto_renewal === true,
			expired_at: typeof c.expired_at === "string" ? c.expired_at : null
		},
		traffic_limit: asNumber(c.traffic_limit),
		traffic_limit_type: asString(c.traffic_limit_type, "max"),
		public_remark: asString(c.public_remark),
		remark: asString(c.remark),
		ipv4: asString(c.ipv4),
		ipv6: asString(c.ipv6),
		agent_version: asString(c.version),
		created_at: typeof c.created_at === "string" ? c.created_at : null
	};
}
/** Whitelist one latest-report entry (mirrors the panel's own record projection). */
function pickLive(raw) {
	const r = asRecord(raw);
	const tcpTotal = asNumber(r.connections);
	const udp = asNumber(r.connections_udp);
	const gpuCount = asNumber(r.gpu_count);
	return {
		time: typeof r.time === "string" ? r.time : null,
		online: r.online === true,
		uptime: asNumber(r.uptime),
		cpu: asNumber(r.cpu),
		ram: {
			used: asNumber(r.ram),
			total: asNumber(r.ram_total)
		},
		swap: {
			used: asNumber(r.swap),
			total: asNumber(r.swap_total)
		},
		disk: {
			used: asNumber(r.disk),
			total: asNumber(r.disk_total)
		},
		load: {
			load1: asNumber(r.load),
			load5: asNumber(r.load5),
			load15: asNumber(r.load15)
		},
		temp: asNumber(r.temp),
		network: {
			up: asNumber(r.net_out),
			down: asNumber(r.net_in),
			total_up: asNumber(r.net_total_up),
			total_down: asNumber(r.net_total_down)
		},
		connections: {
			tcp: Math.max(0, tcpTotal - udp),
			udp
		},
		process: asNumber(r.process),
		gpu: gpuCount > 0 ? {
			count: gpuCount,
			usage: asNumber(r.gpu_average_usage)
		} : null,
		ping: asRecord(r.ping)
	};
}
/**
* Link an optional caller signal with a timeout into one abort signal.
* @param signal - caller cancellation signal (`exec.signal`), maybe undefined.
* @param ms - timeout in milliseconds.
* @returns the linked signal plus a disposer clearing the timer.
*/
function linkTimeout(signal, ms) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(/* @__PURE__ */ new Error(`request timed out after ${ms}ms`)), ms);
	const onAbort = () => controller.abort(signal?.reason);
	if (signal !== void 0) {
		if (signal.aborted) controller.abort(signal.reason);
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	};
}
/** Pull a human-readable message out of a panel error body. */
function errorMessage(body, fallback) {
	const b = asRecord(body);
	const direct = asString(b.message);
	if (direct !== "") return direct;
	const nested = asString(asRecord(b.error).message);
	if (nested !== "") return nested;
	return fallback;
}
/**
* Stateful Komari client bound to one `(endpoint, username, password)` triple.
*
* The session cookie is cached and re-acquired lazily: a single 401 triggers
* exactly one re-login and one retry, so a revoked/expired session self-heals
* without the tool layer knowing about it.
*/
var KomariClient = class {
	conn;
	session = null;
	loginPromise = null;
	constructor(conn) {
		this.conn = conn;
	}
	/** @returns the normalized panel origin this client talks to. */
	get endpoint() {
		return this.conn.endpoint;
	}
	/** Drop the cached session (next call re-authenticates). */
	reset() {
		this.session = null;
		this.loginPromise = null;
	}
	/**
	* Authenticate against `POST /api/login` and cache the session cookie.
	* @param signal - caller cancellation signal.
	* @returns the session token.
	*/
	async login(signal) {
		if (this.session !== null) return this.session;
		if (this.loginPromise !== null) return await this.loginPromise;
		this.loginPromise = this.doLogin(signal);
		try {
			this.session = await this.loginPromise;
			return this.session;
		} finally {
			this.loginPromise = null;
		}
	}
	async doLogin(signal) {
		const { endpoint, username, password, timeoutMs } = this.conn;
		if (endpoint === "") throw new KomariAuthError("Komari panel address is not configured.");
		if (username === "" || password === "") throw new KomariAuthError("Komari username/password are not configured.");
		const link = linkTimeout(signal, timeoutMs);
		let res;
		try {
			res = await fetch(`${endpoint}/api/login`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json"
				},
				body: JSON.stringify({
					username,
					password,
					"2fa_code": ""
				}),
				signal: link.signal
			});
		} catch (err) {
			throw new KomariError(`login request to ${endpoint} failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			link.dispose();
		}
		const text = await res.text();
		let body = null;
		try {
			body = text === "" ? null : JSON.parse(text);
		} catch {
			body = null;
		}
		if (!res.ok) {
			const message = errorMessage(body, `HTTP ${res.status}`);
			if (res.status === 401) throw new KomariAuthError(`Komari login rejected: ${message} (check username/password; accounts with 2FA enabled cannot be used here)`);
			if (res.status === 403) throw new KomariAuthError(`Komari panel refuses password login: ${message}`);
			throw new KomariError(`Komari login failed (HTTP ${res.status}): ${message}`);
		}
		const embedded = asString(asRecord(asRecord(asRecord(body).data)["set-cookie"]).session_token);
		if (embedded !== "") return embedded;
		const fromHeader = res.headers.getSetCookie?.().find((v) => v.startsWith("session_token=")) ?? res.headers.get("set-cookie") ?? "";
		const match = /session_token=([^;]+)/.exec(fromHeader);
		if (match?.[1] !== void 0 && match[1] !== "") return match[1];
		throw new KomariError("Komari login succeeded but returned no session token.");
	}
	/**
	* One authenticated HTTP call returning the raw Response with its body NOT
	* consumed (binary streams need it). The connect-and-headers phase is bounded
	* by the configured request timeout; the caller owns the body phase (see the
	* transfer timeout in tools.ts). Retries once after a session reset on 401/403.
	* @param path - panel path beginning with a slash.
	* @param init - fetch init; headers are merged over the session cookie.
	* @param signal - caller cancellation signal.
	* @returns the raw response, body unread.
	*/
	async rawFetch(path, init, signal) {
		const { endpoint, timeoutMs } = this.conn;
		const attempt = async (session) => {
			const link = linkTimeout(signal, timeoutMs);
			try {
				return await fetch(`${endpoint}${path}`, {
					...init,
					headers: {
						accept: "application/json",
						cookie: `session_token=${session}`,
						...init.headers ?? {}
					},
					signal: link.signal
				});
			} catch (err) {
				throw new KomariError(`request to ${endpoint}${path} failed: ${err instanceof Error ? err.message : String(err)}`);
			} finally {
				link.dispose();
			}
		};
		const first = await attempt(await this.login(signal));
		if (first.status !== 401 && first.status !== 403) return first;
		await first.body?.cancel();
		this.reset();
		return await attempt(await this.login(signal));
	}
	/** One authenticated JSON call; retries once after a session reset on 401/403. */
	async send(path, init, signal) {
		const res = await this.rawFetch(path, init, signal);
		const text = await res.text();
		let body = null;
		try {
			body = text === "" ? null : JSON.parse(text);
		} catch {
			body = text;
		}
		return {
			status: res.status,
			body,
			setCookie: res.headers.getSetCookie?.() ?? []
		};
	}
	/** Standard-envelope call: unwraps `data`, raises on `status:"error"` or non-2xx. */
	async callData(path, init, signal) {
		const res = await this.send(path, init, signal);
		if (res.status === 401 || res.status === 403) throw new KomariAuthError(`Komari rejected the session (HTTP ${res.status}): ${errorMessage(res.body, "permission denied")}. The account may need admin rights, or the panel may require 2FA for sensitive operations.`);
		if (res.status >= 400) throw new KomariError(`Komari request ${path} failed (HTTP ${res.status}): ${errorMessage(res.body, "unknown error")}`);
		return asRecord(res.body).data;
	}
	/**
	* Call one JSON-RPC method through the panel's `/api/rpc2` entry and unwrap
	* the JSON-RPC envelope (NOT the `{status,data}` REST envelope).
	* @param method - RPC method name, e.g. `admin:fileStat`.
	* @param params - named parameters object.
	* @param signal - caller cancellation signal.
	*/
	async rpcCall(method, params, signal) {
		const res = await this.send("/api/rpc2", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method,
				params
			})
		}, signal);
		if (res.status === 401 || res.status === 403) throw new KomariAuthError(`Komari refused ${method} (HTTP ${String(res.status)}): ${errorMessage(res.body, "permission denied")}`);
		if (res.status >= 400) throw new KomariError(`Komari ${method} failed (HTTP ${String(res.status)}): ${errorMessage(res.body, "unknown error")}`);
		const envelope = asRecord(res.body);
		if (envelope.error !== void 0) throw new KomariError(`Komari ${method} failed: ${errorMessage(envelope, "unknown error")}`);
		return envelope.result;
	}
	/**
	* List every node including hidden ones (admin view), whitelisted.
	* @param signal - caller cancellation signal.
	*/
	async listNodes(signal) {
		const res = await this.send("/api/admin/client/list", { method: "GET" }, signal);
		if (res.status === 401 || res.status === 403) throw new KomariAuthError(`Komari refused the node list (HTTP ${res.status}): ${errorMessage(res.body, "permission denied")}. This account needs panel administrator rights.`);
		if (res.status >= 400) throw new KomariError(`Komari node list failed (HTTP ${res.status}): ${errorMessage(res.body, "unknown error")}`);
		const raw = Array.isArray(res.body) ? res.body : asRecord(res.body).data;
		if (!Array.isArray(raw)) throw new KomariError("Komari node list returned an unexpected payload shape.");
		return raw.map(pickNode);
	}
	/**
	* Fetch the latest live report for every node, keyed by uuid.
	* Uses the `common:getNodesLatestStatus` RPC through the panel's `/api/rpc2` entry
	* (that method has no dedicated REST route).
	* @param signal - caller cancellation signal.
	*/
	async latestStatus(signal) {
		const result = asRecord(await this.rpcCall("common:getNodesLatestStatus", {}, signal));
		const out = {};
		for (const [uuid, value] of Object.entries(result)) out[uuid] = pickLive(value);
		return out;
	}
	/**
	* Submit a command for remote execution on the given nodes.
	* @param command - shell command run by the agent (root on most Linux nodes).
	* @param uuids - target node uuids.
	* @param signal - caller cancellation signal.
	*/
	async exec(command, uuids, signal) {
		const data = asRecord(await this.callData("/api/admin/task/exec", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				command,
				clients: uuids
			})
		}, signal));
		return {
			task_id: asString(data.task_id),
			clients: Array.isArray(data.clients) ? data.clients.map((v) => asString(v)).filter(Boolean) : [],
			queued_clients: Array.isArray(data.queued_clients) ? data.queued_clients.map((v) => asString(v)).filter(Boolean) : []
		};
	}
	/**
	* Read one exec task with the results that have landed so far.
	* @param taskId - task id from {@link exec}.
	* @param signal - caller cancellation signal.
	*/
	async task(taskId, signal) {
		const data = asRecord(await this.callData(`/api/admin/task/${encodeURIComponent(taskId)}`, { method: "GET" }, signal));
		const results = Array.isArray(data.results) ? data.results : [];
		return {
			task_id: asString(data.task_id, taskId),
			command: asString(data.command),
			clients: Array.isArray(data.clients) ? data.clients.map((v) => asString(v)).filter(Boolean) : [],
			results: results.map((raw) => {
				const r = asRecord(raw);
				return {
					client: asString(r.client),
					result: asString(r.result),
					exit_code: asNumber(r.exit_code),
					finished_at: typeof r.finished_at === "string" ? r.finished_at : null
				};
			})
		};
	}
	/** Read one remote file's metadata through `admin:fileStat`. */
	async statFile(uuid, path, signal) {
		const info = asRecord(await this.rpcCall("admin:fileStat", {
			uuid,
			path
		}, signal));
		return {
			name: asString(info.name),
			path: asString(info.path, path),
			size: asNumber(info.size),
			is_dir: info.is_dir === true,
			mode: asString(info.mode),
			modified_at: typeof info.modified_at === "string" ? info.modified_at : null
		};
	}
	/**
	* Delete one path on a machine through `admin:fileDelete`.
	* @param uuid - target machine uuid.
	* @param path - absolute path to delete.
	* @param signal - caller cancellation signal.
	*/
	async deleteFile(uuid, path, signal) {
		await this.rpcCall("admin:fileDelete", {
			uuid,
			path
		}, signal);
	}
	/**
	* Open a chunked upload session (`operation=init`).
	* @param uuid - target machine uuid.
	* @param path - absolute destination path on that machine.
	* @param size - total byte length of the file being uploaded.
	* @param signal - caller cancellation signal.
	*/
	async uploadInit(uuid, path, size, signal) {
		const data = asRecord(await this.callData(`/api/admin/client/${encodeURIComponent(uuid)}/file/upload?operation=init`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				path,
				size
			})
		}, signal));
		return {
			upload_id: asString(data.upload_id),
			chunk_size: asNumber(data.chunk_size, 26214400),
			chunk_count: asNumber(data.chunk_count),
			complete: data.complete === true
		};
	}
	/**
	* Send one chunk as a raw body. The panel requires `Content-Length` to equal
	* the chunk's exact expected size, so the byte array is passed whole.
	* @param uuid - target machine uuid.
	* @param uploadId - session id from {@link uploadInit}.
	* @param index - zero-based chunk index.
	* @param bytes - the chunk's bytes (last chunk may be shorter); must be
	*   ArrayBuffer-backed so it is assignable to the fetch body type.
	* @param signal - caller cancellation signal.
	*/
	async uploadChunk(uuid, uploadId, index, bytes, signal) {
		const query = `operation=chunk&upload_id=${encodeURIComponent(uploadId)}&chunk_index=${String(index)}`;
		await this.callData(`/api/admin/client/${encodeURIComponent(uuid)}/file/upload?${query}`, {
			method: "POST",
			headers: { "content-type": "application/octet-stream" },
			body: bytes
		}, signal);
	}
	/**
	* Commit the uploaded chunks (`operation=merge`).
	* @param uuid - target machine uuid.
	* @param uploadId - session id from {@link uploadInit}.
	* @param signal - caller cancellation signal.
	*/
	async uploadMerge(uuid, uploadId, signal) {
		await this.callData(`/api/admin/client/${encodeURIComponent(uuid)}/file/upload?operation=merge`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ upload_id: uploadId })
		}, signal);
	}
	/**
	* Abandon an upload session and drop the partially written file.
	* @param uuid - target machine uuid.
	* @param uploadId - session id from {@link uploadInit}.
	* @param signal - caller cancellation signal.
	*/
	async uploadCancel(uuid, uploadId, signal) {
		await this.callData(`/api/admin/client/${encodeURIComponent(uuid)}/file/upload?operation=cancel&upload_id=${encodeURIComponent(uploadId)}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ upload_id: uploadId })
		}, signal);
	}
	/**
	* Open the raw download stream for one remote file. The caller consumes the
	* body; a non-2xx response carries a JSON error body instead of file bytes.
	* @param uuid - source machine uuid.
	* @param path - absolute source path on that machine.
	* @param signal - caller cancellation signal.
	*/
	async downloadStream(uuid, path, signal) {
		return await this.rawFetch(`/api/admin/client/${encodeURIComponent(uuid)}/file/download?path=${encodeURIComponent(path)}`, {
			method: "GET",
			headers: { accept: "*/*" }
		}, signal);
	}
	/**
	* Read the panel's JSON error body from a failed transfer response.
	* @param res - the non-2xx response.
	*/
	async transferError(res) {
		const text = await res.text().catch(() => "");
		let body = null;
		try {
			body = text === "" ? null : JSON.parse(text);
		} catch {
			body = null;
		}
		return errorMessage(body, text === "" ? `HTTP ${res.status}` : text.slice(0, 200));
	}
	/**
	* Connectivity probe for the settings page: login + one node list + live counts.
	* @param signal - caller cancellation signal.
	*/
	async probe(signal) {
		const nodes = await this.listNodes(signal);
		let online = 0;
		try {
			const live = await this.latestStatus(signal);
			online = Object.values(live).filter((l) => l.online).length;
		} catch {
			online = nodes.filter(() => false).length;
		}
		return {
			node_count: nodes.length,
			online_count: online
		};
	}
};
//#endregion
//#region src/summary.ts
/** Human-readable byte size. */
function formatBytes(bytes) {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0B";
	const units = [
		"B",
		"KB",
		"MB",
		"GB",
		"TB",
		"PB"
	];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return (value >= 100 ? value.toFixed(0) : value.toFixed(1)) + units[unit];
}
/** Compact duration, e.g. 8d20h / 3h12m / 45s. */
function formatDuration(seconds) {
	if (!Number.isFinite(seconds) || seconds <= 0) return "-";
	const d = Math.floor(seconds / 86400);
	const h = Math.floor(seconds % 86400 / 3600);
	const m = Math.floor(seconds % 3600 / 60);
	const s = Math.floor(seconds % 60);
	if (d > 0) return d + "d" + h + "h";
	if (h > 0) return h + "h" + m + "m";
	if (m > 0) return m + "m" + s + "s";
	return s + "s";
}
/**
* Merge one machine's static record with its latest live report.
* Totals fall back to the static record when the live report carries zeros.
* @param node - whitelisted static record.
* @param live - whitelisted live record, if the panel reported one.
*/
function summarizeNode(node, live) {
	const ramTotal = live !== void 0 && live.ram.total > 0 ? live.ram.total : node.mem_total;
	const diskTotal = live !== void 0 && live.disk.total > 0 ? live.disk.total : node.disk_total;
	const swapTotal = live !== void 0 && live.swap.total > 0 ? live.swap.total : node.swap_total;
	return {
		uuid: node.uuid,
		name: node.name,
		group: node.group,
		region: node.region,
		tags: node.tags,
		online: live?.online ?? false,
		last_report: live?.time ?? "",
		uptime_seconds: live?.uptime ?? 0,
		cpu_percent: live?.cpu ?? 0,
		load1: live?.load.load1 ?? 0,
		ram_used: live?.ram.used ?? 0,
		ram_total: ramTotal,
		disk_used: live?.disk.used ?? 0,
		disk_total: diskTotal,
		swap_used: live?.swap.used ?? 0,
		swap_total: swapTotal,
		net_up_per_sec: live?.network.up ?? 0,
		net_down_per_sec: live?.network.down ?? 0,
		net_total_up: live?.network.total_up ?? 0,
		net_total_down: live?.network.total_down ?? 0,
		tcp_connections: live?.connections.tcp ?? 0,
		udp_connections: live?.connections.udp ?? 0,
		process_count: live?.process ?? 0,
		temperature: live?.temp ?? 0,
		os: node.os,
		arch: node.arch,
		cpu_model: node.cpu.name,
		virtualization: node.virtualization,
		gpu: node.gpu_name === "None" ? "" : node.gpu_name,
		memo: node.public_remark !== "" ? node.public_remark : node.remark
	};
}
/**
* Map node references (uuid, exact name, or unique name substring) onto nodes.
* Exact uuid wins, then exact name (case-insensitive), then a unique substring
* of the name/uuid; an ambiguous substring is reported instead of guessed.
* @param refs - references as supplied by the model.
* @param nodes - machines to resolve against.
*/
function resolveNodeRefs(refs, nodes) {
	const matched = [];
	const unresolved = [];
	const ambiguous = [];
	const seen = /* @__PURE__ */ new Set();
	for (const raw of refs) {
		const ref = raw.trim();
		if (ref === "") continue;
		const needle = ref.toLowerCase();
		let hit = nodes.find((n) => n.uuid.toLowerCase() === needle) ?? nodes.find((n) => n.name.trim().toLowerCase() === needle);
		if (hit === void 0) {
			const candidates = nodes.filter((n) => n.name.toLowerCase().includes(needle) || n.uuid.toLowerCase().includes(needle));
			if (candidates.length === 1) hit = candidates[0];
			else if (candidates.length > 1) {
				ambiguous.push({
					ref,
					candidates: candidates.map((n) => n.name + " (" + n.uuid + ")")
				});
				continue;
			}
		}
		if (hit === void 0) {
			unresolved.push(ref);
			continue;
		}
		if (seen.has(hit.uuid)) continue;
		seen.add(hit.uuid);
		matched.push({
			ref,
			uuid: hit.uuid,
			name: hit.name
		});
	}
	return {
		matched,
		unresolved,
		ambiguous
	};
}
/** Render the komari_list_nodes value as text. */
function renderListOutput(value) {
	const lines = ["Komari " + value.endpoint + " — " + String(value.total) + " machine(s): " + String(value.online) + " online, " + String(value.offline) + " offline"];
	if (value.warning !== void 0) lines.push("Warning: " + value.warning);
	lines.push("");
	for (const n of value.nodes) {
		const where = [n.group, n.region].filter(Boolean).join(" ");
		const parts = [
			(n.online ? "ONLINE  " : "OFFLINE ") + n.name,
			where === "" ? "" : "[" + where + "]",
			n.online ? "cpu " + n.cpu_percent.toFixed(1) + "%" : "",
			n.ram_total > 0 ? "mem " + formatBytes(n.ram_used) + "/" + formatBytes(n.ram_total) : "",
			n.disk_total > 0 ? "disk " + formatBytes(n.disk_used) + "/" + formatBytes(n.disk_total) : "",
			n.online ? "load " + n.load1.toFixed(2) : "",
			n.online ? "up " + formatDuration(n.uptime_seconds) : "",
			"up-total " + formatBytes(n.net_total_up) + "  down-total " + formatBytes(n.net_total_down)
		].filter((p) => p !== "");
		lines.push("- " + parts.join("  "));
		lines.push("  uuid: " + n.uuid + (n.memo === "" ? "" : "  |  " + n.memo.replace(/\s+/g, " ").slice(0, 80)));
	}
	return lines.join("\n");
}
/** Render the komari_upload_file value as text. */
function renderUploadOutput(value) {
	const lines = ["Komari upload " + value.status + ": " + value.local_path + " (" + formatBytes(value.bytes) + ")"];
	for (const a of value.ambiguous ?? []) lines.push("ambiguous node reference \"" + a.ref + "\": " + a.candidates.join(", "));
	if ((value.unresolved ?? []).length > 0) lines.push("unresolved node reference(s): " + (value.unresolved ?? []).join(", "));
	lines.push("");
	for (const r of value.results) lines.push(r.ok ? "ok   " + r.name + " (" + r.uuid + ")  " + formatBytes(r.bytes) : "FAIL " + r.name + " (" + r.uuid + ")  " + (r.error ?? "unknown error"));
	return lines.join("\n").trimEnd();
}
/** Render the komari_download_file value as text. */
function renderDownloadOutput(value) {
	return ["Komari download: " + value.node + ":" + value.remote_path, "saved to " + value.local_path + " (" + formatBytes(value.bytes) + ")"].join("\n");
}
/** Render the komari_exec value as text. */
function renderExecOutput(value) {
	const lines = ["Komari exec " + value.status + " (task " + value.task_id + ")", "command: " + value.command];
	if (value.message !== void 0) lines.push("note: " + value.message);
	for (const a of value.ambiguous ?? []) lines.push("ambiguous node reference \"" + a.ref + "\": " + a.candidates.join(", "));
	if ((value.unresolved ?? []).length > 0) lines.push("unresolved node reference(s): " + (value.unresolved ?? []).join(", "));
	if ((value.pending ?? []).length > 0) lines.push("still running on: " + (value.pending ?? []).join(", "));
	lines.push("");
	for (const r of value.results) {
		lines.push("=== " + r.name + " (" + r.uuid + ") exit=" + String(r.exit_code) + " ===");
		lines.push(r.output.trim() === "" ? "(no output)" : r.output.trimEnd());
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}
//#endregion
//#region src/transfer.ts
/**
* transfer.ts — local-file side of Komari file transfer (host half).
*
* Komari splits transfer into a control protocol and a raw byte stream:
*   upload   POST .../file/upload?operation=init  {path,size}       -> session + chunk_size
*            POST .../file/upload?operation=chunk&upload_id&chunk_index  <raw bytes>
*            POST .../file/upload?operation=merge {upload_id}
*            (cancel is issued as cleanup when any step fails)
*   download GET  .../file/download?path=<abs>                      -> 200 + file bytes
*
* Panel limits this module enforces or relies on: MaxUploadSize 8 GiB, chunk
* size 1 MiB..128 MiB (25 MiB default), upload sessions expire after 15 minutes,
* and every chunk's Content-Length must equal its exact expected size — so a
* chunk is read whole into memory and sent in one request.
*/
/** Panel-side hard limit on one uploaded file. */
const MAX_UPLOAD_BYTES = 8589934592;
/**
* Where a download lands when the caller names no destination.
* @param remotePath - remote path the file is read from.
* @returns an absolute path under the OS temp directory.
*/
function defaultDownloadPath(remotePath) {
	const name = basename(remotePath.replace(/\\/g, "/")) || "komari-download";
	return join(tmpdir(), "komari-downloads", name);
}
/**
* Read one chunk of a local file at an exact offset.
* @param handle - open file handle.
* @param offset - byte offset to read from.
* @param length - exact number of bytes to read.
* @returns the bytes read (always `length` long, or an error).
*/
async function readExact(handle, offset, length) {
	const buffer = Buffer.alloc(length);
	let filled = 0;
	while (filled < length) {
		const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
		if (bytesRead === 0) break;
		filled += bytesRead;
	}
	if (filled !== length) throw new KomariError(`local file shrank while reading: got ${String(filled)} of ${String(length)} bytes at offset ${String(offset)}`);
	return buffer;
}
/**
* Upload one local file to one machine through the panel's chunked protocol.
* @param client - authenticated panel client.
* @param uuid - target machine uuid.
* @param localPath - path on the machine running dsh.
* @param remotePath - absolute destination path on the target machine.
* @param signal - cancellation signal (also carries the transfer deadline).
* @returns bytes and chunk count actually sent.
*/
async function uploadLocalFile(client, uuid, localPath, remotePath, signal) {
	const info = await stat(localPath).catch((err) => {
		throw new KomariError(`cannot read local file ${localPath}: ${err instanceof Error ? err.message : String(err)}`);
	});
	if (!info.isFile()) throw new KomariError(`${localPath} is not a regular file`);
	if (info.size > 8589934592) throw new KomariError(`${localPath} is ${String(info.size)} bytes; the panel accepts at most ${String(MAX_UPLOAD_BYTES)}`);
	const session = await client.uploadInit(uuid, remotePath, info.size, signal);
	if (session.complete) return {
		bytes: 0,
		chunks: 0
	};
	const chunkSize = session.chunk_size;
	const chunkCount = session.chunk_count;
	const handle = await open(localPath, "r");
	try {
		for (let index = 0; index < chunkCount; index += 1) {
			signal?.throwIfAborted();
			const offset = index * chunkSize;
			const bytes = await readExact(handle, offset, Math.min(chunkSize, info.size - offset));
			await client.uploadChunk(uuid, session.upload_id, index, Uint8Array.from(bytes), signal);
		}
		await client.uploadMerge(uuid, session.upload_id, signal);
	} catch (err) {
		try {
			await client.uploadCancel(uuid, session.upload_id);
		} catch {}
		throw err;
	} finally {
		await handle.close();
	}
	return {
		bytes: info.size,
		chunks: chunkCount
	};
}
/**
* Download one remote file into the local filesystem, streaming it.
* @param client - authenticated panel client.
* @param uuid - source machine uuid.
* @param remotePath - absolute source path on that machine.
* @param destPath - local destination path (parent directories are created).
* @param signal - cancellation signal (also carries the transfer deadline).
* @returns bytes written plus the resolved path and response metadata.
*/
async function downloadToLocalFile(client, uuid, remotePath, destPath, signal) {
	const res = await client.downloadStream(uuid, remotePath, signal);
	if (!res.ok) throw new KomariError(`download of ${remotePath} failed (HTTP ${String(res.status)}): ${await client.transferError(res)}`);
	await mkdir(dirname(destPath), { recursive: true });
	const out = createWriteStream(destPath);
	let bytes = 0;
	try {
		const body = res.body;
		if (body === null) await new Promise((resolve, reject) => {
			out.end(() => resolve());
			out.once("error", reject);
		});
		else {
			const reader = body.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value === void 0) continue;
				bytes += value.byteLength;
				if (!out.write(Buffer.from(value.buffer, value.byteOffset, value.byteLength))) await once(out, "drain");
			}
			await new Promise((resolve, reject) => {
				out.end(() => resolve());
				out.once("error", reject);
			});
		}
	} catch (err) {
		out.destroy();
		throw err;
	}
	const disposition = res.headers.get("content-disposition") ?? "";
	const filename = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition)?.[1];
	return {
		bytes,
		path: destPath,
		content_type: res.headers.get("content-type"),
		filename: filename === void 0 ? null : decodeURIComponent(filename)
	};
}
//#endregion
//#region src/tools.ts
/** Name of the lazily-loaded toolset this plugin contributes. */
const TOOLSET_NAME = "komari";
/** Model-facing "when to use this toolset" statement (English, per toolsets contract). */
const TOOLSET_DESCRIPTION = "Query and operate the user's Komari monitoring panel: list monitored machines with live status, run shell commands on them, and move files between this machine and them. Load it whenever the user mentions Komari, a status panel, or one of their servers/machines by name.";
const DEFAULT_WAIT_SECONDS = 30;
const MAX_WAIT_SECONDS = 300;
const POLL_INTERVAL_MS = 1e3;
function textRender(fn) {
	return (_args, value) => [{
		type: "text",
		text: fn(value)
	}];
}
/** Await one poll interval, honoring cancellation. */
function delay(ms, signal) {
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error("aborted"));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
}
/**
* Register the Komari tools.
* Tools read the live client/config through getters, so a settings edit takes
* effect on the next call without re-registering anything.
* @param ctx - host context (tools is injected by the entry).
* @param getClient - live client getter.
* @param getConfig - live config getter.
*/
function buildKomariToolset(getClient, getConfig) {
	const client = () => getClient();
	const tools = [
		defineTool({
			name: "komari_list_nodes",
			description: "List the machines monitored by the configured Komari panel together with each one's latest live status (online flag, CPU %, load, memory/disk/swap usage, network totals, uptime, connections, temperature). Every entry carries the uuid and name that komari_exec accepts as a target. Returns endpoint, totals and nodes[].",
			parameters: {
				group: {
					type: "string",
					description: "Only return machines whose Komari group equals this value (exact match). Omit for all groups."
				},
				include_offline: {
					type: "boolean",
					description: "Include machines that are currently offline. Default: true."
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						endpoint: {
							type: "string",
							required: true,
							description: "Panel address the data came from."
						},
						total: {
							type: "integer",
							required: true,
							description: "Number of machines returned."
						},
						online: {
							type: "integer",
							required: true,
							description: "How many of them are online."
						},
						offline: {
							type: "integer",
							required: true,
							description: "How many of them are offline."
						},
						warning: {
							type: "string",
							description: "Set when live status could not be fetched (static data only)."
						},
						nodes: {
							type: "array",
							required: true,
							description: "One entry per machine.",
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									uuid: {
										type: "string",
										required: true,
										description: "Machine uuid (pass to komari_exec)."
									},
									name: {
										type: "string",
										required: true,
										description: "Machine display name."
									},
									group: {
										type: "string",
										description: "Komari group."
									},
									region: {
										type: "string",
										description: "Region flag/label."
									},
									tags: {
										type: "array",
										items: { type: "string" },
										description: "Tags."
									},
									online: {
										type: "boolean",
										required: true,
										description: "Whether the agent is currently online."
									},
									last_report: {
										type: "string",
										description: "ISO-8601 timestamp of the latest agent report; empty when none arrived."
									},
									uptime_seconds: {
										type: "integer",
										description: "Machine uptime in seconds."
									},
									cpu_percent: {
										type: "number",
										description: "CPU usage percent."
									},
									load1: {
										type: "number",
										description: "1-minute load average."
									},
									ram_used: {
										type: "integer",
										description: "Used memory in bytes."
									},
									ram_total: {
										type: "integer",
										description: "Total memory in bytes."
									},
									disk_used: {
										type: "integer",
										description: "Used disk in bytes."
									},
									disk_total: {
										type: "integer",
										description: "Total disk in bytes."
									},
									swap_used: {
										type: "integer",
										description: "Used swap in bytes."
									},
									swap_total: {
										type: "integer",
										description: "Total swap in bytes."
									},
									net_up_per_sec: {
										type: "integer",
										description: "Current upload rate in bytes/sec."
									},
									net_down_per_sec: {
										type: "integer",
										description: "Current download rate in bytes/sec."
									},
									net_total_up: {
										type: "integer",
										description: "Lifetime uploaded bytes."
									},
									net_total_down: {
										type: "integer",
										description: "Lifetime downloaded bytes."
									},
									tcp_connections: {
										type: "integer",
										description: "TCP connection count."
									},
									udp_connections: {
										type: "integer",
										description: "UDP connection count."
									},
									process_count: {
										type: "integer",
										description: "Process count."
									},
									temperature: {
										type: "number",
										description: "Temperature in Celsius (0 when unreported)."
									},
									os: {
										type: "string",
										description: "Operating system."
									},
									arch: {
										type: "string",
										description: "CPU architecture."
									},
									cpu_model: {
										type: "string",
										description: "CPU model."
									},
									virtualization: {
										type: "string",
										description: "Virtualization type."
									},
									gpu: {
										type: "string",
										description: "GPU model, empty when none."
									},
									memo: {
										type: "string",
										description: "Remark configured for this machine."
									}
								}
							}
						}
					}
				},
				render: textRender(renderListOutput)
			},
			timeoutMs: 6e4,
			execute: async (args, exec) => {
				const a = args;
				exec.signal.throwIfAborted();
				const endpoint = getConfig().endpoint;
				const nodes = await client().listNodes(exec.signal);
				let live = {};
				let warning;
				try {
					live = await client().latestStatus(exec.signal);
				} catch (err) {
					warning = "live status unavailable (" + (err instanceof Error ? err.message : String(err)) + "); static data only";
				}
				const group = typeof a.group === "string" && a.group !== "" ? a.group : void 0;
				const includeOffline = a.include_offline !== false;
				const summaries = nodes.filter((n) => group === void 0 ? true : n.group === group).map((n) => summarizeNode(n, live[n.uuid])).filter((s) => includeOffline || s.online).sort((x, y) => {
					if (x.online !== y.online) return x.online ? -1 : 1;
					const g = x.group.localeCompare(y.group);
					return g !== 0 ? g : x.name.localeCompare(y.name);
				});
				const out = {
					endpoint,
					total: summaries.length,
					online: summaries.filter((s) => s.online).length,
					offline: summaries.filter((s) => !s.online).length,
					nodes: summaries
				};
				if (warning !== void 0) out.warning = warning;
				return out;
			}
		}),
		defineTool({
			name: "komari_exec",
			description: "Run a shell command on one or more monitored machines through the Komari panel and return each machine's output and exit code. The command runs through the panel agent with that agent's privileges — root on most Linux nodes, the agent service account on Windows (PowerShell: avoid bash-only syntax such as \"&&\"). DANGEROUS: these are production machines and this tool executes for real. Before running anything destructive (restart, delete, edit configuration, install packages, or a batch command), state the exact plan and get explicit user confirmation first. Targets accept a uuid, an exact machine name, or a unique name substring; ambiguous or unknown references are reported and skipped. Waits up to wait_seconds for output and reports whatever is still running.",
			parameters: {
				command: {
					type: "string",
					required: true,
					description: "Shell command to execute on each target machine (sh on Linux, PowerShell on Windows)."
				},
				nodes: {
					type: "array",
					required: true,
					items: { type: "string" },
					description: "Target machines: a uuid, an exact name, or a unique name substring (e.g. [\"润才 腾讯 广州BGP\"])."
				},
				wait_seconds: {
					type: "integer",
					description: "How long to wait for results before returning what has landed. Default " + String(DEFAULT_WAIT_SECONDS) + ", max " + String(MAX_WAIT_SECONDS) + "."
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						task_id: {
							type: "string",
							description: "Komari task id (empty when nothing was submitted)."
						},
						command: {
							type: "string",
							required: true,
							description: "The command that was submitted."
						},
						status: {
							type: "string",
							required: true,
							description: "\"completed\" (every target reported), \"partial\" (some still running), or \"rejected\" (no valid target)."
						},
						message: {
							type: "string",
							description: "Why the submission was rejected, when status is \"rejected\"."
						},
						unresolved: {
							type: "array",
							items: { type: "string" },
							description: "Node references that matched no machine."
						},
						ambiguous: {
							type: "array",
							description: "Node references that matched several machines and were skipped.",
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									ref: {
										type: "string",
										required: true
									},
									candidates: {
										type: "array",
										required: true,
										items: { type: "string" }
									}
								}
							}
						},
						targets: {
							type: "array",
							required: true,
							description: "Machines the command was submitted to.",
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									uuid: {
										type: "string",
										required: true
									},
									name: {
										type: "string",
										required: true
									}
								}
							}
						},
						pending: {
							type: "array",
							items: { type: "string" },
							description: "Targets whose result had not arrived yet."
						},
						results: {
							type: "array",
							required: true,
							description: "Results that arrived within the wait window.",
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									uuid: {
										type: "string",
										required: true
									},
									name: {
										type: "string",
										required: true
									},
									exit_code: {
										type: "integer",
										required: true,
										description: "Exit code (-1 when the machine was offline)."
									},
									output: {
										type: "string",
										required: true,
										description: "Command output (stdout, often with stderr)."
									},
									finished_at: {
										type: "string",
										description: "ISO-8601 finish timestamp; empty when not reported yet."
									}
								}
							}
						}
					}
				},
				render: textRender(renderExecOutput)
			},
			timeoutMs: 32e4,
			execute: async (args, exec) => {
				const a = args;
				exec.signal.throwIfAborted();
				const command = a.command;
				const requested = Array.isArray(a.nodes) ? a.nodes : [];
				const waitSeconds = Math.min(Math.max(1, typeof a.wait_seconds === "number" && Number.isFinite(a.wait_seconds) ? Math.floor(a.wait_seconds) : DEFAULT_WAIT_SECONDS), MAX_WAIT_SECONDS);
				const resolved = resolveNodeRefs(requested, await client().listNodes(exec.signal));
				const targets = resolved.matched.map((m) => ({
					uuid: m.uuid,
					name: m.name
				}));
				if (targets.length === 0) return {
					task_id: "",
					command,
					status: "rejected",
					message: resolved.ambiguous.length > 0 ? "ambiguous node reference(s): " + resolved.ambiguous.map((x) => "\"" + x.ref + "\" matches " + x.candidates.join(", ")).join("; ") : "no machine matched: " + resolved.unresolved.join(", "),
					unresolved: resolved.unresolved,
					ambiguous: resolved.ambiguous,
					targets,
					pending: [],
					results: []
				};
				const submitted = await client().exec(command, targets.map((t) => t.uuid), exec.signal);
				const nameOf = new Map(targets.map((t) => [t.uuid, t.name]));
				const deadline = Date.now() + waitSeconds * 1e3;
				let collected = [];
				let expected = targets.length;
				for (;;) {
					exec.signal.throwIfAborted();
					const task = await client().task(submitted.task_id, exec.signal);
					expected = task.clients.length > 0 ? task.clients.length : targets.length;
					collected = task.results.map((r) => ({
						uuid: r.client,
						name: nameOf.get(r.client) ?? r.client,
						exit_code: r.exit_code,
						output: r.result,
						finished_at: r.finished_at ?? ""
					}));
					if (collected.length >= expected || Date.now() >= deadline) break;
					await delay(POLL_INTERVAL_MS, exec.signal);
				}
				const done = new Set(collected.map((r) => r.uuid));
				const pending = targets.map((t) => t.uuid).filter((uuid) => !done.has(uuid));
				return {
					task_id: submitted.task_id,
					command,
					status: pending.length === 0 ? "completed" : "partial",
					unresolved: resolved.unresolved,
					ambiguous: resolved.ambiguous,
					targets,
					pending,
					results: collected.sort((x, y) => x.name.localeCompare(y.name))
				};
			}
		}),
		defineTool({
			name: "komari_upload_file",
			description: "Copy a file from THIS machine (where dsh runs) to one or more monitored machines, using the Komari panel's chunked upload stream. Files up to 8 GiB are accepted; large files are sent in chunks and the remote path is created or overwritten. DANGEROUS: this overwrites the destination path on production machines; get explicit user confirmation before replacing an existing file. Targets accept a uuid, an exact machine name, or a unique name substring; ambiguous or unknown references are reported and skipped.",
			parameters: {
				local_path: {
					type: "string",
					required: true,
					description: "Path of the source file on the machine running dsh (absolute, or relative to the dsh working directory)."
				},
				remote_path: {
					type: "string",
					required: true,
					description: "Absolute destination path on the target machine(s), e.g. /root/app.tar.gz or C:\\Temp\\app.zip."
				},
				nodes: {
					type: "array",
					required: true,
					items: { type: "string" },
					description: "Target machines: a uuid, an exact name, or a unique name substring."
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						local_path: {
							type: "string",
							required: true,
							description: "Source path that was read."
						},
						remote_path: {
							type: "string",
							required: true,
							description: "Destination path on the target machines."
						},
						bytes: {
							type: "integer",
							required: true,
							description: "Size of the local file in bytes."
						},
						status: {
							type: "string",
							required: true,
							description: "\"uploaded\" (every target succeeded), \"partial\" (some failed), or \"rejected\" (no valid target)."
						},
						message: {
							type: "string",
							description: "Why the transfer was rejected, when status is \"rejected\"."
						},
						unresolved: {
							type: "array",
							items: { type: "string" },
							description: "Node references that matched no machine."
						},
						ambiguous: {
							type: "array",
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									ref: {
										type: "string",
										required: true
									},
									candidates: {
										type: "array",
										required: true,
										items: { type: "string" }
									}
								}
							}
						},
						results: {
							type: "array",
							required: true,
							description: "One entry per targeted machine.",
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									uuid: {
										type: "string",
										required: true
									},
									name: {
										type: "string",
										required: true
									},
									ok: {
										type: "boolean",
										required: true,
										description: "Whether this machine received the file."
									},
									bytes: {
										type: "integer",
										required: true,
										description: "Bytes written on this machine (0 on failure)."
									},
									chunks: {
										type: "integer",
										description: "Chunk count sent to this machine."
									},
									error: {
										type: "string",
										description: "Failure reason for this machine."
									}
								}
							}
						}
					}
				},
				render: textRender(renderUploadOutput)
			},
			timeoutMs: 9e5,
			execute: async (args, exec) => {
				const a = args;
				exec.signal.throwIfAborted();
				const localPath = a.local_path;
				const remotePath = a.remote_path;
				const resolved = resolveNodeRefs(Array.isArray(a.nodes) ? a.nodes : [], await client().listNodes(exec.signal));
				if (resolved.matched.length === 0) return {
					local_path: localPath,
					remote_path: remotePath,
					bytes: 0,
					status: "rejected",
					message: resolved.ambiguous.length > 0 ? "ambiguous node reference(s): " + resolved.ambiguous.map((x) => "\"" + x.ref + "\" matches " + x.candidates.join(", ")).join("; ") : "no machine matched: " + resolved.unresolved.join(", "),
					unresolved: resolved.unresolved,
					ambiguous: resolved.ambiguous,
					results: []
				};
				const link = linkTimeout(exec.signal, getConfig().transferTimeoutMs);
				const results = [];
				let total = 0;
				try {
					for (const target of resolved.matched) {
						exec.signal.throwIfAborted();
						try {
							const outcome = await uploadLocalFile(client(), target.uuid, localPath, remotePath, link.signal);
							total = outcome.bytes;
							results.push({
								uuid: target.uuid,
								name: target.name,
								ok: true,
								bytes: outcome.bytes,
								chunks: outcome.chunks
							});
						} catch (err) {
							results.push({
								uuid: target.uuid,
								name: target.name,
								ok: false,
								bytes: 0,
								error: err instanceof Error ? err.message : String(err)
							});
						}
					}
				} finally {
					link.dispose();
				}
				const failed = results.filter((r) => !r.ok).length;
				return {
					local_path: localPath,
					remote_path: remotePath,
					bytes: total,
					status: failed === 0 ? "uploaded" : "partial",
					unresolved: resolved.unresolved,
					ambiguous: resolved.ambiguous,
					results
				};
			}
		}),
		defineTool({
			name: "komari_download_file",
			description: "Copy a file from one monitored machine to THIS machine (where dsh runs), through the Komari panel's binary download stream. The bytes are streamed to disk; the response metadata (resolved filename and content type) is reported back. Directories cannot be downloaded. Targets accept a uuid, an exact machine name, or a unique name substring.",
			parameters: {
				remote_path: {
					type: "string",
					required: true,
					description: "Absolute source path on the target machine, e.g. /var/log/syslog."
				},
				node: {
					type: "string",
					required: true,
					description: "Source machine: a uuid, an exact name, or a unique name substring."
				},
				local_path: {
					type: "string",
					description: "Where to write the file locally. Defaults to a komari-downloads/ folder in the OS temp directory."
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						node: {
							type: "string",
							required: true,
							description: "Machine name the file was read from."
						},
						uuid: {
							type: "string",
							required: true,
							description: "Machine uuid."
						},
						remote_path: {
							type: "string",
							required: true,
							description: "Source path that was read."
						},
						local_path: {
							type: "string",
							required: true,
							description: "Local path the file was written to."
						},
						bytes: {
							type: "integer",
							required: true,
							description: "Bytes written locally."
						},
						content_type: {
							type: "string",
							description: "Content type reported by the panel."
						},
						filename: {
							type: "string",
							description: "Filename reported by the panel."
						}
					}
				},
				render: textRender(renderDownloadOutput)
			},
			timeoutMs: 9e5,
			execute: async (args, exec) => {
				const a = args;
				exec.signal.throwIfAborted();
				const all = await client().listNodes(exec.signal);
				const resolved = resolveNodeRefs([a.node], all);
				if (resolved.matched.length === 0) {
					const detail = resolved.ambiguous.length > 0 ? "ambiguous node reference: " + resolved.ambiguous.map((x) => "\"" + x.ref + "\" matches " + x.candidates.join(", ")).join("; ") : "no machine matched: " + resolved.unresolved.join(", ");
					throw new Error("komari_download_file: " + detail);
				}
				const target = resolved.matched[0];
				if (target === void 0) throw new Error("komari_download_file: no machine matched");
				const dest = typeof a.local_path === "string" && a.local_path !== "" ? a.local_path : defaultDownloadPath(a.remote_path);
				const link = linkTimeout(exec.signal, getConfig().transferTimeoutMs);
				try {
					const outcome = await downloadToLocalFile(client(), target.uuid, a.remote_path, dest, link.signal);
					const out = {
						node: target.name,
						uuid: target.uuid,
						remote_path: a.remote_path,
						local_path: outcome.path,
						bytes: outcome.bytes
					};
					if (outcome.content_type !== null) out.content_type = outcome.content_type;
					if (outcome.filename !== null) out.filename = outcome.filename;
					return out;
				} finally {
					link.dispose();
				}
			}
		})
	];
	return {
		name: TOOLSET_NAME,
		description: TOOLSET_DESCRIPTION,
		tools
	};
}
/**
* Contribute the Komari tools as one lazily-loaded toolset: they stay out of the
* global tool list until the model calls `get_tools("komari")`, and the model
* sees {@link TOOLSET_DESCRIPTION} as the when-to-use line instead.
* @param ctx - host context (`toolsets` is injected by the entry).
* @param getClient - live client getter.
* @param getConfig - live config getter.
*/
function registerTools(ctx, getClient, getConfig) {
	ctx.toolsets.register(buildKomariToolset(getClient, getConfig));
}
//#endregion
//#region src/rpc.ts
/** Wire endpoint this route owns; the client calls \`rpc.call('/api', 'komari.probe', {})\`. */
const PROBE_ENDPOINT = "komari.probe";
function ok(value) {
	return {
		ok: true,
		value
	};
}
function fail(message) {
	return {
		ok: false,
		error: {
			code: "internal",
			message,
			details: {}
		}
	};
}
function envelopeResponse(rpcId, result) {
	return new Response(JSON.stringify({
		type: "server-response",
		rpcId,
		result
	}), {
		status: 200,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store"
		}
	});
}
/**
* Register the \`komari.probe\` exact Fetch route on the host's connection service.
* @param ctx - host context (\`connection\` is injected by the entry).
* @param deps - live client getter (sees the latest accepted config).
*/
function registerRpc(ctx, deps) {
	ctx.logger.info(`dsh-komari: registering ${API_PATH}/${PROBE_ENDPOINT} Fetch route`);
	ctx.effect(() => ctx.connection.fetch.register({
		path: `${API_PATH}/${PROBE_ENDPOINT}`,
		methods: ["POST"],
		requestBody: "buffered",
		fetch: async (request) => {
			if (request.method !== "POST") return new Response("not found", { status: 404 });
			if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return new Response("content type must be application/json", { status: 415 });
			let body;
			try {
				body = await request.json();
			} catch {
				return new Response("body is not JSON", { status: 400 });
			}
			const envelope = body;
			if (envelope === null || typeof envelope !== "object" || envelope.type !== "client-request" || typeof envelope.rpcId !== "string" || envelope.rpcId === "" || typeof envelope.method !== "string") return envelopeResponse("invalid-request", fail("invalid client-request message"));
			if (envelope.method !== "komari.probe") return envelopeResponse(envelope.rpcId, fail(`method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(PROBE_ENDPOINT)}`));
			try {
				const probe = await deps.getClient().probe(request.signal);
				return envelopeResponse(envelope.rpcId, ok({
					node_count: probe.node_count,
					online_count: probe.online_count
				}));
			} catch (err) {
				return envelopeResponse(envelope.rpcId, fail(err instanceof Error ? err.message : String(err)));
			}
		}
	}), `dsh-komari: ${API_PATH}/${PROBE_ENDPOINT} Fetch route`);
}
//#endregion
//#region src/index.ts
/**
* index.ts — dsh-komari cordis plugin entry (host half).
*
* Bundle-style DSH plugin: one cordis.patch.yml row, no DSH source patches.
* The browser half ships via \`./client\` (see src/client/index.ts).
*
* Architecture:
*   - Two model-facing tools (komari_list_nodes, komari_exec) registered once
*     at load; each reads the live config/client through getters, so a settings
*     edit takes effect on the next call without re-registration.
*   - Settings ARE the profile-owned Cordis Config: endpoint / username /
*     password / requestTimeoutMs are \`.volatile()\`, so \`apply\` receives live
*     references whose \`.get()\` always returns the latest accepted value. Edits
*     made on the plugin's configure page (Settings -> Plugins) persist per
*     profile in \`cordis.patch.yml\` under the entry id \`dsh-komari\` and update
*     those references in place — the entry is never remounted.
*   - \`settings.configure({ auto: false })\` suppresses the schema-generated form,
*     because this plugin ships its own \`plugins.row.config\` card.
*   - One RPC route (\`komari.probe\`) backs the card's "Test connection" button.
*
* An empty endpoint is a legal state (first boot, before the user configures
* the panel): the plugin loads, tools report a clear "not configured" error,
* and the settings card is where the address gets filled in.
*/
const name = "dsh-komari";
const inject = ["toolsets", "connection"];
/**
* Schemastery schema for the plugin's profile-owned Config.
* Every user-editable field is \`.volatile()\`; the defaults below are the
* composition-layer seed, and a committed settings edit updates the running
* reference in place.
*/
const Config = z.object({
	endpoint: z.string().default("").description("Komari panel address, e.g. https://status.example.com (a trailing /api or /api/v1 is ignored).").volatile(),
	username: z.string().default("").description("Komari panel account name. Must have administrator rights (remote execution is admin-only).").volatile(),
	password: z.string().default("").description("Komari panel account password. Stored in the active profile's cordis.patch.yml (plain text).").volatile(),
	requestTimeoutMs: z.number().default(15e3).description("HTTP timeout for one panel request, in milliseconds.").volatile(),
	transferTimeoutMs: z.number().default(6e5).description("Upper bound for one whole file upload/download, in milliseconds.").volatile()
});
/** Read the current value of a volatile (or plain, in hand-built contexts) field. */
function live(ref) {
	if (typeof ref === "object" && ref !== null && typeof ref.get === "function") return ref.get();
	return ref;
}
function resolveConfig(entry) {
	return {
		endpoint: normalizeEndpoint(live(entry.endpoint) ?? ""),
		username: (live(entry.username) ?? "").trim(),
		password: live(entry.password) ?? "",
		requestTimeoutMs: live(entry.requestTimeoutMs) ?? 15e3,
		transferTimeoutMs: live(entry.transferTimeoutMs) ?? 6e5
	};
}
function toConnection(resolved) {
	return {
		endpoint: resolved.endpoint,
		username: resolved.username,
		password: resolved.password,
		timeoutMs: resolved.requestTimeoutMs
	};
}
function apply(ctx, config = {}) {
	let resolved = resolveConfig(config);
	let client = new KomariClient(toConnection(resolved));
	const getResolved = () => {
		const next = resolveConfig(config);
		if (next.endpoint !== resolved.endpoint || next.username !== resolved.username || next.password !== resolved.password || next.requestTimeoutMs !== resolved.requestTimeoutMs || next.transferTimeoutMs !== resolved.transferTimeoutMs) {
			resolved = next;
			client = new KomariClient(toConnection(next));
			ctx.logger.info(`dsh-komari: configuration updated (endpoint=${next.endpoint === "" ? "(unset)" : next.endpoint})`);
		}
		return resolved;
	};
	const getClient = () => {
		getResolved();
		return client;
	};
	if (resolved.endpoint === "") ctx.logger.warn("dsh-komari: panel address is not configured yet — set it on the plugin configure page (Settings -> Plugins -> dsh-komari).");
	registerTools(ctx, getClient, getResolved);
	ctx.inject(["settings"], (sctx) => {
		sctx.effect(() => {
			try {
				return sctx.settings.configure({ auto: false }, ctx.fiber);
			} catch (err) {
				ctx.logger.debug(`dsh-komari: settings policy already configured (${err instanceof Error ? err.message : String(err)})`);
				return () => {};
			}
		});
	});
	registerRpc(ctx, { getClient });
}
//#endregion
export { Config, apply, inject, name };
