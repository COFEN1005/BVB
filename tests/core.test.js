import test from 'node:test';
import assert from 'node:assert/strict';
import { searchURL, GOOGLE, payloadFor, normalizePhrase, defaults, settingsFrom, isPhrase, PhraseGate,
  completionMs, totalWireBytes, makeHeader, parseCaps } from '../dist/core.js';

test('search preserves Japanese, ASCII, symbols, emoji, spaces and replaces each newline', () => {
  const input = '日本語 abc 123 :/?=% &+# "\' 😀\n次\r\n行\r末\u2028終';
  const url = searchURL(input);
  assert.equal(new URL(url).searchParams.get('q'), input.replace(/\r\n|[\r\n\u2028\u2029]/g, ' '));
  assert.match(url, /^[\x20-\x7e]+$/);
  assert.ok(url.includes('%3A%2F%3F%3D%25'));
  assert.equal(searchURL('%E6'), GOOGLE + '%25E6'); // literal percent is encoded once
});
test('unpaired surrogates are rejected, valid surrogate pairs survive', () => {
  for (const text of ['\ud800', '\udc00', 'a\ud800z']) {
    assert.throws(() => searchURL(text), /Unicode/);
    assert.throws(() => payloadFor('legacy', text, 'windows'), /Unicode/);
  }
  assert.equal(searchURL('😀'), GOOGLE + '%F0%9F%98%80');
});
test('4096 limit counts entire URL and separates transport metadata', () => {
  assert.equal(payloadFor('search', 'a'.repeat(4096 - GOOGLE.length)).length, 4096);
  assert.equal(payloadFor('search', 'a'.repeat(4097 - GOOGLE.length)).length, 4097);
  assert.equal(payloadFor('search', '漢').length, GOOGLE.length + 9);
  assert.equal(totalWireBytes(4096), 6333);
  assert.equal(totalWireBytes(0), 25);
});
test('open never includes text; legacy remains Windows Alt+X only for Unicode', () => {
  assert.equal(payloadFor('open', 'do not send', 'windows').length, 0);
  assert.deepEqual([...payloadFor('legacy', '漢', 'windows')], [30,54,70,50,50,59]);
  assert.throws(() => payloadFor('legacy', '漢', 'mac'), /Windows/);
  assert.equal(new TextDecoder().decode(payloadFor('legacy', 'abc\r\n', 'mac')), 'abc\n');
  for (const c of ['\x00', '\x1b', '\x1e', '\x7f']) assert.throws(() => payloadFor('legacy', c, 'windows'), /制御文字/);
});
test('phrase normalization only triggers whole input, including width and punctuation', () => {
  assert.equal(normalizePhrase(' ｸﾛｰﾑ を 開いて。！ '), normalizePhrase(defaults.phrase));
  assert.equal(isPhrase('クロームを開いて。', defaults), true);
  assert.equal(isPhrase('明日はクロームを開いて調べる', defaults), false);
  assert.equal(isPhrase(defaults.phrase, { ...defaults, phraseEnabled: false }), false);
});
test('phrase gate does not replay while composing, disconnected, busy, hidden, or after failure', () => {
  const gate = new PhraseGate();
  assert.equal(gate.take('phrase', true, true, true), false);
  assert.equal(gate.take('phrase', true, true, false), true);
  assert.equal(gate.take('phrase。', true, true, false), false);
  gate.observe('', false, true, false);
  assert.equal(gate.take('phrase', true, false, false), false);
  assert.equal(gate.take('phrase', true, true, false), false);
  gate.observe('', false, true, false);
  assert.equal(gate.take('phrase', true, true, false), true);
});
test('settings validate corrupted storage; PC OS has no inferred default', () => {
  assert.equal(settingsFrom(null).os, '');
  assert.deepEqual(settingsFrom({ os: 'iphone', launchMs: -3, keyMs: '8' }), defaults);
  assert.equal(settingsFrom({ os: 'mac', theme: 'dark', launchMs: 5000 }).launchMs, 5000);
});
test('protocol header specifies operation, PC OS, layout, ID and exact byte size', () => {
  const b = makeHeader(0x12345678, 'search', { ...defaults, os: 'windows', layout: 'jis' }, 4096);
  assert.equal(b.length, 20); assert.deepEqual([...b.slice(0, 10)], [177,2,120,86,52,18,2,1,1,1]);
  assert.equal(new DataView(b.buffer).getUint16(10, true), 4096);
  assert.equal(makeHeader(1, 'open', defaults, 0)[8], 0);
});
test('capabilities must match version, features, and payload capacity', () => {
  const b = Uint8Array.from([66,86,66,50,7,0,0,16,1,0,0,0,12,0,0,0]);
  assert.deepEqual(parseCaps(new DataView(b.buffer)), { state: 0, boot: 1, lastId: 12 });
  b[4] = 1; assert.throws(() => parseCaps(new DataView(b.buffer)), /更新/);
});
test('HID wait scales with byte count, delays and Alt+X; it exceeds five seconds', () => {
  const small = completionMs('search', new Uint8Array(32), defaults);
  assert.ok(small > 5000);
  assert.ok(completionMs('search', new Uint8Array(4096), defaults) > small + 4096 * 8);
  assert.ok(completionMs('search', new Uint8Array(32), { ...defaults, launchMs: 15000, keyMs: 100 }) > small);
});
