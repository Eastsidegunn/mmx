// mmx-wasm.js: dependency-free loader for mmx_wasm.wasm (one full mmx turn:
// lint, render, diff, state) in the browser or in Node >= 18.
//
//   import { loadMmx } from "./mmx-wasm.js";
//   const mmx = await loadMmx("mmx_wasm.wasm");           // URL, bytes or Module
//   const out = mmx.turn({ source, by: "human", note, prev_state });
//
// Loaded with <script type="module">, it also sets `window.MmxWasm =
// { loadMmx }` for code outside the module graph.
//
// The module is built for wasm32-wasip1 and imports a handful of
// `wasi_snapshot_preview1` functions. mmx never touches files, the
// environment or stdin in a turn, so the shim below is minimal: a real
// clock, real randomness, stdout/stderr to the console, an empty
// environment and no preopened directories. Everything else fails safely.

const ESUCCESS = 0;
const EBADF = 8;
const ENOSYS = 52;

class WasiExit extends Error {
  constructor(code) {
    super(`mmx_wasm called proc_exit(${code})`);
    this.name = "WasiExit";
    this.code = code;
  }
}

function makeWasi(getMemory) {
  const view = () => new DataView(getMemory().buffer);
  const bytes = () => new Uint8Array(getMemory().buffer);
  const decoder = new TextDecoder();
  const pending = { 1: "", 2: "" };
  const flush = (fd, text) => {
    pending[fd] += text;
    let nl;
    while ((nl = pending[fd].indexOf("\n")) >= 0) {
      const line = pending[fd].slice(0, nl);
      pending[fd] = pending[fd].slice(nl + 1);
      (fd === 1 ? console.log : console.error)(`[mmx_wasm] ${line}`);
    }
  };
  const nowNs = (id) => {
    // 0 = realtime, everything else (monotonic, cputime) from performance.now().
    const ms = id === 0 || typeof performance === "undefined"
      ? Date.now()
      : performance.timeOrigin + performance.now();
    return BigInt(Math.round(ms * 1e6));
  };

  return {
    random_get(ptr, len) {
      const c = globalThis.crypto;
      if (!c || !c.getRandomValues) return ENOSYS;
      // getRandomValues refuses more than 65536 bytes per call.
      for (let off = 0; off < len; off += 65536) {
        c.getRandomValues(bytes().subarray(ptr + off, ptr + Math.min(len, off + 65536)));
      }
      return ESUCCESS;
    },
    environ_sizes_get(countPtr, sizePtr) {
      const v = view();
      v.setUint32(countPtr, 0, true);
      v.setUint32(sizePtr, 0, true);
      return ESUCCESS;
    },
    environ_get() {
      return ESUCCESS;
    },
    clock_time_get(id, _precision, timePtr) {
      view().setBigUint64(timePtr, nowNs(id), true);
      return ESUCCESS;
    },
    fd_close(fd) {
      return fd <= 2 ? ESUCCESS : EBADF;
    },
    fd_fdstat_get(fd, statPtr) {
      if (fd > 2) return EBADF;
      const v = view();
      v.setUint8(statPtr, 2); // filetype: character_device
      v.setUint16(statPtr + 2, 0, true); // fdflags
      v.setBigUint64(statPtr + 8, 0xffffffffffffffffn, true); // rights_base
      v.setBigUint64(statPtr + 16, 0n, true); // rights_inheriting
      return ESUCCESS;
    },
    fd_filestat_get(fd) {
      return fd > 2 ? EBADF : ENOSYS;
    },
    fd_prestat_get() {
      return EBADF; // no preopened directories: libc stops enumerating here
    },
    fd_prestat_dir_name() {
      return EBADF;
    },
    fd_read(fd, _iovs, _iovsLen, nreadPtr) {
      if (fd !== 0) return EBADF;
      view().setUint32(nreadPtr, 0, true); // stdin is always at EOF
      return ESUCCESS;
    },
    fd_write(fd, iovs, iovsLen, nwrittenPtr) {
      if (fd !== 1 && fd !== 2) return EBADF;
      const v = view();
      let total = 0;
      let text = "";
      for (let i = 0; i < iovsLen; i++) {
        const buf = v.getUint32(iovs + i * 8, true);
        const len = v.getUint32(iovs + i * 8 + 4, true);
        text += decoder.decode(bytes().slice(buf, buf + len), { stream: true });
        total += len;
      }
      flush(fd, text);
      v.setUint32(nwrittenPtr, total, true);
      return ESUCCESS;
    },
    path_create_directory() {
      return ENOSYS;
    },
    path_filestat_get() {
      return ENOSYS;
    },
    path_open() {
      return ENOSYS;
    },
    proc_exit(code) {
      throw new WasiExit(code);
    },
  };
}

async function compile(src) {
  if (src instanceof WebAssembly.Module) return src;
  if (src instanceof ArrayBuffer || ArrayBuffer.isView(src)) return WebAssembly.compile(src);
  const res = await fetch(src);
  if (!res.ok) throw new Error(`mmx_wasm: fetch ${src} failed: HTTP ${res.status}`);
  if (WebAssembly.compileStreaming && /wasm/.test(res.headers.get("content-type") || "")) {
    return WebAssembly.compileStreaming(res);
  }
  return WebAssembly.compile(await res.arrayBuffer());
}

function instantiate(module) {
  let memory = null;
  const wasi = makeWasi(() => memory);
  // Instance from an already compiled Module is allowed synchronously.
  const instance = new WebAssembly.Instance(module, { wasi_snapshot_preview1: wasi });
  memory = instance.exports.memory;
  if (typeof instance.exports._initialize === "function") instance.exports._initialize();
  return instance.exports;
}

/**
 * Load mmx_wasm.wasm.
 * @param {string|URL|ArrayBuffer|ArrayBufferView|WebAssembly.Module} urlOrBytes
 * @returns {Promise<{turn(input: {source: string, by: string, note?: string,
 *   prev_state?: object|null}): {exit: number, svg?: string, diff?: object,
 *   state?: object, noop?: true, error?: string}}>}
 */
export async function loadMmx(urlOrBytes) {
  const module = await compile(urlOrBytes);
  let exp = instantiate(module);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function turn(input) {
    if (!input || typeof input.source !== "string") {
      throw new TypeError("mmx turn: input.source must be a string");
    }
    const req = encoder.encode(JSON.stringify(input));
    try {
      const ptr = exp.wasm_alloc(req.length) >>> 0;
      new Uint8Array(exp.memory.buffer, ptr, req.length).set(req);
      const out = exp.wasm_turn(ptr, req.length) >>> 0;
      const len = exp.wasm_result_len() >>> 0;
      // Read after the call: memory may have grown and detached old views.
      const result = JSON.parse(decoder.decode(new Uint8Array(exp.memory.buffer, out, len)));
      // wasm_free exists from 0.4.1; older modules leak the request buffer.
      if (exp.wasm_free) exp.wasm_free(ptr, req.length);
      return result;
    } catch (e) {
      // A trap (Rust panic) or proc_exit leaves the instance unusable;
      // start a fresh one so the next turn works. No state lives in it.
      exp = instantiate(module);
      throw e;
    }
  }

  return { turn };
}

if (typeof window !== "undefined") window.MmxWasm = { loadMmx };
