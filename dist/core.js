export const SERVICE = '7f510001-6f3b-4f37-9d9a-6c7f5f11b001';
export const WRITE = '7f510002-6f3b-4f37-9d9a-6c7f5f11b001';
export const STATUS = '7f510003-6f3b-4f37-9d9a-6c7f5f11b001';
export const CAPS = '7f510004-6f3b-4f37-9d9a-6c7f5f11b001';
export const MAX_BYTES = 4096;
export const CHUNK = 13;
export const GOOGLE = 'https://www.google.com/search?q=';
export const OP = Object.freeze({ open: 1, search: 2, legacy: 3 });
export const defaults = Object.freeze({ os: '', layout: '', target: 'search', theme: '',
  phraseEnabled: true, phrase: 'クロームを開いて', enter: true,
  shortcutMs: 500, launchMs: 2000, focusMs: 350, keyMs: 12 });
export const timingBounds = Object.freeze({ shortcutMs: [200, 5000], launchMs: [500, 15000],
  focusMs: [100, 5000], keyMs: [8, 100] });

export function settingsFrom(value) {
  const s = { ...defaults };
  if (!value || typeof value !== 'object') return s;
  for (const [key, values] of Object.entries({ os: ['windows', 'mac'], layout: ['us', 'jis'],
    target: ['search', 'legacy'], theme: ['light', 'dark'] })) {
    if (values.includes(value[key])) s[key] = value[key];
  }
  for (const key of ['enter', 'phraseEnabled']) if (typeof value[key] === 'boolean') s[key] = value[key];
  if (typeof value.phrase === 'string' && value.phrase.length <= 100 && normalizePhrase(value.phrase)) s.phrase = value.phrase;
  for (const [key, [min, max]] of Object.entries(timingBounds)) {
    if (Number.isInteger(value[key]) && value[key] >= min && value[key] <= max) s[key] = value[key];
  }
  return s;
}

export function assertUnicode(text) {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('不正なUnicodeです');
    } else if (c >= 0xdc00 && c <= 0xdfff) throw new Error('不正なUnicodeです');
  }
}
export function searchURL(text) {
  assertUnicode(text);
  const query = text.replace(/\r\n|[\r\n\u2028\u2029]/g, ' ');
  return GOOGLE + encodeURIComponent(query).replace(/[!'()*~]/g,
    c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
export function legacyBytes(text, os) {
  assertUnicode(text);
  const bytes = [];
  for (const c of text.replace(/\r\n?/g, '\n')) {
    const code = c.codePointAt(0);
    if (code < 32 && code !== 9 && code !== 10 || code === 127) throw new Error('制御文字は送信できません');
    if (code < 128) bytes.push(code);
    else {
      if (os !== 'windows') throw new Error('従来入力の日本語はWindows専用です');
      bytes.push(0x1e, ...new TextEncoder().encode(code.toString(16).toUpperCase().padStart(4, '0')), 59);
    }
  }
  return Uint8Array.from(bytes);
}
export function payloadFor(kind, text, os) {
  if (kind === 'open') return new Uint8Array();
  if (!text.trim()) return new Uint8Array();
  return kind === 'search' ? new TextEncoder().encode(searchURL(text)) : legacyBytes(text, os);
}
export function normalizePhrase(text) {
  return text.normalize('NFKC').replace(/\s+/gu, '').replace(/[。、，,.!！?？]+$/u, '').toLocaleLowerCase('ja');
}
export function isPhrase(text, settings) {
  return settings.phraseEnabled && !!normalizePhrase(settings.phrase) && normalizePhrase(text) === normalizePhrase(settings.phrase);
}
export function totalWireBytes(length) { return length + 25 + Math.ceil(length / CHUNK) * 7; }
export function parseCaps(value) {
  const b = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (b.length !== 16 || String.fromCharCode(...b.slice(0, 4)) !== 'BVB2' || b[4] !== 7 || value.getUint16(6, true) !== MAX_BYTES)
    throw new Error('対応ファームウェアへ更新してください');
  return { state: b[5], boot: value.getUint32(8, true), lastId: value.getUint32(12, true) };
}
export function makeHeader(id, kind, settings, size) {
  const b = new Uint8Array(20), v = new DataView(b.buffer);
  b[0] = 0xb1; b[1] = 2; v.setUint32(2, id, true); b[6] = OP[kind];
  b[7] = settings.os === 'windows' ? 1 : 2; b[8] = kind !== 'open' && settings.enter ? 1 : 0;
  b[9] = settings.layout === 'jis' ? 1 : 0; v.setUint16(10, size, true);
  ['shortcutMs', 'launchMs', 'focusMs', 'keyMs'].forEach((k, i) => v.setUint16(12 + i * 2, settings[k], true));
  return b;
}
// Conservative HID deadline, independent of BLE upload timeout. Includes per-report
// USB allowance and Alt+X conversion pauses. No retry on expiry.
export function completionMs(kind, bytes, s) {
  let reports = bytes.length + (s.enter ? 1 : 0), conversionMs = 0;
  if (kind === 'legacy') for (const b of bytes) if (b === 0x1e) conversionMs += 700;
  const setup = kind === 'legacy' ? 0 : s.launchMs + 4 * s.shortcutMs + 2 * s.focusMs + 30 * (s.keyMs + 300);
  return 15000 + setup + reports * (s.keyMs + 300) + conversionMs;
}

// One attempt per continuous nonempty input. Losing eligibility consumes an
// already matching phrase; reconnecting/focus changes cannot replay it.
export class PhraseGate {
  constructor() { this.attempted = false; }
  observe(text, phrase, eligible, composing) {
    if (!text.trim()) this.attempted = false;
    if (!composing && phrase && !eligible) this.attempted = true;
  }
  take(text, phrase, eligible, composing) {
    this.observe(text, phrase, eligible, composing);
    if (!phrase || !eligible || composing || this.attempted) return false;
    this.attempted = true; return true;
  }
}
