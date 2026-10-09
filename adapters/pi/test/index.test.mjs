import assert from "node:assert/strict";
import { execFile, spawn as realSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(new URL("..", import.meta.url).pathname);

// The extension follows pi's peer-dependency convention. For a standalone
// node --test run, make the globally installed pi-bundled TypeBox resolvable.
const nodeModules = join(packageRoot, "node_modules");
await fs.mkdir(nodeModules, { recursive: true });
const piPackageLink = join(nodeModules, "@earendil-works", "pi-coding-agent");
await fs.mkdir(join(nodeModules, "@earendil-works"), { recursive: true });
try {
	await fs.lstat(piPackageLink);
} catch {
	const globalRoot = (await execFileAsync("npm", ["root", "-g"])).stdout.trim();
	await fs.symlink(join(globalRoot, "@earendil-works", "pi-coding-agent"), piPackageLink, "dir");
}
const typeboxLink = join(nodeModules, "typebox");
try {
	await fs.lstat(typeboxLink);
} catch {
	const { stdout } = await execFileAsync("npm", ["root", "-g"]);
	const globalRoot = stdout.trim();
	const candidates = [
		join(globalRoot, "@earendil-works", "pi-coding-agent", "node_modules", "typebox"),
		join(globalRoot, "typebox"),
	];
	const target = candidates.find((candidate) => {
		return existsSync(candidate);
	});
	if (!target) throw new Error("Could not find pi's installed typebox peer");
	await fs.symlink(target, typeboxLink, "dir");
}

const tempDirs = new Set();
async function mkdtemp(prefix) {
	const dir = await fs.mkdtemp(prefix);
	tempDirs.add(dir);
	return dir;
}
test.after(async () => {
	await Promise.all([...tempDirs].map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const { createMmxExtension, MmxError } = await import("../index.ts");

function sleep(ms) {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

class FakePi {
	constructor() {
		this.tools = new Map();
		this.commands = new Map();
		this.handlers = new Map();
		this.sent = [];
		this.execCalls = [];
	}

	on(name, handler) {
		this.handlers.set(name, handler);
	}

	registerTool(tool) {
		this.tools.set(tool.name, tool);
	}

	registerCommand(name, command) {
		this.commands.set(name, command);
	}

	sendMessage(message, options) {
		this.sent.push({ message, options });
	}

	async exec(command, args, options = {}) {
		this.execCalls.push({ command, args, options });
		return new Promise((resolvePromise, reject) => {
			const child = realSpawn(command, args, {
				cwd: options.cwd,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => (stdout += chunk));
			child.stderr.on("data", (chunk) => (stderr += chunk));
			const abort = () => child.kill("SIGTERM");
			if (options.signal) {
				if (options.signal.aborted) abort();
				else options.signal.addEventListener("abort", abort, { once: true });
			}
			child.on("error", reject);
			child.on("close", (code, signal) => resolvePromise({ stdout, stderr, code, killed: Boolean(signal) }));
		});
	}
}

class MissingMmxPi extends FakePi {
	async exec(command, args, options = {}) {
		this.execCalls.push({ command, args, options });
		return { stdout: "", stderr: "mmx: command not found", code: 127 };
	}
}

function context(cwd) {
	return {
		cwd,
		hasUI: true,
		signal: undefined,
		ui: { notifications: [], notify(message, level) { this.notifications.push({ message, level }); } },
		isProjectTrusted: () => true,
	};
}

async function invokeTool(pi, name, params, ctx, signal) {
	return pi.tools.get(name).execute("test", params, signal, undefined, ctx);
}

async function mmx(cwd, args) {
	return execFileAsync("mmx", args, { cwd, encoding: "utf8" })
		.then((result) => ({ ...result, code: 0 }))
		.catch((error) => ({ stdout: error.stdout ?? "", stderr: error.stderr ?? String(error), code: error.code }));
}

async function writeDiagram(dir, body = "flowchart LR\nA-->B\n") {
	const path = join(dir, "diagram.mmd");
	await fs.writeFile(path, body);
	return path;
}

test("mmx_render uses the real mmx binary for baseline, success, no-op, and parse errors", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mmx-render-"));
	const path = await writeDiagram(dir);
	const pi = new FakePi();
	const ctx = context(dir);
	createMmxExtension(pi);
	const first = await invokeTool(pi, "mmx_render", { path: "diagram.mmd" }, ctx);
	assert.equal(first.content[0].text, "baseline recorded");
	await fs.writeFile(path, "flowchart LR\nA-->B\nB-->C\n");
	const changed = await invokeTool(pi, "mmx_render", { path: "diagram.mmd", note: "Add the next step" }, ctx);
	assert.match(changed.content[0].text, /turn recorded with your note:/);
	const turns = (await fs.readFile(join(dir, "diagram.turns.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(turns.length, 2);
	assert.equal(turns.at(-1).note, "Add the next step");
	const noop = await invokeTool(pi, "mmx_render", { path: "diagram.mmd" }, ctx);
	assert.equal(noop.content[0].text, "no change (identical bytes and identical note)");
	await fs.writeFile(path, "flowchart LR\nA[-->B\n");
	await assert.rejects(() => invokeTool(pi, "mmx_render", { path: "diagram.mmd" }, ctx), (error) => {
		assert.ok(error instanceof MmxError);
		assert.equal(error.code, 2);
		assert.equal(error.line, 2);
		assert.equal(error.column, 2);
		assert.equal((error.message.match(/line 2/g) ?? []).length, 1);
		return true;
	});
});

test("tool_result validates successful and invalid built-in .mmd writes without committing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mmx-auto-"));
	const path = await writeDiagram(dir);
	const pi = new FakePi();
	const ctx = context(dir);
	createMmxExtension(pi);
	await invokeTool(pi, "mmx_render", { path: "diagram.mmd" }, ctx);
	const stateBefore = await fs.readFile(join(dir, "diagram.state.json"), "utf8");
	await fs.writeFile(path, "flowchart LR\nA-->B\nB-->C\n");
	const handler = pi.handlers.get("tool_result");
	const success = await handler({ type: "tool_result", toolName: "write", toolCallId: "w", input: { path: "diagram.mmd", content: "..." }, content: [{ type: "text", text: "written" }], details: undefined, isError: false }, ctx);
	assert.match(success.content.at(-1).text, /valid; pending change/);
	assert.equal(success.isError, false);
	assert.equal((await fs.readFile(join(dir, "diagram.turns.jsonl"), "utf8")).trim().split("\n").length, 1);
	assert.equal(await fs.readFile(join(dir, "diagram.state.json"), "utf8"), stateBefore);
	await fs.writeFile(path, "flowchart LR\nA[-->B\n");
	const failure = await handler({ type: "tool_result", toolName: "edit", toolCallId: "e", input: { path: "diagram.mmd", edits: [] }, content: [{ type: "text", text: "edited" }], details: undefined, isError: false }, ctx);
	assert.match(failure.content.at(-1).text, /line 2/);
	assert.equal(failure.isError, false);
	assert.equal((await fs.readFile(join(dir, "diagram.turns.jsonl"), "utf8")).trim().split("\n").length, 1);
	assert.equal(await fs.readFile(join(dir, "diagram.state.json"), "utf8"), stateBefore);
});

test("validated agent edits make mmx_wait refuse until mmx_render, while direct human edits still arrive", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mmx-dirty-"));
	const path = await writeDiagram(dir);
	const pi = new FakePi();
	const ctx = context(dir);
	createMmxExtension(pi);
	await invokeTool(pi, "mmx_render", { path: "diagram.mmd", note: "init" }, ctx);
	await fs.writeFile(path, "flowchart LR\nA-->C\n");
	await pi.handlers.get("tool_result")({ type: "tool_result", toolName: "edit", toolCallId: "e", input: { path: "diagram.mmd" }, content: [], isError: false }, ctx);
	await assert.rejects(() => invokeTool(pi, "mmx_wait", { path: "diagram.mmd", timeoutSeconds: 0 }, ctx), /unsent change.*diagram\.mmd/);
	const sent = await invokeTool(pi, "mmx_render", { path: "diagram.mmd", note: "send edit" }, ctx);
	assert.match(sent.content[0].text, /turn recorded/);
	await fs.writeFile(path, "flowchart LR\nA-->D\n");
	await mmx(dir, ["render", path, "--by", "human"]);
	const waited = await invokeTool(pi, "mmx_wait", { path: "diagram.mmd", timeoutSeconds: 0 }, ctx);
	assert.match(waited.content[0].text, /mmx_diff_version/);
});

test("validation uses print-if-changed stdout and identifies a first version", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mmx-validation-"));
	const path = await writeDiagram(dir);
	const pi = new FakePi();
	const ctx = context(dir);
	createMmxExtension(pi);
	const handler = pi.handlers.get("tool_result");
	const first = await handler({ type: "tool_result", toolName: "write", toolCallId: "w", input: { path: "diagram.mmd" }, content: [], isError: false }, ctx);
	assert.match(first.content.at(-1).text, /this will be the first version/);
	await invokeTool(pi, "mmx_render", { path: "diagram.mmd", note: "init" }, ctx);
	await fs.writeFile(path, "flowchart LR\nA-->B\n");
	const same = await handler({ type: "tool_result", toolName: "write", toolCallId: "w2", input: { path: "diagram.mmd" }, content: [], isError: false }, ctx);
	assert.match(same.content.at(-1).text, /no pending change/);
});

test("concurrent renders report ambiguous appended turns instead of guessing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mmx-concurrent-"));
	const path = await writeDiagram(dir);
	const pi = new FakePi();
	const ctx = context(dir);
	createMmxExtension(pi);
	await invokeTool(pi, "mmx_render", { path: "diagram.mmd", note: "init" }, ctx);
	await fs.writeFile(path, "flowchart LR\nA-->C\n");
	const results = await Promise.all([
		invokeTool(pi, "mmx_render", { path: "diagram.mmd", note: "same" }, ctx),
		invokeTool(pi, "mmx_render", { path: "diagram.mmd", note: "same" }, ctx),
	]);
	assert.ok(results.some((result) => /appended 2 agent turns matching/.test(result.content[0].text)));
});

