'use strict';

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const mgr = new StripManager();

// ---------- состояние ----------
const DEFAULT_STATE = {
  power: true,
  rgb: [255, 0, 255],
  bright: 100,
  speed: 50,
  mode: 'color',          // color | soft | hw | music
  soft: null,
  hw: null,
  music: 'pulse',
  sens: 60,
  floor: 5,
  order: 'RGB',
  gain: [100, 100, 100],
  variant: 'auto',
  autoReconnect: true,
  keepAwake: true,
  favs: ['#ff00ff', '#00e5ff', '#ff3b00', '#7a00ff'],
  scenes: null,
  schedules: [],
  smooth: 60,
  gamma: true,
  hwTimer: { on: { en: false, time: '07:00', days: 0x7f }, off: { en: false, time: '23:30', days: 0x7f } },
};

function loadState() {
  try { return { ...DEFAULT_STATE, ...JSON.parse(localStorage.getItem('neon-state') || '{}') }; }
  catch { return { ...DEFAULT_STATE }; }
}
const S = loadState();
let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { localStorage.setItem('neon-state', JSON.stringify(S)); } catch { /* приватный режим */ } }, 300);
}

// ---------- цвет: утилиты ----------
function hsv2rgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255].map(Math.round);
}
function rgb2hsv([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return [(h + 360) % 360, max ? d / max : 0, max];
}
const toHex = rgb => '#' + rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
function fromHex(h) {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [n >> 16 & 255, n >> 8 & 255, n & 255];
}
function kelvin2rgb(k) {
  const t = k / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [r, g, b].map(v => Math.round(clamp(v, 0, 255)));
}
const mix = (a, b, t) => a.map((v, i) => lerp(v, b[i], t));
const scale = (c, k) => c.map(v => v * k);

// плавный шум для «живых» эффектов
const noiseSeeds = Array.from({ length: 64 }, () => Math.random());
function noise(x, ch = 0) {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  const a = noiseSeeds[(i + ch * 7) & 63], b = noiseSeeds[(i + 1 + ch * 7) & 63];
  return lerp(a, b, u);
}

// ---------- вывод на ленту ----------
// Цвета в приложении — «как видит глаз» (0–255). Светодиоды светят линейно, поэтому
// перед отправкой применяем гамму 2.2: так затухания и переливы идут равномерно,
// без резкого провала в темноту и скачков у нижней границы яркости.
// Сглаживание тоже идёт в линейном свете, чтобы переходы не проседали по яркости.
const GAMMA = 2.2;
const toLin = v => (S.gamma ? Math.pow(clamp(v, 0, 255) / 255, GAMMA) : clamp(v, 0, 255) / 255);
const fromLin = v => 255 * (S.gamma ? Math.pow(clamp(v, 0, 1), 1 / GAMMA) : clamp(v, 0, 1));
const mixLin = (a, b, t) => a.map((v, i) => fromLin(lerp(toLin(v), toLin(b[i]), t)));

const eng = { cur: null, target: [0, 0, 0], tau: 0, timer: null, last: 0 };
let lastSent = '';

// rgb — целевой цвет; tau — постоянная сглаживания в мс (0 — мгновенно)
function output(rgb, tau = 250, force = false) {
  document.documentElement.style.setProperty('--live', toHex(rgb.map(v => clamp(Math.round(v), 0, 255))));
  eng.target = rgb.map(toLin);
  if (!S.power) return;
  if (!eng.cur || tau <= 0 || force) {
    eng.cur = [...eng.target];
    stopEngine();
    sendLin(eng.cur, force);
    return;
  }
  eng.tau = tau;
  if (!eng.timer) { eng.last = performance.now(); eng.timer = setInterval(engineTick, 20); }
}

function engineTick() {
  const now = performance.now(), k = 1 - Math.exp(-(now - eng.last) / eng.tau);
  eng.last = now;
  let done = true;
  eng.cur = eng.cur.map((v, i) => {
    const n = v + (eng.target[i] - v) * k;
    if (Math.abs(eng.target[i] - n) > 0.0005) done = false;
    return n;
  });
  // в статичном режиме цикл останавливается, когда цвет догнал цель
  if (done && !fxTimer && !audio && !alarm) { eng.cur = [...eng.target]; stopEngine(); }
  sendLin(eng.cur);
}
function stopEngine() { clearInterval(eng.timer); eng.timer = null; }

function sendLin(lin, force = false) {
  const corrected = lin.map((v, i) => Math.round(255 * v * S.gain[i] / 100));
  const idx = { R: 0, G: 1, B: 2 };
  const ordered = S.order.split('').map(ch => corrected[idx[ch]]);
  const key = ordered.join(',');
  if (!force && key === lastSent) return;
  lastSent = key;
  mgr.color(...ordered);
}
const fxTau = fx => (fx.sharp ? 0 : 40 + S.smooth * 6);   // 40…640 мс

function setPower(on) {
  S.power = on;
  mgr.power(on);
  if (on) { lastSent = ''; eng.cur = null; mgr.brightness(S.bright); restoreMode(); }
  else { stopLoops(); stopEngine(); }
  renderPower(); save();
}

// ---------- режимы ----------
let fxTimer = null, fxStart = 0;

function stopLoops() {
  clearInterval(fxTimer); fxTimer = null;
  stopMusic();
  updateWakeLock();
}

function setStaticColor(rgb) {
  stopLoops();
  S.mode = 'color'; S.rgb = rgb.map(Math.round);
  if (!S.power) setPower(true); else output(S.rgb);
  syncWheel(); renderActive(); save();
}

// скорость по экспоненте: левая половина ползунка — медленные спокойные эффекты
const speedK = () => 0.08 * Math.pow(25, S.speed / 100);  // 0.08…2.0

function startSoft(id) {
  stopLoops();
  S.mode = 'soft'; S.soft = id;
  const fx = SOFT_FX.find(f => f.id === id);
  fxStart = performance.now();
  const tick = () => {
    const t = (performance.now() - fxStart) / 1000;
    output(fx.fn(t * speedK(), t), fxTau(fx));
  };
  fxTimer = setInterval(tick, 30);
  tick();
  renderActive(); updateWakeLock(); save();
}

function startHw(code) {
  stopLoops();
  S.mode = 'hw'; S.hw = code;
  mgr.effect(code);
  mgr.speed(S.speed);
  renderActive(); save();
}

function restoreMode() {
  if (S.mode === 'soft' && S.soft) startSoft(S.soft);
  else if (S.mode === 'hw' && S.hw != null) startHw(S.hw);
  else output(S.rgb, 0, true);
}

// ---------- эффекты ----------
const FAV = () => (S.favs.length ? S.favs : DEFAULT_STATE.favs).map(fromHex).filter(Boolean);
const cycle = (colors, x) => {
  const n = colors.length, i = Math.floor(x) % n;
  const f = x - Math.floor(x), u = f * f * (3 - 2 * f);
  return mixLin(colors[i], colors[(i + 1) % n], u);
};

const SOFT_FX = [
  { id: 'rainbow', em: '🌈', nm: 'Радуга', bar: 'linear-gradient(90deg,red,orange,yellow,lime,cyan,blue,magenta)',
    fn: x => hsv2rgb(x * 30, 1, 1) },
  { id: 'breath', em: '🫁', nm: 'Дыхание', bar: 'var(--live)',
    fn: x => scale(S.rgb, 0.12 + 0.88 * (0.5 - 0.5 * Math.cos(x * 2.5))) },
  { id: 'favs', em: '⭐', nm: 'Мои цвета', bar: 'linear-gradient(90deg,#ff00ff,#00e5ff,#ff3b00)',
    fn: x => cycle(FAV(), x * 0.5) },
  { id: 'candle', em: '🕯️', nm: 'Свеча', bar: 'linear-gradient(90deg,#ff7a00,#ffb347)',
    fn: x => scale([255, 120, 20], 0.6 + 0.4 * noise(x * 3) * (0.8 + 0.2 * noise(x * 7, 1))) },
  { id: 'fire', em: '🔥', nm: 'Огонь', bar: 'linear-gradient(90deg,#ff1e00,#ff9500)',
    fn: x => { const n = noise(x * 2); return [255, 40 + 100 * n, 0].map(v => v * (0.65 + 0.35 * noise(x * 4, 2))); } },
  { id: 'ocean', em: '🌊', nm: 'Океан', bar: 'linear-gradient(90deg,#003cff,#00e5ff)',
    fn: x => mixLin([0, 40, 255], [0, 220, 255], noise(x * 0.6)).map(v => v * (0.8 + 0.2 * noise(x * 1.1, 3))) },
  { id: 'aurora', em: '🌌', nm: 'Сияние', bar: 'linear-gradient(90deg,#00ff88,#00b3ff,#9d00ff)',
    fn: x => cycle([[0, 255, 120], [0, 180, 255], [150, 0, 255], [0, 255, 200]], x * 0.35) },
  { id: 'sunset', em: '🌇', nm: 'Закат', bar: 'linear-gradient(90deg,#ff5e00,#ff006a,#7000ff)',
    fn: x => cycle([[255, 80, 0], [255, 0, 90], [120, 0, 255], [255, 0, 40]], x * 0.3) },
  { id: 'police', em: '🚨', nm: 'Полиция', sharp: true, bar: 'linear-gradient(90deg,red 50%,blue 50%)',
    fn: x => { const p = (x * 2) % 2, s = (p % 1) < 0.5 && Math.floor((p % 1) * 8) % 2 === 0; return s ? (p < 1 ? [255, 0, 0] : [0, 0, 255]) : [0, 0, 0]; } },
  { id: 'strobe', em: '⚡', nm: 'Стробоскоп', sharp: true, bar: '#fff',
    fn: x => ((x * 6) % 1 < 0.25 ? S.rgb : [0, 0, 0]) },
  { id: 'heart', em: '💓', nm: 'Сердцебиение', bar: '#ff0040',
    fn: x => { const p = (x * 0.8) % 1; const k = Math.exp(-((p - 0.1) ** 2) / 0.002) + 0.7 * Math.exp(-((p - 0.3) ** 2) / 0.002); return scale([255, 0, 50], 0.05 + 0.95 * Math.min(1, k)); } },
  { id: 'brokenneon', em: '🍸', nm: 'Старая вывеска', sharp: true, bar: 'var(--live)',
    fn: (x, t) => { const n = noise(t * 3, 4); return n < 0.18 ? scale(S.rgb, noise(t * 40, 5) > 0.5 ? 0.15 : 1) : S.rgb; } },
  { id: 'random', em: '🎲', nm: 'Случайные', bar: 'linear-gradient(90deg,#f0f,#0f0,#fa0)',
    fn: x => hsv2rgb(noise(x * 0.25, 6) * 540, 1, 1) },
  { id: 'chase', em: '🎡', nm: 'Вспышки цвета', bar: 'linear-gradient(90deg,#ff0,#0ff,#f0f)',
    fn: x => { const i = Math.floor(x), f = x % 1; return scale(hsv2rgb(i * 137.5, 1, 1), 0.1 + 0.9 * Math.sin(Math.PI * f)); } },
];

const HW_FX = [
  { code: 0x87, nm: 'Прыжки RGB', bar: 'linear-gradient(90deg,red,lime,blue)' },
  { code: 0x88, nm: 'Прыжки 7 цветов', bar: 'linear-gradient(90deg,red,yellow,lime,cyan,blue,magenta,white)' },
  { code: 0x89, nm: 'Перелив RGB', bar: 'linear-gradient(90deg,red,lime,blue)' },
  { code: 0x8a, nm: 'Перелив 7 цветов', bar: 'linear-gradient(90deg,red,yellow,lime,cyan,blue,magenta,white)' },
  { code: 0x8b, nm: 'Пульс красный', bar: 'red' },
  { code: 0x8c, nm: 'Пульс зелёный', bar: 'lime' },
  { code: 0x8d, nm: 'Пульс синий', bar: 'blue' },
  { code: 0x8e, nm: 'Пульс жёлтый', bar: 'yellow' },
  { code: 0x8f, nm: 'Пульс голубой', bar: 'cyan' },
  { code: 0x90, nm: 'Пульс фиолетовый', bar: 'magenta' },
  { code: 0x91, nm: 'Пульс белый', bar: 'white' },
  { code: 0x92, nm: 'Красный ↔ зелёный', bar: 'linear-gradient(90deg,red,lime)' },
  { code: 0x93, nm: 'Красный ↔ синий', bar: 'linear-gradient(90deg,red,blue)' },
  { code: 0x94, nm: 'Зелёный ↔ синий', bar: 'linear-gradient(90deg,lime,blue)' },
  { code: 0x95, nm: 'Мигание 7 цветов', bar: 'linear-gradient(90deg,red,yellow,lime,cyan,blue,magenta,white)' },
  { code: 0x96, nm: 'Мигание красный', bar: 'red' },
  { code: 0x97, nm: 'Мигание зелёный', bar: 'lime' },
  { code: 0x98, nm: 'Мигание синий', bar: 'blue' },
  { code: 0x99, nm: 'Мигание жёлтый', bar: 'yellow' },
  { code: 0x9a, nm: 'Мигание голубой', bar: 'cyan' },
  { code: 0x9b, nm: 'Мигание фиолет.', bar: 'magenta' },
  { code: 0x9c, nm: 'Мигание белый', bar: 'white' },
];

// ---------- светомузыка ----------
const MUSIC_MODES = [
  { id: 'pulse', em: '💥', nm: 'Пульс' },
  { id: 'spectrum', em: '🌈', nm: 'Спектр' },
  { id: 'beat', em: '🥁', nm: 'Смена на бит' },
  { id: 'bass', em: '🔊', nm: 'Басы' },
  { id: 'fire', em: '🔥', nm: 'Огонь' },
  { id: 'disco', em: '🪩', nm: 'Диско' },
];
let audio = null;

async function startMusic() {
  stopLoops();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 1024; an.smoothingTimeConstant = 0.6;
    src.connect(an);
    audio = { stream, ctx, an, buf: new Uint8Array(an.frequencyBinCount), avg: 0, bassAvg: 0, hue: Math.random() * 360, level: 0, lastBeat: 0 };
    S.mode = 'music';
    audio.timer = setInterval(musicTick, 33);
    $('btnMusic').textContent = '⏹ Остановить светомузыку';
    renderActive(); updateWakeLock(); save();
  } catch (e) {
    toast('Нет доступа к микрофону: ' + e.message);
  }
}

