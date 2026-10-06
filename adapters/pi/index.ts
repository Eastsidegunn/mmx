import { spawn as nodeSpawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { Type } from "typebox";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MIN_MMX = [0, 4, 0] as const;
const DEFAULT_WAIT_SECONDS = 120;
const WATCH_INTERVAL_MS = 200;
const BURST_DEBOUNCE_MS = 1000;
const AUTO_TRIGGER_CAP = 3;

type ExecResult = { stdout?: string; stderr?: string; code?: number | null; killed?: boolean; signal?: string | null };
type ExecOptions = { cwd?: string; signal?: AbortSignal; timeout?: number };
type SpawnLike = (command: string, args: string[], options: Record<string, unknown>) => ChildProcess;
type OpenBrowser = (url: string) => Promise<void> | void;

export type MmxExtensionDeps = {
	spawn?: SpawnLike;
	openBrowser?: OpenBrowser;
	watchIntervalMs?: number;
	debounceMs?: number;
};

export class MmxError extends Error {
	kind?: string;
	line?: number;
	column?: number;
	code?: number | null;

	constructor(message: string, fields: Partial<Pick<MmxError, "kind" | "line" | "column" | "code">> = {}) {
		super(message);
		this.name = "MmxError";
		Object.assign(this, fields);
	}
}

type Diff = {
	baseline?: boolean;
	error?: { kind?: string; message?: string; line?: number; column?: number } | null;
	by?: string;
	note?: string | null;
	[key: string]: unknown;
};

type HumanTurn = { path: string; entry: Record<string, unknown>; line: string };

type DiagramState = {
	path: string;
	logPath: string;
	offset: number;
	tail: Buffer;
	timer?: NodeJS.Timeout;
};

type ServeState = { path: string; child: ChildProcess; url: string };

const renderParams = Type.Object({
	path: Type.String({ description: "Path to the Mermaid .mmd diagram (relative to the project)" }),
	note: Type.Optional(Type.String({ description: "What changed and why; a non-empty note always makes an mmx turn" })),
});

const waitParams = Type.Object({
	path: Type.String({ description: "Path to the Mermaid .mmd diagram (relative to the project)" }),
	timeoutSeconds: Type.Optional(Type.Number({ description: "Seconds to wait; defaults to 120" })),
});

function stripAt(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

function absolutePath(cwd: string, input: string): string {
	const value = stripAt(input).trim();
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
	return resolve(cwd, value);
}

function siblingPath(input: string, suffix: string): string {
	const extension = extname(input);
	return join(dirname(input), `${basename(input, extension)}.${suffix}`);
}

function compareVersion(version: string): boolean {
	const match = version.match(/(?:mmx\s+)?(\d+)\.(\d+)\.(\d+)/i);
	if (!match) return false;
	const got = [Number(match[1]), Number(match[2]), Number(match[3])];
	for (let i = 0; i < MIN_MMX.length; i += 1) {
		if (got[i] !== MIN_MMX[i]) return got[i] > MIN_MMX[i];
	}
	return true;
}

function textContent(text: string) {
	return { type: "text" as const, text };
}

async function sourceSha256(path: string): Promise<string> {
	return createHash("sha256").update(await fs.readFile(path)).digest("hex");
}

async function readDiff(path: string): Promise<Diff | undefined> {
	try {
		return JSON.parse(await fs.readFile(siblingPath(path, "diff.json"), "utf8")) as Diff;
	} catch {
		return undefined;
	}
}

function formatParseError(diff: Diff | undefined, fallback: string): MmxError {
	const error = diff?.error;
	const kind = error?.kind ?? "parse";
	const message = error?.message ?? fallback;
	const hasLocation = error?.line && new RegExp(`\\bline\\s+${error.line}\\b`, "i").test(message);
	const location = error?.line && !hasLocation ? ` (line ${error.line}${error.column ? `, column ${error.column}` : ""})` : "";
	return new MmxError(`${kind}: ${message}${location}. Fix the Mermaid diagram and try again.`, {
		kind,
		line: error?.line,
		column: error?.column,
		code: 2,
	});
}

function commandError(result: ExecResult, command: string): MmxError {
	const detail = (result.stderr ?? result.stdout ?? "").trim();
	return new MmxError(`${command} failed${detail ? `: ${detail}` : ""}`, { code: result.code });
}

function defaultBrowserOpener(url: string): Promise<void> {
	const platform = process.platform;
	const command = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
	const options: Record<string, unknown> = { stdio: "ignore", detached: true };
	if (platform === "win32") options.shell = true;
	return new Promise((resolvePromise, reject) => {
		try {
			const child = nodeSpawn(command, [url], options as never);
			child.once("error", reject);
			child.once("spawn", () => {
				child.unref();
				resolvePromise();
			});
		} catch (error) {
			reject(error);
		}
	});
}

function parseUrl(text: string): string | undefined {
	return text.match(/https?:\/\/[^\s\r\n]+/)?.[0];
}

function configPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "mmx.json");
}