test("mmx_render explains when an earlier serve-style agent turn already committed the change", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mmx-serve-note-"));
	const path = await writeDiagram(dir);
	const pi = new FakePi();
	const ctx = context(dir);
	createMmxExtension(pi);
	await invokeTool(pi, "mmx_render", { path: "diagram.mmd", note: "init" }, ctx);
	await fs.writeFile(path, "flowchart LR\nA-->C\n");
	await mmx(dir, ["render", path, "--by", "agent"]); // the serve poller's note-less commit
	const result = await invokeTool(pi, "mmx_render", { path: "diagram.mmd", note: "explain the change" }, ctx);
	assert.match(result.content[0].text, /Your note was recorded as its own turn; the change itself had already been recorded by mmx serve/);
});

test("human turn summaries cap large arrays", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mmx-summary-"));
	const path = await writeDiagram(dir);
	await fs.mkdir(join(dir, ".pi"));
	await fs.writeFile(join(dir, ".pi", "mmx.json"), JSON.stringify({ diagrams: ["diagram.mmd"] }));
	const pi = new FakePi();
	const ctx = context(dir);
	createMmxExtension(pi, { watchIntervalMs: 10, debounceMs: 10 });
	await pi.handlers.get("session_start")({}, ctx);
	await invokeTool(pi, "mmx_render", { path: "diagram.mmd", note: "baseline" }, ctx);
	const body = "flowchart LR\n" + Array.from({ length: 45 }, (_, i) => `N${i} --> N${i + 1}`).join("\n") + "\n";
	await fs.writeFile(path, body);
	await mmx(dir, ["render", path, "--by", "human"]);
	await sleep(80);
	const summary = pi.sent.at(-1)?.message.content ?? "";
	assert.ok(summary.length < 12000, `summary length=${summary.length}`);
	assert.match(summary, /\+\d+ more/, summary.slice(0, 500));
	await pi.handlers.get("session_shutdown")({}, ctx);
});

test("mmx_wait consumes turns from the watcher so a human turn is delivered once", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mmx-double-"));
	const path = await writeDiagram(dir);
	await fs.mkdir(join(dir, ".pi"));
	await fs.writeFile(join(dir, ".pi", "mmx.json"), JSON.stringify({ diagrams: ["diagram.mmd"] }));
	const pi = new FakePi();
	const ctx = context(dir);
	createMmxExtension(pi, { watchIntervalMs: 10, debounceMs: 1000 });
	await pi.handlers.get("session_start")({}, ctx);
	await invokeTool(pi, "mmx_render", { path: "diagram.mmd" }, ctx);
	await fs.writeFile(path, "flowchart LR\nA-->C\n");
	await mmx(dir, ["render", path, "--by", "human"]);
	const waited = await invokeTool(pi, "mmx_wait", { path: "diagram.mmd", timeoutSeconds: 5 }, ctx);
	assert.match(waited.content[0].text, /mmx_diff_version/);
	await sleep(1100);
	assert.equal(pi.sent.length, 0);
	await pi.handlers.get("session_shutdown")({}, ctx);
});

test("missing mmx never marks a built-in edit as an error and tools explain the failure", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mmx-missing-"));
	await writeDiagram(dir);
	const pi = new MissingMmxPi();
	const ctx = context(dir);
	createMmxExtension(pi);
	const handler = pi.handlers.get("tool_result");
	const event = { type: "tool_result", toolName: "write", toolCallId: "w", input: { path: "diagram.mmd" }, content: [], details: undefined, isError: false };
	const result = await handler(event, ctx);
	assert.equal(result.isError, false);
	assert.match(result.content.at(-1).text, /mmx (is unavailable|0\.4\.0)/i);
	await assert.rejects(() => invokeTool(pi, "mmx_render", { path: "diagram.mmd" }, ctx), /mmx .*required|mmx is unavailable/i);
	await handler(event, ctx);
	assert.equal(ctx.ui.notifications.length, 1);
});