function stopMusic() {
  if (!audio) return;
  clearInterval(audio.timer);
  audio.stream.getTracks().forEach(t => t.stop());
  audio.ctx.close();
  audio = null;
  $('btnMusic').textContent = '🎤 Включить светомузыку';
  $('meterBar').style.width = '0';
}

function musicTick() {
  const a = audio, buf = a.buf;
  a.an.getByteFrequencyData(buf);
  const binHz = a.ctx.sampleRate / a.an.fftSize;
  let bass = 0, total = 0, peakI = 0, peakV = 0, bassN = 0;
  for (let i = 1; i < buf.length; i++) {
    const v = buf[i] / 255, hz = i * binHz;
    if (hz < 160) { bass += v; bassN++; }
    if (hz < 6000) total += v;
    if (hz > 80 && hz < 4000 && buf[i] > peakV) { peakV = buf[i]; peakI = i; }
  }
  bass /= bassN || 1;
  total /= buf.length * (6000 / (a.ctx.sampleRate / 2));
  const gain = 0.5 + (S.sens / 100) * 4;
  const lvl = clamp(total * gain * 1.6, 0, 1);
  const bl = clamp(bass * gain, 0, 1);

  a.avg = lerp(a.avg, lvl, 0.05);
  a.bassAvg = lerp(a.bassAvg, bl, 0.08);
  const now = performance.now();
  const beat = bl > a.bassAvg * 1.35 + 0.08 && now - a.lastBeat > 180;
  if (beat) a.lastBeat = now;
  a.level = Math.max(lvl, a.level * 0.85);

  $('meterBar').style.width = (a.level * 100).toFixed(0) + '%';
  $('meterBeat').style.opacity = now - a.lastBeat < 100 ? 1 : 0;

  const floor = S.floor / 100;
  const k = v => floor + (1 - floor) * v;
  let rgb;
  switch (S.music) {
    case 'pulse': rgb = scale(S.rgb, k(a.level)); break;
    case 'spectrum': {
      const hz = peakI * binHz;
      const target = clamp(Math.log2(Math.max(hz, 80) / 80) / Math.log2(50), 0, 1) * 300;
      a.hue = lerp(a.hue, target, 0.2);
      rgb = hsv2rgb(a.hue, 1, k(a.level));
      break;
    }
    case 'beat':
      if (beat) a.hue = (a.hue + 70 + Math.random() * 140) % 360;
      rgb = hsv2rgb(a.hue, 1, k(Math.max(a.level, 0.4)));
      break;
    case 'bass': rgb = scale(S.rgb, k(Math.pow(bl, 1.5))); break;
    case 'fire': rgb = hsv2rgb(lerp(0, 45, a.level), 1, k(a.level)); break;
    case 'disco':
      if (beat) a.hue = Math.random() * 360;
      rgb = now - a.lastBeat < 90 ? [255, 255, 255] : hsv2rgb(a.hue, 1, k(a.level * 0.7));
      break;
  }
  output(rgb, S.music === 'disco' ? 0 : 70);
}

