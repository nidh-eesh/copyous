import GLib from 'gi://GLib';
import type GObject from 'gi://GObject';
import type Gda from 'gi://Gda';
import Gio from 'gi://Gio';

import type CopyousExtension from '../../extension.js';
import { ItemType, getDefaultDatabaseFile } from '../common/constants.js';
import { ClipboardHistory, DatabaseBackend } from '../common/settings.js';
import { beginTiming } from '../common/timing.js';
import { getLinkImagePath } from '../misc/link.js';
import { ClipboardEntry, Database, Metadata } from './database.js';
import { GdaDatabase } from './gda.js';
import { JsonDatabase } from './json.js';
import { MemoryDatabase } from './memory.js';
import { PersistenceQueue, PersistenceTask } from './persistenceQueue.js';
import { ClipboardStore } from './store.js';

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => {
		GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
			resolve();
			return GLib.SOURCE_REMOVE;
		});
	});
}

export class ClipboardEntryTracker {
	private _database: Database | undefined;
	private readonly _store: ClipboardStore;
	private _storageIds = new WeakMap<ClipboardEntry, number>();
	private readonly _signalIds = new Map<ClipboardEntry, number[]>();
	private readonly _persistenceQueue: PersistenceQueue;
	private _initTail: Promise<void> = Promise.resolve();
	private _ready: Promise<void> = Promise.resolve();
	private _fromDefault: boolean = false;
	private _storageWarningShown: boolean = false;

	constructor(private ext: CopyousExtension) {
		this._store = new ClipboardStore((message) => this.ext.logger?.log(message));
		this._persistenceQueue = new PersistenceQueue({
			delay,
			timingSink: (message) => this.ext.logger?.log(message),
			onError: (error, task, attempt) => this.persistenceFailed(error, task, attempt),
			onRecovered: () => {
				this._storageWarningShown = false;
				this.ext.logger.log('Clipboard history storage recovered');
			},
		});
	}

	get shouldInit(): boolean {
		if (this._fromDefault) {
			this._fromDefault = false;
			return false;
		}

		return true;
	}

	public isTracked(entry: ClipboardEntry): boolean {
		return this._store.has(entry);
	}

	public entries(): ClipboardEntry[] {
		return this._store.snapshot();
	}

	public init(): Promise<ClipboardEntry[]> {
		const run = this._initTail.catch(() => {}).then(() => this.initialize());
		this._ready = run.then(() => {});
		this._initTail = this._ready.catch(() => {});
		return run;
	}

	private async initialize(): Promise<ClipboardEntry[]> {
		await this._persistenceQueue.drain();
		await this._database?.close();
		this._database = undefined;
		this.untrackAll();
		this._store.clear();
		this._storageIds = new WeakMap<ClipboardEntry, number>();

		const backend: DatabaseBackend = this.ext.settings.get_enum('database-backend');
		const file = this.getFile();
		const dir = file.get_parent()!;
		const fileName = file.get_basename()!.replace(/(\.db|\.json)$/, '');
		const dbFile = dir.get_child(`${fileName}.db`);
		const jsonFile = dir.get_child(`${fileName}.json`);

		let entries: ClipboardEntry[] | null = null;
		if (backend === DatabaseBackend.Default) {
			this._fromDefault = true;
			if (this.ext.settings.get_boolean('in-memory-database')) {
				this.ext.logger.log('Set default database backend to in-memory');
				entries = await this.initMemory();
			} else if (dbFile.query_exists(null)) {
				entries = await this.initSqlite(dbFile, true);
				this.ext.settings.set_enum('database-backend', DatabaseBackend.Sqlite);
				this.ext.logger.log('Set default database backend to SQLite');
			} else if (jsonFile.query_exists(null)) {
				entries = await this.initJson(jsonFile);
				this.ext.settings.set_enum('database-backend', DatabaseBackend.Json);
				this.ext.logger.log('Set default database backend to JSON');
			} else {
				entries = await this.initSqlite(dbFile, false);
				if (entries !== null) {
					this.ext.settings.set_enum('database-backend', DatabaseBackend.Sqlite);
					this.ext.logger.log('Set default database backend to SQLite');
				} else {
					entries = await this.initJson(jsonFile);
					if (entries !== null) {
						this.ext.settings.set_enum('database-backend', DatabaseBackend.Json);
						this.ext.logger.log('Set default database backend to JSON');
					} else {
						entries = await this.initMemory();
						this.ext.settings.set_enum('database-backend', DatabaseBackend.Memory);
						this.ext.logger.log('Set default database backend to in-memory');
					}
				}
			}
		} else if (backend === DatabaseBackend.Sqlite) {
			entries = await this.initSqlite(dbFile, true);
		} else if (backend === DatabaseBackend.Json) {
			entries = await this.initJson(jsonFile);
		}

		entries ??= await this.initMemory();
		this._store.hydrate(entries);
		for (const entry of entries) {
			if (!this._store.has(entry)) continue;
			this._storageIds.set(entry, entry.id);
			this.track(entry);
		}

		this.applyRetention();
		return this._store.snapshot();
	}

