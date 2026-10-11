import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import Gda from 'gi://Gda?version=6.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

const UUID = 'copyous@boerdereinar.dev';
const ROOT = GLib.getenv('COPYOUS_SHELL_TEST_ROOT');
const report = { passed: false, scenarios: [], openMs: [], screenshots: [], contentPixels: {} };

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

async function waitFor(check, message) {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (check()) return;
		await Scripting.sleep(50);
	}
	throw new Error(message);
}

async function snapshot(name) {
	const path = `${ROOT}/${name}.png`;
	const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.NONE, null);
	const shot = new Shell.Screenshot();
	await new Promise((resolve, reject) => {
		shot.screenshot(false, stream, (object, result) => {
			try {
				object.screenshot_finish(result);
				resolve();
			} catch (error) {
				reject(error);
			}
		});
	});
	stream.close(null);
	report.screenshots.push(path);
	return path;
}

function assertRenderedContent(item, path) {
	const pixbuf = GdkPixbuf.Pixbuf.new_from_file(path);
	const pixels = pixbuf.get_pixels();
	const channels = pixbuf.get_n_channels();
	const stride = pixbuf.get_rowstride();
	const [x, y] = item._content.get_transformed_position();
	const [width, height] = item._content.get_transformed_size();
	let visible = 0;
	for (let row = Math.max(0, Math.ceil(y)); row < Math.min(pixbuf.height, y + height); row++) {
		for (let column = Math.max(0, Math.ceil(x)); column < Math.min(pixbuf.width, x + width); column++) {
			const offset = row * stride + column * channels;
			if (pixels[offset] > 190 && pixels[offset + 1] > 190 && pixels[offset + 2] > 190) visible++;
		}
	}
	report.contentPixels[item.entry.type] = visible;
	assert(visible > 20, `card content did not produce visible text pixels: ${item.entry.type}`);
}

