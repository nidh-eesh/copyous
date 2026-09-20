import GLib from 'gi://GLib';

/**
 * Opt-in, low-noise timing diagnostics for startup and UI investigations.
 *
 * The environment is read once so the normal extension path only pays for a
 * boolean check when instrumentation is disabled. Timing output deliberately
 * contains labels and small scalar fields only; callers should never pass
 * clipboard content or paths.
 */
export type TimingField = string | number | boolean | null | undefined;

export type TimingFields = Record<string, TimingField>;

export type TimingSink = ((message: string) => void) | undefined;

export interface TimingSpan {
	finish(fields?: TimingFields): void;
	cancel(fields?: TimingFields): void;
}

let _enabled: boolean | undefined;

export function timingsEnabled(): boolean {
	_enabled ??= GLib.environ_getenv(GLib.get_environ(), 'DEBUG_COPYOUS_TIMINGS') === '1';
	return _enabled;
}

function emit(sink: TimingSink, message: string): void {
	if (!sink) return;

	try {
		sink(message);
	} catch {
		// Diagnostics must never affect the extension lifecycle.
	}
}

function formatFields(fields: TimingFields | undefined): string {
	if (!fields) return '';

	const values = Object.entries(fields)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => `${key}=${String(value).replace(/\s+/g, '_')}`);
	return values.length > 0 ? ` ${values.join(' ')}` : '';
}

export function timingEvent(sink: TimingSink, label: string, fields?: TimingFields): void {
	if (!timingsEnabled()) return;
	emit(sink, `[copyous-timing] ${label}${formatFields(fields)}`);
}

export function beginTiming(sink: TimingSink, label: string, fields?: TimingFields): TimingSpan {
	if (!timingsEnabled()) {
		return {
			finish: () => {},
			cancel: () => {},
		};
	}

	const started = GLib.get_monotonic_time();
	let completed = false;

	const end = (status: 'ok' | 'cancelled', endFields?: TimingFields): void => {
		if (completed) return;
		completed = true;

		const elapsed = (GLib.get_monotonic_time() - started) / 1000;
		emit(
			sink,
			`[copyous-timing] ${label}${formatFields(fields)} duration_ms=${elapsed.toFixed(1)} status=${status}${formatFields(endFields)}`,
		);
	};

	return {
		finish: (endFields) => end('ok', endFields),
		cancel: (endFields) => end('cancelled', endFields),
	};
}