	private getFile(): Gio.File {
		const environment = GLib.get_environ();
		const debugPath = GLib.environ_getenv(environment, 'DEBUG_COPYOUS_DBPATH');
		if (debugPath) {
			this.ext.logger.log('Using debug database');
			return Gio.File.new_for_path(debugPath);
		}

		const location = this.ext.settings.get_string('database-location');
		return location ? Gio.File.new_for_path(location) : getDefaultDatabaseFile(this.ext, DatabaseBackend.Default);
	}

	private async initSqlite(file: Gio.File | null, showError: boolean): Promise<ClipboardEntry[] | null> {
		const backendTiming = beginTiming((message) => this.ext.logger?.log(message), 'storage.backend.init', {
			backend: 'sqlite',
		});
		let snapshotTiming: ReturnType<typeof beginTiming> | undefined;

		try {
			const environment = GLib.get_environ();
			const gdaVersion = GLib.environ_getenv(environment, 'DEBUG_COPYOUS_GDA_VERSION');
			if (gdaVersion) imports.package.require({ Gda: gdaVersion });
		} catch (err) {
			this.ext.logger.warn(err);
		}

		let gda: typeof Gda;
		try {
			gda = (await import('gi://Gda')).default;
		} catch {
			this.ext.logger.error(`Failed to load Gda`);

			if (showError && !this.ext.settings.get_boolean('disable-gda-warning')) {
				this.ext.notificationManager?.warning(
					_('Failed to load Gda'),
					_('Clipboard history will be disabled'),
					[_('Disable Warning'), () => this.ext.settings.set_boolean('disable-gda-warning', true)],
				);
			}
			backendTiming.cancel({ error: true });
			return null;
		}

		try {
			this.ext.logger.log(`Using ${file === null ? 'in-memory ' : ''}Gda ${gda.__version__} database`);
			this._database = new GdaDatabase(this.ext, gda, file);
			await this._database.init();
			backendTiming.finish();
			snapshotTiming = beginTiming((message) => this.ext.logger?.log(message), 'storage.backend.snapshot', {
				backend: 'sqlite',
			});
			const entries = await this._database.entries();
			snapshotTiming.finish({ entries: entries.length });
			return entries;
		} catch (error) {
			backendTiming.cancel({ error: true });
			snapshotTiming?.cancel({ error: true });
			this.ext.logger.error('Failed to load Gda', error);
			this.ext.notificationManager?.warning(_('Failed to load Gda'), _('Clipboard history will be disabled'));
			this._database = undefined;
			return null;
		}
	}

	private async initJson(file: Gio.File | null): Promise<ClipboardEntry[] | null> {
		if (file === null) return await this.initMemory();

		const backendTiming = beginTiming((message) => this.ext.logger?.log(message), 'storage.backend.init', {
			backend: 'json',
		});
		let snapshotTiming: ReturnType<typeof beginTiming> | undefined;

		try {
			this.ext.logger.log('Using JSON database');
			this._database = new JsonDatabase(this.ext, file);
			await this._database.init();
			backendTiming.finish();
			snapshotTiming = beginTiming((message) => this.ext.logger?.log(message), 'storage.backend.snapshot', {
				backend: 'json',
			});
			const entries = await this._database.entries();
			snapshotTiming.finish({ entries: entries.length });
			return entries;
		} catch (error) {
			backendTiming.cancel({ error: true });
			snapshotTiming?.cancel({ error: true });
			this.ext.logger.error('Failed to initialize JSON database', error);
			this.ext.notificationManager?.warning(_('Failed to load JSON'), _('Clipboard history will be disabled'));
			this._database = undefined;
			return null;
		}
	}