// ---------- сцены ----------
const DEFAULT_SCENES = [
  { nm: 'Чтение', em: '📖', mode: 'color', rgb: kelvin2rgb(4500), bright: 100 },
  { nm: 'Кино', em: '🎬', mode: 'color', rgb: [40, 0, 120], bright: 20 },
  { nm: 'Вечер', em: '🌙', mode: 'color', rgb: kelvin2rgb(2200), bright: 40 },
  { nm: 'Киберпанк', em: '🌆', mode: 'soft', soft: 'favs', rgb: [255, 0, 255], bright: 100, speed: 25 },
  { nm: 'Вечеринка', em: '🎉', mode: 'soft', soft: 'chase', rgb: [255, 0, 255], bright: 100, speed: 70 },
  { nm: 'Романтика', em: '❤️', mode: 'soft', soft: 'candle', rgb: [255, 0, 60], bright: 50, speed: 40 },
  { nm: 'Игры', em: '🎮', mode: 'soft', soft: 'aurora', rgb: [0, 255, 200], bright: 100, speed: 35 },
  { nm: 'Чил', em: '🌊', mode: 'soft', soft: 'ocean', rgb: [0, 120, 255], bright: 60, speed: 15 },
];
if (!S.scenes) S.scenes = DEFAULT_SCENES;

