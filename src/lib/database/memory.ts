import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import { ItemType } from '../common/constants.js';
import { ClipboardHistory } from '../common/settings.js';
import { ClipboardEntry, Database, DatabaseSearch, Metadata } from './database.js';

/**
 * In memory database
 */
export class MemoryDatabase implements Database {
	protected _entries: Map<string, ClipboardEntry> = new Map();
	protected _keys: Map<number, string> = new Map();
	protected _id: number = 0;

	constructor() {}

	public async init(): Promise<void> {}

	public clear(history: ClipboardHistory): Promise<number[]> {
		let deleted: number[] = [];
		switch (history) {
			case ClipboardHistory.Clear:
				deleted = Array.from(this._keys.keys());
				this._entries.clear();
				this._keys.clear();
				break;
			case ClipboardHistory.KeepPinnedAndTagged:
				deleted = [];
				for (const [key, entry] of this._entries) {
					if (!(entry.pinned || entry.tag)) {
						this._entries.delete(key);
						this._keys.delete(entry.id);
						deleted.push(entry.id);
					}
				}
				break;
			case ClipboardHistory.KeepAll:
				break;
		}

		return Promise.resolve(deleted);
	}

	public async close(): Promise<void> {
		await this.clear(ClipboardHistory.Clear);
	}

	public flush(): Promise<void> {
		return Promise.resolve();
	}

	public entries(limit?: number): Promise<ClipboardEntry[]> {
		const entries = Array.from(this._entries.values()).sort((a, b) => b.datetime.compare(a.datetime));
		return Promise.resolve(limit === undefined ? entries : entries.slice(0, limit));
	}

	public get(id: number): Promise<ClipboardEntry | null> {
		const key = this._keys.get(id);
		return Promise.resolve(key === undefined ? null : (this._entries.get(key) ?? null));
	}

	public async search(search: DatabaseSearch, limit: number): Promise<ClipboardEntry[]> {
		const query = search.query.toLocaleLowerCase();
		const entries = await this.entries();
		return entries
			.filter((entry) => {
				if (search.pinned ? !entry.pinned : search.excludePinned && entry.pinned) return false;
				if (search.tag !== null ? entry.tag !== search.tag : search.excludeTagged && entry.tag !== null)
					return false;
				if (search.type !== null && entry.type !== search.type) return false;
				if (query.length === 0) return true;

				const text = [entry.content, entry.title];
				if (entry.metadata) text.push(JSON.stringify(entry.metadata));
				if (entry.type === ItemType.File || entry.type === ItemType.Files) {
					try {
						text.push(decodeURI(entry.content).replaceAll('file://', ''));
					} catch {
						// Keep the encoded URI as a search candidate.
					}
				}
				return text.some((value) => value.toLocaleLowerCase().includes(query));
			})
			.slice(0, limit);
	}

	public selectConflict(entry: ClipboardEntry | { type: ItemType; content: string }): Promise<number | null> {
		const key = this.entryToKey(entry);
		return Promise.resolve(this._entries.get(key)?.id ?? null);
	}

	public insert(type: ItemType, content: string, metadata: Metadata | null = null): Promise<ClipboardEntry | null> {
		const key = this.entryToKey({ type, content });
		const entry = this._entries.get(key);
		if (entry) {
			return Promise.resolve(null);
		} else {
			const newEntry = new ClipboardEntry(
				this._id++,
				type,
				content,
				false,
				null,
				GLib.DateTime.new_now_utc(),
				metadata,
			);
			this._entries.set(key, newEntry);
			this._keys.set(newEntry.id, key);
			return Promise.resolve(newEntry);
		}
	}

	public updateProperty(
		entry: ClipboardEntry,
		property: Exclude<keyof ClipboardEntry, keyof GObject.Object>,
	): Promise<number> {
		const previousKey = this._keys.get(entry.id);
		if (previousKey === undefined) return Promise.resolve(-1);

		if (property === 'type' || property === 'content') {
			const nextKey = this.entryToKey(entry);
			const conflict = this._entries.get(nextKey);
			if (conflict && conflict.id !== entry.id) return Promise.resolve(conflict.id);

			if (previousKey !== nextKey) this._entries.delete(previousKey);
			this._entries.set(nextKey, entry);
			this._keys.set(entry.id, nextKey);
		} else {
			this._entries.set(previousKey, entry);
		}

		return Promise.resolve(-1);
	}

	public delete(entry: ClipboardEntry): Promise<boolean> {
		const key = this._keys.get(entry.id);
		this._keys.delete(entry.id);
		if (key) {
			this._entries.delete(key);
			return Promise.resolve(true);
		}

		return Promise.resolve(false);
	}

	public async deleteOldest(offset: number, olderThanMinutes: number): Promise<number[]> {
		const entries = await this.entries();
		const unprotected = entries.filter((e) => !(e.pinned || e.tag));
		const deleted = unprotected.slice(offset).map((e) => e.id);

		if (olderThanMinutes > 0) {
			const now = GLib.DateTime.new_now_utc();
			const olderThan = now.add_minutes(-olderThanMinutes)!;
			const deletedIds = new Set(deleted);
			for (const entry of unprotected) {
				if (!deletedIds.has(entry.id) && entry.datetime.compare(olderThan) < 0) {
					deletedIds.add(entry.id);
					deleted.push(entry.id);
				}
			}
		}

		for (const id of deleted) {
			const key = this._keys.get(id);
			this._keys.delete(id);
			if (key) this._entries.delete(key);
		}

		return deleted;
	}

	protected entryToKey(entry: ClipboardEntry | { type: ItemType; content: string }) {
		return `${entry.type}:${entry.content}`;
	}
}
