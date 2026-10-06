// Records the README demo GIF: a real `mmx serve` cockpit on the left, the
// agent's terminal on the right. The human renames a node on the picture
// and sends a note; the agent, blocked in `mmx wait`, receives the turn,
// edits the diagram and answers with a note; the cockpit updates live.
// Every command shown is actually run.
//
//   cargo build --release
//   cd examples/demo && npm i puppeteer-core gifenc pngjs
//   CHROME=/path/to/chrome node record.mjs ../../target/release/mmx ../../media/demo.gif
//
// CHROME: any Chrome/Chromium (e.g. `npx @puppeteer/browsers install chrome-headless-shell@stable`).
import puppeteer from "puppeteer-core";
import gifenc from "gifenc";
import { PNG } from "pngjs";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const { GIFEncoder, quantize, applyPalette } = gifenc;
const here = dirname(fileURLToPath(import.meta.url));
const MMX = resolve(process.argv[2] || join(here, "../../target/release/mmx"));
const OUT = resolve(process.argv[3] || join(here, "../../media/demo.gif"));
const CHROME = process.env.CHROME;
if (!CHROME) throw new Error("set CHROME to a Chrome/Chromium binary");
const W = 1280, H = 720, FPS = 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), "mmx-demo-"));
copyFileSync(join(here, "checkout.mmd"), join(dir, "checkout.mmd"));
execFileSync(MMX, ["render", "checkout.mmd", "--by", "agent", "--note", "First draft of the checkout flow"], { cwd: dir });
// MMX_DEMO_PORT pins the port; by default the OS picks a free one and serve
// prints the URL it bound.
const serve = spawn(MMX, ["serve", "checkout.mmd", "--addr", `127.0.0.1:${process.env.MMX_DEMO_PORT || 0}`], { cwd: dir });
const URL_BASE = await new Promise((resolveUrl, reject) => {
  let out = "";
  serve.stdout.on("data", (d) => {
    out += d;
    const m = /http:\/\/[^\s]+/.exec(out);
    if (m) resolveUrl(m[0]);
  });
  serve.on("exit", (code) => reject(new Error(`mmx serve exited (${code})`)));
});
const PORT = new URL(URL_BASE).port;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
await page.setContent(`<!doctype html><html><head><style>
  body{margin:0;display:flex;height:${H}px;font:14px -apple-system,system-ui,sans-serif;background:#f6f4ef}
  iframe{border:0;width:820px;height:${H}px;background:#fff}
  #term{flex:1;background:#1e1f24;color:#d8d8d8;font:13px/1.45 ui-monospace,Menlo,monospace;padding:16px 18px;white-space:pre-wrap;overflow:hidden}
  .p{color:#7fd17f}.c{color:#8ab4f8}.d{color:#888}.n{color:#f3c969}
  .h{font:600 12px -apple-system,system-ui,sans-serif;color:#999;letter-spacing:.06em;margin-bottom:10px}
</style></head><body><iframe src="${URL_BASE}/?lang=en"></iframe><div id="term"><div class="h">AGENT TERMINAL</div></div></body></html>`);
const frame = () => page.frames().find((f) => f.url().includes(`:${PORT}`));
await page.waitForFunction(() => document.querySelector("iframe"));
for (let i = 0; i < 50 && !(await frame()?.evaluate(() => !!document.querySelector("mmx-editor")?.lastElementChild?.shadowRoot?.querySelector(".svgslot svg")).catch(() => false)); i++) await sleep(100);

const term = (html) => page.evaluate((h) => { const t = document.getElementById("term"); t.insertAdjacentHTML("beforeend", h); t.scrollTop = t.scrollHeight; }, html);
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

// ---- frame capture ----
const frames = [];
let capturing = true;
const capture = (async () => {
  while (capturing) {
    const t0 = Date.now();
    frames.push(await page.screenshot({ type: "png" }));
    await sleep(Math.max(0, 1000 / FPS - (Date.now() - t0)));
  }
})();

async function hold(ms) { await sleep(ms); }
async function nodeCenter(id) {
  const f = frame();
  const box = await (await page.$("iframe")).boundingBox();
  const r = await f.evaluate((id) => {
    const el = document.querySelector("mmx-editor").lastElementChild.shadowRoot.querySelector(`.hit[data-id="${id}"]`);
    const b = el.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }, id);
  return { x: box.x + r.x, y: box.y + r.y };
}
async function elCenter(sel) {
  const f = frame();
  const box = await (await page.$("iframe")).boundingBox();
  const r = await f.evaluate((sel) => {
    const el = document.querySelector("mmx-editor").lastElementChild.shadowRoot.querySelector(sel);
    const b = el.getBoundingClientRect();
    return { x: b.left + 24, y: b.top + b.height / 2 };
  }, sel);
  return { x: box.x + r.x, y: box.y + r.y };
}

