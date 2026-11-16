// Deterministic GATT double. It models wire notifications, never PC/OS success.
export function installFakeBLE(options = {}) {
  const frames = [], operations = [];
  let lastId = 0, state = 0, current;
  const status = new EventTarget();
  status.startNotifications = async () => status;
  function notify(type, id, reason = 0) {
    const b = new Uint8Array(7); b[0] = 0xc2; b[1] = type;
    new DataView(b.buffer).setUint32(2, id, true); b[6] = reason;
    status.value = new DataView(b.buffer); status.dispatchEvent(new Event('characteristicvaluechanged'));
  }
  function finish() { state = 0; notify(2, current.id); }
  const capability = { readValue: async () => {
    const b = Uint8Array.from([66,86,66,50,7,state,0,16,1,0,0,0,0,0,0,0]);
    new DataView(b.buffer).setUint32(12, lastId, true); return new DataView(b.buffer);
  }};
  const writer = { writeValueWithResponse: async bytes => {
    const b = new Uint8Array(bytes); frames.push([...b]); const v = new DataView(b.buffer);
    if (b[0] === 0xb1) {
      lastId = v.getUint32(2, true); state = 1;
      current = { id: lastId, op: b[6], os: b[7], enter: b[8], layout: b[9], bytes: [] };
    } else if (b[0] === 0xb2) current.bytes.push(...b.slice(7));
    else if (b[0] === 0xb3) {
      state = 3; operations.push(current); notify(1, current.id);
      if (options.disconnect) device.gatt.disconnect();
      else if (options.error) notify(3, current.id, 8);
      else if (!options.hold) setTimeout(finish, 50);
    }
  }};
  const service = { getCharacteristic: async uuid => {
    if (uuid.startsWith('7f510004')) {
      if (options.old) throw new DOMException('Missing capability', 'NotFoundError');
      return capability;
    }
    if (uuid.startsWith('7f510003')) return status;
    return writer;
  }};
  const device = new EventTarget();
  device.gatt = { connected: false,
    connect: async () => { device.gatt.connected = true; return { getPrimaryService: async () => service }; },
    disconnect: () => { if (device.gatt.connected) { device.gatt.connected = false; state = 0; device.dispatchEvent(new Event('gattserverdisconnected')); } }
  };
  const bluetooth = { requestDevice: async () => device };
  Object.defineProperty(navigator, 'bluetooth', { value: bluetooth, configurable: true });
  globalThis.bleMock = { frames, operations, device, status, capability, writer, notify, finish };
  return globalThis.bleMock;
}
