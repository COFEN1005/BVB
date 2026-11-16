import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../dist/transport.js';
import { defaults, payloadFor, completionMs } from '../dist/core.js';
import { installFakeBLE } from './fake-ble.js';
const s = { ...defaults, os: 'windows', layout: 'us' };
test('old firmware receives zero writes', async () => {
  const mock = installFakeBLE({ old: true }), b = new Bridge(() => {}, () => {});
  await assert.rejects(b.connect(), /更新/);
  assert.equal(mock.frames.length, 0); assert.equal(b.ready, false);
});
test('acceptance and completion are separate; busy rejects double taps and interleaving', async () => {
  const mock = installFakeBLE({ hold: true }), progress = [], b = new Bridge(() => {}, x => progress.push(x));
  await b.connect(); const work = b.execute('open', new Uint8Array(), s);
  await assert.rejects(b.execute('open', new Uint8Array(), s), /処理中/);
  while (!mock.operations.length) await new Promise(r => setTimeout(r, 10));
  assert.equal(b.busy, true); assert.deepEqual(progress, ['ESP32で受付']);
  mock.notify(2, 999); assert.equal(b.busy, true);
  mock.finish(); await work; assert.equal(b.busy, false);
  assert.equal(mock.operations.length, 1); assert.equal(mock.operations[0].bytes.length, 0);
});
test('search packet stream reconstructs exactly the once-encoded URL', async () => {
  const mock = installFakeBLE(), b = new Bridge(() => {}, () => {});
  await b.connect(); const bytes = payloadFor('search', '日本語 😀\n:/?=%', s.os);
  await b.execute('search', bytes, { ...s, os: 'mac', enter: false, layout: 'jis' });
  assert.deepEqual(mock.operations[0].bytes, [...bytes]);
  assert.equal(mock.operations[0].os, 2); assert.equal(mock.operations[0].enter, 0);
  assert.ok(mock.frames.every(p => p.length <= 20));
  await b.execute('open', new Uint8Array(), s);
  assert.equal(mock.operations[1].id, mock.operations[0].id + 1);
});
test('disconnect leaves result uncertain; no automatic retries, controls leave busy', async () => {
  const mock = installFakeBLE({ disconnect: true }), b = new Bridge(() => {}, () => {});
  await b.connect(); await assert.rejects(b.execute('open', new Uint8Array(), s), /結果不明/);
  assert.equal(b.busy, false); assert.equal(b.ready, false); assert.equal(mock.operations.length, 1);
});
test('firmware error disconnects rather than resending the operation', async () => {
  const mock = installFakeBLE({ error: true }), b = new Bridge(() => {}, () => {});
  await b.connect(); await assert.rejects(b.execute('open', new Uint8Array(), s), /中断/);
  assert.equal(mock.operations.length, 1); assert.equal(b.ready, false);
});
test('oversize payload is rejected before any wire write', async () => {
  const mock = installFakeBLE(), b = new Bridge(() => {}, () => {});
  await b.connect(); await assert.rejects(b.execute('search', new Uint8Array(4097), s), /容量/);
  assert.equal(mock.frames.length, 0);
});
test('HID completion waits beyond five seconds and never retries when unknown', async t => {
  const mock = installFakeBLE({ hold: true }), b = new Bridge(() => {}, () => {});
  await b.connect(); t.mock.timers.enable({ apis: ['setTimeout'] });
  const work = b.execute('open', new Uint8Array(), s);
  const rejection = assert.rejects(work, /結果不明/);
  // Advance the two writes while letting their promise continuations run.
  for (let i = 0; i < 5; i++) { await new Promise(setImmediate); t.mock.timers.tick(20); }
  assert.equal(mock.operations.length, 1);
  t.mock.timers.tick(5000); await new Promise(setImmediate); assert.equal(b.busy, true);
  t.mock.timers.tick(12400 + completionMs('open', new Uint8Array(), s));
  await rejection;
  assert.equal(b.ready, false); assert.equal(b.busy, false); assert.equal(mock.operations.length, 1);
});
test('hung GATT write is bounded; its late continuation cannot send remaining packets', async t => {
  const mock = installFakeBLE(), b = new Bridge(() => {}, () => {});
  await b.connect(); t.mock.timers.enable({ apis: ['setTimeout'] });
  let releaseWrite, calls = 0;
  mock.writer.writeValueWithResponse = () => { calls++; return new Promise(resolve => { releaseWrite = resolve; }); };
  const work = b.execute('search', payloadFor('search', 'hello', s.os), s);
  const rejection = assert.rejects(work, /結果不明/);
  await new Promise(setImmediate); t.mock.timers.tick(10001); await rejection;
  releaseWrite(); await new Promise(setImmediate); t.mock.timers.tick(1000); await new Promise(setImmediate);
  assert.equal(calls, 1); assert.equal(b.busy, false); assert.equal(b.ready, false);
});