// ---- the agent waits ----
await hold(1200);
await term(`<span class="p">$</span> mmx wait checkout.mmd --timeout 300\n<span class="d">waiting for the human…</span>\n`);
const wait = spawn(MMX, ["wait", "checkout.mmd", "--timeout", "300"], { cwd: dir });
let waited = "";
wait.stdout.on("data", (d) => (waited += d));
const waitExit = new Promise((r) => wait.on("exit", r));
await hold(1500);

// ---- the human edits on the picture ----
const pay = await nodeCenter("pay");
await page.mouse.move(pay.x - 120, pay.y + 80);
await page.mouse.move(pay.x, pay.y, { steps: 12 });
await hold(400);
await page.mouse.click(pay.x, pay.y);
await sleep(120);
await page.mouse.click(pay.x, pay.y);
await hold(500);
await page.keyboard.down("Meta"); await page.keyboard.press("a"); await page.keyboard.up("Meta");
await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control");
await page.keyboard.type("Payment (3-D Secure)", { delay: 70 });
await page.keyboard.press("Enter");
await hold(700);
const note = await elCenter(".note");
await page.mouse.move(note.x, note.y, { steps: 10 });
await page.mouse.click(note.x, note.y);
await page.keyboard.type("We need a fraud check before payment", { delay: 55 });
await hold(500);
const send = await elCenter(".send");
await page.mouse.move(send.x, send.y, { steps: 10 });
await hold(300);
await page.screenshot({ path: join(dirname(OUT), "human-edit.png") });
await frame().evaluate(() => document.querySelector("mmx-editor").lastElementChild.shadowRoot.querySelector(".send").click());

// ---- the agent receives the turn ----
await waitExit;
const turn = JSON.parse(waited.trim().split("\n").pop());
const shown = {
  by: turn.by,
  note: turn.note,
  nodes: { changed: turn.nodes.changed },
};
await term(`<span class="c">${esc(JSON.stringify(shown, null, 1).replace(/\n\s*/g, " "))}</span>\n\n`);
await hold(2200);

// ---- the agent answers on the diagram ----
const src = readFileSync(join(dir, "checkout.mmd"), "utf8");
const next = src.replace(/cart\[Cart\] --> pay/, "cart[Cart] --> fraud{Fraud check}\n    fraud -->|ok| pay");
writeFileSync(join(dir, "checkout.mmd"), next);
await term(`<span class="d"># edits checkout.mmd: Cart → Fraud check → Payment</span>\n`);
await hold(900);
const reply = "Added a fraud check between cart and payment";
await term(`<span class="p">$</span> mmx render checkout.mmd --by agent --note "${reply}"\n`);
execFileSync(MMX, ["render", "checkout.mmd", "--by", "agent", "--note", reply], { cwd: dir });
// The edit may land as two agent turns (`mmx serve` can render the file
// before the note arrives): sum every agent turn since the human's.
const log = readFileSync(join(dir, "checkout.turns.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const since = log.slice(log.map((e) => e.by).lastIndexOf("human") + 1);
const added = since.flatMap((e) => e.diff.nodes.added.map((n) => n.label));
const edgesAdded = since.reduce((n, e) => n + e.diff.edges.added.length, 0);
const edgesRemoved = since.reduce((n, e) => n + e.diff.edges.removed.length, 0);
await term(`<span class="n">+ ${added.join(", ")}  · edges +${edgesAdded} −${edgesRemoved}</span>\n`);
await hold(4500);
await page.screenshot({ path: join(dirname(OUT), "agent-answer.png") });

capturing = false;
await capture;
await browser.close();
serve.kill();

// ---- encode ----
const gif = GIFEncoder();
let prev = null, delay = 1000 / FPS;
const flush = (rgba) => {
  const palette = quantize(rgba, 256);
  gif.writeFrame(applyPalette(rgba, palette), W, H, { palette, delay: Math.round(delay) });
};
for (const buf of frames) {
  const { data } = PNG.sync.read(Buffer.from(buf));
  if (prev && Buffer.compare(prev, data) === 0) { delay += 1000 / FPS; continue; }
  if (prev) flush(prev);
  prev = data; delay = 1000 / FPS;
}
if (prev) flush(prev);
gif.finish();
writeFileSync(OUT, gif.bytes());
console.log(`${OUT}: ${frames.length} frames, ${(gif.bytes().length / 1e6).toFixed(1)} MB`);