function applyScene(sc) {
  if (!S.power) setPower(true);
  S.bright = sc.bright ?? S.bright;
  if (sc.speed) S.speed = sc.speed;
  S.rgb = sc.rgb || S.rgb;
  mgr.brightness(S.bright);
  syncControls();
  if (sc.mode === 'soft') startSoft(sc.soft);
  else if (sc.mode === 'hw') startHw(sc.hw);
  else if (sc.mode === 'music') { S.music = sc.music || S.music; startMusic(); }
  else setStaticColor(S.rgb);
  toast(`Сцена «${sc.nm}»`);
}

function saveScene() {
  const nm = prompt('Название сцены:', 'Моя сцена');
  if (!nm) return;
  const em = S.mode === 'soft' ? SOFT_FX.find(f => f.id === S.soft).em : S.mode === 'music' ? '🎵' : S.mode === 'hw' ? '✨' : '💡';
  S.scenes.push({ nm, em, mode: S.mode, soft: S.soft, hw: S.hw, music: S.music, rgb: [...S.rgb], bright: S.bright, speed: S.speed });
  renderScenes(); save();
}

// ---------- таймеры ----------
let sleepTimer = null; // { end, start, from }
let alarm = null;      // { at: Date, dur }

function startSleep(min) {
  sleepTimer = min ? { start: Date.now(), end: Date.now() + min * 60000, from: S.bright } : null;
  if (!min) { mgr.brightness(S.bright); }
  renderTimers(); updateWakeLock();
  if (min) toast(`Лента погаснет через ${min} мин`);
}