export async function run() {
	try {
		await Scripting.disableHelperAutoExit();
		Main.overview.hide();
		const moduleRoot = Gio.File.new_for_path(`${ROOT}/data/gnome-shell/extensions/${UUID}`).get_uri();
		const { ItemType } = await import(`${moduleRoot}/lib/common/constants.js`);
		const { GdaDatabase } = await import(`${moduleRoot}/lib/database/gda.js`);
		const fixtureLog = {
			log() {},
			info() {},
			warn() {},
			error(message, error) {
				throw new Error(`${message}: ${error}`);
			},
		};
		const seed = new GdaDatabase(
			{ logger: fixtureLog },
			Gda,
			Gio.File.new_for_path(`${ROOT}/data/${UUID}/clipboard.db`),
		);
		await seed.init();
		for (let index = 0; index < 520; index++) {
			await seed.insert(ItemType.Text, index === 0 ? 'ARCHIVE NEEDLE FIXTURE' : `PAGING FIXTURE ${index}`, null);
		}
		await seed.close();
		const source = Gio.SettingsSchemaSource.new_from_directory(
			`${ROOT}/data/gnome-shell/extensions/${UUID}/schemas`,
			Gio.SettingsSchemaSource.get_default(),
			false,
		);
		const fixtureSettings = new Gio.Settings({
			settings_schema: source.lookup('org.gnome.shell.extensions.copyous', false),
		});
		fixtureSettings.set_int('history-length', 1000);
		fixtureSettings.set_enum('clipboard-history', 2);
		const maskFailure = GLib.getenv('COPYOUS_TEST_MASK_FAILURE') === '1';
		if (maskFailure) {
			const { createHoleEffect } = await import(`${moduleRoot}/lib/ui/components/holeEffect.js`);
			const original = Cogl.Snippet.new;
			const actor = new Clutter.Actor();
			try {
				Cogl.Snippet.new = () => {
					throw new Error('fixture snippet construction failure');
				};
				assert(createHoleEffect(actor) === null, 'mask initialization failure was not caught');
			} finally {
				Cogl.Snippet.new = original;
			}
			assert(createHoleEffect(actor) === null, 'failed mask initialization was retried');
			actor.destroy();
			report.scenarios.push('snippet initialization failure falls back to visible content');
		}
		global.settings.set_strv('enabled-extensions', [UUID]);
		global.settings.set_boolean('disable-user-extensions', false);
		await waitFor(() => Main.extensionManager.lookup(UUID)?.stateObj?.entryTracker, 'extension did not enable');
		const extension = Main.extensionManager.lookup(UUID).stateObj;
		await extension.entryTracker._ready;
		assert(!Main.extensionManager.lookup(UUID).error, 'extension reported an error');
		assert(extension.entryTracker.entries().length === 500, 'history hydration was not bounded to 500 entries');
		report.scenarios.push('520-entry SQLite archive with bounded 500-entry hydration');
		const { SearchChange, SearchQuery } = await import(`${moduleRoot}/lib/ui/searchEntry.js`);
		const { createHoleEffect } = await import(`${moduleRoot}/lib/ui/components/holeEffect.js`);
		const { openPopupMenu, closePopupMenu } = await import(`${moduleRoot}/lib/misc/popupMenu.js`);
		const dialog = extension.clipboardDialog;
		const target = new Clutter.Actor();
		const effect = createHoleEffect(target);
		if (!maskFailure) {
			assert(effect instanceof Clutter.ShaderEffect, 'GNOME 51 shader effect did not initialize');
			assert(effect.vfunc_get_static_snippet() !== null, 'native shader callback returned no snippet');
		} else {
			assert(effect === null, 'mask fallback did not persist');
		}
		target.destroy();
		report.scenarios.push(
			maskFailure
				? 'mask fallback remains disabled after initialization failure'
				: 'native effect registration and non-null Cogl snippet',
		);

		extension.settings.set_int('history-length', 1000);
		const textPath = `${ROOT}/fixture.txt`;
		GLib.file_set_contents(textPath, 'VISIBLE FILE PREVIEW\nsecond line');
		const imagePath = `${ROOT}/fixture.png`;
		const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, true, 8, 128, 128);
		pixbuf.fill(0xe66100ff);
		pixbuf.savev(imagePath, 'png', [], []);
		const fixtures = [
			[ItemType.Text, 'VISIBLE TEXT CARD\nSecond line with Unicode: café 日本語', null],
			[
				ItemType.Code,
				'const visible = 51;\nconsole.log(visible);',
				{ language: { id: 'javascript', name: 'JavaScript' } },
			],
			[
				ItemType.Link,
				'https://example.invalid/copyous-native-test',
				{ title: 'VISIBLE LINK CARD', description: 'Offline fixture', image: null },
			],
			[ItemType.Image, Gio.File.new_for_path(imagePath).get_uri(), null],
			[ItemType.File, Gio.File.new_for_path(textPath).get_uri(), null],
			[
				ItemType.Files,
				`${Gio.File.new_for_path(textPath).get_uri()}\n${Gio.File.new_for_path(imagePath).get_uri()}`,
				null,
			],
			[ItemType.Character, 'λ', null],
			[ItemType.Color, '#e66100', null],
		];
		for (const [type, content, metadata] of fixtures) {
			const entry = await extension.entryTracker.insert(type, content, metadata);
			assert(entry !== null, `fixture insertion failed: ${type}`);
			dialog.addEntry(entry);
		}
		await Scripting.sleep(300);
		const query = (text = '', type = null) =>
			new SearchQuery(SearchChange.Different, text, false, false, null, false, type);
		dialog.search(query());
		for (const orientation of [Clutter.Orientation.HORIZONTAL, Clutter.Orientation.VERTICAL]) {
			extension.settings.set_enum('clipboard-orientation', orientation);
			for (const header of [true, false]) {
				extension.settings.set_boolean('show-header', header);
				await Scripting.sleep(100);
				const started = GLib.get_monotonic_time();
				dialog.open();
				await waitFor(() => dialog.opened && dialog._dialog.opacity === 255, 'clipboard did not map');
				report.openMs.push((GLib.get_monotonic_time() - started) / 1000);
				await Scripting.sleep(250);
				await snapshot(`orientation-${orientation}-header-${header}`);
				assert(dialog._scrollView.getItems().length > 0, 'mapped clipboard contains no cards');
				dialog.close();
				await Scripting.sleep(120);
			}
		}
		extension.settings.set_enum('clipboard-orientation', Clutter.Orientation.HORIZONTAL);
		extension.settings.set_boolean('show-header', true);
		for (const [type] of fixtures) {
			dialog.search(query('', type));
			dialog.open();
			await Scripting.sleep(200);
			const items = dialog._scrollView.getItems();
			assert(
				items.some((item) => item.entry.type === type),
				`card missing: ${type}`,
			);
			const image = await snapshot(`card-${type}`);
			if (type === ItemType.Text || type === ItemType.Code) assertRenderedContent(items[0], image);
			dialog.close();
			await Scripting.sleep(100);
		}
		dialog.search(query('ARCHIVE NEEDLE FIXTURE'));
		dialog.open();
		await waitFor(
			() => dialog._scrollView.getItems().some((item) => item.entry.content === 'ARCHIVE NEEDLE FIXTURE'),
			'archive search did not find the oldest entry',
		);
		await Scripting.sleep(100);
		await snapshot('archive-search');
		dialog.close();
		await Scripting.sleep(100);
		report.scenarios.push('indexed archive search beyond the hot history');
		await extension.entryTracker._persistenceQueue.drain();
		const backend = extension.entryTracker._database;
		const insert = backend.insert.bind(backend);
		const notification = extension.notificationManager.warning;
		const logError = extension.logger.error;
		let failures = 1;
		let warnings = 0;
		backend.insert = async (...args) => {
			if (failures-- > 0) throw new Error('fixture persistence failure');
			return insert(...args);
		};
		extension.notificationManager.warning = () => {
			warnings++;
		};
		extension.logger.error = (message, ...args) => {
			if (!String(message).startsWith('Failed to persist clipboard history'))
				logError.call(extension.logger, message, ...args);
		};
		await extension.entryTracker.insert(ItemType.Text, 'RECOVERED PERSISTENCE FIXTURE');
		await waitFor(
			() => extension.entryTracker._persistenceQueue.pending === 0,
			'persistence queue did not recover',
		);
		assert(warnings === 1, 'persistence failure did not report exactly one warning');
		backend.insert = insert;
		extension.notificationManager.warning = notification;
		extension.logger.error = logError;
		report.scenarios.push('real tracker persistence failure, warning, retry, recovery');
		dialog.search(query('VISIBLE TEXT CARD'));
		dialog.open();
		await Scripting.sleep(150);
		const item = dialog._scrollView.getItems()[0];
		assert(item._text.text.includes('VISIBLE TEXT CARD'), 'text card has an empty label');
		item.entry.content = 'VISIBLE TEXT CARD UPDATED';
		await Scripting.sleep(100);
		assert(item._text.text.includes('VISIBLE TEXT CARD UPDATED'), 'text card failed to update');
		dialog.search(query(''));
		dialog._clipboardItemMenu.entry = extension.entryTracker.entries()[0];
		openPopupMenu(dialog._clipboardItemMenu, -1);
		await Scripting.sleep(100);
		closePopupMenu(dialog._clipboardItemMenu, 2);
		dialog.close();
		await Scripting.sleep(100);
		report.scenarios.push('all eight card types, both orientations, hidden header, content updates, popup menu');
		const { EditDialog } = await import(`${moduleRoot}/lib/ui/components/editDialog.js`);
		const codeEntry = extension.entryTracker.entries().find((entry) => entry.type === ItemType.Code);
		const editor = new EditDialog(extension, codeEntry);
		let languageMenuDestroyed = false;
		editor._languageButton._popupMenu.actor.connect('destroy', () => {
			languageMenuDestroyed = true;
		});
		editor.open();
		await Scripting.sleep(150);
		editor._languageButton.vfunc_clicked(Clutter.BUTTON_PRIMARY);
		await Scripting.sleep(100);
		closePopupMenu(editor._languageButton._popupMenu, 2);
		editor.close();
		await Scripting.sleep(250);
		assert(languageMenuDestroyed, 'closing the editor leaked its language menu');
		report.scenarios.push('code editor and language popup lifecycle');

		for (let cycle = 0; cycle < 20; cycle++) {
			const started = GLib.get_monotonic_time();
			dialog.open();
			await waitFor(() => dialog._dialog.opacity === 255, 'warm clipboard did not map');
			report.openMs.push((GLib.get_monotonic_time() - started) / 1000);
			dialog.renderMore();
			await Scripting.sleep(50);
			dialog.close();
			await Scripting.sleep(80);
		}
		report.scenarios.push('20 repeated open, page, close cycles');
		await Main.extensionManager._callExtensionDisableWithRebase(UUID);
		await Scripting.sleep(200);
		await Main.extensionManager._callExtensionEnable(UUID);
		await waitFor(
			() => Main.extensionManager.lookup(UUID)?.stateObj?.clipboardDialog,
			'extension did not re-enable',
		);
		const reloaded = Main.extensionManager.lookup(UUID).stateObj;
		await reloaded.entryTracker._ready;
		reloaded.clipboardDialog.open();
		await Scripting.sleep(200);
		const modalCount = Main.modalCount;
		let itemMenuDestroyed = false;
		let searchMenuDestroyed = false;
		reloaded.clipboardDialog._clipboardItemMenu.actor.connect('destroy', () => {
			itemMenuDestroyed = true;
		});
		reloaded.clipboardDialog._header.searchEntry._menu.actor.connect('destroy', () => {
			searchMenuDestroyed = true;
		});
		await Main.extensionManager._callExtensionDisableWithRebase(UUID);
		await Scripting.sleep(100);
		assert(Main.modalCount === modalCount - 1, 'extension disable left a modal grab');
		assert(itemMenuDestroyed && searchMenuDestroyed, 'extension disable leaked a popup menu');
		report.scenarios.push('extension disable, enable, paint, disable lifecycle');
		report.passed = true;
	} finally {
		GLib.file_set_contents(`${ROOT}/result.json`, JSON.stringify(report, null, 2));
	}
}