	private async initMemory(): Promise<ClipboardEntry[]> {
		this.ext.logger.log('Using in-memory database');
		const backendTiming = beginTiming((message) => this.ext.logger?.log(message), 'storage.backend.init', {
			backend: 'memory',
		});
		this._database = new MemoryDatabase();
		await this._database.init();
		backendTiming.finish({ entries: 0 });
		return [];
	}

	public async clear(history: ClipboardHistory | null = null): Promise<void> {
		await this._ready;
		if (!this._database) return;

		const selectedHistory = history ?? this.ext.settings.get_enum('clipboard-history');
		const removed = this._store.clearCandidates(selectedHistory);
		if (removed.length === 0) return;

		for (const entry of removed) this.removeLocal(entry, true);
		this.removePendingUpdates(removed);

		const database = this._database;
		this._persistenceQueue.enqueue({
			kind: 'clear',
			barrier: true,
			run: async () => {
				await database.clear(selectedHistory);
				removed.forEach((entry) => this.cleanupEntryAssets(entry));
			},
		});
		this.enqueueFlush(database);
	}

	public async destroy(): Promise<void> {
		await this._ready.catch(() => {});
		await this._persistenceQueue.drain();
		await this._database?.close();
		this._database = undefined;
		this.untrackAll();
		this._store.clear();
	}

	public async insert(
		type: ItemType,
		content: string,
		metadata: Metadata | null = null,
	): Promise<ClipboardEntry | null> {
		await this._ready;
		const database = this._database;
		if (!database) return null;

		const conflict = this._store.findConflict(type, content);
		if (conflict) {
			conflict.datetime = GLib.DateTime.new_now_utc();
			return null;
		}

		const entry = this._store.create(type, content, metadata);
		if (!entry) return null;
		this.track(entry);

		const insertedType = type;
		const insertedContent = content;
		const insertedMetadata = metadata;
		this._persistenceQueue.enqueue({
			kind: 'insert',
			group: this.entryGroup(entry),
			run: async () => {
				const stored = await database.insert(insertedType, insertedContent, insertedMetadata);
				if (!stored) throw new Error('Failed to persist clipboard entry');
				this._storageIds.set(entry, stored.id);

				const persistedEntry = this.toStorageEntry(entry);
				await database.updateProperty(persistedEntry, 'datetime');
			},
		});
		this.enqueueFlush(database);

		this.applyRetention();
		return entry;
	}

	public checkOldest(): boolean {
		const minutes = this.ext.settings.get_int('history-time');
		if (minutes === 0) return false;

		const cutoff = GLib.DateTime.new_now_utc().add_minutes(-minutes)!;
		return this._store
			.snapshot()
			.some((entry) => !(entry.pinned || entry.tag) && entry.datetime.compare(cutoff) < 0);
	}

	public async deleteOldest(): Promise<void> {
		await this._ready;
		this.applyRetention();
	}

	private applyRetention(): void {
		const database = this._database;
		if (!database) return;

		const limit = this.ext.settings.get_int('history-length');
		const minutes = this.ext.settings.get_int('history-time');
		const removed = this._store.retentionCandidates(limit, minutes);
		if (removed.length === 0) return;

		for (const entry of removed) this.removeLocal(entry, true);
		this.removePendingUpdates(removed);
		this._persistenceQueue.enqueue({
			kind: 'retention',
			barrier: true,
			run: async () => {
				await database.deleteOldest(limit, minutes);
				removed.forEach((entry) => this.cleanupEntryAssets(entry));
			},
		});
		this.enqueueFlush(database);
	}

	private track(entry: ClipboardEntry): void {
		const reindex = (property: 'type' | 'content') => {
			const conflict = this._store.reindex(entry);
			if (conflict) {
				const datetime = entry.datetime;
				this.remove(entry);
				conflict.datetime = datetime;
				return;
			}
			this.enqueueUpdate(entry, property);
		};

		const ids = [
			entry.connect('notify::type', () => reindex('type')),
			entry.connect('notify::content', () => reindex('content')),
			entry.connect('notify::pinned', () => this.enqueueUpdate(entry, 'pinned')),
			entry.connect('notify::tag', () => this.enqueueUpdate(entry, 'tag')),
			entry.connect('notify::datetime', () => {
				this._store.reorder(entry);
				this.enqueueUpdate(entry, 'datetime');
			}),
			entry.connect('notify::metadata', () => this.enqueueUpdate(entry, 'metadata')),
			entry.connect('notify::title', () => this.enqueueUpdate(entry, 'title')),
			entry.connect('delete', () => this.remove(entry)),
		];
		this._signalIds.set(entry, ids);
	}

