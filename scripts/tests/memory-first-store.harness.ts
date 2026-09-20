export type StoreEntry = {
	id: number;
	type: string;
	content: string;
	datetime: number;
	pinned: boolean;
	tag: string | null;
	title: string;
};

export type PersistedSnapshot = readonly StoreEntry[];

export type PendingOperation = {
	revision: number;
	snapshot: PersistedSnapshot;
	barrier: boolean;
	totalAttempts: number;
};

export interface PersistenceAdapter {
	load(): Promise<StoreEntry[]>;
	persist(snapshot: PersistedSnapshot, revision: number): Promise<void>;
}

function cloneEntry(entry: StoreEntry): StoreEntry {
	return { ...entry };
}

export function cloneSnapshot(snapshot: PersistedSnapshot): StoreEntry[] {
	return snapshot.map(cloneEntry);
}

function entryKey(type: string, content: string): string {
	return `${type}\u0000${content}`;
}

/**
 * A deterministic persistent fake. It records only generated test data and
 * deliberately exposes no content in its diagnostics.
 */
export class FakePersistenceAdapter implements PersistenceAdapter {
	private currentSnapshot: StoreEntry[];
	private failuresRemaining = 0;

	public loadCalls = 0;
	public persistCalls = 0;
	public readonly attemptedRevisions: number[] = [];
	public readonly persistedRevisions: number[] = [];
	public readonly persistedSnapshots: StoreEntry[][] = [];

	constructor(initialSnapshot: PersistedSnapshot = []) {
		this.currentSnapshot = cloneSnapshot(initialSnapshot);
	}

	setFailures(count: number): void {
		if (!Number.isInteger(count) || count < 0) throw new RangeError('failure count must be non-negative');
		this.failuresRemaining = count;
	}

	get snapshot(): StoreEntry[] {
		return cloneSnapshot(this.currentSnapshot);
	}

	async load(): Promise<StoreEntry[]> {
		this.loadCalls++;
		return cloneSnapshot(this.currentSnapshot);
	}

	async persist(snapshot: PersistedSnapshot, revision: number): Promise<void> {
		this.persistCalls++;
		this.attemptedRevisions.push(revision);

		if (this.failuresRemaining > 0) {
			this.failuresRemaining--;
			throw new Error('injected persistence failure');
		}

		this.currentSnapshot = cloneSnapshot(snapshot);
		this.persistedRevisions.push(revision);
		this.persistedSnapshots.push(cloneSnapshot(snapshot));
	}
}

export class OrderedPersistenceQueue {
	private readonly pending: PendingOperation[] = [];
	private queueState: 'open' | 'draining' | 'failed' | 'closed' = 'open';

	constructor(
		private readonly adapter: PersistenceAdapter,
		private readonly maxAttempts = 3,
	) {
		if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
			throw new RangeError('maxAttempts must be positive');
		}
	}

	get state(): 'open' | 'draining' | 'failed' | 'closed' {
		return this.queueState;
	}

	get size(): number {
		return this.pending.length;
	}

	pendingOperations(): PendingOperation[] {
		return this.pending.map((operation) => ({
			revision: operation.revision,
			snapshot: cloneSnapshot(operation.snapshot),
			barrier: operation.barrier,
			totalAttempts: operation.totalAttempts,
		}));
	}

	enqueue(snapshot: PersistedSnapshot, revision: number, barrier = false): void {
		if (this.queueState === 'closed') throw new Error('persistence queue is closed');
		if (this.queueState === 'failed') throw new Error('persistence queue needs retry');

		const operation: PendingOperation = {
			revision,
			snapshot: cloneSnapshot(snapshot),
			barrier,
			totalAttempts: 0,
		};
		const previous = this.pending.at(-1);

		// Consecutive ordinary snapshots can be coalesced. A barrier remains a
		// durable ordering point so that later writes cannot leapfrog a delete or clear.
		if (previous && !previous.barrier && !barrier) this.pending[this.pending.length - 1] = operation;
		else this.pending.push(operation);
	}

	async drain(): Promise<void> {
		if (this.queueState === 'closed') return;
		if (this.queueState === 'failed') throw new Error('persistence queue needs retry');

		this.queueState = 'draining';
		while (this.pending.length > 0) {
			const operation = this.pending[0]!;
			let attemptsThisDrain = 0;

			while (true) {
				operation.totalAttempts++;
				attemptsThisDrain++;
				try {
					await this.adapter.persist(operation.snapshot, operation.revision);
					this.pending.shift();
					break;
				} catch (error) {
					if (attemptsThisDrain >= this.maxAttempts) {
						this.queueState = 'failed';
						throw error;
					}
				}
			}
		}

		this.queueState = 'open';
	}

	async retry(): Promise<void> {
		if (this.queueState !== 'failed') return this.drain();
		this.queueState = 'open';
		return this.drain();
	}

	async close(): Promise<void> {
		if (this.queueState === 'closed') return;
		await this.drain();
		this.queueState = 'closed';
	}
}