function setAlarm() {
  const [h, m] = $('alarmTime').value.split(':').map(Number);
  const at = new Date(); at.setHours(h, m, 0, 0);
  if (at <= new Date()) at.setDate(at.getDate() + 1);
  alarm = { at: at.getTime(), dur: +$('alarmDur').value, running: false };
  renderTimers(); updateWakeLock();
  toast(`Рассвет начнётся за ${alarm.dur} мин до ${$('alarmTime').value}`);
}

function addSchedule() {
  S.schedules.push({ action: $('schedAction').value, time: $('schedTime').value, last: '' });
  renderTimers(); save(); updateWakeLock();
}

const SUNRISE = [[0, 0, 0], [80, 0, 0], [255, 40, 0], [255, 120, 20], [255, 190, 110], kelvin2rgb(5500)];

function timerTick() {
  const now = Date.now();
  if (sleepTimer) {
    const p = (now - sleepTimer.start) / (sleepTimer.end - sleepTimer.start);
    if (p >= 1) { const from = sleepTimer.from; sleepTimer = null; setPower(false); S.bright = from; toast('Спокойной ночи 🌙'); renderTimers(); updateWakeLock(); }
    else mgr.brightness(Math.max(1, sleepTimer.from * Math.pow(1 - p, 2)));
  }
  if (alarm) {
    const startAt = alarm.at - alarm.dur * 60000;
    if (now >= startAt) {
      if (!alarm.running) {
        alarm.running = true; stopLoops(); S.mode = 'color';
        if (!S.power) { S.power = true; mgr.power(true); renderPower(); }
        mgr.brightness(100);
      }
      const p = clamp((now - startAt) / (alarm.dur * 60000), 0, 1);
      const c = cycle(SUNRISE, p * (SUNRISE.length - 1.001));
      output(c, 1500);
      if (p >= 1) { S.rgb = c.map(Math.round); alarm = null; renderTimers(); updateWakeLock(); save(); toast('Доброе утро ☀️'); }
    }
  }
  const hm = new Date().toTimeString().slice(0, 5);
  const day = new Date().toDateString();
  for (const sc of S.schedules) {
    if (sc.time === hm && sc.last !== day) {
      sc.last = day; save();
      setPower(sc.action === 'on');
      toast(sc.action === 'on' ? 'Включено по расписанию' : 'Выключено по расписанию');
    }
  }
  renderTimerCountdowns();
}
setInterval(timerTick, 1000);

// ---------- встроенный таймер контроллера ----------
const DAY_NAMES = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
function renderHwTimer() {
  for (const kind of ['on', 'off']) {
    const t = S.hwTimer[kind], K = kind === 'on' ? 'On' : 'Off';
    $('hw' + K + 'En').checked = t.en;
    $('hw' + K + 'Time').value = t.time;
    const box = document.querySelector(`.days[data-for=${kind}]`);
    box.innerHTML = '';
    DAY_NAMES.forEach((nm, i) => {
      const b = document.createElement('button');
      b.textContent = nm;
      b.classList.toggle('on', !!(t.days & (1 << i)));
      b.onclick = () => { t.days ^= 1 << i; renderHwTimer(); save(); };
      box.append(b);
    });
  }
}
for (const kind of ['on', 'off']) {
  const K = kind === 'on' ? 'On' : 'Off';
  $('hw' + K + 'En').onchange = e => { S.hwTimer[kind].en = e.target.checked; save(); };
  $('hw' + K + 'Time').onchange = e => { S.hwTimer[kind].time = e.target.value; save(); };
}
function writeHwTimer(silent) {
  if (!mgr.anyConnected) { if (!silent) toast('Сначала подключи ленту'); return; }
  mgr.syncClock();
  for (const kind of ['on', 'off']) {
    const t = S.hwTimer[kind];
    const [h, m] = t.time.split(':').map(Number);
    mgr.hwTimer(kind === 'on', h, m, t.days, t.en && t.days > 0);
  }
  if (!silent) {
    const parts = ['on', 'off'].filter(k => S.hwTimer[k].en).map(k => `${k === 'on' ? 'вкл' : 'выкл'} в ${S.hwTimer[k].time}`);
    toast(parts.length ? `Записано в ленту: ${parts.join(', ')}` : 'Таймеры в ленте отключены');
  }
}
$('btnHwTimer').onclick = () => writeHwTimer(false);

