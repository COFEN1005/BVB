import { writeFileSync, mkdirSync } from 'node:fs';
import { makeHeader, payloadFor, defaults, GOOGLE } from '../dist/core.js';
mkdirSync('.build', { recursive: true });
for (const [name, kind, text, os] of [
  ['search-win', 'search', '日本語 abc :/?=% 😀\n次', 'windows'],
  ['search-mac', 'search', '日本語 abc :/?=% 😀\n次', 'mac'],
  ['max', 'search', 'a'.repeat(4096 - GOOGLE.length), 'windows'],
  ['legacy', 'legacy', 'a漢😀\n', 'windows'], ['open', 'open', 'ignored', 'mac']
]) {
  const bytes = payloadFor(kind, text, os);
  const frames = [makeHeader(1, kind, { ...defaults, os, layout: 'jis' }, bytes.length)];
  for (let i = 0; i < bytes.length; i += 13) {
    const p = new Uint8Array(7 + Math.min(13, bytes.length - i)); p[0] = 0xb2;
    const v = new DataView(p.buffer); v.setUint32(1, 1, true); v.setUint16(5, i, true); p.set(bytes.slice(i, i + 13), 7); frames.push(p);
  }
  frames.push(Uint8Array.from([0xb3, 1, 0, 0, 0]));
  writeFileSync(`.build/${name}.bin`, Buffer.concat(frames.map(f => Buffer.from([f.length, ...f]))));
}
