import GLib from 'gi://GLib';

import { ItemType } from '../common/constants.js';
import { ClipboardHistory } from '../common/settings.js';
import { beginTiming } from '../common/timing.js';
import { ClipboardEntry, Metadata } from './database.js';

function entryKey(entry: ClipboardEntry | { type: ItemType; content: string }): string {
	return `${entry.type}\u0000${entry.content}`;
}

function compareEntries(a: ClipboardEntry, b: ClipboardEntry): number {
	const datetime = b.datetime.compare(a.datetime);
	return datetime !== 0 ? datetime : b.id - a.id;
}

/**
 * Canonical in-memory clipboard model.
 *
 * Persistent backends hydrate this store once. After hydration, reads and
 * mutations never need to consult the backend.
 */
export class ClipboardStore {
	private readonly _byId = new Map<number, ClipboardEntry>();
	private readonly _byKey = new Map<string, ClipboardEntry>();
	private readonly _keysById = new Map<number, string>();
	private _ordered: ClipboardEntry[] = [];
	private _nextTemporaryId: number = 2147483647;

	constructor(private readonly timingSink?: (message: string) => void) {}

	public hydrate(entries: readonly ClipboardEntry[]): void {
		const timing = beginTiming(this.timingSink, 'storage.memory.hydrate', { requested: entries.length });
		this.clear();

		for (const entry of entries) this.add(entry);
		this._ordered.sort(compareEntries);
		timing.finish({ entries: this._ordered.length });
	}

	public clear(): void {
		this._byId.clear();
		this._byKey.clear();
		this._keysById.clear();
		this._ordered = [];
		this._nextTemporaryId = 2147483647;
	}

	public snapshot(): ClipboardEntry[] {
		const timing = beginTiming(this.timingSink, 'storage.memory.snapshot');
		const snapshot = this._ordered.slice();
		timing.finish({ entries: snapshot.length });
		return snapshot;
	}

	public has(entry: ClipboardEntry): boolean {
		return this._byId.get(entry.id) === entry;
	}

	public get(id: number): ClipboardEntry | undefined {
		return this._byId.get(id);
	}

	public findConflict(type: ItemType, content: string): ClipboardEntry | undefined {
		return this._byKey.get(entryKey({ type, content }));
	}

	public create(type: ItemType, content: string, metadata: Metadata | null): ClipboardEntry | null {
		if (this.findConflict(type, content)) return null;

		const entry = new ClipboardEntry(
			this._nextTemporaryId--,
			type,
			content,
			false,
			null,
			GLib.DateTime.new_now_utc(),
			metadata,
		);
		this.add(entry);
		this.reorder(entry);
		return entry;
	}

	/** Adds a storage-backed entry to the bounded working set. */
	public adopt(entry: ClipboardEntry): ClipboardEntry {
		const existing = this._byId.get(entry.id) ?? this._byKey.get(entryKey(entry));
		if (existing) return existing;

		this.add(entry);
		this.reorder(entry);
		return entry;
	}

	public remove(entry: ClipboardEntry): boolean {
		if (!this.has(entry)) return false;

		this._byId.delete(entry.id);
		const key = this._keysById.get(entry.id);
		if (key !== undefined) {
			this._keysById.delete(entry.id);
			if (this._byKey.get(key) === entry) this._byKey.delete(key);
		}

		const index = this._ordered.indexOf(entry);
		if (index >= 0) this._ordered.splice(index, 1);
		return true;
	}

	/**
	 * Re-indexes an entry after its type or content changes.
	 * @returns the conflicting entry, or null when the new key was accepted.
	 */
	public reindex(entry: ClipboardEntry): ClipboardEntry | null {
		if (!this.has(entry)) return null;

		const previousKey = this._keysById.get(entry.id);
		const nextKey = entryKey(entry);
		if (previousKey === nextKey) return null;

		const conflict = this._byKey.get(nextKey);
		if (conflict && conflict !== entry) return conflict;

		if (previousKey !== undefined && this._byKey.get(previousKey) === entry) {
			this._byKey.delete(previousKey);
		}
		this._byKey.set(nextKey, entry);
		this._keysById.set(entry.id, nextKey);
		return null;
	}

	public reorder(entry: ClipboardEntry): void {
		if (!this.has(entry)) return;

		const current = this._ordered.indexOf(entry);
		if (current >= 0) this._ordered.splice(current, 1);

		let low = 0;
		let high = this._ordered.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (compareEntries(entry, this._ordered[middle]!) < 0) high = middle;
			else low = middle + 1;
		}
		this._ordered.splice(low, 0, entry);
	}

	public clearCandidates(history: ClipboardHistory): ClipboardEntry[] {
		switch (history) {
			case ClipboardHistory.Clear:
				return this.snapshot();
			case ClipboardHistory.KeepPinnedAndTagged:
				return this._ordered.filter((entry) => !(entry.pinned || entry.tag));
			case ClipboardHistory.KeepAll:
				return [];
		}
	}

	public retentionCandidates(limit: number, olderThanMinutes: number): ClipboardEntry[] {
		const unprotected = this._ordered.filter((entry) => !(entry.pinned || entry.tag));
		const candidates = new Set(unprotected.slice(limit));

		if (olderThanMinutes > 0) {
			const cutoff = GLib.DateTime.new_now_utc().add_minutes(-olderThanMinutes)!;
			for (const entry of unprotected) {
				if (entry.datetime.compare(cutoff) < 0) candidates.add(entry);
			}
		}

		return this._ordered.filter((entry) => candidates.has(entry));
	}

	private add(entry: ClipboardEntry): void {
		const key = entryKey(entry);
		const conflict = this._byKey.get(key);
		if (conflict && conflict !== entry) return;

		this._byId.set(entry.id, entry);
		this._byKey.set(key, entry);
		this._keysById.set(entry.id, key);
		this._ordered.push(entry);
	}
}