test("aborted mmx operations report an aborted error", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mmx-abort-"));
	await writeDiagram(dir);
	const pi = new FakePi();
	const ctx = context(dir);
	createMmxExtension(pi);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(() => invokeTool(pi, "mmx_render", { path: "diagram.mmd" }, ctx, controller.signal), /aborted/i);
});

test("tilde paths resolve like pi paths", async (t) => {
	let dir;
	try {
		dir = await fs.mkdtemp(join(homedir(), ".pi-mmx-tilde-"));
	} catch {
		t.skip("home directory is not writable in this environment");
		return;
	}
	try {
		await writeDiagram(dir);
		const pi = new FakePi();
		const ctx = context(dir);
		createMmxExtension(pi);
		const result = await invokeTool(pi, "mmx_render", { path: `~/${dir.slice(homedir().length + 1)}/diagram.mmd` }, ctx);
		assert.match(result.content[0].text, /baseline recorded/);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("/mmx stop stops a diagram watcher and /mmx open resumes it", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mmx-stop-watch-"));
	await writeDiagram(dir);
	const pi = new FakePi();
	const ctx = context(dir);
	const extension = createMmxExtension(pi, {
		openBrowser: () => {},
		spawn: () => {
			const stdout = new PassThrough();
			const stderr = new PassThrough();
			const child = new (class extends PassThrough {
				constructor() { super(); this.stdout = stdout; this.stderr = stderr; this.exitCode = null; this.killed = false; }
				kill() { this.killed = true; this.exitCode = 0; return true; }
				unref() {}
			})();
			setTimeout(() => stdout.write("http://127.0.0.1:43211\n"), 5);
			return child;
		},
	});
	await pi.handlers.get("session_start")({}, ctx);
	await pi.commands.get("mmx").handler(`open ${join(dir, "diagram.mmd")}`, ctx);
	assert.equal(extension.diagrams.size, 1);
	await pi.commands.get("mmx").handler(`stop ${join(dir, "diagram.mmd")}`, ctx);
	assert.equal(extension.diagrams.size, 0);
	await pi.commands.get("mmx").handler(`open ${join(dir, "diagram.mmd")}`, ctx);
	assert.equal(extension.diagrams.size, 1);
	await pi.handlers.get("session_shutdown")({}, ctx);
});

test("mmx_wait returns timeout text and passes abort signals to mmx", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mmx-wait-"));
	await writeDiagram(dir);
	const pi = new FakePi();
	const ctx = context(dir);
	createMmxExtension(pi);
	const result = await invokeTool(pi, "mmx_wait", { path: "diagram.mmd", timeoutSeconds: 0 }, ctx);
	assert.equal(result.content[0].text, "no human turn yet");
	const controller = new AbortController();
	const pending = invokeTool(pi, "mmx_wait", { path: "diagram.mmd", timeoutSeconds: 120 }, ctx, controller.signal);
	await sleep(20);
	controller.abort();
	await assert.rejects(pending);
});

test("human watcher skips history and agent turns, coalesces bursts, and caps automatic turns", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mmx-watch-"));
	const path = await writeDiagram(dir);
	await mmx(dir, ["render", path, "--by", "human"]); // history before startup must not replay
	await fs.mkdir(join(dir, ".pi"));
	await fs.writeFile(join(dir, ".pi", "mmx.json"), JSON.stringify({ diagrams: ["diagram.mmd"] }));
	const pi = new FakePi();
	const ctx = context(dir);
	createMmxExtension(pi, { watchIntervalMs: 10, debounceMs: 25 });
	await pi.handlers.get("session_start")({}, ctx);
	await sleep(60);
	assert.equal(pi.sent.length, 0);
	await fs.writeFile(path, "flowchart LR\nA-->Z\n");
	const agentTurn = await mmx(dir, ["render", path, "--by", "agent", "--note", "agent maintenance"]);
	assert.equal(agentTurn.code, 0);
	await sleep(60);
	assert.equal(pi.sent.length, 0); // loop guard: agent/serve entries never trigger

	const humanTurn = async (body) => {
		await fs.writeFile(path, body);
		const result = await mmx(dir, ["render", path, "--by", "human", "--print-if-changed"]);
		assert.equal(result.code, 0);
	};
	await humanTurn("flowchart LR\nA-->B\nB-->C\n");
	await humanTurn("flowchart LR\nA-->B\nB-->C\nC-->D\n");
	await sleep(80);
	assert.equal(pi.sent.length, 1); // burst is one agent turn
	assert.equal(pi.sent[0].options.deliverAs, "followUp");
	assert.equal(pi.sent[0].options.triggerTurn, true);
	assert.equal(pi.sent[0].message.customType, "mmx-turn");
	assert.match(pi.sent[0].message.content, /^The human changed diagram\.mmd\./);
	assert.match(pi.sent[0].message.content, /source_changed/);

	await humanTurn("flowchart LR\nA-->B\nB-->C\nC-->D\nD-->E\n");
	await sleep(60);
	await humanTurn("flowchart LR\nA-->B\nB-->C\nC-->D\nD-->E\nE-->F\n");
	await sleep(60);
	await humanTurn("flowchart LR\nA-->B\nB-->C\nC-->D\nD-->E\nE-->F\nF-->G\n");
	await sleep(60);
	await humanTurn("flowchart LR\nA-->B\nB-->C\nC-->D\nD-->E\nE-->F\nF-->G\nG-->H\n");
	await sleep(80);
	assert.equal(pi.sent.length, 5);
	assert.deepEqual(pi.sent.slice(1, 4).map((item) => item.options.deliverAs), ["followUp", "followUp", "nextTurn"]);
	assert.equal(pi.sent[4].options.deliverAs, "nextTurn");
	assert.ok(ctx.ui.notifications.some((item) => item.message.includes("cap reached")));

	await pi.handlers.get("tool_result")({ type: "tool_result", toolName: "bash", toolCallId: "b", input: {}, content: [], details: undefined, isError: false }, ctx);
	await pi.handlers.get("input")({ source: "interactive" }, ctx);
	await pi.handlers.get("session_shutdown")({}, ctx);
});

