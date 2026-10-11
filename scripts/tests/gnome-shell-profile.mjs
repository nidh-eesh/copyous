import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

const now = () => GLib.get_monotonic_time() / 1000;

// Diagnostic switches only affect the disposable Shell, never the desktop.
export async function profileOpen(extension) {
	const mode = GLib.getenv('COPYOUS_SHELL_PROFILE');
	const dialog = extension.clipboardDialog;
	const scroll = dialog._scrollView;
	extension.settings.set_enum('clipboard-orientation', Clutter.Orientation.HORIZONTAL);
	extension.settings.set_int('item-width', 250);
	extension.settings.set_int('item-height', 170);
	extension.settings.set_boolean('show-header', !mode.includes('hidden'));
	extension.settings.set_enum('clipboard-position-horizontal', 3);
	await Scripting.sleep(150);
	if (mode.includes('directfocus')) {
		scroll.navigate_focus = () => {
			const item = scroll.getItems().find((actor) => actor.visible);
			if (!item) return false;
			scroll._scrollContainer._lastFocus = item;
			item.grab_key_focus();
			return true;
		};
	}
	if (mode.includes('nopaging')) scroll.setLoadMoreCallback(null);
	if (mode.includes('nopreview')) dialog.queuePreviews = () => {};
	if (mode.includes('noeffect')) {
		const disable = (item) => {
			for (const effect of item?._content.get_effects() ?? []) effect.enabled = false;
			return item;
		};
		for (const item of scroll.getItems()) disable(item);
		const create = dialog.createItem.bind(dialog);
		dialog.createItem = (entry) => disable(create(entry));
	}
	if (mode.includes('noscale')) {
		const ease = dialog._dialog.ease.bind(dialog._dialog);
		dialog._dialog.ease = (params) => {
			dialog._dialog.scale_x = 1;
			dialog._dialog.scale_y = 1;
			return ease({ ...params, scaleX: 1, scaleY: 1 });
		};
	}
	const cycles = [];
	for (let index = 0; index < 12; index++) {
		const started = now();
		const cycle = {
			index,
			initialCards: scroll.getItems().length,
			frames: [],
			creates: [],
			previews: [],
			phases: [],
		};
		const restore = [];
		for (const [object, name] of [
			[dialog, 'show'],
			[dialog, 'updateFitConstraint'],
			[scroll, 'navigate_focus'],
			...(scroll.focusInitialItem ? [[scroll, 'focusInitialItem']] : []),
		]) {
			const original = object[name];
			object[name] = function (...args) {
				const time = now();
				const result = original.apply(this, args);
				cycle.phases.push({ name, at: time - started, duration: now() - time });
				return result;
			};
			restore.push(() => {
				object[name] = original;
			});
		}
		let paintStart = 0;
		let lastTick = started;
		cycle.maxHeartbeatGapMs = 0;
		const heartbeat = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5, () => {
			const time = now();
			cycle.maxHeartbeatGapMs = Math.max(cycle.maxHeartbeatGapMs, time - lastTick);
			lastTick = time;
			return GLib.SOURCE_CONTINUE;
		});
		const before = global.stage.connect('before-paint', () => {
			paintStart = now();
		});
		const after = global.stage.connect('after-paint', () => {
			const time = now();
			cycle.frames.push({ at: time - started, cpuMs: time - paintStart, opacity: dialog._dialog.opacity });
			if (time - started < 250) global.stage.queue_redraw();
		});
		const opacity = dialog._dialog.connect('notify::opacity', () => {
			if (dialog._dialog.opacity === 255 && cycle.fullyOpaqueMs === undefined)
				cycle.fullyOpaqueMs = now() - started;
		});
		const create = dialog.createItem.bind(dialog);
		dialog.createItem = (entry) => {
			const time = now();
			const item = create(entry);
			cycle.creates.push({ at: time - started, duration: now() - time, type: entry.type });
			return item;
		};
		const preview = dialog.queuePreviews.bind(dialog);
		dialog.queuePreviews = (items) => {
			for (const item of items) {
				if (item._profileOriginalPreview) continue;
				item._profileOriginalPreview = item.loadPreview;
				item.loadPreview = () => {
					const time = now();
					item._profileOriginalPreview.call(item);
					cycle.previews.push({ at: time - started, duration: now() - time, type: item.entry.type });
				};
			}
			preview(items);
		};
		dialog.open();
		cycle.openCallMs = now() - started;
		await Scripting.sleep(350);
		GLib.source_remove(heartbeat);
		global.stage.disconnect(before);
		global.stage.disconnect(after);
		dialog._dialog.disconnect(opacity);
		dialog.createItem = create;
		dialog.queuePreviews = preview;
		for (const method of restore) method();
		cycle.finalCards = scroll.getItems().length;
		cycle.firstVisiblePaintMs = cycle.frames.find((frame) => frame.opacity > 0)?.at;
		cycle.maxFrameGapMs = Math.max(0, ...cycle.frames.slice(1).map((frame, i) => frame.at - cycle.frames[i].at));
		cycle.maxPaintCpuMs = Math.max(0, ...cycle.frames.map((frame) => frame.cpuMs));
		cycles.push(cycle);
		dialog.close();
		await Scripting.sleep(150);
		for (const item of scroll.getItems()) {
			if (!item._profileOriginalPreview) continue;
			item.loadPreview = item._profileOriginalPreview;
			delete item._profileOriginalPreview;
		}
	}
	const { x, y, width, height } = global.display.get_monitor_geometry(0);
	return { mode, version: extension.metadata['version-name'], monitor: { x, y, width, height }, cycles };
}