// ---------- не давать экрану гаснуть ----------
let wakeLock = null;
async function updateWakeLock() {
  const need = S.keepAwake && (fxTimer || audio || sleepTimer || alarm || S.schedules.length);
  try {
    if (need && !wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!need && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* браузер не разрешил */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') updateWakeLock(); });

// ---------- UI ----------
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2200);
}

function longPress(el, onTap, onLong) {
  let timer, long = false;
  el.addEventListener('pointerdown', () => { long = false; timer = setTimeout(() => { long = true; onLong(); }, 600); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => el.addEventListener(ev, () => clearTimeout(timer)));
  el.addEventListener('click', () => { if (!long) onTap(); });
  el.addEventListener('contextmenu', e => e.preventDefault());
}

// вкладки
document.querySelectorAll('nav.bottom button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
function showTab(name) {
  document.querySelectorAll('nav.bottom button').forEach(x => x.classList.toggle('active', x.dataset.tab === name));
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.id === 'tab-' + name));
  if (name === 'color') drawWheel();
}

// цветовой круг
const wheel = $('wheel'), knob = $('wheelKnob');
let wheelDrawn = false;
function drawWheel() {
  if (wheelDrawn) return;
  const ctx = wheel.getContext('2d'), W = wheel.width, R = W / 2;
  const img = ctx.createImageData(W, W);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const dx = x - R, dy = y - R, d = Math.hypot(dx, dy) / R;
    if (d > 1) continue;
    const [r, g, b] = hsv2rgb(Math.atan2(dy, dx) * 180 / Math.PI, Math.min(1, d), 1);
    const o = (y * W + x) * 4;
    img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  wheelDrawn = true;
}
function syncWheel() {
  const [h, s] = rgb2hsv(S.rgb);
  const a = h * Math.PI / 180;
  knob.style.left = (50 + Math.cos(a) * s * 50) + '%';
  knob.style.top = (50 + Math.sin(a) * s * 50) + '%';
  knob.style.background = toHex(S.rgb);
  $('hexInput').value = toHex(S.rgb);
}
function wheelPick(e) {
  const r = wheel.getBoundingClientRect();
  const dx = e.clientX - r.left - r.width / 2, dy = e.clientY - r.top - r.height / 2;
  const s = Math.min(1, Math.hypot(dx, dy) / (r.width / 2));
  setStaticColor(hsv2rgb(Math.atan2(dy, dx) * 180 / Math.PI, s, 1));
}
const wrap = wheel.parentElement;
wrap.addEventListener('pointerdown', e => { wrap.setPointerCapture(e.pointerId); wheelPick(e); });
wrap.addEventListener('pointermove', e => { if (e.buttons) wheelPick(e); });

// яркость, температура, скорость
$('bright').addEventListener('input', e => {
  S.bright = +e.target.value; $('brightVal').textContent = S.bright + '%';
  sleepTimer = null; renderTimers();
  mgr.brightness(S.bright); save();
});
$('kelvin').addEventListener('input', e => {
  $('kelvinVal').textContent = e.target.value + 'K';
  setStaticColor(kelvin2rgb(+e.target.value));
});
$('speed').addEventListener('input', e => {
  S.speed = +e.target.value; $('speedVal').textContent = S.speed;
  if (S.mode === 'hw') mgr.speed(S.speed);
  save();
});

// быстрые и избранные цвета
const QUICK = ['#ff0000', '#ff5500', '#ffaa00', '#ffff00', '#00ff00', '#00ffaa', '#00ffff', '#0066ff', '#0000ff', '#7a00ff', '#ff00ff', '#ff0066', '#ffffff'];
function renderSwatches() {
  $('quickColors').innerHTML = '';
  QUICK.forEach(c => {
    const b = document.createElement('button');
    b.className = 'swatch'; b.style.background = c;
    b.onclick = () => setStaticColor(fromHex(c));
    $('quickColors').append(b);
  });
  $('favColors').innerHTML = '';
  S.favs.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'swatch'; b.style.background = c;
    longPress(b, () => setStaticColor(fromHex(c)), () => { S.favs.splice(i, 1); renderSwatches(); save(); toast('Удалено из избранного'); });
    $('favColors').append(b);
  });
}
$('btnAddFav').onclick = () => {
  const c = toHex(S.rgb);
  if (!S.favs.includes(c)) { S.favs.push(c); renderSwatches(); save(); toast('Добавлено в избранное'); }
};
$('btnHex').onclick = () => { const c = fromHex($('hexInput').value); c ? setStaticColor(c) : toast('Неверный HEX, пример: #ff00aa'); };