test("/mmx open reuses a serve, reports URL, stop kills it, and shutdown cleans up", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mmx-open-"));
	await writeDiagram(dir);
	const pi = new FakePi();
	const ctx = context(dir);
	let child;
	const opened = [];
	const extension = createMmxExtension(pi, {
		openBrowser: (url) => opened.push(url),
		spawn: () => {
			const stdout = new PassThrough();
			const stderr = new PassThrough();
			child = new (class extends PassThrough {
				constructor() {
					super();
					this.stdout = stdout;
					this.stderr = stderr;
					this.exitCode = null;
					this.killed = false;
				}
				kill() {
					this.killed = true;
					this.exitCode = 0;
					return true;
				}
				unref() {}
			})();
			setTimeout(() => stdout.write("http://127.0.0.1:43210\n"), 5);
			return child;
		},
	});
	await pi.handlers.get("session_start")({}, ctx);
	await pi.commands.get("mmx").handler("open diagram.mmd", ctx);
	assert.deepEqual(opened, ["http://127.0.0.1:43210"]);
	assert.match(ctx.ui.notifications.at(-1).message, /43210/);
	await pi.commands.get("mmx").handler("stop", ctx);
	assert.equal(child.killed, true);
	assert.equal(extension.serves.size, 0);
	await pi.commands.get("mmx").handler("open diagram.mmd", ctx);
	await pi.handlers.get("session_shutdown")({}, ctx);
	assert.equal(child.killed, true);
});

test("real mmx serve is used when a loopback port can be bound", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mmx-real-serve-"));
	await writeDiagram(dir);
	const pi = new FakePi();
	const ctx = context(dir);
	createMmxExtension(pi, { openBrowser: () => {} });
	try {
		await pi.commands.get("mmx").handler("open diagram.mmd", ctx);
		const message = ctx.ui.notifications.at(-1)?.message ?? "";
		if (!message.includes("http://")) {
			t.skip(`real mmx serve could not bind a port: ${message}`);
			return;
		}
		assert.match(message, /http:\/\//);
	} finally {
		await pi.commands.get("mmx").handler("stop diagram.mmd", ctx);
		await pi.handlers.get("session_shutdown")({}, ctx);
	}
});

// ---- 0.2.0: automatic turn routine (turn-start injection, settle commit, mmx_note) ----

async function configure(dir, config) {
	await fs.mkdir(join(dir, ".pi"), { recursive: true });
	await fs.writeFile(join(dir, ".pi", "mmx.json"), JSON.stringify(config));
}

async function turnLog(dir) {
	try {
		return (await fs.readFile(join(dir, "diagram.turns.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

async function agentEdit(pi, ctx, path, body) {
	await fs.writeFile(path, body);
	return pi.handlers.get("tool_result")({ type: "tool_result", toolName: "edit", toolCallId: "e", input: { path: "diagram.mmd" }, content: [], isError: false }, ctx);
}

test("before_agent_start injects an unanswered human turn made before the session started, once", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mmx-inject-"));
	const path = await writeDiagram(dir);
	await mmx(dir, ["render", path, "--by", "agent", "--note", "first draft"]);
	await fs.writeFile(path, "flowchart LR\nA-->B\nB-->C\n");
	assert.equal((await mmx(dir, ["render", path, "--by", "human", "--note", "add C please"])).code, 0);
	await configure(dir, { diagrams: ["diagram.mmd"] });
	const pi = new FakePi();
	const ctx = context(dir);
	createMmxExtension(pi, { watchIntervalMs: 10, debounceMs: 200 });
	await pi.handlers.get("session_start")({}, ctx);
	// A second human turn arrives while the session runs; the watcher sees it
	// too, but the prompt's injection delivers it first.
	await fs.writeFile(path, "flowchart LR\nA-->B\nB-->C\nC-->D\n");
	assert.equal((await mmx(dir, ["render", path, "--by", "human"])).code, 0);
	await sleep(40);
	const result = await pi.handlers.get("before_agent_start")({ type: "before_agent_start", prompt: "hi" }, ctx);
	assert.equal(result.message.customType, "mmx-turn");
	assert.equal(result.message.display, true);
	assert.match(result.message.content, /^The human changed diagram\.mmd\./);
	assert.match(result.message.content, /note: add C please/);
	assert.equal(result.message.details.turns.length, 2);
	assert.ok(pi.execCalls.some((call) => call.args[0] === "wait" && call.args.includes("--timeout") && call.args.at(-1) === "0"));
	// Not again at the next prompt, and the watcher does not repeat it either.
	assert.equal(await pi.handlers.get("before_agent_start")({ type: "before_agent_start", prompt: "again" }, ctx), undefined);
	await sleep(400);
	assert.equal(pi.sent.length, 0);
	await pi.handlers.get("session_shutdown")({}, ctx);
});

test("before_agent_start renders a direct file edit as the human's turn (no serve) and skips answered history", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mmx-inject-direct-"));
	const path = await writeDiagram(dir);
	await mmx(dir, ["render", path, "--by", "human"]);
	await mmx(dir, ["note", path, "answered"]);
	await configure(dir, { diagrams: ["diagram.mmd"] });
	const pi = new FakePi();
	const ctx = context(dir);
	createMmxExtension(pi, { watchIntervalMs: 10, debounceMs: 20 });
	await pi.handlers.get("session_start")({}, ctx);
	assert.equal(await pi.handlers.get("before_agent_start")({ type: "before_agent_start", prompt: "hi" }, ctx), undefined);
	await fs.writeFile(path, "flowchart LR\nA-->B\nB-->Z\n");
	await sleep(50);
	const result = await pi.handlers.get("before_agent_start")({ type: "before_agent_start", prompt: "hi" }, ctx);
	assert.match(result?.message.content ?? "", /The human changed diagram\.mmd/);
	assert.equal((await turnLog(dir)).at(-1).by, "human");
	await sleep(150);
	assert.equal(pi.sent.length, 0); // the watcher sees the new entry but it was already delivered
	await pi.handlers.get("session_shutdown")({}, ctx);
});

test("a watcher-delivered human turn is not injected again at the next prompt", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mmx-inject-dedupe-"));
	const path = await writeDiagram(dir);
	await configure(dir, { diagrams: ["diagram.mmd"] });
	const pi = new FakePi();
	const ctx = context(dir);
	createMmxExtension(pi, { watchIntervalMs: 10, debounceMs: 10 });
	await pi.handlers.get("session_start")({}, ctx);
	await invokeTool(pi, "mmx_render", { path: "diagram.mmd", note: "baseline" }, ctx);
	await fs.writeFile(path, "flowchart LR\nA-->C\n");
	await mmx(dir, ["render", path, "--by", "human"]);
	await sleep(80);
	assert.equal(pi.sent.length, 1);
	assert.equal(await pi.handlers.get("before_agent_start")({ type: "before_agent_start", prompt: "follow-up" }, ctx), undefined);
	// mmx_wait still shows the unanswered turn (documented), and the watcher stays quiet.
	assert.match((await invokeTool(pi, "mmx_wait", { path: "diagram.mmd", timeoutSeconds: 0 }, ctx)).content[0].text, /mmx_diff_version/);
	await sleep(40);
	assert.equal(pi.sent.length, 1);
	await pi.handlers.get("session_shutdown")({}, ctx);
});

test("no turn-start injection or mmx wait for a diagram with an unsent agent edit", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mmx-inject-dirty-"));
	const path = await writeDiagram(dir);
	await mmx(dir, ["render", path, "--by", "agent", "--note", "init"]);
	await fs.writeFile(path, "flowchart LR\nA-->H\n");
	await mmx(dir, ["render", path, "--by", "human"]);
	const pi = new FakePi();
	const ctx = context(dir);
	createMmxExtension(pi);
	await pi.handlers.get("session_start")({}, ctx);
	await agentEdit(pi, ctx, path, "flowchart LR\nA-->H\nH-->I\n");
	const callsBefore = pi.execCalls.length;
	assert.equal(await pi.handlers.get("before_agent_start")({ type: "before_agent_start", prompt: "hi" }, ctx), undefined);
	assert.ok(!pi.execCalls.slice(callsBefore).some((call) => call.args[0] === "wait"));
	assert.equal((await turnLog(dir)).length, 2); // the agent's edit was not rendered as a human turn
	await pi.handlers.get("session_shutdown")({}, ctx);
});

test("agent_settled sends an unsent edit once with the automatic note; mmx_render before settle adds nothing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mmx-settle-"));
	const path = await writeDiagram(dir);
	const pi = new FakePi();
	const ctx = context(dir);
	createMmxExtension(pi);
	await invokeTool(pi, "mmx_render", { path: "diagram.mmd", note: "init" }, ctx);
	await agentEdit(pi, ctx, path, "flowchart LR\nA-->B\nB-->C\n");
	await agentEdit(pi, ctx, path, "flowchart LR\nA-->B\nB-->C\nC-->D\n");
	await pi.handlers.get("agent_settled")({ type: "agent_settled" }, ctx);
	let turns = await turnLog(dir);
	assert.equal(turns.length, 2);
	assert.equal(turns[1].by, "agent");
	assert.match(turns[1].note, /^pi edited this diagram \(automatic turn\): \+2 nodes \(C, D\)/);
	await pi.handlers.get("agent_settled")({ type: "agent_settled" }, ctx);
	assert.equal((await turnLog(dir)).length, 2);

	await agentEdit(pi, ctx, path, "flowchart LR\nA-->B\n");
	await invokeTool(pi, "mmx_render", { path: "diagram.mmd", note: "back to two nodes" }, ctx);
	await pi.handlers.get("agent_settled")({ type: "agent_settled" }, ctx);
	turns = await turnLog(dir);
	assert.equal(turns.length, 3);
	assert.equal(turns[2].note, "back to two nodes");
});

