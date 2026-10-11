/** Bound card layout and syntax highlighting work while retaining the original clipboard entry. */
export function previewText(text: string, maxCharacters = 4096, maxLines = 64): string {
	let end = Math.min(text.length, maxCharacters);
	const prefix = text.slice(0, end);
	let offset = 0;
	for (let line = 0; line < maxLines; line++) {
		const newline = prefix.indexOf('\n', offset);
		if (newline < 0 || newline >= end) break;
		offset = newline + 1;
		if (line === maxLines - 1) end = newline;
	}
	// Keep UTF-16 surrogate pairs intact at the character boundary.
	if (end < text.length && end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
	return end < text.length ? text.slice(0, end) + '\n...' : text;
}
