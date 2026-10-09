import { spawn as nodeSpawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { Type } from "typebox";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { deliveryKey, readTurnEntries, unansweredHumanEntries, type TurnEntry } from "./turns.ts";
import { liveInstances, ownerAlive, readSidecar, updateSidecar, type Owner } from "./pending.ts";

const MIN_MMX = [0, 4, 0] as const;
const DEFAULT_WAIT_SECONDS = 120;
const WATCH_INTERVAL_MS = 200;
const BURST_DEBOUNCE_MS = 1000;
const AUTO_TRIGGER_CAP = 3;
const MAX_INJECT_DIAGRAMS = 8;

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

const noteParams = Type.Object({
	path: Type.String({ description: "Path to the Mermaid .mmd diagram (relative to the project)" }),
	text: Type.String({ description: "Your message to the human; always makes an mmx turn without editing the diagram" }),
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

type MmxConfig = { diagrams: string[]; autoRender: boolean; injectAtStart: boolean };

async function readConfig(ctx: ExtensionContext): Promise<MmxConfig> {
	const config: MmxConfig = { diagrams: [], autoRender: true, injectAtStart: true };
	const trusted = typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : false;
	if (!trusted) return config;
	try {
		const parsed = JSON.parse(await fs.readFile(configPath(ctx.cwd), "utf8")) as Record<string, unknown>;
		if (Array.isArray(parsed.diagrams)) config.diagrams = parsed.diagrams.filter((value): value is string => typeof value === "string");
		if (typeof parsed.autoRender === "boolean") config.autoRender = parsed.autoRender;
		if (typeof parsed.injectAtStart === "boolean") config.injectAtStart = parsed.injectAtStart;
	} catch {
		// No or unreadable config: defaults.
	}
	return config;
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
	// Pending agent edits: diagram path -> sha256 of the bytes the agent left
	// unsent. Persisted in .mmx/pi-pending.json so a new session (/new, /resume,
	// /reload, restart) never mistakes them for the human's edit.
	const dirtyPaths = new Map<string, string>();
	// Pending edits held back because the run was stopped (path -> sha).
	const heldPaths = new Map<string, string>();
	const delivered = new Set<string>();
	const snapshots = new Map<string, Map<string, string>>();
	let runStopped = false;
	let runInProgress = false;
	const owner: Owner = { pid: process.pid, id: randomUUID() };
	liveInstances.add(owner.id);
	let saveChain: Promise<void> = Promise.resolve();
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
			// mmx compacted the log (possibly while appending a new human turn):
			// queue its unanswered human turns that were not delivered yet.
			state.offset = stat.size;
			state.tail = Buffer.alloc(0);
			for (const entry of unansweredHumanEntries(await readTurnEntries(state.logPath))) {
				if (!delivered.has(deliveryKey(state.path, entry))) pendingTurns.push({ path: state.path, entry, line: "" });
			}
		} else if (stat.size === state.offset) {
			return;
		} else {
			await readAppended(state, stat.size);
		}
		await refreshDirty(state.path);
		if (sessionStarted && pendingTurns.length && !pendingTimer) {
			pendingTimer = setTimeout(() => {
				pendingTimer = undefined;
				void flushHumanTurns();
			}, debounceMs);
		}
	};

	const readAppended = async (state: DiagramState, size: number) => {
		const handle = await fs.open(state.logPath, "r");
		try {
			const length = size - state.offset;
			const chunk = Buffer.alloc(length);
			await handle.read(chunk, 0, length, state.offset);
			state.offset = size;
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

	/** Marks a human turn as delivered to the model; false when it already was. */
	const markDelivered = (path: string, entry: TurnEntry): boolean => {
		const key = deliveryKey(path, entry);
		if (delivered.has(key)) return false;
		delivered.add(key);
		return true;
	};

	const flushHumanTurns = async () => {
		if (!pendingTurns.length) return;
		const batch = pendingTurns.splice(0, pendingTurns.length).filter((turn) => markDelivered(turn.path, turn.entry));
		if (!batch.length) return;
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

	// Writes only this instance's entries; other owners' entries are kept as they are.
	const savePending = (cwd = lastContext?.cwd) => {
		if (!cwd) return saveChain;
		const mine = [...dirtyPaths].map(([path, sha]) => [path, { sha, held: heldPaths.get(path) === sha || undefined, owner }] as const);
		saveChain = saveChain.then(() =>
			updateSidecar(cwd, (entries) => {
				for (const [path, entry] of Object.entries(entries)) if (entry.owner?.id === owner.id) delete entries[path];
				for (const [path, entry] of mine) entries[path] = entry;
			}).catch(() => {
				// Best effort: losing the sidecar only loses cross-session attribution.
			}),
		);
		return saveChain;
	};

	/** Session start: take over entries whose owner is gone (crash, quit, /new, /reload). */
	const loadPending = async (cwd: string) => {
		await updateSidecar(cwd, (entries) => {
			for (const [path, entry] of Object.entries(entries)) {
				if (entry.owner?.id === owner.id || ownerAlive(entry.owner)) continue;
				dirtyPaths.set(path, entry.sha);
				if (entry.held) heldPaths.set(path, entry.sha);
				entries[path] = { ...entry, owner };
			}
		}).catch(() => {});
	};

	/** Diagrams whose bytes are still another live pi's unsent edit (another process or instance). */
	const foreignPending = async (cwd: string) => {
		const paths = new Set<string>();
		for (const [path, entry] of Object.entries(await readSidecar(cwd))) {
			if (entry.owner?.id === owner.id || !ownerAlive(entry.owner)) continue;
			if (await sourceSha256(path).then((sha) => sha === entry.sha, () => false)) paths.add(path);
		}
		return paths;
	};

	const setPending = async (path: string, sha: string | undefined) => {
		if (sha === undefined ? !dirtyPaths.delete(path) : dirtyPaths.get(path) === sha) return;
		if (sha !== undefined) dirtyPaths.set(path, sha);
		await savePending();
	};

	/** True while the file still holds the bytes the agent left unsent. */
	const refreshDirty = async (path: string): Promise<boolean> => {
		const pending = dirtyPaths.get(path);
		if (pending === undefined) return false;
		let current: string;
		try {
			current = await sourceSha256(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
			await setPending(path, undefined); // deleted or renamed: nothing left to send
			return false;
		}
		if (current === pending && current !== await committedSourceSha(path)) return true;
		// Sent since (by mmx_render, a bash render, or serve), or edited by the
		// human after the agent: either way no longer the agent's pending edit.
		await setPending(path, undefined);
		return false;
	};

	const markDirty = async (path: string) => {
		try {
			const current = await sourceSha256(path);
			await setPending(path, current === await committedSourceSha(path) ? undefined : current);
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
			await setPending(path, undefined);
			const previous = before.last;
			if (note && entryDiff?.source_changed === false && previous?.by === "agent" && !previous.note && (previous.diff as Diff | undefined)?.source_changed === true) {
				return `Your note was recorded as its own turn; the change itself had already been recorded by mmx serve: ${diffSummary(previous.diff as Diff | undefined)}`;
			}
			if (entryDiff?.baseline) return "baseline recorded";
			return `turn recorded with your note: ${diffSummary(entryDiff)}`;
		}
		if (matches.length > 1) {
			await setPending(path, undefined);
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
		// Do not inject the turns the model has now seen again at the next prompt.
		// mmx wait prints each turn's diff exactly as logged; match on it.
		const printed = new Set(output.split(/\r?\n/).map((line) => {
			try {
				return JSON.stringify(JSON.parse(line));
			} catch {
				return "";
			}
		}));
		for (const entry of unansweredHumanEntries(await readTurnEntries(siblingPath(path, "turns.jsonl")))) {
			if (printed.has(JSON.stringify(entry.diff))) markDelivered(path, entry);
		}
		return output;
	};

	const note = async (path: string, text: string, ctx: ExtensionContext, signal?: AbortSignal) => {
		if (signal?.aborted) throw abortedError();
		if (!text.trim()) throw new MmxError("mmx_note needs a non-empty text; nothing was sent.");
		await ensureMmx(ctx, signal);
		if (signal?.aborted) throw abortedError();
		const result = await exec(["note", path, "--", text], { cwd: ctx.cwd, signal });
		if (isAborted(result, signal)) throw abortedError();
		if (result.code === 2) throw formatParseError(await readDiff(path), result.stderr ?? "mmx could not parse the diagram");
		if (result.code !== 0) throw commandError(result, "mmx note");
		await setPending(path, undefined);
		await trackDiagram(path, true);
		const diff = await readDiff(path);
		if (diff?.source_changed) return `note recorded, together with your unsent change: ${diffSummary(diff)}`;
		return "note recorded";
	};

	type Preview = { changed: boolean; firstVersion: boolean; diff?: Diff; error?: MmxError; failure?: string };

	/** Renders a temporary copy (with the current state) to see what committing would record; never commits. */
	const previewRender = async (path: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<Preview | "aborted"> => {
		const tempDir = await fs.mkdtemp(join(tmpdir(), "pi-mmx-validate-"));
		try {
			const tempPath = join(tempDir, basename(path));
			await fs.copyFile(path, tempPath);
			const statePath = siblingPath(path, "state.json");
			let firstVersion = false;
			try {
				await fs.copyFile(statePath, siblingPath(tempPath, "state.json"));
			} catch {
				// A missing state is the normal baseline case.
				firstVersion = true;
			}
			const result = await exec(["render", tempPath, "--by", "agent", "--print-if-changed"], { cwd: ctx.cwd, signal });
			if (isAborted(result, signal)) return "aborted";
			if (result.code === 2) {
				return { changed: false, firstVersion, error: formatParseError(await readDiff(tempPath), result.stderr ?? "mmx could not parse the diagram") };
			}
			if (result.code !== 0) return { changed: false, firstVersion, failure: commandError(result, "mmx render").message };
			const changed = Boolean((result.stdout ?? "").trim());
			return { changed, firstVersion, diff: changed ? await readDiff(tempPath) : undefined };
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	};

	const validateEdit = async (path: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<string> => {
		if (signal?.aborted) return "[mmx] auto-render aborted.";
		try {
			await ensureMmx(undefined, signal);
			if (signal?.aborted) return "[mmx] auto-render aborted.";
			const preview = await previewRender(path, ctx, signal);
			if (preview === "aborted") return "[mmx] auto-render aborted.";
			if (preview.error) {
				await markDirty(path);
				return `[mmx] ${preview.error.message}`;
			}
			if (preview.failure) return `[mmx] validation failed: ${preview.failure}`;
			await markDirty(path);
			if (!preview.changed && preview.firstVersion) return "[mmx] valid; this will be the first version — call mmx_render with a note to send it";
			const summary = preview.changed ? diffSummary(preview.diff) : "no pending change";
			return `[mmx] valid; pending change: ${summary} — call mmx_render with a note to send it`;
		} catch (error) {
			if (error instanceof MmxError && error.message.includes("aborted")) return "[mmx] auto-render aborted.";
			if (error instanceof MmxError && (error.message.includes("unavailable") || error.message.includes("required"))) {
				notifyUnavailable(ctx);
				return `[mmx] ${unavailableMessage()}`;
			}
			return `[mmx] validation failed: ${error instanceof Error ? error.message : String(error)}`;
		}
	};

	/** End of run: send an edit the agent left unsent, with an automatic note, unless it does not parse. */
	const autoCommit = async (path: string, ctx: ExtensionContext, remind = true) => {
		const rel = relativeDiagramPath(ctx.cwd, path);
		let preview: Preview | "aborted";
		try {
			await ensureMmx(undefined, ctx.signal);
			preview = await previewRender(path, ctx, ctx.signal);
		} catch (error) {
			notify(ctx, `mmx: could not send the edit to ${rel}: ${error instanceof Error ? error.message : String(error)}`, "warning");
			return;
		}
		if (preview === "aborted") return;
		if (preview.error) {
			const { line, column } = preview.error;
			const location = line ? ` (line ${line}${column ? `, column ${column}` : ""})` : "";
			notify(ctx, `mmx: ${rel} does not parse${location}; the edit was not sent to the human.`, "warning");
			// Queued for the next prompt; pi cannot withdraw it if the file is fixed meanwhile.
			if (remind) pi.sendMessage(
				{
					customType: "mmx-turn",
					content: `Your last edit to ${rel} was not sent to the human because it did not parse when the run ended: ${preview.error.message} If the file still fails to parse, fix it, then call mmx_render with a note.`,
					display: true,
					details: { path, error: { kind: preview.error.kind, message: preview.error.message, line, column } },
				},
				{ deliverAs: "nextTurn" },
			);
			return;
		}
		if (preview.failure) {
			notify(ctx, `mmx: could not send the edit to ${rel}: ${preview.failure}`, "warning");
			return;
		}
		const summary = preview.changed ? diffSummary(preview.diff) : preview.firstVersion ? "first version" : "no semantic change";
		try {
			await render(path, `pi edited this diagram (automatic turn): ${summary}`, ctx, ctx.signal);
			notify(ctx, `mmx: sent the edit to ${rel} with an automatic note.`, "info");
		} catch (error) {
			notify(ctx, `mmx: could not send the edit to ${rel}: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	};

	/** Sends pending edits (end of run, shutdown, /mmx send); held edits only when `force`. */
	const sendPending = async (ctx: ExtensionContext, options: { remind?: boolean; force?: boolean; only?: string } = {}) => {
		for (const path of [...dirtyPaths.keys()]) {
			if (options.only && path !== options.only) continue;
			if (!(await refreshDirty(path))) continue;
			if (!options.force && heldPaths.get(path) === dirtyPaths.get(path)) continue;
			heldPaths.delete(path);
			await autoCommit(path, ctx, options.remind ?? true);
		}
	};

	/** Turn start: render a direct file edit as the human's turn (mmx wait) and collect unanswered human turns. */
	const collectUnanswered = async (ctx: ExtensionContext) => {
		const turns: HumanTurn[] = [];
		const warnings: string[] = [];
		const paths = [...diagrams.keys()];
		try {
			await ensureMmx(undefined, ctx.signal);
		} catch {
			return { turns, warnings }; // The tools explain a missing mmx when they are used.
		}
		const foreign = await foreignPending(ctx.cwd);
		for (const path of paths.slice(0, MAX_INJECT_DIAGRAMS)) {
			if (ctx.signal?.aborted) break;
			if (foreign.has(path)) continue; // another pi's unsent edit: not the human's
			const rel = relativeDiagramPath(ctx.cwd, path);
			try {
				if (await refreshDirty(path)) continue;
				if (!(await fs.access(path).then(() => true, () => false))) continue;
				const result = await exec(["wait", path, "--timeout", "0"], { cwd: ctx.cwd, signal: ctx.signal });
				if (isAborted(result, ctx.signal)) break;
				if (result.code !== 0 && result.code !== 3) {
					warnings.push(`[mmx] could not check ${rel} for human turns: ${commandError(result, "mmx wait").message.replace(/\s+/g, " ")}`);
				}
				for (const entry of unansweredHumanEntries(await readTurnEntries(siblingPath(path, "turns.jsonl")))) {
					if (markDelivered(path, entry)) turns.push({ path, entry, line: "" });
				}
			} catch (error) {
				warnings.push(`[mmx] could not check ${rel} for human turns: ${(error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ")}`);
			}
		}
		if (paths.length > MAX_INJECT_DIAGRAMS) warnings.push(`[mmx] checked ${MAX_INJECT_DIAGRAMS} of ${paths.length} tracked diagrams for human turns.`);
		return { turns, warnings };
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
			"Send your edit of a Mermaid .mmd diagram to the human as one mmx turn, with a note saying what changed and why (a non-empty note always makes a turn). pi's edit/write tools only validate .mmd edits; call mmx_render once the edit is done. An edit left unsent is sent at the end of the run with an automatic note, but your own note is better. Human edits made in the mmx cockpit arrive on their own as mmx-turn messages. Exit-2 parse errors are returned with line/column so you can fix the diagram.",
		promptSnippet: "Send a Mermaid .mmd edit to the human through mmx, with a note",
		promptGuidelines: [
			"After editing a .mmd diagram with edit or write (the mmx extension validates it), call mmx_render with a note saying what changed and why; use mmx_render too after a .mmd edit made through bash.",
			"An mmx-turn message is the human's edit or question about a diagram: answer by editing the .mmd and calling mmx_render with a note, or with mmx_note when the diagram does not need to change.",
			"Suggest /mmx open <path> so the human can see and edit the diagram in the local mmx cockpit; their changes arrive as mmx-turn messages without polling.",
		],
		parameters: renderParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			lastContext = ctx;
			const path = absolutePath(ctx.cwd, params.path);
			return { content: [textContent(await render(path, params.note, ctx, signal))], details: { path } };
		},
	});

	pi.registerTool({
		name: "mmx_note",
		label: "mmx note",
		description:
			"Reply to the human about an mmx diagram without editing it (an answer, a question, a status). Always makes a turn the human sees in the mmx cockpit; unsent edits in the file become part of it. Parse errors are returned with line/column.",
		promptSnippet: "Reply to the human about an mmx diagram without editing it",
		promptGuidelines: ["Use mmx_note to answer a human's mmx-turn question when the diagram itself does not need to change."],
		parameters: noteParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			lastContext = ctx;
			const path = absolutePath(ctx.cwd, params.path);
			return { content: [textContent(await note(path, params.text, ctx, signal))], details: { path } };
		},
	});

	pi.registerTool({
		name: "mmx_wait",
		label: "mmx wait",
		description:
			"Wait for unanswered human edits to an mmx diagram. Usually not needed: human turns arrive on their own as mmx-turn messages. Use it to block inside a run for the human's reply. Returns one diff JSON line per unanswered human turn (including turns already delivered as mmx-turn messages), or `no human turn yet` after the timeout. It refuses while you have an unsent .mmd edit (call mmx_render first). Esc/abort cancels the mmx child process.",
		promptSnippet: "Wait for a human's mmx diagram edit",
		parameters: waitParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			lastContext = ctx;
			const path = absolutePath(ctx.cwd, params.path);
			return { content: [textContent(await wait(path, params.timeoutSeconds, ctx, signal))], details: { path } };
		},
	});

	// bash, and other tools whose input names a diagram, can change a tracked
	// diagram too: snapshot before, compare after, and treat a change as the agent's edit.
	const isEditTool = (name: string) => name === "edit" || name === "write";
	pi.on("tool_call", async (event, ctx) => {
		runInProgress = true; // tools run only inside a run, even if agent_start was missed
		if (isEditTool(event.toolName) || event.toolName.startsWith("mmx_") || !diagrams.size) return;
		if (event.toolName !== "bash") {
			const input = JSON.stringify(event.input ?? {});
			if (!input.includes(".mmd") && ![...diagrams.keys()].some((path) => input.includes(path) || input.includes(relativeDiagramPath(ctx.cwd, path)))) return;
		}
		const shas = new Map<string, string>();
		for (const path of diagrams.keys()) shas.set(path, await sourceSha256(path).catch(() => ""));
		snapshots.set(event.toolCallId, shas);
	});

	pi.on("tool_result", async (event, ctx) => {
		lastContext = ctx;
		runInProgress = true;
		if (!isEditTool(event.toolName)) {
			const before = snapshots.get(event.toolCallId);
			snapshots.delete(event.toolCallId);
			if (!before) return;
			const lines: string[] = [];
			for (const [path, sha] of before) {
				if ((await sourceSha256(path).catch(() => "")) === sha) continue;
				const outcome = await validateEdit(path, ctx, ctx.signal);
				lines.push(outcome.replace(/^\[mmx\] /, `[mmx] ${relativeDiagramPath(ctx.cwd, path)}: `));
			}
			if (!lines.length) return;
			return { content: [...event.content, textContent(`\n${lines.join("\n")}`)], isError: event.isError };
		}
		if (event.isError) return;
		const input = event.input as { path?: unknown };
		if (typeof input.path !== "string" || !input.path.toLowerCase().endsWith(".mmd")) return;
		const path = absolutePath(ctx.cwd, input.path);
		const outcome = await validateEdit(path, ctx, ctx.signal);
		await trackDiagram(path, true);
		return { content: [...event.content, textContent(`\n${outcome}`)], isError: event.isError };
	});

	pi.registerCommand("mmx", {
		description: "Open, stop, or inspect the local mmx Mermaid cockpit, or send pi's unsent diagram edits",
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
			if (action === "send") {
				const target = words.length ? absolutePath(ctx.cwd, words.join(" ")) : undefined;
				if (![...dirtyPaths.keys()].some((path) => !target || path === target)) {
					notify(ctx, "No unsent agent edits.", "info");
					return;
				}
				await sendPending(ctx, { force: true, only: target });
				return;
			}
			if (action === "status") {
				const lines = [...diagrams.keys()].map((path) => `${path}${serves.get(path)?.url ? ` — ${serves.get(path)?.url}` : ""}${dirtyPaths.has(path) ? " (unsent agent edit)" : ""}`);
				notify(ctx, lines.length ? lines.join("\n") : "No tracked mmx diagrams.", "info");
				return;
			}
			notify(ctx, "Usage: /mmx open [path], /mmx stop [path], /mmx send [path], or /mmx status", "warning");
		},
	});

	pi.on("input", (event) => {
		if (event.source === "interactive" || event.source === "rpc") autoTriggerCount = 0;
	});

	pi.on("session_start", async (_event, ctx) => {
		lastContext = ctx;
		sessionStarted = true;
		owner.session = (ctx as { sessionManager?: { getSessionId?: () => string } }).sessionManager?.getSessionId?.();
		await loadPending(ctx.cwd);
		for (const path of dirtyPaths.keys()) await trackDiagram(path, true);
		try {
			await ensureMmx(ctx);
		} catch {
			return;
		}
		for (const configured of (await readConfig(ctx)).diagrams) {
			await trackDiagram(absolutePath(ctx.cwd, configured), true);
		}
	});

	// Hook parity with mmx's Claude Code hooks: unanswered human turns, including
	// ones made while pi was closed, are injected before the run that answers them.
	// pi 0.82 emits before_agent_start only from prompt() (agent-session.js:881);
	// a run started by the watcher's sendMessage(triggerTurn) does not fire it.
	pi.on("before_agent_start", async (_event, ctx) => {
		lastContext = ctx;
		if (!diagrams.size || !(await readConfig(ctx)).injectAtStart) return;
		const { turns, warnings } = await collectUnanswered(ctx);
		if (!turns.length && !warnings.length) return;
		const content = [...turns.map((turn) => humanTurnMessage(ctx.cwd, turn)), ...warnings].join("\n\n");
		const details = {
			source: "turn-start",
			diagrams: [...new Set(turns.map((turn) => turn.path))],
			turns: turns.map((turn) => turn.entry),
			warnings,
		};
		return { message: { customType: "mmx-turn", content, display: true, details } };
	});

	pi.on("agent_start", () => {
		runInProgress = true;
	});

	/** Holds pending edits instead of sending them (a stopped run, or pi closing mid-run). */
	const holdPending = async (ctx: ExtensionContext, reason: string) => {
		for (const path of [...dirtyPaths.keys()]) {
			if (!(await refreshDirty(path)) || heldPaths.get(path) === dirtyPaths.get(path)) continue;
			heldPaths.set(path, dirtyPaths.get(path) ?? "");
			notify(ctx, `mmx: the edit to ${relativeDiagramPath(ctx.cwd, path)} was not sent because ${reason}; use /mmx send or ask pi to send it.`, "warning");
		}
		await savePending();
	};

	// agent_end can fire more than once per settled run (retries); the last one decides.
	pi.on("agent_end", (event) => {
		const last = [...(event.messages ?? [])].reverse().find((message) => message.role === "assistant") as { stopReason?: string } | undefined;
		runStopped = last?.stopReason === "aborted" || last?.stopReason === "error";
	});

	pi.on("agent_settled", async (_event, ctx) => {
		lastContext = ctx;
		const stopped = runStopped;
		runStopped = false;
		runInProgress = false;
		snapshots.clear(); // tool calls that never produced a result
		if (!dirtyPaths.size || !(await readConfig(ctx)).autoRender) return;
		if (stopped) await holdPending(ctx, "the run was stopped");
		else await sendPending(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx) lastContext = ctx;
		if (ctx && dirtyPaths.size && (await readConfig(ctx)).autoRender) {
			if (runInProgress) await holdPending(ctx, "pi closed in the middle of a run");
			else await sendPending(ctx, { remind: false });
		}
		await saveChain;
		liveInstances.delete(owner.id);
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
