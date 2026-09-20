import { performance } from 'node:perf_hooks';

import { FakePersistenceAdapter, MemoryFirstStore, makeEntries } from './memory-first-store.harness.js';

function percentile(values: number[], fraction: number): number {
	const ordered = [...values].sort((a, b) => a - b);
	const index = Math.min(ordered.length - 1, Math.floor(ordered.length * fraction));
	return ordered[index]!;
}

async function main(): Promise<void> {
	const entries = makeEntries(500);
	const adapter = new FakePersistenceAdapter(entries);
	const store = new MemoryFirstStore(adapter);

	const hydrationStart = performance.now();
	await store.hydrate();
	const hydrationMs = performance.now() - hydrationStart;

	const queryTimes: number[] = [];
	let matched = 0;
	for (let index = 0; index < 1000; index++) {
		const queryStart = performance.now();
		const entryIndex = index % 500;
		matched += store.query(
			`generated-entry-${entryIndex % 50}-payload-${String(entryIndex).padStart(4, '0')}`,
		).length;
		queryTimes.push(performance.now() - queryStart);
	}

	const p50Ms = percentile(queryTimes, 0.5);
	const p95Ms = percentile(queryTimes, 0.95);
	const maxMs = Math.max(...queryTimes);
	if (store.snapshot().length !== 500) throw new Error('benchmark hydration count mismatch');
	if (matched !== 1000) throw new Error('benchmark query match count mismatch');
	if (adapter.persistCalls !== 0) throw new Error('benchmark queries unexpectedly persisted');
	if (hydrationMs >= 250) throw new Error(`hydration acceptance threshold exceeded: ${hydrationMs.toFixed(3)} ms`);
	if (p95Ms >= 25) throw new Error(`query p95 acceptance threshold exceeded: ${p95Ms.toFixed(3)} ms`);

	console.log(
		JSON.stringify({
			entries: 500,
			queries: 1000,
			hydrationMs: Number(hydrationMs.toFixed(3)),
			queryP50Ms: Number(p50Ms.toFixed(3)),
			queryP95Ms: Number(p95Ms.toFixed(3)),
			queryMaxMs: Number(maxMs.toFixed(3)),
			matched,
			persistCalls: adapter.persistCalls,
			acceptance: 'pass',
		}),
	);
}

await main();
