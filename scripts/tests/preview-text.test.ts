import assert from 'node:assert/strict';

import { previewText } from '../../src/lib/common/previewText.js';

assert.equal(previewText('short text'), 'short text');
assert.equal(previewText(''), '');
assert.equal(previewText('line\n'.repeat(100)).split('\n').length, 65);
const large = 'text'.repeat(200000);
assert.equal(previewText(large).length, 4100);
assert.equal(large.length, 800000);
assert.equal(previewText('abc😀def', 4), 'abc\n...');
assert.equal(previewText('abc😀def', 5), 'abc😀\n...');
assert.equal(previewText('abcdef', 6), 'abcdef');
console.log('PASS bounded clipboard previews, line limits, original data, Unicode boundaries');
