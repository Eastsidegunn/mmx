import { promises as fs } from "node:fs";

// Helpers for mmx's turn log (`<stem>.turns.jsonl`): one JSON object per
// committed turn, `{v, at, by, note, source_sha256, diff}`.

export type TurnEntry = Record<string, unknown>;

export async function readTurnEntries(logPath: string): Promise<TurnEntry[]> {
	let text: string;
	try {
		text = await fs.readFile(logPath, "utf8");
	} catch {
		return [];
	}
	const entries: TurnEntry[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line) as TurnEntry);
		} catch {
			// mmx skips unparseable lines too; a partial final line is not a turn.
		}
	}
	return entries;
}

/** Human turns after the last non-human turn: mmx's definition of "unanswered". */
export function unansweredHumanEntries(entries: TurnEntry[]): TurnEntry[] {
	let start = 0;
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		if (entries[i].by !== "human") {
			start = i + 1;
			break;
		}
	}
	return entries.slice(start).filter((entry) => entry.by === "human");
}

/** Identity of one turn for delivery dedupe across the watcher, turn-start injection, and mmx_wait. */
export function deliveryKey(path: string, entry: TurnEntry): string {
	return `${path}\0${String(entry.at)}\0${String(entry.source_sha256)}\0${String(entry.note ?? "")}`;
}