// карточки эффектов
function card(em, nm, bar, onTap, onLong) {
  const b = document.createElement('button');
  b.className = 'card';
  b.innerHTML = `<div class="bar" style="background:${bar}"></div>${em ? `<div class="em">${em}</div>` : ''}<div class="nm"></div>`;
  b.querySelector('.nm').textContent = nm;
  if (onLong) longPress(b, onTap, onLong); else b.onclick = onTap;
  return b;
}
SOFT_FX.forEach(f => { const c = card(f.em, f.nm, f.bar, () => { if (!S.power) setPower(true); startSoft(f.id); }); c.dataset.soft = f.id; $('softFx').append(c); });
HW_FX.forEach(f => { const c = card('', f.nm, f.bar, () => { if (!S.power) setPower(true); startHw(f.code); }); c.dataset.hw = f.code; $('hwFx').append(c); });
MUSIC_MODES.forEach(m => {
  const c = card(m.em, m.nm, 'var(--live)', () => { S.music = m.id; renderActive(); save(); if (!audio) startMusic(); });
  c.dataset.music = m.id; $('musicModes').append(c);
});
$('btnStopFx').onclick = () => setStaticColor(S.rgb);
$('btnMusic').onclick = () => (audio ? setStaticColor(S.rgb) : startMusic());
$('sens').addEventListener('input', e => { S.sens = +e.target.value; $('sensVal').textContent = S.sens; save(); });
$('floor').addEventListener('input', e => { S.floor = +e.target.value; $('floorVal').textContent = S.floor + '%'; save(); });

function renderActive() {
  document.querySelectorAll('[data-soft]').forEach(c => c.classList.toggle('active', S.mode === 'soft' && c.dataset.soft === S.soft));
  document.querySelectorAll('[data-hw]').forEach(c => c.classList.toggle('active', S.mode === 'hw' && +c.dataset.hw === S.hw));
  document.querySelectorAll('[data-music]').forEach(c => c.classList.toggle('active', c.dataset.music === S.music));
}

// сцены
function renderScenes() {
  $('scenes').innerHTML = '';
  S.scenes.forEach((sc, i) => {
    const bar = sc.rgb ? toHex(sc.rgb) : 'var(--live)';
    $('scenes').append(card(sc.em, sc.nm, bar, () => applyScene(sc), () => {
      if (confirm(`Удалить сцену «${sc.nm}»?`)) { S.scenes.splice(i, 1); renderScenes(); save(); }
    }));
  });
}
$('btnSaveScene').onclick = saveScene;

// таймеры
[0, 5, 15, 30, 60, 90].forEach(m => {
  const b = document.createElement('button');
  b.className = 'chip'; b.textContent = m ? `${m} мин` : 'Отмена';
  b.onclick = () => startSleep(m);
  $('sleepChips').append(b);
});
$('btnAlarm').onclick = setAlarm;
$('btnSched').onclick = addSchedule;

