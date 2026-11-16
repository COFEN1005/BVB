import { SERVICE, WRITE, STATUS, CAPS, CHUNK, MAX_BYTES, parseCaps, makeHeader, completionMs } from './core.js';

const errors = { 1: '処理中です', 2: '同じ操作IDは実行しません', 3: 'データ形式エラー',
  4: '容量を超えています', 5: 'データ順序エラー', 6: '入力形式エラー', 7: '受信が中断しました', 8: 'HID送出を中断しました' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, ms = 10000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('通信が応答しません。結果不明です')), ms); })]); }
  finally { clearTimeout(timer); }
}
export class Bridge {
  constructor(onState, onProgress) {
    this.onState = onState; this.onProgress = onProgress; this.busy = false; this.ready = false; this.connecting = false;
  }
  async connect() {
    if (this.busy || this.connecting) return;
    if (!navigator.bluetooth) throw new Error('iPhoneではBluefyを使用してください');
    this.connecting = true; this.onState();
    try {
      this.device = await navigator.bluetooth.requestDevice({ filters: [{ name: 'ESP-BVB Bridge', services: [SERVICE] }] });
      this.disconnectListener = () => this.disconnected();
      this.device.addEventListener('gattserverdisconnected', this.disconnectListener);
      const server = await bounded(this.device.gatt.connect());
      const service = await bounded(server.getPrimaryService(SERVICE));
      // A separate read-only capability characteristic is mandatory. Never probe
      // old firmware by writing bytes into its text characteristic.
      this.capability = await bounded(service.getCharacteristic(CAPS));
      const caps = parseCaps(await bounded(this.capability.readValue()));
      if (caps.state) throw new Error('ESP32が処理中です。後で再接続してください');
      this.boot = caps.boot; this.lastId = caps.lastId;
      this.status = await bounded(service.getCharacteristic(STATUS));
      this.listener = event => this.receive(event.target.value);
      this.status.addEventListener('characteristicvaluechanged', this.listener);
      await bounded(this.status.startNotifications());
      this.writer = await bounded(service.getCharacteristic(WRITE));
      this.ready = true;
    } catch (error) {
      this.disconnect();
      if (error.name === 'NotFoundError' && this.device) throw new Error('対応ファームウェアへ更新してください');
      throw error;
    } finally { this.connecting = false; this.onState(); }
  }
  disconnected() {
    if (this.ready && !this.pending) this.onProgress('切断されました');
    this.ready = false;
    this.pending?.reject(new Error('切断されました。結果不明です'));
    if (this.status && this.listener) this.status.removeEventListener('characteristicvaluechanged', this.listener);
    if (this.device && this.disconnectListener) this.device.removeEventListener('gattserverdisconnected', this.disconnectListener);
    this.writer = null; this.status = null;
    this.onState();
  }
  disconnect() { this.device?.gatt.disconnect(); this.disconnected(); }
  receive(v) {
    const p = this.pending;
    if (!p || v.byteLength !== 7 || v.getUint8(0) !== 0xc2 || v.getUint32(2, true) !== p.id) return;
    const type = v.getUint8(1);
    if (type === 1) { p.accepted = true; this.onProgress('ESP32で受付'); }
    else if (type === 2 && p.accepted) p.resolve();
    else if (type === 3) p.reject(new Error(errors[v.getUint8(6)] || 'ESP32エラー'));
  }
  async execute(kind, bytes, settings) {
    if (!this.ready || this.busy) throw new Error('未接続または処理中です');
    if (!['windows', 'mac'].includes(settings.os) || !['us', 'jis'].includes(settings.layout)) throw new Error('設定でPCを選択してください');
    if (bytes.length > MAX_BYTES || (kind === 'open' ? bytes.length !== 0 : bytes.length === 0)) throw new Error('送信容量を確認してください');
    this.busy = true; this.onState();
    let timer;
    try {
      const caps = parseCaps(await bounded(this.capability.readValue()));
      if (caps.state || caps.boot !== this.boot) throw new Error('ESP32の状態が変わりました。再接続してください');
      const id = Math.max(caps.lastId, this.lastId) + 1;
      if (id > 0xffffffff) throw new Error('ESP32を再起動してください');
      this.lastId = id;
      let resolve, reject;
      const completion = new Promise((res, rej) => { resolve = res; reject = rej; });
      // Observe early disconnects/errors even while awaiting a BLE write.
      completion.catch(() => {});
      this.pending = { id, resolve, reject, accepted: false };
      const packets = Math.ceil(bytes.length / CHUNK) + 2;
      const uploadBudget = 10000 + packets * 1200;
      const hidBudget = completionMs(kind, bytes, settings);
      timer = setTimeout(() => reject(new Error('応答待ちが終了しました。結果不明です')), uploadBudget + hidBudget);
      const write = async bytes => {
        if (!this.ready || this.pending?.id !== id) throw new Error('切断されました。結果不明です');
        await bounded(this.writer.writeValueWithResponse(bytes));
        await sleep(18);
      };
      const upload = async () => {
        await write(makeHeader(id, kind, settings, bytes.length));
        for (let offset = 0; offset < bytes.length; offset += CHUNK) {
          const chunk = bytes.slice(offset, offset + CHUNK), packet = new Uint8Array(7 + chunk.length);
          packet[0] = 0xb2; const v = new DataView(packet.buffer);
          v.setUint32(1, id, true); v.setUint16(5, offset, true); packet.set(chunk, 7);
          await write(packet);
        }
        const end = new Uint8Array(5); end[0] = 0xb3; new DataView(end.buffer).setUint32(1, id, true);
        await write(end);
      };
      // Race the whole upload as well: a hung write must not freeze the UI.
      await Promise.race([upload().then(() => completion), completion]);
    } catch (error) {
      this.disconnect(); // Uncertain execution requires deliberate reconnect, never retry.
      throw error;
    } finally { clearTimeout(timer); this.pending = null; this.busy = false; this.onState(); }
  }
}