	private enqueueUpdate(
		entry: ClipboardEntry,
		property: Exclude<keyof ClipboardEntry, keyof GObject.Object | 'id'>,
	): void {
		const database = this._database;
		if (!database || !this._store.has(entry)) return;

		this._persistenceQueue.enqueue({
			kind: 'update',
			group: this.entryGroup(entry),
			key: `${this.entryGroup(entry)}:${String(property)}`,
			run: async () => {
				const persistedEntry = this.toStorageEntry(entry);
				const conflictId = await database.updateProperty(persistedEntry, property);
				if (conflictId >= 0) {
					this.ext.logger.warn(`Persistent clipboard conflict for entry ${entry.id}`);
				}
			},
		});
		this.enqueueFlush(database);
	}

	private remove(entry: ClipboardEntry): void {
		if (!this._store.has(entry)) return;
		const database = this._database;
		if (!database) return;

		this.removeLocal(entry, false);
		const group = this.entryGroup(entry);
		this._persistenceQueue.removePending((task) => task.group === group && task.kind === 'update');
		this._persistenceQueue.enqueue({
			kind: 'delete',
			group,
			barrier: true,
			run: async () => {
				const persistedEntry = this.toStorageEntry(entry);
				await database.delete(persistedEntry);
				this.cleanupEntryAssets(entry);
			},
		});
		this.enqueueFlush(database);
	}

	private enqueueFlush(database: Database): void {
		if (!(database instanceof JsonDatabase)) return;

		this._persistenceQueue.enqueue({
			kind: 'flush',
			key: 'json-flush',
			trailing: true,
			run: async () => {
				await delay(250);
				await database.flush();
			},
		});
	}

	private removeLocal(entry: ClipboardEntry, emitDelete: boolean): void {
		if (!this._store.remove(entry)) return;
		this.untrack(entry);
		if (emitDelete) entry.emit('delete');
	}

	private removePendingUpdates(entries: readonly ClipboardEntry[]): void {
		const groups = new Set(entries.map((entry) => this.entryGroup(entry)));
		this._persistenceQueue.removePending(
			(task) => task.kind === 'update' && !!task.group && groups.has(task.group),
		);
	}

	private untrack(entry: ClipboardEntry): void {
		const ids = this._signalIds.get(entry);
		if (!ids) return;
		for (const id of ids) entry.disconnect(id);
		this._signalIds.delete(entry);
	}

	private untrackAll(): void {
		for (const entry of this._signalIds.keys()) this.untrack(entry);
	}

	private toStorageEntry(entry: ClipboardEntry): ClipboardEntry {
		const id = this._storageIds.get(entry);
		if (id === undefined) throw new Error(`Clipboard entry ${entry.id} has not been persisted yet`);

		return new ClipboardEntry(
			id,
			entry.type,
			entry.content,
			entry.pinned,
			entry.tag,
			entry.datetime,
			entry.metadata,
			entry.title,
		);
	}

	private entryGroup(entry: ClipboardEntry): string {
		return `entry:${entry.id}`;
	}

	private cleanupEntryAssets(entry: ClipboardEntry): void {
		if (entry.type === ItemType.Image) {
			try {
				const file = Gio.File.new_for_uri(entry.content);
				if (file.query_exists(null)) file.delete(null);
			} catch {
				this.ext.logger.error('Failed to delete image', entry.content);
			}
		} else if (entry.type === ItemType.Link && entry.metadata) {
			const metadata: { image: string | null } = { image: null, ...entry.metadata };
			if (!metadata.image) return;

			try {
				const file = getLinkImagePath(this.ext, metadata.image);
				if (file?.query_exists(null)) file.delete(null);
			} catch {
				this.ext.logger.error('Failed to delete thumbnail image', metadata.image);
			}
		}
	}

	private persistenceFailed(error: unknown, task: PersistenceTask, attempt: number): void {
		this.ext.logger.error(`Failed to persist clipboard history (${task.kind}, attempt ${attempt})`, error);
		if (this._storageWarningShown) return;

		this._storageWarningShown = true;
		this.ext.notificationManager?.warning(
			_('Failed to save clipboard history'),
			_('Copyous will keep the history in memory and retry in the background'),
		);
	}
}