test("agent_settled does not send an edit that does not parse and queues a fix request", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mmx-settle-error-"));
	const path = await writeDiagram(dir);
	const pi = new FakePi();
	const ctx = context(dir);
	createMmxExtension(pi);
	await invokeTool(pi, "mmx_render", { path: "diagram.mmd", note: "init" }, ctx);
	const stateBefore = await fs.readFile(join(dir, "diagram.state.json"), "utf8");
	await agentEdit(pi, ctx, path, "flowchart LR\nA[-->B\n");
	await pi.handlers.get("agent_settled")({ type: "agent_settled" }, ctx);
	assert.equal((await turnLog(dir)).length, 1);
	assert.equal(await fs.readFile(join(dir, "diagram.state.json"), "utf8"), stateBefore);
	assert.equal(pi.sent.length, 1);
	assert.equal(pi.sent[0].options.deliverAs, "nextTurn");
	assert.equal(pi.sent[0].message.customType, "mmx-turn");
	assert.match(pi.sent[0].message.content, /did not parse.*line 2/);
	assert.equal(pi.sent[0].message.details.error.line, 2);
	assert.ok(ctx.ui.notifications.some((item) => /line 2, column 2/.test(item.message)));
	await pi.handlers.get("agent_settled")({ type: "agent_settled" }, ctx);
	assert.equal(pi.sent.length, 2); // reminded at every settle while the same broken bytes are pending
	assert.match(pi.sent[1].message.content, /If the file still fails to parse/);
	await agentEdit(pi, ctx, path, "flowchart LR\nA-->B\nB-->F\n");
	await pi.handlers.get("agent_settled")({ type: "agent_settled" }, ctx);
	assert.equal((await turnLog(dir)).length, 2);
});

test("mmx_note records a reply, includes unsent edits, and reports errors honestly", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mmx-note-"));
	const path = await writeDiagram(dir);
	const pi = new FakePi();
	const ctx = context(dir);
	createMmxExtension(pi);
	await invokeTool(pi, "mmx_render", { path: "diagram.mmd", note: "init" }, ctx);
	const plain = await invokeTool(pi, "mmx_note", { path: "diagram.mmd", text: "-- B is the payment step" }, ctx);
	assert.equal(plain.content[0].text, "note recorded");
	let turns = await turnLog(dir);
	assert.equal(turns.at(-1).note, "-- B is the payment step");
	assert.equal(turns.at(-1).by, "agent");
	await agentEdit(pi, ctx, path, "flowchart LR\nA-->B\nB-->N\n");
	const withEdit = await invokeTool(pi, "mmx_note", { path: "diagram.mmd", text: "added N" }, ctx);
	assert.match(withEdit.content[0].text, /together with your unsent change: \+1 nodes \(N\)/);
	await pi.handlers.get("agent_settled")({ type: "agent_settled" }, ctx);
	turns = await turnLog(dir);
	assert.equal(turns.length, 3); // the note cleared the unsent edit
	await assert.rejects(() => invokeTool(pi, "mmx_note", { path: "diagram.mmd", text: "  " }, ctx), /non-empty text/);
	await fs.writeFile(path, "flowchart LR\nA[-->B\n");
	await assert.rejects(() => invokeTool(pi, "mmx_note", { path: "diagram.mmd", text: "broken?" }, ctx), (error) => {
		assert.ok(error instanceof MmxError);
		assert.equal(error.code, 2);
		assert.equal(error.line, 2);
		return true;
	});
	await assert.rejects(() => invokeTool(pi, "mmx_note", { path: "missing.mmd", text: "hello" }, ctx), /mmx note failed/);
});

test("config flags turn off turn-start injection and the automatic end-of-run send", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mmx-flags-"));
	const path = await writeDiagram(dir);
	await mmx(dir, ["render", path, "--by", "agent", "--note", "init"]);
	await fs.writeFile(path, "flowchart LR\nA-->Q\n");
	await mmx(dir, ["render", path, "--by", "human"]);
	await configure(dir, { diagrams: ["diagram.mmd"], injectAtStart: false, autoRender: false });
	const pi = new FakePi();
	const ctx = context(dir);
	createMmxExtension(pi);
	await pi.handlers.get("session_start")({}, ctx);
	assert.equal(await pi.handlers.get("before_agent_start")({ type: "before_agent_start", prompt: "hi" }, ctx), undefined);
	await agentEdit(pi, ctx, path, "flowchart LR\nA-->Q\nQ-->R\n");
	await pi.handlers.get("agent_settled")({ type: "agent_settled" }, ctx);
	assert.equal((await turnLog(dir)).length, 2);
	assert.equal(pi.sent.length, 0);
	await pi.handlers.get("session_shutdown")({}, ctx);
});

