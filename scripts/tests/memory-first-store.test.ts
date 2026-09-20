import assert from 'node:assert/strict';

import { FakePersistenceAdapter, MemoryFirstStore, makeEntries } from './memory-first-store.harness.js';

async function testHydrationAndMemoryQueries(): Promise<void> {
	const adapter = new FakePersistenceAdapter(makeEntries(12));
	const store = new MemoryFirstStore(adapter);

	await store.hydrate();

	assert.equal(store.state, 'ready');
	assert.equal(adapter.loadCalls, 1);
	assert.equal(adapter.persistCalls, 0);
	assert.equal(store.snapshot().length, 12);
	assert.equal(store.query('generated-entry-4').length, 1);
	assert.equal(adapter.persistCalls, 0, 'memory-only queries must not touch persistence');
}

async function testDuplicateTouch(): Promise<void> {
	const adapter = new FakePersistenceAdapter(makeEntries(1));
	const store = new MemoryFirstStore(adapter);
	await store.hydrate();

	const result = store.insert('Text', 'generated-entry-0-payload-0000', 999);

	assert.equal(result.duplicate, true);
	assert.equal(result.entry.id, 1);
	assert.equal(store.snapshot().length, 1);
	assert.equal(store.snapshot()[0]!.datetime, 999);
	assert.equal(store.queue.size, 1);
}

async function testCoalescingAndDeleteBarriers(): Promise<void> {
	const adapter = new FakePersistenceAdapter(makeEntries(2));
	const store = new MemoryFirstStore(adapter);
	await store.hydrate();

	store.update(1, { title: 'first update' });
	store.update(1, { title: 'coalesced update' });
	store.delete(1);
	store.update(2, { pinned: true });

	const pending = store.queue.pendingOperations();
	assert.deepEqual(
		pending.map((operation) => operation.revision),
		[2, 3, 4],
		'ordinary updates coalesce, but a delete remains an ordering barrier',
	);
	assert.deepEqual(
		pending.map((operation) => operation.barrier),
		[false, true, false],
	);

	await store.queue.drain();
	assert.deepEqual(adapter.persistedRevisions, [2, 3, 4]);
	assert.deepEqual(
		adapter.snapshot.map((entry) => entry.id),
		[2],
	);
	assert.equal(adapter.snapshot[0]!.pinned, true);
}

async function testRetryAndFailureRecovery(): Promise<void> {
	const adapter = new FakePersistenceAdapter();
	const store = new MemoryFirstStore(adapter);
	await store.hydrate();

	adapter.setFailures(2);
	store.insert('Text', 'generated-new-entry', 1);
	await store.queue.drain();
	assert.deepEqual(adapter.attemptedRevisions, [1, 1, 1]);
	assert.deepEqual(adapter.persistedRevisions, [1]);
	assert.equal(store.queue.size, 0);

	adapter.setFailures(99);
	store.insert('Text', 'generated-failed-entry', 2);
	await assert.rejects(store.queue.drain());
	assert.equal(store.queue.state, 'failed');
	assert.equal(store.queue.size, 1);

	adapter.setFailures(0);
	await store.queue.retry();
	assert.equal(store.queue.state, 'open');
	assert.equal(store.queue.size, 0);
	assert.equal(adapter.snapshot.length, 2);
}

async function testClearIsADeleteBarrier(): Promise<void> {
	const adapter = new FakePersistenceAdapter(makeEntries(3));
	const store = new MemoryFirstStore(adapter);
	await store.hydrate();

	store.update(1, { title: 'before clear' });
	assert.equal(store.clear(), 3);
	store.insert('Text', 'generated-after-clear', 1000);

	const pending = store.queue.pendingOperations();
	assert.deepEqual(
		pending.map((operation) => operation.barrier),
		[false, true, false],
	);
	await store.queue.drain();

	assert.deepEqual(
		adapter.snapshot.map((entry) => entry.content),
		['generated-after-clear'],
	);
}

async function testCloseDrainsAndStopsWrites(): Promise<void> {
	const adapter = new FakePersistenceAdapter();
	const store = new MemoryFirstStore(adapter);
	await store.hydrate();
	store.insert('Text', 'generated-close-entry', 1);

	await store.close();

	assert.equal(store.state, 'closed');
	assert.equal(store.queue.state, 'closed');
	assert.equal(store.queue.size, 0);
	assert.equal(adapter.snapshot.length, 1);
	assert.throws(() => store.insert('Text', 'after-close', 2));
}

async function main(): Promise<void> {
	const tests: Array<[string, () => Promise<void>]> = [
		['hydration and memory-only queries', testHydrationAndMemoryQueries],
		['duplicate touch', testDuplicateTouch],
		['coalescing and delete barriers', testCoalescingAndDeleteBarriers],
		['retry and failure recovery', testRetryAndFailureRecovery],
		['clear is a delete barrier', testClearIsADeleteBarrier],
		['close drains and stops writes', testCloseDrainsAndStopsWrites],
	];

	for (const [name, test] of tests) {
		await test();
		console.log(`PASS ${name}`);
	}

	console.log(`PASS ${tests.length} memory-first persistence tests`);
}

await main();
