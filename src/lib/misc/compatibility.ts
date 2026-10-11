import St from 'gi://St';

import * as Config from 'resource:///org/gnome/shell/misc/config.js';

export const VERSION: number = Number(Config.PACKAGE_VERSION.split('.')[0]);

const masks = St.ButtonMask as typeof St.ButtonMask & {
	PRIMARY: St.ButtonMask;
	MIDDLE: St.ButtonMask;
	SECONDARY: St.ButtonMask;
};

export const ButtonMask = {
	Primary: VERSION >= 51 ? masks.PRIMARY : St.ButtonMask.ONE,
	Middle: VERSION >= 51 ? masks.MIDDLE : St.ButtonMask.TWO,
	Secondary: VERSION >= 51 ? masks.SECONDARY : St.ButtonMask.THREE,
};
