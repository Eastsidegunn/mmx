import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

// The pending-edit sidecar `<cwd>/.mmx/pi-pending.json`: unsent agent edits,
// {path: {sha, held?, owner}}. Several pi processes (and, after /new or
// /reload, several extension instances in one process) may share it, so each
// writer changes only its own entries under a lockfile.

export type Owner = { pid: number; id: string; session?: string };
export type PendingEntry = { sha: string; held?: boolean; owner?: Owner };
export type PendingEntries = Record<string, PendingEntry>;

/** Extension instances alive in this process (an instance leaves at session_shutdown). */
export const liveInstances = new Set<string>();

export function sidecarPath(cwd: string): string {
	return join(cwd, ".mmx", "pi-pending.json");
}

export function ownerAlive(owner: Owner | undefined): boolean {
	if (!owner || typeof owner.pid !== "number") return false;
	if (owner.pid === process.pid) return liveInstances.has(owner.id);
	try {
		process.kill(owner.pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export async function readSidecar(cwd: string): Promise<PendingEntries> {
	try {
		const parsed = JSON.parse(await fs.readFile(sidecarPath(cwd), "utf8")) as { pending?: Record<string, unknown> };
		const entries: PendingEntries = {};
		for (const [path, value] of Object.entries(parsed.pending ?? {})) {
			if (typeof value === "string") entries[path] = { sha: value }; // an ownerless entry is taken over
			else if (value && typeof (value as PendingEntry).sha === "string") entries[path] = value as PendingEntry;
		}
		return entries;
	} catch {
		return {};
	}
}

const sleep = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function withLock<T>(file: string, body: () => Promise<T>): Promise<T> {
	const lock = `${file}.lock`;
	await fs.mkdir(dirname(file), { recursive: true });
	let handle: fs.FileHandle | undefined;
	for (let attempt = 0; attempt < 100 && !handle; attempt += 1) {
		try {
			handle = await fs.open(lock, "wx");
		} catch {
			// Held by another writer; a lock older than 5 s is from a crashed one.
			// Rename it away first so a fresh lock created meanwhile is never removed.
			const age = await fs.stat(lock).then((stat) => Date.now() - stat.mtimeMs, () => 0);
			if (age > 5000) {
				const stale = `${lock}.${process.pid}.${attempt}.stale`;
				if (await fs.rename(lock, stale).then(() => true, () => false)) await fs.rm(stale, { force: true });
			} else await sleep(10);
		}
	}
	if (!handle) throw new Error("pi-mmx: the pending-edit sidecar is locked by another writer");
	try {
		return await body();
	} finally {
		await handle.close();
		await fs.rm(lock, { force: true });
	}
}

/** Read-modify-write under the lock; an empty result deletes the file. */
export async function updateSidecar(cwd: string, mutate: (entries: PendingEntries) => void): Promise<void> {
	const file = sidecarPath(cwd);
	await withLock(file, async () => {
		const entries = await readSidecar(cwd);
		mutate(entries);
		if (!Object.keys(entries).length) {
			await fs.rm(file, { force: true });
			return;
		}
		const temp = `${file}.${process.pid}.tmp`;
		await fs.writeFile(temp, `${JSON.stringify({ v: 2, pending: entries }, null, 1)}\n`);
		await fs.rename(temp, file);
	});
}
