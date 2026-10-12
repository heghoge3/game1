// Протокол контроллеров ELK-BLEDOM (Lotus Lantern / duoCo Strip) и родственных.
// Все команды — 9 байт: 7E ... EF.

const VARIANTS = {
  elk: {
    label: 'ELK-BLEDOM',
    on:  [0x7e, 0x00, 0x04, 0xf0, 0x00, 0x01, 0xff, 0x00, 0xef],
    off: [0x7e, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0x00, 0xef],
    color: (r, g, b) => [0x7e, 0x00, 0x05, 0x03, r, g, b, 0x00, 0xef],
    bright: v => [0x7e, 0x00, 0x01, v, 0x00, 0x00, 0x00, 0x00, 0xef],
    effect: m => [0x7e, 0x00, 0x03, m, 0x03, 0x00, 0x00, 0x00, 0xef],
    speed: v => [0x7e, 0x00, 0x02, v, 0x00, 0x00, 0x00, 0x00, 0xef],
  },
  melk: {
    label: 'MELK / ELK-BLEDOB',
    init: [[0x7e, 0x07, 0x83], [0x7e, 0x04, 0x04]],
    on:  [0x7e, 0x07, 0x04, 0xff, 0x00, 0x01, 0x02, 0x01, 0xef],
    off: [0x7e, 0x07, 0x04, 0x00, 0x00, 0x00, 0x02, 0x01, 0xef],
    color: (r, g, b) => [0x7e, 0x07, 0x05, 0x03, r, g, b, 0x10, 0xef],
    bright: v => [0x7e, 0x04, 0x01, v, 0x01, 0xff, 0x02, 0x01, 0xef],
    effect: m => [0x7e, 0x07, 0x03, m, 0x03, 0xff, 0xff, 0x00, 0xef],
    speed: v => [0x7e, 0x07, 0x02, v, 0xff, 0xff, 0xff, 0x00, 0xef],
  },
  ledble: {
    label: 'LEDBLE',
    on:  [0x7e, 0x00, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0xef],
    off: [0x7e, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0xef],
    color: (r, g, b) => [0x7e, 0x00, 0x05, 0x03, r, g, b, 0x00, 0xef],
    bright: v => [0x7e, 0x00, 0x01, v, 0x00, 0x00, 0x00, 0x00, 0xef],
    effect: m => [0x7e, 0x00, 0x03, m, 0x03, 0x00, 0x00, 0x00, 0xef],
    speed: v => [0x7e, 0x00, 0x02, v, 0x00, 0x00, 0x00, 0x00, 0xef],
  },
};

// Пары «сервис → характеристика записи», которые встречаются у этих контроллеров.
const GATT_CANDIDATES = [
  { service: 0xfff0, char: 0xfff3 },
  { service: 0xffe0, char: 0xffe1 },
];

const NAME_PREFIXES = ['ELK', 'MELK', 'BLEDOM', 'LEDBLE', 'duoCo', 'Triones', 'LEDnet', 'QHM'];

function variantByName(name = '') {
  const n = name.toUpperCase();
  if (n.startsWith('MELK') || n.includes('BLEDOB')) return 'melk';
  if (n.startsWith('LEDBLE')) return 'ledble';
  return 'elk';
}

const hex = bytes => bytes.map(b => b.toString(16).padStart(2, '0')).join(' ');

class Strip {
  constructor(device, mgr) {
    this.device = device;
    this.mgr = mgr;
    this.char = null;
    this.noResponse = false;
    this.pending = new Map(); // ключ → байты; новые команды того же типа заменяют старые
    this.writing = false;
    this.manualDisconnect = false;
    device.addEventListener('gattserverdisconnected', () => this.onDisconnect());
  }

  get name() { return this.device.name || 'Без имени'; }
  get connected() { return !!(this.device.gatt && this.device.gatt.connected && this.char); }
  get variant() {
    const v = this.mgr.variantOverride;
    return VARIANTS[v !== 'auto' ? v : variantByName(this.device.name)];
  }