test("derived pi skills match the canonical mmx skills", async () => {
	const repoRoot = resolve(packageRoot, "..", "..");
	const script = join(packageRoot, "scripts", "derive-skills.mjs");
	const check = await execFileAsync(process.execPath, [script, "--check"], { encoding: "utf8" })
		.then((result) => ({ ...result, code: 0 }))
		.catch((error) => ({ stdout: error.stdout, stderr: error.stderr, code: error.code }));
	assert.equal(check.code, 0, check.stderr);
	// Independent of the script: its own heading parser and forbidden patterns.
	const headingsOf = (text) => text.split("\n").filter((line) => line.startsWith("## ") || line.startsWith("### "));
	const dropped = { mmx: [], "mmx-codemap": [] };
	const forbidden = [
		/--by (agent|human)/,
		/claude\.ai/,
		/--print-if-changed/,
		/^\s*mmx (serve|wait|note|render)\b/m, // shell lines in code blocks
		/`mmx serve [^`]*`/,
		/`mmx wait [^`-][^`]*`/,
		/`mmx note [^`-][^`]*`/,
		/`mmx render [^`]*--note[^`]*`/,
	];
	const skills = [
		{ dir: "mmx", source: "skills/mmx/SKILL.md", copies: [["skills/mmx/references/diff-schema.md", "references/diff-schema.md"]] },
		{
			dir: "mmx-codemap",
			source: "adapters/codemap/SKILL.md",
			copies: [
				["adapters/codemap/codemap.py", "codemap.py"],
				["adapters/codemap/example/index_rust.py", "example/index_rust.py"],
				["adapters/codemap/example/mmx-self/turn-log-change.mmd", "example/mmx-self/turn-log-change.mmd"],
				["adapters/codemap/example/mmx-self/turn-log-change.ko.mmd", "example/mmx-self/turn-log-change.ko.mmd"],
			],
		},
	];
	for (const skill of skills) {
		const derived = await fs.readFile(join(packageRoot, "skills", skill.dir, "SKILL.md"), "utf8");
		const canonical = await fs.readFile(join(repoRoot, skill.source), "utf8");
		const derivedHeadings = new Set(headingsOf(derived));
		for (const heading of headingsOf(canonical)) {
			assert.ok(derivedHeadings.has(heading) || dropped[skill.dir].includes(heading), `${skill.dir}: missing heading ${heading}`);
		}
		assert.match(derived, new RegExp(`^---\\nname: ${skill.dir}\\n`));
		for (const pattern of forbidden) assert.doesNotMatch(derived, pattern, `${skill.dir}: ${pattern}`);
		for (const [from, to] of skill.copies) {
			assert.ok((await fs.readFile(join(packageRoot, "skills", skill.dir, to))).equals(await fs.readFile(join(repoRoot, from))), `${to} is not a byte-identical copy`);
		}
	}
	const files = (await fs.readdir(join(packageRoot, "skills"), { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
	assert.equal(files.length, skills.reduce((sum, skill) => sum + 1 + skill.copies.length, 0));
});

async function sha256(path) {
	return createHash("sha256").update(await fs.readFile(path)).digest("hex");
}

async function pendingSidecar(dir) {
	try {
		return JSON.parse(await fs.readFile(join(dir, ".mmx", "pi-pending.json"), "utf8"));
	} catch {
		return undefined;
	}
}

async function session(dir, deps = {}) {
	const pi = new FakePi();
	const ctx = context(dir);
	createMmxExtension(pi, deps);
	await pi.handlers.get("session_start")({}, ctx);
	return { pi, ctx };
}

const prompt = (pi, ctx) => pi.handlers.get("before_agent_start")({ type: "before_agent_start", prompt: "next" }, ctx);

test("an unsent agent edit survives a session boundary and is never logged as the human's", async () => {
	for (const [config, body] of [[{ autoRender: false }, "flowchart LR\nA-->B\nB-->AGENT_ONLY\n"], [{}, "flowchart LR\nA[-->B\n"]]) {
		const dir = await mkdtemp(join(tmpdir(), "pi-mmx-boundary-"));
		const path = await writeDiagram(dir);
		await configure(dir, { diagrams: ["diagram.mmd"], ...config });
		let { pi, ctx } = await session(dir);
		await invokeTool(pi, "mmx_render", { path: "diagram.mmd", note: "first draft" }, ctx);
		await agentEdit(pi, ctx, path, body);
		await pi.handlers.get("agent_settled")({ type: "agent_settled" }, ctx);
		await pi.handlers.get("session_shutdown")({}, ctx);
		const sidecar = await pendingSidecar(dir);
		assert.ok(sidecar?.pending[path], JSON.stringify(sidecar));
		({ pi, ctx } = await session(dir)); // /new, /resume, /reload or a restart: a fresh instance
		const callsBefore = pi.execCalls.length;
		assert.equal(await prompt(pi, ctx), undefined);
		assert.ok(!pi.execCalls.slice(callsBefore).some((call) => call.args[0] === "wait"));
		const turns = await turnLog(dir);
		assert.equal(turns.length, 1);
		assert.equal(turns[0].by, "agent");
		// A human edit after the agent's is the human's again.
		await fs.writeFile(path, "flowchart LR\nA-->B\nB-->HUMAN\n");
		await sleep(50);
		assert.match((await prompt(pi, ctx))?.message.content ?? "", /The human changed diagram\.mmd/);
		assert.equal(await pendingSidecar(dir), undefined);
		await pi.handlers.get("session_shutdown")({}, ctx);
	}
});

test("session_shutdown after a settled run sends edits that parse and keeps broken ones pending", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mmx-shutdown-"));
	const path = await writeDiagram(dir);
	await mmx(dir, ["render", path, "--by", "agent", "--note", "init"]);
	// An unsent edit left by an earlier pi that is gone (an ownerless, older-format entry).
	await fs.writeFile(path, "flowchart LR\nA-->B\nB-->S\n");
	await fs.mkdir(join(dir, ".mmx"), { recursive: true });
	await fs.writeFile(join(dir, ".mmx", "pi-pending.json"), JSON.stringify({ v: 1, pending: { [path]: await sha256(path) } }));
	const { pi, ctx } = await session(dir);
	assert.equal(await prompt(pi, ctx), undefined); // taken over: the agent's, not the human's
	await pi.handlers.get("session_shutdown")({}, ctx);
	const turns = await turnLog(dir);
	assert.equal(turns.length, 2);
	assert.match(turns[1].note, /^pi edited this diagram \(automatic turn\)/);
	assert.equal(await pendingSidecar(dir), undefined);

	const second = await session(dir);
	await agentEdit(second.pi, second.ctx, path, "flowchart LR\nA[-->B\n");
	await second.pi.handlers.get("agent_settled")({ type: "agent_settled" }, second.ctx);
	await second.pi.handlers.get("session_shutdown")({}, second.ctx);
	assert.equal((await turnLog(dir)).length, 2);
	assert.equal(second.pi.sent.length, 1); // the settle reminder only; none queued into the closing session
	assert.ok((await pendingSidecar(dir))?.pending[path]);
});

test("quitting in the middle of a run holds the partial edit instead of sending it", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mmx-quit-midrun-"));
	const path = await writeDiagram(dir);
	const { pi, ctx } = await session(dir);
	await invokeTool(pi, "mmx_render", { path: "diagram.mmd", note: "init" }, ctx);
	await pi.handlers.get("agent_start")({ type: "agent_start" }, ctx);
	await agentEdit(pi, ctx, path, "flowchart LR\nA-->B\nB-->HALF_DONE\n");
	await pi.handlers.get("session_shutdown")({}, ctx); // no agent_end / agent_settled
	assert.equal((await turnLog(dir)).length, 1);
	assert.equal((await pendingSidecar(dir))?.pending[path]?.held, true);
	assert.ok(ctx.ui.notifications.some((item) => /closed in the middle of a run/.test(item.message)));
	const next = await session(dir);
	assert.equal(await prompt(next.pi, next.ctx), undefined);
	await next.pi.handlers.get("agent_settled")({ type: "agent_settled" }, next.ctx);
	assert.equal((await turnLog(dir)).length, 1);
	await next.pi.handlers.get("session_shutdown")({}, next.ctx);
});

test("two pi instances in one project keep to their own sidecar entries", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mmx-two-"));
	const path = await writeDiagram(dir);
	const other = join(dir, "other.mmd");
	await fs.writeFile(other, "flowchart LR\nX-->Y\n");
	await configure(dir, { diagrams: ["diagram.mmd"] });
	const a = await session(dir);
	await invokeTool(a.pi, "mmx_render", { path: "diagram.mmd", note: "A draft" }, a.ctx);
	const b = await session(dir); // started before A's edit
	await agentEdit(a.pi, a.ctx, path, "flowchart LR\nA-->B\nB-->A_WORK\n");
	await invokeTool(b.pi, "mmx_render", { path: "other.mmd", note: "B baseline" }, b.ctx);
	await fs.writeFile(other, "flowchart LR\nX-->Y\nY-->Z\n");
	await b.pi.handlers.get("tool_result")({ type: "tool_result", toolName: "edit", toolCallId: "e", input: { path: "other.mmd" }, content: [], isError: false }, b.ctx);
	await invokeTool(b.pi, "mmx_render", { path: "other.mmd", note: "B sent" }, b.ctx); // B's own entries empty
	await b.pi.handlers.get("agent_settled")({ type: "agent_settled" }, b.ctx);
	assert.equal((await turnLog(dir)).length, 1); // B never sends A's edit
	assert.ok((await pendingSidecar(dir))?.pending[path], "B removed A's entry");
	assert.equal(await prompt(b.pi, b.ctx), undefined); // nor injects it as the human's
	assert.equal((await turnLog(dir)).length, 1);
	// A live foreign process owns an entry: not taken over. A dead one: taken over.
	const live = realSpawn("sleep", ["5"]);
	const dead = realSpawn("true");
	await new Promise((resolvePromise) => dead.on("close", resolvePromise));
	try {
		await fs.writeFile(other, "flowchart LR\nX-->Y\nY-->LIVE\n");
		await fs.writeFile(join(dir, ".mmx", "pi-pending.json"), JSON.stringify({
			v: 2,
			pending: {
				[path]: { sha: await sha256(path), owner: { pid: dead.pid, id: "gone" } },
				[other]: { sha: await sha256(other), owner: { pid: live.pid, id: "elsewhere" } },
			},
		}));
		const c = await session(dir);
		const sidecar = await pendingSidecar(dir);
		assert.equal(sidecar.pending[other].owner.pid, live.pid);
		assert.equal(sidecar.pending[path].owner.pid, process.pid);
		await c.pi.handlers.get("agent_settled")({ type: "agent_settled" }, c.ctx);
		const turns = await turnLog(dir);
		assert.equal(turns.at(-1).by, "agent");
		assert.match(turns.at(-1).note, /automatic turn.*A_WORK/);
		await c.pi.handlers.get("session_shutdown")({}, c.ctx);
	} finally {
		live.kill();
	}
	await a.pi.handlers.get("session_shutdown")({}, a.ctx);
	await b.pi.handlers.get("session_shutdown")({}, b.ctx);
});

test("a pending entry for a deleted diagram is dropped", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mmx-stale-"));
	const path = await writeDiagram(dir);
	await configure(dir, { autoRender: false });
	const { pi, ctx } = await session(dir);
	await invokeTool(pi, "mmx_render", { path: "diagram.mmd", note: "init" }, ctx);
	await agentEdit(pi, ctx, path, "flowchart LR\nA-->B\nB-->C\n");
	await pi.handlers.get("session_shutdown")({}, ctx);
	assert.ok((await pendingSidecar(dir))?.pending[path]);
	await fs.rename(path, join(dir, "renamed.mmd"));
	await configure(dir, {});
	const next = await session(dir);
	await next.pi.handlers.get("agent_settled")({ type: "agent_settled" }, next.ctx);
	assert.equal(next.ctx.ui.notifications.length, 0);
	assert.equal(await pendingSidecar(dir), undefined);
	await next.pi.handlers.get("session_shutdown")({}, next.ctx);
});

test("tool calls that do not name a diagram are not snapshotted, except bash", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mmx-snapshot-"));
	const path = await writeDiagram(dir);
	const { pi, ctx } = await session(dir);
	await invokeTool(pi, "mmx_render", { path: "diagram.mmd", note: "init" }, ctx);
	await pi.handlers.get("tool_call")({ type: "tool_call", toolName: "web_fetch", toolCallId: "w", input: { url: "x" } }, ctx);
	await fs.writeFile(path, "flowchart LR\nA-->B\nB-->W\n");
	assert.equal(await pi.handlers.get("tool_result")({ type: "tool_result", toolName: "web_fetch", toolCallId: "w", input: {}, content: [], isError: false }, ctx), undefined);
	await pi.handlers.get("tool_call")({ type: "tool_call", toolName: "codemap", toolCallId: "c", input: { out: "diagram.mmd" } }, ctx);
	await fs.writeFile(path, "flowchart LR\nA-->B\nB-->W\nW-->V\n");
	const named = await pi.handlers.get("tool_result")({ type: "tool_result", toolName: "codemap", toolCallId: "c", input: {}, content: [], isError: false }, ctx);
	assert.match(named.content.at(-1).text, /\[mmx\] diagram\.mmd: valid/);
	await pi.handlers.get("session_shutdown")({}, ctx);
});

test("a bash edit to a tracked diagram is the agent's edit, validated and sent at settle", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mmx-bash-"));
	const path = await writeDiagram(dir);
	const { pi, ctx } = await session(dir);
	await invokeTool(pi, "mmx_render", { path: "diagram.mmd", note: "first draft" }, ctx);
	await pi.handlers.get("tool_call")({ type: "tool_call", toolName: "bash", toolCallId: "b1", input: { command: "sed ..." } }, ctx);
	await fs.writeFile(path, "flowchart LR\nA-->B\nB-->FROM_BASH\n");
	const result = await pi.handlers.get("tool_result")({ type: "tool_result", toolName: "bash", toolCallId: "b1", input: {}, content: [{ type: "text", text: "ok" }], isError: false }, ctx);
	assert.match(result.content.at(-1).text, /\[mmx\] diagram\.mmd: valid; pending change: \+1 nodes \(FROM_BASH\)/);
	assert.equal(await prompt(pi, ctx), undefined);
	assert.equal((await turnLog(dir)).length, 1);
	await pi.handlers.get("agent_settled")({ type: "agent_settled" }, ctx);
	const turns = await turnLog(dir);
	assert.equal(turns.length, 2);
	assert.equal(turns[1].by, "agent");
	// A tool that does not touch the diagram adds nothing.
	await pi.handlers.get("tool_call")({ type: "tool_call", toolName: "bash", toolCallId: "b2", input: { command: "ls" } }, ctx);
	assert.equal(await pi.handlers.get("tool_result")({ type: "tool_result", toolName: "bash", toolCallId: "b2", input: {}, content: [], isError: false }, ctx), undefined);
	await pi.handlers.get("session_shutdown")({}, ctx);
});

test("a stopped run keeps its edit pending until /mmx send", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mmx-abort-settle-"));
	const path = await writeDiagram(dir);
	const { pi, ctx } = await session(dir);
	await invokeTool(pi, "mmx_render", { path: "diagram.mmd", note: "init" }, ctx);
	await agentEdit(pi, ctx, path, "flowchart LR\nA-->B\nB-->HALF\n");
	await pi.handlers.get("agent_end")({ type: "agent_end", messages: [{ role: "user" }, { role: "assistant", stopReason: "aborted" }] }, ctx);
	await pi.handlers.get("agent_settled")({ type: "agent_settled" }, ctx);
	assert.equal((await turnLog(dir)).length, 1);
	assert.ok(ctx.ui.notifications.some((item) => /not sent because the run was stopped/.test(item.message)));
	await pi.handlers.get("session_shutdown")({}, ctx);
	assert.equal((await turnLog(dir)).length, 1);
	assert.equal((await pendingSidecar(dir))?.pending[path]?.held, true);

	const next = await session(dir);
	await next.pi.handlers.get("agent_settled")({ type: "agent_settled" }, next.ctx);
	assert.equal((await turnLog(dir)).length, 1); // still held in the new session
	await next.pi.commands.get("mmx").handler("send", next.ctx);
	const turns = await turnLog(dir);
	assert.equal(turns.length, 2);
	assert.match(turns[1].note, /automatic turn/);
	assert.equal(await pendingSidecar(dir), undefined);
	await next.pi.handlers.get("session_shutdown")({}, next.ctx);
});

test("the watcher recovers a human turn appended while mmx compacts the log", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mmx-rotation-"));
	const path = await writeDiagram(dir);
	await mmx(dir, ["render", path, "--by", "agent", "--note", "init"]);
	const logPath = join(dir, "diagram.turns.jsonl");
	const entry = JSON.parse((await fs.readFile(logPath, "utf8")).trim());
	entry.note = "x".repeat(8000);
	await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`.repeat(300));
	const sizeBefore = (await fs.stat(logPath)).size;
	await configure(dir, { diagrams: ["diagram.mmd"] });
	const { pi, ctx } = await session(dir, { watchIntervalMs: 20, debounceMs: 20 });
	await fs.writeFile(path, "flowchart LR\nA-->B\nB-->HUMAN\n");
	await mmx(dir, ["render", path, "--by", "human", "--note", "please look"]);
	assert.ok((await fs.stat(logPath)).size < sizeBefore, "mmx did not compact the log");
	await sleep(300);
	assert.equal(pi.sent.length, 1);
	assert.match(pi.sent[0].message.content, /please look/);
	assert.equal(await prompt(pi, ctx), undefined);
	await pi.handlers.get("session_shutdown")({}, ctx);
});