export class MemoryFirstStore {
	private readonly entries = new Map<number, StoreEntry>();
	private readonly idsByKey = new Map<string, number>();
	private nextId = 1;
	private revision = 0;
	private storeState: 'new' | 'ready' | 'closed' = 'new';

	public readonly queue: OrderedPersistenceQueue;

	constructor(private readonly adapter: PersistenceAdapter) {
		this.queue = new OrderedPersistenceQueue(adapter);
	}

	get state(): 'new' | 'ready' | 'closed' {
		return this.storeState;
	}

	async hydrate(): Promise<void> {
		if (this.storeState === 'closed') throw new Error('store is closed');
		const snapshot = await this.adapter.load();
		this.entries.clear();
		this.idsByKey.clear();
		this.nextId = 1;

		for (const entry of snapshot) {
			if (this.entries.has(entry.id)) throw new Error(`duplicate id ${entry.id}`);
			const key = entryKey(entry.type, entry.content);
			if (this.idsByKey.has(key)) throw new Error('duplicate entry key');
			const copy = cloneEntry(entry);
			this.entries.set(copy.id, copy);
			this.idsByKey.set(key, copy.id);
			this.nextId = Math.max(this.nextId, copy.id + 1);
		}

		this.storeState = 'ready';
	}

	query(text = ''): StoreEntry[] {
		this.ensureReady();
		const needle = text.toLocaleLowerCase();
		return this.snapshot().filter((entry) => needle === '' || entry.content.toLocaleLowerCase().includes(needle));
	}

	snapshot(): StoreEntry[] {
		return [...this.entries.values()].sort((a, b) => b.datetime - a.datetime || b.id - a.id).map(cloneEntry);
	}

	insert(type: string, content: string, datetime: number): { entry: StoreEntry; duplicate: boolean } {
		this.ensureReady();
		const key = entryKey(type, content);
		const existingId = this.idsByKey.get(key);
		if (existingId !== undefined) {
			const existing = this.entries.get(existingId)!;
			this.entries.set(existingId, { ...existing, datetime });
			this.enqueueSnapshot(false);
			return { entry: cloneEntry(this.entries.get(existingId)!), duplicate: true };
		}

		const entry: StoreEntry = { id: this.nextId++, type, content, datetime, pinned: false, tag: null, title: '' };
		this.entries.set(entry.id, entry);
		this.idsByKey.set(key, entry.id);
		this.enqueueSnapshot(false);
		return { entry: cloneEntry(entry), duplicate: false };
	}

	update(
		id: number,
		patch: Partial<Pick<StoreEntry, 'content' | 'datetime' | 'pinned' | 'tag' | 'title'>>,
	): StoreEntry {
		this.ensureReady();
		const current = this.entries.get(id);
		if (!current) throw new Error(`unknown entry ${id}`);

		if (patch.content !== undefined && patch.content !== current.content) {
			const conflictingId = this.idsByKey.get(entryKey(current.type, patch.content));
			if (conflictingId !== undefined && conflictingId !== id) throw new Error('duplicate entry key');
			this.idsByKey.delete(entryKey(current.type, current.content));
			this.idsByKey.set(entryKey(current.type, patch.content), id);
		}

		const updated = { ...current, ...patch };
		this.entries.set(id, updated);
		this.enqueueSnapshot(false);
		return cloneEntry(updated);
	}

	delete(id: number): boolean {
		this.ensureReady();
		const entry = this.entries.get(id);
		if (!entry) return false;
		this.entries.delete(id);
		this.idsByKey.delete(entryKey(entry.type, entry.content));
		this.enqueueSnapshot(true);
		return true;
	}

	clear(): number {
		this.ensureReady();
		const count = this.entries.size;
		this.entries.clear();
		this.idsByKey.clear();
		this.enqueueSnapshot(true);
		return count;
	}

	async close(): Promise<void> {
		if (this.storeState === 'closed') return;
		await this.queue.close();
		this.storeState = 'closed';
	}

	private enqueueSnapshot(barrier: boolean): void {
		this.queue.enqueue(this.snapshot(), ++this.revision, barrier);
	}

	private ensureReady(): void {
		if (this.storeState !== 'ready') throw new Error(`store is ${this.storeState}`);
	}
}

export function makeEntries(count: number): StoreEntry[] {
	if (!Number.isInteger(count) || count < 0) throw new RangeError('count must be non-negative');

	return Array.from({ length: count }, (_, index) => ({
		id: index + 1,
		type: index % 3 === 0 ? 'Text' : index % 3 === 1 ? 'Code' : 'Link',
		content: `generated-entry-${index % 50}-payload-${String(index).padStart(4, '0')}`,
		datetime: count - index,
		pinned: index % 97 === 0,
		tag: index % 101 === 0 ? 'generated' : null,
		title: index % 11 === 0 ? `generated-title-${index}` : '',
	}));
}