  async connect() {
    this.manualDisconnect = false;
    this.mgr.log(`→ подключение к ${this.name}…`);
    const server = await this.device.gatt.connect();
    let lastErr;
    for (const c of GATT_CANDIDATES) {
      try {
        const svc = await server.getPrimaryService(c.service);
        this.char = await svc.getCharacteristic(c.char);
        this.noResponse = !!this.char.properties.writeWithoutResponse;
        this.mgr.log(`✓ ${this.name}: сервис ${c.service.toString(16)}, характеристика ${c.char.toString(16)}`);
        break;
      } catch (e) { lastErr = e; }
    }
    if (!this.char) throw lastErr || new Error('Не найдена характеристика записи');
    for (const cmd of this.variant.init || []) await this.writeRaw(cmd);
    this.mgr.emit();
  }

  disconnect() {
    this.manualDisconnect = true;
    if (this.device.gatt.connected) this.device.gatt.disconnect();
  }

  async onDisconnect() {
    this.char = null;
    this.pending.clear();
    this.mgr.log(`✗ ${this.name} отключилась`);
    this.mgr.emit();
    if (this.manualDisconnect || !this.mgr.autoReconnect) return;
    for (let i = 0; i < 5 && !this.manualDisconnect; i++) {
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
      try { await this.connect(); this.mgr.onReconnect(this); return; } catch (e) { /* следующая попытка */ }
    }
  }

  send(key, bytes) {
    if (!this.connected) return;
    this.pending.set(key, bytes);
    this.drain();
  }

  async drain() {
    if (this.writing) return;
    this.writing = true;
    try {
      while (this.pending.size && this.connected) {
        const [key, bytes] = this.pending.entries().next().value;
        this.pending.delete(key);
        await this.writeRaw(bytes);
        await new Promise(r => setTimeout(r, 12));
      }
    } finally {
      this.writing = false;
    }
  }

  async writeRaw(bytes) {
    const data = new Uint8Array(bytes);
    try {
      if (this.noResponse && this.char.writeValueWithoutResponse) await this.char.writeValueWithoutResponse(data);
      else await this.char.writeValue(data);
      if (this.mgr.verbose) this.mgr.log(`  ${hex(bytes)}`);
    } catch (e) {
      this.mgr.log(`! ошибка записи: ${e.message}`);
    }
  }
}

class StripManager {
  constructor() {
    this.strips = [];
    this.listeners = [];
    this.variantOverride = 'auto';
    this.autoReconnect = true;
    this.verbose = false;
    this.logLines = [];
    this.onReconnect = () => {};
  }

  get supported() { return !!(navigator.bluetooth && navigator.bluetooth.requestDevice); }
  get anyConnected() { return this.strips.some(s => s.connected); }

  on(fn) { this.listeners.push(fn); }
  emit() { this.listeners.forEach(fn => fn()); }

  log(line) {
    const t = new Date().toLocaleTimeString();
    this.logLines.push(`${t} ${line}`);
    if (this.logLines.length > 200) this.logLines.shift();
    this.emit();
  }

  async add(acceptAll = false) {
    const optionalServices = GATT_CANDIDATES.map(c => c.service);
    const opts = acceptAll
      ? { acceptAllDevices: true, optionalServices }
      : { filters: [...NAME_PREFIXES.map(namePrefix => ({ namePrefix })), ...optionalServices.map(s => ({ services: [s] }))], optionalServices };
    const device = await navigator.bluetooth.requestDevice(opts);
    let strip = this.strips.find(s => s.device.id === device.id);
    if (!strip) { strip = new Strip(device, this); this.strips.push(strip); }
    await strip.connect();
    return strip;
  }

  remove(strip) {
    strip.disconnect();
    this.strips = this.strips.filter(s => s !== strip);
    this.emit();
  }

  // Высокоуровневые команды — уходят на все подключённые ленты.
  each(fn) { this.strips.filter(s => s.connected).forEach(fn); }
  power(on) { this.each(s => s.send('power', on ? s.variant.on : s.variant.off)); }
  color(r, g, b) { this.each(s => s.send('color', s.variant.color(r, g, b))); }
  brightness(v) { this.each(s => s.send('bright', s.variant.bright(Math.round(v)))); }
  effect(m) { this.each(s => s.send('effect', s.variant.effect(m))); }
  speed(v) { this.each(s => s.send('speed', s.variant.speed(Math.round(v)))); }
  raw(bytes) { this.each(s => s.send('raw' + Math.random(), bytes)); }
}

window.VARIANTS = VARIANTS;
window.StripManager = StripManager;
window.hexBytes = hex;
