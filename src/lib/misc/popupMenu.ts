import { VERSION } from './compatibility.js';

type PopupMethod = (parameters?: number | { animate: boolean; fadeOnly?: boolean }) => void;

function isGnome51OrLater(): boolean {
	return VERSION >= 51;
}

function animate(menu: unknown, method: 'open' | 'close', animation: number): void {
	const popup = menu as Record<'open' | 'close', PopupMethod>;
	if (isGnome51OrLater()) {
		popup[method]({ animate: animation !== 0, fadeOnly: animation === 2 });
	} else {
		popup[method](animation);
	}
}

export function openPopupMenu(menu: unknown, animation: number): void {
	animate(menu, 'open', animation);
}

export function closePopupMenu(menu: unknown, animation: number): void {
	animate(menu, 'close', animation);
}