test("mmx_wait marks only the turns it printed as delivered", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mmx-wait-mark-"));
	const path = await writeDiagram(dir);
	await mmx(dir, ["render", path, "--by", "agent", "--note", "init"]);
	await fs.writeFile(path, "flowchart LR\nA-->W\n");
	await mmx(dir, ["render", path, "--by", "human", "--note", "seen by wait"]);
	const { pi, ctx } = await session(dir);
	const waited = await invokeTool(pi, "mmx_wait", { path: "diagram.mmd", timeoutSeconds: 0 }, ctx);
	assert.match(waited.content[0].text, /seen by wait/);
	assert.equal(await prompt(pi, ctx), undefined);
	await mmx(dir, ["note", path, "a later question", "--by", "human"]);
	const result = await prompt(pi, ctx);
	assert.match(result?.message.content ?? "", /a later question/);
	assert.doesNotMatch(result.message.content, /seen by wait/);
	await pi.handlers.get("session_shutdown")({}, ctx);
});

test("with mmx serve running, a direct file edit is not injected as the human's turn", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-mmx-serve-inject-"));
	const path = await writeDiagram(dir);
	const { pi, ctx } = await session(dir, { openBrowser: () => {} });
	await invokeTool(pi, "mmx_render", { path: "diagram.mmd", note: "init" }, ctx);
	try {
		await pi.commands.get("mmx").handler("open diagram.mmd", ctx);
		const message = ctx.ui.notifications.at(-1)?.message ?? "";
		if (!message.includes("http://")) {
			t.skip(`real mmx serve could not bind a port: ${message}`);
			return;
		}
		await fs.writeFile(path, "flowchart LR\nA-->B\nB-->DIRECT\n");
		await sleep(1200); // serve's poller records it as by: agent
		assert.equal(await prompt(pi, ctx), undefined);
		assert.notEqual((await turnLog(dir)).at(-1).by, "human");
		await mmx(dir, ["note", path, "question from the cockpit", "--by", "human"]);
		assert.match((await prompt(pi, ctx))?.message.content ?? "", /question from the cockpit/);
	} finally {
		await pi.commands.get("mmx").handler("stop diagram.mmd", ctx);
		await pi.handlers.get("session_shutdown")({}, ctx);
	}
});
