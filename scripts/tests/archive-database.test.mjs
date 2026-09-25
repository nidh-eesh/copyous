import GLib from 'gi://GLib';
import Gda from 'gi://Gda?version=6.0';
import Gio from 'gi://Gio';

import { ItemType } from '../../dist/lib/common/constants.js';
import { GdaDatabase } from '../../dist/lib/database/gda.js';

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

const logger = {
	info() {},
	log() {},
	warn(message, error) {
		printerr(`${message}: ${String(error)}`);
	},
	error(message, error) {
		printerr(`${String(message)}: ${String(error)}`);
	},
};

const directory = GLib.dir_make_tmp('copyous-archive-test-XXXXXX');
const file = Gio.File.new_for_path(GLib.build_filenamev([directory, 'clipboard.db']));
const sourcePath = GLib.getenv('COPYOUS_TEST_SOURCE_DB');
if (sourcePath) {
	Gio.File.new_for_path(sourcePath).copy(file, Gio.FileCopyFlags.NONE, null, null);
}
const database = new GdaDatabase({ logger }, Gda, file);

try {
	await database.init();
	for (let index = 0; index < 24; index++) {
		const content = index === 3 ? 'archive-only-deep-needle' : `generated-entry-${index}`;
		const entry = await database.insert(ItemType.Text, content, null);
		assert(entry !== null, `failed to insert fixture ${index}`);
	}

	const newest = await database.entries(5);
	assert(newest.length === 5, `expected a five-entry hot snapshot, got ${newest.length}`);

	const search = {
		query: 'deep-needle',
		pinned: false,
		excludePinned: false,
		tag: null,
		excludeTagged: false,
		type: null,
	};
	const matches = await database.search(search, 20);
	assert(matches.length === 1, `expected one archive match, got ${matches.length}`);
	assert(matches[0].content === 'archive-only-deep-needle', 'archive search returned the wrong entry');

	const literal = await database.insert(ItemType.Text, 'literal-%_-needle', null);
	assert(literal !== null, 'failed to insert wildcard fixture');
	const literalMatches = await database.search({ ...search, query: '%_-' }, 20);
	assert(literalMatches.length === 1, 'LIKE wildcard characters were not treated literally');

	const short = await database.insert(ItemType.Text, 'short-xy-archive-needle', null);
	assert(short !== null, 'failed to insert short-query fixture');
	short.pinned = true;
	await database.updateProperty(short, 'pinned');
	const shortMatches = await database.search({ ...search, query: 'xy', pinned: true }, 20);
	assert(
		shortMatches.some((entry) => entry.id === short.id),
		'short archive query did not use the scan fallback',
	);

	const conflictSource = await database.insert(ItemType.Text, 'conflict-source', null);
	const conflictTarget = await database.insert(ItemType.Text, 'conflict-target', null);
	assert(conflictSource !== null && conflictTarget !== null, 'failed to insert conflict fixtures');
	conflictSource.content = conflictTarget.content;
	const conflictId = await database.updateProperty(conflictSource, 'content');
	assert(conflictId === conflictTarget.id, 'content conflict did not return the existing entry id');

	const updated = await database.insert(ItemType.Text, 'index-update-fixture', null);
	assert(updated !== null, 'failed to insert update fixture');
	updated.title = 'title-only-archive-needle';
	await database.updateProperty(updated, 'title');
	const titleMatches = await database.search({ ...search, query: 'title-only-archive-needle' }, 20);
	assert(
		titleMatches.some((entry) => entry.id === updated.id),
		'title update was not reflected in the FTS index',
	);

	updated.pinned = true;
	await database.updateProperty(updated, 'pinned');
	const pinnedMatches = await database.search({ ...search, query: 'index-update', pinned: true }, 20);
	assert(pinnedMatches.length === 1, 'archive property filters returned an unexpected result');

	await database.delete(updated);
	const deletedMatches = await database.search({ ...search, query: 'title-only-archive-needle' }, 20);
	assert(deletedMatches.length === 0, 'deleted entry remained in the FTS index');

	print('PASS bounded SQLite hydration and indexed archive search');
} finally {
	await database.close();
	if (file.query_exists(null)) file.delete(null);
	const directoryFile = Gio.File.new_for_path(directory);
	if (directoryFile.query_exists(null)) directoryFile.delete(null);
}