async function configuredDiagrams(cwd: string, trusted: boolean): Promise<string[]> {
	if (!trusted) return [];
	try {
		const parsed = JSON.parse(await fs.readFile(configPath(cwd), "utf8")) as { diagrams?: unknown };
		if (!Array.isArray(parsed.diagrams)) return [];
		return parsed.diagrams.filter((value): value is string => typeof value === "string");
	} catch {
		return [];
	}
}

function isAborted(result: ExecResult, signal?: AbortSignal): boolean {
	return Boolean(signal?.aborted || result.killed || result.signal);
}

function abortedError(): MmxError {
	return new MmxError("mmx operation aborted", { code: null });
}

type LogMark = { lines: number; last?: Record<string, unknown> };

async function readLogMark(path: string): Promise<LogMark> {
	try {
		const text = await fs.readFile(path, "utf8");
		const lines = text.split(/\r?\n/).filter(Boolean);
		let last: Record<string, unknown> | undefined;
		try {
			if (lines.length) last = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
		} catch {
			// A partial final line is not a committed turn.
		}
		return { lines: lines.length, last };
	} catch {
		return { lines: 0 };
	}
}

function listLabels(items: unknown, field = "label"): string[] {
	if (!Array.isArray(items)) return [];
	const labels = items.slice(0, 20).map((item) => {
		if (!item || typeof item !== "object") return String(item);
		const object = item as Record<string, unknown>;
		if (object.old !== undefined || object.new !== undefined) {
			const anchor = object.id ?? object.key ?? "?";
			return `${String(anchor)}: ${String(object.old ?? "∅")} → ${String(object.new ?? "∅")}`;
		}
		const value = object[field] ?? object.id ?? object.key;
		return String(value ?? "?");
	});
	if (items.length > 20) labels.push(`+${items.length - 20} more`);
	return labels;
}

function diffSummary(diff: Diff | undefined): string {
	if (!diff) return "diagram change";
	const parts: string[] = [];
	for (const sectionName of ["nodes", "edges", "subgraphs"] as const) {
		const section = diff[sectionName] as Record<string, unknown> | undefined;
		if (!section) continue;
		for (const change of ["added", "removed", "changed"] as const) {
			const raw = section[change];
			const values = listLabels(raw);
			if (values.length) {
				const count = Array.isArray(raw) ? raw.length : values.length;
				parts.push(`${change === "added" ? "+" : change === "removed" ? "-" : "~"}${count} ${sectionName} (${values.join(", ")})`);
			}
		}
	}
	if (diff.direction && typeof diff.direction === "object") parts.push(`direction ${JSON.stringify(diff.direction)}`);
	if (diff.source_hunks && Array.isArray(diff.source_hunks) && diff.source_hunks.length) parts.push("source text changed");
	return parts.join("; ") || (diff.baseline ? "baseline" : diff.source_changed ? "source changed" : "no semantic change");
}

function compactDiff(diff: Diff | undefined): Diff | undefined {
	if (!diff) return undefined;
	const copy = JSON.parse(JSON.stringify(diff)) as Diff;
	if (Array.isArray(copy.source_hunks)) {
		let remaining = 60;
		copy.source_hunks = copy.source_hunks.map((hunk) => {
			if (remaining <= 0) return { ...hunk, lines: [] };
			const lines = Array.isArray(hunk.lines) ? hunk.lines.slice(0, remaining) : [];
			remaining -= lines.length;
			return { ...hunk, lines };
		}).filter((hunk) => Array.isArray(hunk.lines) && hunk.lines.length);
		if (remaining <= 0) copy.source_hunks_truncated = true;
	}
	for (const sectionName of ["nodes", "edges", "subgraphs"] as const) {
		const section = copy[sectionName] as Record<string, unknown> | undefined;
		if (!section) continue;
		for (const change of ["added", "removed", "changed"] as const) {
			const values = section[change];
			if (Array.isArray(values) && values.length > 20) {
				section[change] = [...values.slice(0, 20), { __mmx_truncated__: `+${values.length - 20} more` }];
			}
		}
	}
	return copy;
}