const fmtLeft = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 3600) ? Math.floor(s / 3600) + ' ч ' : ''}${Math.floor(s / 60) % 60} мин ${s % 60} с`; };
function timerItem(text, onCancel) {
  const d = document.createElement('div');
  d.className = 'timer-item';
  d.innerHTML = '<span></span><button aria-label="Отменить">✕</button>';
  d.querySelector('span').textContent = text;
  d.querySelector('button').onclick = onCancel;
  return d;
}
function renderTimers() {
  $('sleepStatus').innerHTML = '';
  if (sleepTimer) $('sleepStatus').append(timerItem('', () => { startSleep(0); }));
  $('alarmStatus').innerHTML = '';
  if (alarm) $('alarmStatus').append(timerItem('', () => { alarm = null; renderTimers(); updateWakeLock(); }));
  $('schedStatus').innerHTML = '';
  S.schedules.forEach((sc, i) => $('schedStatus').append(timerItem(`${sc.action === 'on' ? '💡 Включить' : '🌑 Выключить'} каждый день в ${sc.time}`, () => {
    S.schedules.splice(i, 1); renderTimers(); save(); updateWakeLock();
  })));
  renderTimerCountdowns();
}
function renderTimerCountdowns() {
  const s = $('sleepStatus').querySelector('span');
  if (s && sleepTimer) s.textContent = `🌙 Погаснет через ${fmtLeft(sleepTimer.end - Date.now())}`;
  const a = $('alarmStatus').querySelector('span');
  if (a && alarm) a.textContent = alarm.running ? '🌅 Рассвет идёт…' : `🌅 Рассвет через ${fmtLeft(alarm.at - alarm.dur * 60000 - Date.now())}`;
}

// настройки
$('variant').value = S.variant;
$('variant').onchange = e => { S.variant = mgr.variantOverride = e.target.value; save(); toast('Протокол изменён'); };
$('order').value = S.order;
$('order').onchange = e => { S.order = e.target.value; lastSent = ''; restoreMode(); save(); };
['R', 'G', 'B'].forEach((ch, i) => {
  const el = $('gain' + ch);
  el.value = S.gain[i]; $('g' + ch).textContent = S.gain[i] + '%';
  el.addEventListener('input', () => { S.gain[i] = +el.value; $('g' + ch).textContent = el.value + '%'; if (S.mode === 'color') output(S.rgb, 0, true); save(); });
});
$('smooth').value = S.smooth; $('smoothVal').textContent = S.smooth;
$('smooth').addEventListener('input', e => { S.smooth = +e.target.value; $('smoothVal').textContent = S.smooth; save(); });
$('gamma').checked = S.gamma;
$('gamma').onchange = e => { S.gamma = e.target.checked; eng.cur = null; restoreMode(); save(); };
$('autoReconnect').checked = S.autoReconnect;
$('autoReconnect').onchange = e => { S.autoReconnect = mgr.autoReconnect = e.target.checked; save(); };
$('keepAwake').checked = S.keepAwake;
$('keepAwake').onchange = e => { S.keepAwake = e.target.checked; updateWakeLock(); save(); };
$('btnRaw').onclick = () => {
  const bytes = $('rawCmd').value.replace(/0x/gi, '').split(/[\s,]+/).filter(Boolean).map(h => parseInt(h, 16));
  if (!bytes.length || bytes.some(b => isNaN(b) || b > 255)) return toast('Введи байты в HEX через пробел');
  mgr.raw(bytes); mgr.log('⇢ ' + hexBytes(bytes));
};

// подключение
async function connect(acceptAll = false) {
  if (!mgr.supported) return toast('Нужен Chrome с поддержкой Bluetooth');
  try {
    $('statusDot').className = 'status-dot busy'; $('statusText').textContent = 'Поиск…';
    const s = await mgr.add(acceptAll);
    toast(`Подключено: ${s.name}`);
    pushStateTo();
  } catch (e) {
    if (e.name === 'AbortError') { /* пользователь закрыл список */ }
    else if (e.name !== 'NotFoundError') toast('Ошибка: ' + e.message);
    else if (!acceptAll && confirm('Лента не найдена в списке? Показать все Bluetooth-устройства?')) return connect(true);
  }
  renderStatus();
}
function pushStateTo() {
  lastSent = ''; eng.cur = null;
  mgr.syncClock();
  mgr.power(S.power);
  if (S.power) { mgr.brightness(S.bright); restoreMode(); }
}
mgr.onReconnect = () => { toast('Связь восстановлена'); pushStateTo(); };
$('btnConnect').onclick = () => (mgr.anyConnected ? showTab('settings') : connect());
$('btnAddDevice').onclick = () => connect();
$('btnPower').onclick = () => setPower(!S.power);

function renderStatus() {
  const n = mgr.strips.filter(s => s.connected).length;
  $('statusDot').className = 'status-dot' + (n ? ' on' : '');
  $('statusText').textContent = n ? (n > 1 ? `${n} ленты` : mgr.strips.find(s => s.connected).name) : 'Подключить';
  $('devices').innerHTML = mgr.strips.length ? '' : '<p class="hint">Лента ещё не подключена.</p>';
  mgr.strips.forEach(s => {
    const d = document.createElement('div');
    d.className = 'device';
    d.innerHTML = `<div><b></b><small>${s.connected ? 'подключена · ' + s.variant.label : 'отключена'}</small></div><div><button data-a="re">${s.connected ? 'Откл.' : 'Подкл.'}</button> <button data-a="rm">✕</button></div>`;
    d.querySelector('b').textContent = s.name;
    d.querySelector('[data-a=re]').onclick = () => (s.connected ? s.disconnect() : s.connect().then(pushStateTo).catch(e => toast(e.message)));
    d.querySelector('[data-a=rm]').onclick = () => mgr.remove(s);
    $('devices').append(d);
  });
  const log = $('log');
  log.textContent = mgr.logLines.join('\n');
  log.scrollTop = log.scrollHeight;
}
mgr.on(renderStatus);

function renderPower() { $('btnPower').classList.toggle('on', S.power); }

function syncControls() {
  $('bright').value = S.bright; $('brightVal').textContent = S.bright + '%';
  $('speed').value = S.speed; $('speedVal').textContent = S.speed;
  $('sens').value = S.sens; $('sensVal').textContent = S.sens;
  $('floor').value = S.floor; $('floorVal').textContent = S.floor + '%';
  syncWheel();
}

// ---------- старт ----------
mgr.variantOverride = S.variant;
mgr.autoReconnect = S.autoReconnect;
if (!mgr.supported) $('unsupported').classList.remove('hidden');
if (S.mode === 'music') S.mode = 'color'; // микрофон нельзя включить без нажатия
drawWheel();
syncControls();
renderSwatches();
renderScenes();
renderActive();
renderTimers();
renderHwTimer();
renderPower();
renderStatus();
document.documentElement.style.setProperty('--live', toHex(S.rgb));

if ('serviceWorker' in navigator && location.protocol === 'https:' && !window.AndroidBle) navigator.serviceWorker.register('sw.js').catch(() => {});
