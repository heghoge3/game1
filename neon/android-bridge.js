// Мост для Android-приложения: WebView не умеет Web Bluetooth, поэтому
// navigator.bluetooth и navigator.wakeLock здесь эмулируются поверх нативного
// интерфейса AndroidBle. В обычном браузере файл ничего не делает.
(function () {
  const N = window.AndroidBle;
  if (!N) return;

  let seq = 0;
  const pending = {};
  const devices = {};

  const call = (fn, ...args) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending[id] = { resolve, reject };
    N[fn](...args, id);
  });

  const uuid = u => (typeof u === 'number'
    ? `0000${u.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`
    : String(u).toLowerCase());
  const hex = data => Array.from(new Uint8Array(data.buffer || data)).map(b => b.toString(16).padStart(2, '0')).join('');

  // вызывается из Java
  window.__ble = {
    resolve(id, ok, data) {
      const p = pending[id];
      if (!p) return;
      delete pending[id];
      if (ok) return p.resolve(data);
      const e = new Error(data === 'cancel' ? 'Отменено' : data || 'Ошибка Bluetooth');
      e.name = data === 'cancel' ? 'AbortError' : 'NetworkError';
      p.reject(e);
    },
    disconnected(address) {
      const d = devices[address];
      if (!d || !d.gatt.connected) return;
      d.gatt.connected = false;
      d._fire('gattserverdisconnected');
    },
  };

  function makeDevice(address, name) {
    if (devices[address]) return devices[address];
    const listeners = {};
    const dev = {
      id: address,
      name,
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      _fire(type) { (listeners[type] || []).forEach(fn => fn({ target: dev })); },
      gatt: {
        connected: false,
        async connect() {
          await call('connect', address);
          this.connected = true;
          return server;
        },
        disconnect() { N.disconnect(address); },
      },
    };
    const server = {
      device: dev,
      async getPrimaryService(s) {
        const su = uuid(s);
        if (!N.hasService(address, su)) throw new Error('Сервис не найден: ' + su);
        return {
          async getCharacteristic(c) {
            const cu = uuid(c);
            const props = N.charProps(address, su, cu);
            if (props < 0) throw new Error('Характеристика не найдена: ' + cu);
            return {
              properties: { write: !!(props & 0x08), writeWithoutResponse: !!(props & 0x04) },
              writeValueWithoutResponse: d => call('write', address, su, cu, hex(d), true),
              writeValue: d => call('write', address, su, cu, hex(d), false),
            };
          },
        };
      },
    };
    devices[address] = dev;
    return dev;
  }

  Object.defineProperty(navigator, 'bluetooth', {
    configurable: true,
    value: {
      async requestDevice() {
        const r = JSON.parse(await call('requestDevice'));
        return makeDevice(r.address, r.name);
      },
    },
  });

  Object.defineProperty(navigator, 'wakeLock', {
    configurable: true,
    value: {
      async request() {
        N.keepScreenOn(true);
        return { release: async () => N.keepScreenOn(false), addEventListener() {} };
      },
    },
  });
})();
