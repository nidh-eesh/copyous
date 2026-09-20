import { beginTiming } from '../common/timing.js';

export interface PersistenceTask {
	readonly kind: 'insert' | 'update' | 'delete' | 'clear' | 'retention' | 'flush';
	readonly group?: string;
	readonly key?: string;
	readonly barrier?: boolean;
	readonly trailing?: boolean;
	run(): Promise<void>;
}

export type PersistenceDelay = (milliseconds: number) => Promise<void>;

export interface PersistenceQueueOptions {
	delay: PersistenceDelay;
	timingSink?: (message: string) => void;
	onError?: (error: unknown, task: PersistenceTask, attempt: number) => void;
	onRecovered?: () => void;
}

/** Serial, coalescing write-behind queue used by persistent backends. */
export class PersistenceQueue {
	private readonly _pending: PersistenceTask[] = [];
	private readonly _idleWaiters = new Set<() => void>();
	private _running: PersistenceTask | null = null;
	private _pumping: boolean = false;
	private _failed: boolean = false;

	constructor(private readonly options: PersistenceQueueOptions) {}

	get pending(): number {
		return this._pending.length + (this._running ? 1 : 0);
	}

	public enqueue(task: PersistenceTask): void {
		if (task.key && !task.barrier) {
			for (let i = this._pending.length - 1; i >= 0; i--) {
				const pending = this._pending[i]!;
				if (pending.barrier) break;
				if (pending.key === task.key) {
					if (task.trailing) {
						this._pending.splice(i, 1);
						this._pending.push(task);
					} else {
						this._pending[i] = task;
					}
					this.start();
					return;
				}
			}
		}

		this._pending.push(task);
		this.start();
	}

	public removePending(predicate: (task: PersistenceTask) => boolean): void {
		for (let i = this._pending.length - 1; i >= 0; i--) {
			if (predicate(this._pending[i]!)) this._pending.splice(i, 1);
		}
		this.resolveIdle();
	}

	public drain(): Promise<void> {
		if (this.pending === 0) return Promise.resolve();

		return new Promise((resolve) => {
			this._idleWaiters.add(resolve);
		});
	}

	private start(): void {
		if (this._pumping) return;
		this._pumping = true;
		this.pump().catch(() => {});
	}

	private async pump(): Promise<void> {
		const task = this._pending.shift();
		if (!task) {
			this._running = null;
			this._pumping = false;
			this.resolveIdle();

			// A task can be enqueued between checking the queue and resetting the
			// pumping flag.
			if (this._pending.length > 0) this.start();
			return;
		}

		this._running = task;
		const timing = beginTiming(this.options.timingSink, 'storage.persistence.queue', {
			kind: task.kind,
		});
		const attempts = await this.runTask(task);
		timing.finish({ attempts });
		this._running = null;
		await this.pump();
	}

	private async runTask(task: PersistenceTask, attempt: number = 0): Promise<number> {
		try {
			await task.run();
			if (this._failed) {
				this._failed = false;
				this.options.onRecovered?.();
			}
			return attempt;
		} catch (error) {
			const nextAttempt = attempt + 1;
			this._failed = true;
			this.options.onError?.(error, task, nextAttempt);
			const backoff = Math.min(5000, 100 * 2 ** Math.min(nextAttempt - 1, 6));
			await this.options.delay(backoff);
			return await this.runTask(task, nextAttempt);
		}
	}

	private resolveIdle(): void {
		if (this.pending !== 0) return;
		for (const resolve of this._idleWaiters) resolve();
		this._idleWaiters.clear();
	}
}