function relativeDiagramPath(cwd: string, path: string): string {
	const value = relative(cwd, path);
	return value && !value.startsWith("..") ? value : path;
}

function humanTurnMessage(cwd: string, turn: HumanTurn): string {
	const path = relativeDiagramPath(cwd, turn.path);
	const diff = turn.entry.diff as Diff | undefined;
	const note = turn.entry.note ?? diff?.note ?? "";
	const who = String(turn.entry.by ?? "human");
	return [
		`The human changed ${path}. Read the change below, answer by editing the diagram and calling mmx_render with a note.`,
		`${who} turn${note ? `, note: ${String(note)}` : ""}: ${diffSummary(diff)}`,
		JSON.stringify(compactDiff(diff ?? turn.entry)),
	].join("\n");
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

export function createMmxExtension(pi: ExtensionAPI, deps: MmxExtensionDeps = {}) {
	const spawnProcess = deps.spawn ?? ((command, args, options) => nodeSpawn(command, args, options as never));
	const openBrowser = deps.openBrowser ?? defaultBrowserOpener;
	const watchIntervalMs = deps.watchIntervalMs ?? WATCH_INTERVAL_MS;
	const debounceMs = deps.debounceMs ?? BURST_DEBOUNCE_MS;
	const diagrams = new Map<string, DiagramState>();
	const serves = new Map<string, ServeState>();
	const pendingTurns: HumanTurn[] = [];
	const dirtyPaths = new Map<string, string>();
	let pendingTimer: NodeJS.Timeout | undefined;
	let sessionStarted = false;
	let mmxError: string | undefined;
	let unavailableNotified = false;
	let autoTriggerCount = 0;
	let lastContext: ExtensionContext | undefined;

	const exec = async (args: string[], options: ExecOptions = {}): Promise<ExecResult> => {
		return pi.exec("mmx", args, options) as Promise<ExecResult>;
	};

	const unavailableMessage = () =>
		mmxError ?? "mmx is unavailable. Install mmx 0.4.0 or newer and ensure `mmx` is on PATH (see the mmx repository's INSTALL.md).";

	const notifyUnavailable = (ctx?: ExtensionContext) => {
		if (!ctx) return;
		if (unavailableNotified) return;
		unavailableNotified = true;
		notify(ctx, unavailableMessage(), "warning");
	};

	const ensureMmx = async (ctx?: ExtensionContext, signal?: AbortSignal) => {
		if (signal?.aborted) throw abortedError();
		mmxError = undefined;
		try {
			const result = await exec(["--version"], { signal });
			if (isAborted(result, signal)) throw abortedError();
			const versionText = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
			if (result.code !== 0 || !compareVersion(versionText)) {
				mmxError = `mmx 0.4.0 or newer is required (found ${versionText.trim() || "none"}). Install mmx 0.4.0 or newer and ensure \`mmx\` is on PATH (see the mmx repository's INSTALL.md).`;
			}
		} catch (error) {
			if (signal?.aborted) throw abortedError();
			if (error instanceof MmxError && error.message.includes("aborted")) throw error;
			mmxError = `mmx is unavailable: ${error instanceof Error ? error.message : String(error)}. Install mmx 0.4.0 or newer and ensure \`mmx\` is on PATH (see the mmx repository's INSTALL.md).`;
		}
		if (mmxError) {
			notifyUnavailable(ctx);
			throw new MmxError(unavailableMessage());
		}
	};

	const scanDiagram = async (state: DiagramState) => {
		let stat;
		try {
			stat = await fs.stat(state.logPath);
		} catch {
			return;
		}
		if (stat.size < state.offset) {
			// mmx may compact a large log. Do not replay its retained history.
			state.offset = stat.size;
			state.tail = Buffer.alloc(0);
			return;
		}
		if (stat.size === state.offset) return;
		const handle = await fs.open(state.logPath, "r");
		try {
			const length = stat.size - state.offset;
			const chunk = Buffer.alloc(length);
			await handle.read(chunk, 0, length, state.offset);
			state.offset = stat.size;
			const bytes = Buffer.concat([state.tail, chunk]);
			let start = 0;
			for (;;) {
				const end = bytes.indexOf(10, start);
				if (end < 0) break;
				const line = bytes.subarray(start, end).toString("utf8").trim();
				start = end + 1;
				if (!line) continue;
				let entry: Record<string, unknown>;
				try {
					entry = JSON.parse(line) as Record<string, unknown>;
				} catch {
					continue;
				}
				if (entry.by !== "human") continue;
				pendingTurns.push({ path: state.path, entry, line });
			}
			state.tail = bytes.subarray(start);
		} finally {
			await handle.close();
		}
		await refreshDirty(state.path);
		if (sessionStarted && pendingTurns.length && !pendingTimer) {
			pendingTimer = setTimeout(() => {
				pendingTimer = undefined;
				void flushHumanTurns();
			}, debounceMs);
		}
	};

	const trackDiagram = async (path: string, skipHistory: boolean) => {
		if (diagrams.has(path)) return;
		const state: DiagramState = {
			path,
			logPath: siblingPath(path, "turns.jsonl"),
			offset: 0,
			tail: Buffer.alloc(0),
		};
		if (skipHistory) {
			try {
				state.offset = (await fs.stat(state.logPath)).size;
			} catch {
				state.offset = 0;
			}
		}
		diagrams.set(path, state);
		if (sessionStarted) {
			state.timer = setInterval(() => void scanDiagram(state), watchIntervalMs);
			void scanDiagram(state);
		}
	};

	const flushHumanTurns = async () => {
		if (!pendingTurns.length) return;
		const batch = pendingTurns.splice(0, pendingTurns.length);
		const summaries = batch.map((turn) => humanTurnMessage(lastContext?.cwd ?? dirname(turn.path), turn)).join("\n\n");
		const details = { diagrams: [...new Set(batch.map((turn) => turn.path))], turns: batch.map((turn) => turn.entry) };
		if (autoTriggerCount < AUTO_TRIGGER_CAP) {
			autoTriggerCount += 1;
			pi.sendMessage(
				{ customType: "mmx-turn", content: summaries, display: true, details },
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} else {
			pi.sendMessage({ customType: "mmx-turn", content: summaries, display: true, details }, { deliverAs: "nextTurn" });
			if (lastContext) notify(lastContext, "mmx human turn queued for the next prompt (automatic-turn cap reached).", "warning");
		}
	};

	const clearPendingForPath = (path: string) => {
		for (let i = pendingTurns.length - 1; i >= 0; i -= 1) {
			if (pendingTurns[i].path === path) pendingTurns.splice(i, 1);
		}
		if (!pendingTurns.length && pendingTimer) {
			clearTimeout(pendingTimer);
			pendingTimer = undefined;
		}
	};

	const advanceWatcherPastCurrentLog = async (path: string) => {
		const state = diagrams.get(path);
		if (!state) return;
		try {
			state.offset = (await fs.stat(state.logPath)).size;
		} catch {
			state.offset = 0;
		}
		state.tail = Buffer.alloc(0);
		clearPendingForPath(path);
	};

	const committedSourceSha = async (path: string): Promise<string | undefined> => {
		try {
			const state = JSON.parse(await fs.readFile(siblingPath(path, "state.json"), "utf8")) as { source_sha256?: unknown };
			if (typeof state.source_sha256 === "string") return state.source_sha256;
		} catch {
			// Fall through to the turn log for older or partially written state.
		}
		const mark = await readLogMark(siblingPath(path, "turns.jsonl"));
		return typeof mark.last?.source_sha256 === "string" ? mark.last.source_sha256 : undefined;
	};

	const refreshDirty = async (path: string): Promise<boolean> => {
		if (!dirtyPaths.has(path)) return false;
		try {
			const current = await sourceSha256(path);
			if (current === await committedSourceSha(path)) {
				dirtyPaths.delete(path);
				return false;
			}
			dirtyPaths.set(path, current);
			return true;
		} catch {
			return true;
		}
	};

	const markDirty = async (path: string) => {
		try {
			const current = await sourceSha256(path);
			if (current === await committedSourceSha(path)) dirtyPaths.delete(path);
			else dirtyPaths.set(path, current);
		} catch {
			// Validation already reported any relevant read/parse failure.
		}
	};

	const stopWatcher = (path?: string) => {
		const targets = path ? [path] : [...diagrams.keys()];
		for (const target of targets) {
			const state = diagrams.get(target);
			if (state?.timer) clearInterval(state.timer);
			diagrams.delete(target);
			clearPendingForPath(target);
		}
	};

	const render = async (path: string, note: string | undefined, ctx: ExtensionContext, signal?: AbortSignal) => {
		if (signal?.aborted) throw abortedError();
		await ensureMmx(ctx, signal);
		if (signal?.aborted) throw abortedError();
		const logPath = siblingPath(path, "turns.jsonl");
		const before = await readLogMark(logPath);
		const args = ["render", path, "--by", "agent"];
		if (note !== undefined) args.push("--note", note);
		args.push("--print-if-changed");
		const result = await exec(args, { cwd: ctx.cwd, signal });
		if (isAborted(result, signal)) throw abortedError();
		if (result.code === 2) throw formatParseError(await readDiff(path), result.stderr ?? "mmx could not parse the diagram");
		if (result.code !== 0) throw commandError(result, "mmx render");
		await trackDiagram(path, true);
		const after = await readLogMark(logPath);
		const appended: Record<string, unknown>[] = [];
		if (after.lines > before.lines) {
			try {
				for (const line of (await fs.readFile(logPath, "utf8")).split(/\r?\n/).filter(Boolean).slice(before.lines)) {
					try { appended.push(JSON.parse(line) as Record<string, unknown>); } catch { /* partial line */ }
				}
			} catch { /* log may have been rotated */ }
		}
		const matches = appended.filter((entry) => entry.by === "agent" && (note === undefined || entry.note === note));
		if (matches.length === 1) {
			const entry = matches[0];
			const entryDiff = entry.diff as Diff | undefined;
			dirtyPaths.delete(path);
			const previous = before.last;
			if (note && entryDiff?.source_changed === false && previous?.by === "agent" && !previous.note && (previous.diff as Diff | undefined)?.source_changed === true) {
				return `Your note was recorded as its own turn; the change itself had already been recorded by mmx serve: ${diffSummary(previous.diff as Diff | undefined)}`;
			}
			if (entryDiff?.baseline) return "baseline recorded";
			return `turn recorded with your note: ${diffSummary(entryDiff)}`;
		}
		if (matches.length > 1) {
			dirtyPaths.delete(path);
			return `mmx render appended ${matches.length} agent turns matching your note; inspect the turn log.`;
		}
		if (appended.length) return "mmx render appended turns, but none matched your note; inspect the turn log.";
		return "no change (identical bytes and identical note)";
	};

	const wait = async (path: string, timeoutSeconds: number | undefined, ctx: ExtensionContext, signal?: AbortSignal) => {
		if (signal?.aborted) throw abortedError();
		await ensureMmx(ctx, signal);
		if (await refreshDirty(path)) {
			throw new MmxError(`You have an unsent change to ${relativeDiagramPath(ctx.cwd, path)}. Call mmx_render with a note first, then wait.`);
		}
		await trackDiagram(path, true);
		const timeout = timeoutSeconds === undefined ? DEFAULT_WAIT_SECONDS : Math.max(0, Math.floor(timeoutSeconds));
		const result = await exec(["wait", path, "--timeout", String(timeout)], { cwd: ctx.cwd, signal });
		if (isAborted(result, signal)) throw abortedError();
		if (result.code === 3) return "no human turn yet";
		if (result.code !== 0) throw commandError(result, "mmx wait");
		const output = (result.stdout ?? "").trim();
		if (!output) return "no human turn yet";
		await advanceWatcherPastCurrentLog(path);
		return output;
	};

	const validateEdit = async (path: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<string> => {
		if (signal?.aborted) return "[mmx] auto-render aborted.";
		try {
			await ensureMmx(undefined, signal);
			if (signal?.aborted) return "[mmx] auto-render aborted.";
			const tempDir = await fs.mkdtemp(join(tmpdir(), "pi-mmx-validate-"));
			try {
				const tempPath = join(tempDir, basename(path));
				await fs.copyFile(path, tempPath);
				const statePath = siblingPath(path, "state.json");
				try {
					await fs.copyFile(statePath, siblingPath(tempPath, "state.json"));
				} catch {
					// A missing state is the normal baseline case.
				}
				const result = await exec(["render", tempPath, "--by", "agent", "--print-if-changed"], { cwd: ctx.cwd, signal });
				if (isAborted(result, signal)) return "[mmx] auto-render aborted.";
				if (result.code === 2) {
					const error = formatParseError(await readDiff(tempPath), result.stderr ?? "mmx could not parse the diagram");
					return `[mmx] ${error.message}`;
				}
				if (result.code !== 0) return `[mmx] validation failed: ${commandError(result, "mmx render").message}`;
				const changed = Boolean((result.stdout ?? "").trim());
				await markDirty(path);
				const stateExists = await fs.access(statePath).then(() => true).catch(() => false);
				if (!changed && !stateExists) return "[mmx] valid; this will be the first version — call mmx_render with a note to send it";
				const diff = changed ? await readDiff(tempPath) : undefined;
				const summary = changed ? diffSummary(diff) : "no pending change";
				return `[mmx] valid; pending change: ${summary} — call mmx_render with a note to send it`;
			} finally {
				await fs.rm(tempDir, { recursive: true, force: true });
			}
		} catch (error) {
			if (error instanceof MmxError && error.message.includes("aborted")) return "[mmx] auto-render aborted.";
			if (error instanceof MmxError && (error.message.includes("unavailable") || error.message.includes("required"))) {
				notifyUnavailable(ctx);
				return `[mmx] ${unavailableMessage()}`;
			}
			return `[mmx] validation failed: ${error instanceof Error ? error.message : String(error)}`;
		}
	};

	const startServe = async (path: string, ctx: ExtensionContext) => {
		await ensureMmx(ctx);
		const existing = serves.get(path);
		if (existing && existing.child.exitCode == null && !existing.child.killed) return existing.url;
		const child = spawnProcess("mmx", ["serve", path, "--addr", "127.0.0.1:0"], {
			cwd: ctx.cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const state: ServeState = { path, child, url: "" };
		serves.set(path, state);
		child.once("exit", () => {
			if (serves.get(path)?.child === child) serves.delete(path);
		});
		let output = "";
		let stderrOutput = "";
		await new Promise<string>((resolvePromise) => {
			let settled = false;
			let timeout: NodeJS.Timeout | undefined;
			const finish = (url?: string) => {
				if (settled) return;
				if (timeout) clearTimeout(timeout);
				if (url) {
					settled = true;
					state.url = url;
					resolvePromise(url);
					return;
				}
				settled = true;
				resolvePromise("");
			};
			child.stdout?.on("data", (chunk: Buffer | string) => {
				output += chunk.toString();
				const url = parseUrl(output);
				if (url) finish(url);
			});
			child.stderr?.on("data", (chunk: Buffer | string) => {
				stderrOutput += chunk.toString();
				output += chunk.toString();
				const url = parseUrl(output);
				if (url) finish(url);
			});
			child.once("error", () => finish());
			child.once("exit", () => finish());
			timeout = setTimeout(() => finish(parseUrl(output)), 5000);
		});
		if (!state.url) {
			try {
				if (child.exitCode == null) child.kill("SIGTERM");
			} catch {
				// The failed serve may have exited while its URL was being read.
			}
			serves.delete(path);
			const detail = stderrOutput.trim() || output.trim();
			notify(ctx, `mmx serve did not report a URL${detail ? `: ${detail}` : "."}`, "error");
			return "";
		}
		await trackDiagram(path, true);
		return state.url;
	};

	const stopServe = (path?: string) => {
		const targets = path ? [path] : [...serves.keys()];
		for (const target of targets) {
			const state = serves.get(target);
			if (!state) continue;
			try {
				if (state.child.exitCode === null) state.child.kill("SIGTERM");
			} catch {
				// Process may have exited between the check and kill.
			}
			serves.delete(target);
		}
	};

	pi.registerTool({
		name: "mmx_render",
		label: "mmx render",
		description:
			"Render an mmx Mermaid diagram after editing a .mmd file. Use mmx_render after every diagram edit, with a note explaining what changed and why; a non-empty note always makes a turn. Exit-2 parse errors are returned with line/column so you can fix the diagram.",
		promptSnippet: "Render a Mermaid .mmd through mmx and report the human-edit diff",
		promptGuidelines: [
			"Use mmx_render after editing any .mmd file, including a note saying what changed and why.",
			"Use mmx_render's returned diff to understand the picture edit; suggest /mmx open to let the human edit the diagram in a browser.",
		],
		parameters: renderParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const path = absolutePath(ctx.cwd, params.path);
			return { content: [textContent(await render(path, params.note, ctx, signal))], details: { path } };
		},
	});

	pi.registerTool({
		name: "mmx_wait",
		label: "mmx wait",
		description: "Wait for unanswered human edits to an mmx diagram. Returns human turn diff JSON, or `no human turn yet` after the timeout. Esc/abort cancels the mmx child process.",
		promptSnippet: "Wait for a human's mmx diagram edit",
		parameters: waitParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const path = absolutePath(ctx.cwd, params.path);
			return { content: [textContent(await wait(path, params.timeoutSeconds, ctx, signal))], details: { path } };
		},
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		if (event.isError) return;
		const input = event.input as { path?: unknown };
		if (typeof input.path !== "string" || !input.path.toLowerCase().endsWith(".mmd")) return;
		const path = absolutePath(ctx.cwd, input.path);
		const outcome = await validateEdit(path, ctx, ctx.signal);
		return { content: [...event.content, textContent(`\n${outcome}`)], isError: event.isError };
	});

	pi.registerCommand("mmx", {
		description: "Open, stop, or inspect the local mmx Mermaid cockpit",
		handler: async (args, ctx) => {
			lastContext = ctx;
			const words = args.trim().split(/\s+/).filter(Boolean);
			const action = words.shift() ?? "status";
			if (action === "open") {
				let path = words.join(" ");
				if (!path) {
					const cwdFiles = (await fs.readdir(ctx.cwd, { withFileTypes: true }))
						.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".mmd"))
						.map((entry) => resolve(ctx.cwd, entry.name));
					let tracked: string[] = [];
					try {
						const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.mmd"], {
							cwd: ctx.cwd,
							encoding: "utf8",
						});
						tracked = String(result.stdout ?? "").split(/\r?\n/).filter(Boolean).map((item) => resolve(ctx.cwd, item));
					} catch {
						// git is optional; cwd files still provide the useful fallback.
					}
					const candidates = [...new Set([...diagrams.keys(), ...cwdFiles, ...tracked])].sort();
					if (candidates.length !== 1) {
						notify(ctx, candidates.length ? `Choose a diagram: ${candidates.join(", ")}` : "No .mmd diagrams found in the current directory.", "warning");
						return;
					}
					path = candidates[0];
				} else {
					path = absolutePath(ctx.cwd, path);
				}
				let url: string;
				try {
					url = await startServe(path, ctx);
				} catch (error) {
					if (error instanceof MmxError && (error.message.includes("unavailable") || error.message.includes("required"))) {
						notify(ctx, error.message, "warning");
						return;
					}
					notify(ctx, `Could not start mmx serve: ${error instanceof Error ? error.message : String(error)}`, "error");
					return;
				}
				if (!url) return;
				try {
					await openBrowser(url);
				} catch {
					notify(ctx, `Could not open a browser automatically. Open this URL: ${url}`, "warning");
				}
				notify(ctx, `mmx cockpit: ${url}`, "info");
				return;
			}
			if (action === "stop") {
				const target = words.length ? absolutePath(ctx.cwd, words.join(" ")) : undefined;
				stopServe(target);
				stopWatcher(target);
				notify(ctx, "Stopped mmx serve processes.", "info");
				return;
			}
			if (action === "status") {
				const lines = [...diagrams.keys()].map((path) => `${path}${serves.get(path)?.url ? ` — ${serves.get(path)?.url}` : ""}`);
				notify(ctx, lines.length ? lines.join("\n") : "No tracked mmx diagrams.", "info");
				return;
			}
			notify(ctx, "Usage: /mmx open [path], /mmx stop [path], or /mmx status", "warning");
		},
	});

	pi.on("input", (event) => {
		if (event.source === "interactive" || event.source === "rpc") autoTriggerCount = 0;
	});

	pi.on("session_start", async (_event, ctx) => {
		lastContext = ctx;
		sessionStarted = true;
		try {
			await ensureMmx(ctx);
		} catch {
			return;
		}
		for (const configured of await configuredDiagrams(ctx.cwd, typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : false)) {
			await trackDiagram(absolutePath(ctx.cwd, configured), true);
		}
	});

	pi.on("session_shutdown", () => {
		sessionStarted = false;
		if (pendingTimer) clearTimeout(pendingTimer);
		pendingTimer = undefined;
		pendingTurns.length = 0;
		for (const state of diagrams.values()) {
			if (state.timer) clearInterval(state.timer);
		}
		diagrams.clear();
		stopServe();
	});

	return { diagrams, serves };
}

export default function mmxExtension(pi: ExtensionAPI) {
	return createMmxExtension(pi);
}
