import assert from "node:assert/strict";
import { execFile, spawn as realSpawn } from "node:child_process";
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
