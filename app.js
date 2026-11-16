'use strict';
// Protokoll: docs/ble-protokoll.md
const uuid = n => `7b1e000${n}-5c3a-4e6f-9a1d-b1e5ec710000`;
const SVC = uuid(1), CH_INPUT = uuid(2), CH_STATUS = uuid(3), CH_INFO = uuid(4), CH_OTA_CTRL = uuid(5), CH_OTA_DATA = uuid(6), CH_TRACE_CTRL = uuid(7), CH_TRACE_DATA = uuid(8);

const DEFAULT_PIN = '123456';  // Standard-PIN der Firmware; erst bei geänderter PIN erscheint die Abfrage
const HEARTBEAT_MS = 200;
const STATUS_TIMEOUT_MS = 1000;
const CHUNK = 196;  // plus 4 Byte Offset = 200 Byte pro Schreibzugriff

const $ = id => document.getElementById(id);
const keys = [...document.querySelectorAll('.key')];

let device = null, chInput, chStatus, chInfo, chCtrl, chData, chTraceCtrl, chTraceData;
let currentPin = ""; try { currentPin = localStorage.getItem("blesc.pin") || ""; } catch (e) {}
let loginBusy = false, loginFailed = false;
$("app-ver").textContent = typeof APP_VERSION === "string" ? APP_VERSION : "?";
let mask = 0, seq = 0, sending = false;
let lastStatusAt = 0, lastFlags = 0;
let updating = false;
let wakeLock = null;

// ---------- Anzeige ----------
function setRow(dot, text, state, label) {
  $('d-' + dot).className = 'dot ' + state;
  $('t-' + dot).textContent = label;
}

function render() {
  const connected = !!(device && device.gatt.connected);
  const alive = connected && (performance.now() - lastStatusAt) < STATUS_TIMEOUT_MS;
  const f = alive ? lastFlags : 0;

  if (!connected) setRow('ble', '', 'bad', 'getrennt');
  else if (!alive) setRow('ble', '', 'bad', 'keine Antwort');
  else setRow('ble', '', 'ok', 'verbunden');

  if (!alive) { setRow('bus', '', '', '–'); setRow('aux', '', '', '–'); }
  else {
    if (!(f & 1)) setRow('bus', '', 'bad', 'Adresse nicht belegt');
    else if (!(f & 2)) setRow('bus', '', 'warn', 'Adresse belegt, kein Terminal');
    else setRow('bus', '', 'ok', 'Adresse belegt, Terminal gefunden');

    if (f & 16) setRow('aux', '', 'warn', 'Update läuft');
    else if (!(f & 4)) setRow('aux', '', f & 2 ? 'warn' : '', f & 2 ? 'Object Pool wird geladen' : '–');
    else if (!(f & 8)) setRow('aux', '', 'warn', 'Pool geladen, Tasten nicht zugeordnet');
    else setRow('aux', '', 'ok', 'aktiv');
  }

  const alert = $('alert');
  if (connected && !alive) { alert.textContent = 'ESP32 antwortet nicht'; alert.hidden = false; }
  else if (!connected && device) { alert.textContent = 'Verbindung getrennt'; alert.hidden = false; }
  else alert.hidden = true;

  const authed = !!(f & 32);
  $("login").hidden = !(alive && !authed && !updating);
  const usable = alive && authed && !updating && !(f & 16);
  keys.forEach(k => { k.disabled = !usable; });
  if (!usable && mask) { mask = 0; keys.forEach(k => k.classList.remove('active')); }
  $("update").disabled = !connected || updating;
  $("fw-install").disabled = !connected || updating;
  $('setpin').disabled = !connected || updating;
  $('connect').textContent = connected ? 'Trennen' : 'Verbinden';
}
setInterval(render, 200);

// ---------- Tasten ----------
function setBit(bit, on) {
  const m = on ? (mask | (1 << bit)) : (mask & ~(1 << bit));
  if (m === mask) return;
  mask = m;
  sendInput();
}

keys.forEach(k => {
  const bit = +k.dataset.bit;
  k.addEventListener('pointerdown', e => {
    if (k.disabled) return;
    k.setPointerCapture(e.pointerId);
    k.classList.add('active');
    setBit(bit, true);
    if (navigator.vibrate) navigator.vibrate(20);
  });
  const up = () => { k.classList.remove('active'); setBit(bit, false); };
  k.addEventListener('pointerup', up);
  k.addEventListener('pointercancel', up);
  k.addEventListener('lostpointercapture', up);
  k.addEventListener('contextmenu', e => e.preventDefault());
});

async function sendInput() {
  if (!chInput || !device || !device.gatt.connected || updating) return;
  if (sending) return;  // nächster Heartbeat sendet den aktuellen Stand
  sending = true;
  try {
    await chInput.writeValueWithoutResponse(new Uint8Array([mask, seq++ & 0xff]));
  } catch (e) { /* Verbindung weg oder Gerät beschäftigt, Heartbeat versucht es erneut */ }
  sending = false;
}
setInterval(sendInput, HEARTBEAT_MS);

// ---------- Verbindung ----------
async function connect() {
  if (!navigator.bluetooth) { alert('Web Bluetooth wird von diesem Browser nicht unterstützt. Bitte Chrome auf Android verwenden.'); return; }
  if (!device) {
    device = await navigator.bluetooth.requestDevice({ filters: [{ services: [SVC] }] });
    device.addEventListener('gattserverdisconnected', onDisconnected);
  }
  await openGatt();
}

async function openGatt() {
  const server = await device.gatt.connect();
  const svc = await server.getPrimaryService(SVC);
  chInput = await svc.getCharacteristic(CH_INPUT);
  chStatus = await svc.getCharacteristic(CH_STATUS);
  chInfo = await svc.getCharacteristic(CH_INFO);
  chCtrl = await svc.getCharacteristic(CH_OTA_CTRL);
  chData = await svc.getCharacteristic(CH_OTA_DATA);
  chTraceCtrl = await svc.getCharacteristic(CH_TRACE_CTRL);
  chTraceData = await svc.getCharacteristic(CH_TRACE_DATA);

  chStatus.addEventListener('characteristicvaluechanged', e => {
    const v = e.target.value;
    if (v.byteLength >= 2) { lastFlags = v.getUint8(1); lastStatusAt = performance.now(); }
  });
  chCtrl.addEventListener("characteristicvaluechanged", onCtrl);
  chTraceCtrl.addEventListener("characteristicvaluechanged", onTraceCtrl);
  chTraceData.addEventListener("characteristicvaluechanged", onTraceData);
  await chStatus.startNotifications();
  await chCtrl.startNotifications();
  await chTraceCtrl.startNotifications();
  await chTraceData.startNotifications();
  lastStatusAt = performance.now();
  try { $("fw-ver").textContent = $("fw-ver2").textContent = new TextDecoder().decode(await chInfo.readValue()); } catch (e) {}
  requestWakeLock();
  login(currentPin || DEFAULT_PIN, true);  // ohne gespeicherte PIN zuerst die Standard-PIN probieren
}

function onDisconnected() {
  lastFlags = 0;
  mask = 0;
  render();
  if (!updating) autoReconnect();
}

let reconnecting = false;
async function autoReconnect(maxSeconds = 60) {
  if (reconnecting || !device) return false;
  reconnecting = true;
  const end = Date.now() + maxSeconds * 1000;
  while (Date.now() < end && !device.gatt.connected) {
    try { await openGatt(); reconnecting = false; return true; }
    catch (e) { await sleep(1500); }
  }
  reconnecting = false;
  return device.gatt.connected;
}

$('connect').addEventListener('click', async () => {
  try {
    if (device && device.gatt.connected) { const d = device; device = null; d.gatt.disconnect(); render(); return; }
    await connect();
  } catch (e) { if (e.name !== 'NotFoundError') $('fw-msg').textContent = 'Verbindung fehlgeschlagen: ' + e.message; }
});

async function requestWakeLock() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && device && device.gatt.connected) requestWakeLock(); });

// ---------- Firmware-Update ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ctrlWaiters = [];
let progressBytes = 0;

function onCtrl(e) {
  const v = new Uint8Array(e.target.value.buffer.slice(e.target.value.byteOffset, e.target.value.byteOffset + e.target.value.byteLength));
  if (v[0] === 0x20) { progressBytes = new DataView(v.buffer).getUint32(2, true); return; }
  ctrlWaiters = ctrlWaiters.filter(w => { if (w.cmd === v[0]) { w.resolve(v); return false; } return true; });
  // Abbruchmeldung des ESP32 während der Übertragung
  if (updating && v[0] === 0x12 && v[1] !== 0) updateFailed = 'ESP32 hat das Update abgebrochen (Code ' + v[1] + ')';
}
let updateFailed = null;

function ctrl(cmd, payload = [], timeout = 5000) {
  const wait = new Promise((resolve, reject) => {
    const w = { cmd, resolve };
    ctrlWaiters.push(w);
    setTimeout(() => { ctrlWaiters = ctrlWaiters.filter(x => x !== w); reject(new Error('Keine Antwort des ESP32')); }, timeout);
  });
  return chCtrl.writeValueWithResponse(new Uint8Array([cmd, ...payload])).then(() => wait);
}

const enc = new TextEncoder();
async function sha256(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
}

const RESULT = { 1: 'ungültig', 2: 'PIN falsch bzw. nicht berechtigt', 3: 'ESP32 beschäftigt', 4: 'Flash-Fehler', 5: 'Prüfsumme stimmt nicht', 6: 'zu viele Fehlversuche, bitte 30 s warten' };
function check(v, what) { if (v[1] !== 0) throw new Error(what + ': ' + (RESULT[v[1]] || 'Fehler ' + v[1])); }

async function authenticate(pin) {
  const n = await ctrl(0x01);
  const nonce = n.slice(2, 18);
  const pinBytes = enc.encode(pin);
  const proof = await sha256(nonce, pinBytes);
  check(await ctrl(0x02, proof), 'Anmeldung');
  return { nonce, pinBytes };
}

const msg = t => { $('fw-msg').textContent = t; };

async function runUpdate(getData) {
  const pin = currentPin;
  if (!pin) return msg('Bitte zuerst oben mit der PIN anmelden.');
  const prog = $('prog');
  updating = true; updateFailed = null; mask = 0; render();
  prog.hidden = false; prog.value = 0;
  try {
    const data = await getData();
    msg('Anmelden …');
    await authenticate(pin);
    const hash = await sha256(data);
    const size = new Uint8Array(4); new DataView(size.buffer).setUint32(0, data.length, true);
    msg('Übertragung startet …');
    check(await ctrl(0x10, [...size, ...hash]), 'Start');

    const pkt = new Uint8Array(4 + CHUNK);
    for (let off = 0; off < data.length; off += CHUNK) {
      if (updateFailed) throw new Error(updateFailed);
      const part = data.subarray(off, off + CHUNK);
      new DataView(pkt.buffer).setUint32(0, off, true);
      pkt.set(part, 4);
      await chData.writeValueWithResponse(pkt.subarray(0, 4 + part.length));
      prog.value = Math.round(100 * (off + part.length) / data.length);
      if ((off / CHUNK) % 20 === 0) msg(`Übertragung ${prog.value} % (ESP32 bestätigt ${Math.round(progressBytes / 1024)} KB)`);
    }
    msg('Prüfen und installieren …');
    check(await ctrl(0x11, [], 15000), 'Installation');
    msg('Installiert. ESP32 startet neu …');
    await sleep(2500);
    const ok = await autoReconnect(40);
    updating = false;
    msg(ok ? `Update erfolgreich. Neue Version: ${$('fw-ver').textContent}` : 'Update installiert, aber ESP32 meldet sich nicht zurück. Bitte erneut verbinden.');
  } catch (e) {
    updating = false;
    msg('Update fehlgeschlagen: ' + e.message);
    try { if (device.gatt.connected) await ctrl(0x12); } catch (_) {}
  } finally {
    prog.hidden = true;
    updating = false;
    render();
  }
}

$('update').addEventListener('click', () => {
  const file = $('file').files[0];
  if (!file) return msg('Bitte eine Firmware-Datei wählen.');
  runUpdate(async () => new Uint8Array(await file.arrayBuffer()));
});

$('setpin').addEventListener('click', async () => {
  const oldPin = currentPin, newPin = $('newpin').value;
  if (!oldPin) return msg('Bitte zuerst oben mit der PIN anmelden.');
  if (newPin.length < 4 || newPin.length > 16) return msg('Neue PIN: 4 bis 16 Zeichen.');
  try {
    const { nonce, pinBytes } = await authenticate(oldPin);
    const key = await sha256(new Uint8Array([0x50]), nonce, pinBytes);
    const nb = enc.encode(newPin);
    const x = nb.map((b, i) => b ^ key[i]);
    check(await ctrl(0x03, [nb.length, ...x]), 'PIN ändern');
    $('newpin').value = '';
    savePin(newPin);
    msg('PIN geändert.');
  } catch (e) { msg('PIN ändern fehlgeschlagen: ' + e.message); }
});


// ---------- Online-Update: Firmware von der App-Adresse (GitHub Pages) laden ----------
let onlineFw = null;      // Inhalt der firmware.json, wenn neuer als installiert
let loadedFw = null;      // geladene und geprüfte Firmware (Bytes)
const fmsg = t => { $('fw-online-msg').textContent = t; };

function verParts(v) { return String(v).split('.').map(n => parseInt(n, 10) || 0); }
function isNewer(a, b) {
  const x = verParts(a), y = verParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}
const toHex = u8 => Array.from(u8, b => b.toString(16).padStart(2, '0')).join('');

$('fw-check').addEventListener('click', async () => {
  onlineFw = null; loadedFw = null;
  $('fw-fetch').hidden = true; $('fw-install').hidden = true;
  fmsg('Suche …');
  try {
    const r = await fetch('firmware/firmware.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('keine Firmware-Info gefunden (HTTP ' + r.status + ')');
    const info = await r.json();
    const installed = $('fw-ver').textContent;
    if (installed === '–') { fmsg(`Veröffentlicht: ${info.version}. Zum Vergleichen zuerst mit dem ESP32 verbinden.`); return; }
    if (!isNewer(info.version, installed)) { fmsg(`Aktuell: installiert ${installed}, veröffentlicht ${info.version}.`); return; }
    onlineFw = info;
    fmsg(`Update verfügbar: ${installed} → ${info.version} (${Math.round(info.size / 1024)} KB)`);
    $('fw-fetch').hidden = false;
    $('fw-fetch').textContent = `Firmware ${info.version} laden`;
  } catch (e) { fmsg('Suche fehlgeschlagen: ' + e.message); }
});

$('fw-fetch').addEventListener('click', async () => {
  if (!onlineFw) return;
  fmsg('Lade Firmware …');
  try {
    const r = await fetch('firmware/' + (onlineFw.file || 'firmware.bin'), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = new Uint8Array(await r.arrayBuffer());
    if (data.length !== onlineFw.size) throw new Error('Größe stimmt nicht');
    if (toHex(await sha256(data)) !== onlineFw.sha256) throw new Error('Prüfsumme stimmt nicht');
    loadedFw = { data, version: onlineFw.version };
    fmsg(`Firmware ${onlineFw.version} geladen und geprüft. Sie kann jetzt auch ohne Internet installiert werden.`);
    $('fw-fetch').hidden = true;
    $('fw-install').hidden = false;
    $('fw-install').textContent = `Firmware ${onlineFw.version} installieren`;
  } catch (e) { fmsg('Laden fehlgeschlagen: ' + e.message); }
});

$('fw-install').addEventListener('click', () => {
  if (!loadedFw) return;
  const fw = loadedFw;
  runUpdate(async () => fw.data);
});

// ---------- PIN-Anmeldung (Tasten und Update nur für angemeldete Handys) ----------
function savePin(pin) {
  currentPin = pin;
  try { localStorage.setItem('blesc.pin', pin); } catch (e) {}
}

async function login(pin, silent) {
  if (loginBusy || !chCtrl) return;
  loginBusy = true;
  try {
    await authenticate(pin);
    savePin(pin);
    $('loginpin').value = '';
    msg('');
  } catch (e) {
    if (silent) { try { localStorage.removeItem('blesc.pin'); } catch (_) {} currentPin = ''; }
    $('alert').textContent = 'Anmeldung fehlgeschlagen: ' + e.message;
    $('alert').hidden = false;
  }
  loginBusy = false;
}
$('loginbtn').addEventListener('click', () => { const p = $('loginpin').value; if (p) login(p, false); });
$('loginpin').addEventListener('keydown', e => { if (e.key === 'Enter') $('loginbtn').click(); });

// ---------- CAN-Diagnose: Trace herunterladen ----------
const FRAME_SIZE = 18, EVENT_SIZE = 80;
const dmsg = t => { $('diag-msg').textContent = t; };
let trace = null;

const bytesOf = e => new Uint8Array(e.target.value.buffer.slice(e.target.value.byteOffset, e.target.value.byteOffset + e.target.value.byteLength));

function onTraceCtrl(e) {
  const v = bytesOf(e);
  if (!trace) return;
  const dv = new DataView(v.buffer);
  if (v[0] === trace.cmd && !trace.started) {
    trace.started = true;
    if (v[1] !== 0) trace.fail(new Error(RESULT[v[1]] || 'Fehler ' + v[1]));
    else { trace.count = dv.getUint32(2, true); trace.startOk(); }
  } else if (v[0] === 0x04) {
    trace.done({ result: v[1], bytes: dv.getUint32(2, true), crc: dv.getUint32(6, true), lost: dv.getUint32(10, true) });
  }
}

function onTraceData(e) {
  if (!trace || !trace.started) return;
  const v = bytesOf(e);
  if (v[0] !== (trace.seq & 0xff)) { trace.gap = true; trace.seq = v[0]; }
  trace.seq++;
  trace.chunks.push(v.subarray(1));
  trace.bytes += v.length - 1;
  trace.touch = performance.now();
  if (trace.bytes - trace.acked >= 2048) {
    trace.acked = trace.bytes;
    const a = new Uint8Array(5); a[0] = 0x06; new DataView(a.buffer).setUint32(1, trace.bytes, true);
    chTraceCtrl.writeValueWithoutResponse(a).catch(() => {});
  }
  if (trace.total) $('tprog').value = Math.min(100, Math.round(100 * trace.bytes / trace.total));
}

function crc32(parts) {
  const table = crc32.t || (crc32.t = Array.from({ length: 256 }, (_, i) => { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; }));
  let c = 0xFFFFFFFF;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = table[(c ^ p[i]) & 0xFF] ^ (c >>> 8);
  return (~c) >>> 0;
}

async function downloadStream(cmd, recSize) {
  let startOk, done, fail;
  const startP = new Promise((res, rej) => { startOk = res; fail = rej; });
  const doneP = new Promise(res => { done = res; });
  const t = trace = { cmd, started: false, chunks: [], bytes: 0, acked: 0, seq: 0, gap: false, total: 0, count: 0, touch: performance.now(), startOk, done, fail };
  try {
    await chTraceCtrl.writeValueWithResponse(new Uint8Array([cmd]));
    await Promise.race([startP, sleep(5000).then(() => { throw new Error('Keine Antwort des ESP32'); })]);
    t.total = t.count * recSize;
    t.touch = performance.now();
    // Abbruch, wenn 8 s keine Daten mehr kommen
    const watchdog = new Promise((_, rej) => { t.timer = setInterval(() => { if (performance.now() - t.touch > 8000) rej(new Error('Übertragung hängt (keine Daten mehr)')); }, 1000); });
    const end = await Promise.race([doneP, watchdog]);
    if (end.bytes !== t.bytes || t.gap || crc32(t.chunks) !== end.crc) throw new Error('Prüfsumme/Länge stimmt nicht (Funkstörung?)');
    const buf = new Uint8Array(t.bytes);
    let o = 0; for (const c of t.chunks) { buf.set(c, o); o += c.length; }
    return { buf, lost: end.lost, count: t.count };
  } finally {
    clearInterval(t.timer);
    trace = null;
  }
}

function saveFile(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const hex2 = b => b.toString(16).toUpperCase().padStart(2, '0');
function toAsc(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const now = new Date();
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const h12 = now.getHours() % 12 || 12, ampm = now.getHours() < 12 ? 'am' : 'pm';
  const p2 = n => String(n).padStart(2, '0');
  const lines = [`date ${days[now.getDay()]} ${mons[now.getMonth()]} ${now.getDate()} ${p2(h12)}:${p2(now.getMinutes())}:${p2(now.getSeconds())}.000 ${ampm} ${now.getFullYear()}`,
    'base hex  timestamps absolute', 'internal events logged', '// version 9.0.0', '// Zeitstempel: Sekunden seit Start des ESP32'];
  for (let o = 0; o + FRAME_SIZE <= buf.length; o += FRAME_SIZE) {
    const ts = dv.getUint32(o, true) / 10000;
    const id = dv.getUint32(o + 4, true);
    const flags = buf[o + 8], dlc = Math.min(buf[o + 9], 8);
    const idStr = id.toString(16).toUpperCase() + (flags & 2 ? 'x' : '');
    const data = Array.from(buf.subarray(o + 10, o + 10 + dlc), hex2).join(' ');
    lines.push(`${ts.toFixed(6).padStart(12)} 1  ${idStr.padEnd(15)}${flags & 1 ? 'Tx' : 'Rx'}   d ${dlc}${data ? ' ' + data : ''}`);
  }
  return lines.join('\r\n') + '\r\n';
}

function eventsToText(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const dec = new TextDecoder();
  const lines = [`# BleSectionControl Ereignislog, App ${APP_VERSION}, Firmware ${$('fw-ver').textContent}`];
  for (let o = 0; o + EVENT_SIZE <= buf.length; o += EVENT_SIZE) {
    const ms = dv.getUint32(o, true);
    let t = buf.subarray(o + 4, o + EVENT_SIZE); const z = t.indexOf(0); if (z >= 0) t = t.subarray(0, z);
    lines.push(`${(ms / 1000).toFixed(3).padStart(10)} s  ${dec.decode(t)}`);
  }
  return lines.join('\r\n') + '\r\n';
}

async function runDownload(kind) {
  if (!chTraceCtrl || !device || !device.gatt.connected) return dmsg('Nicht verbunden.');
  if (!(lastFlags & 32)) return dmsg('Bitte zuerst mit der PIN anmelden.');
  const buttons = [$('dl-trace'), $('dl-events')];
  buttons.forEach(b => { b.disabled = true; });
  const prog = $('tprog'); prog.hidden = false; prog.value = 0;
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        dmsg(attempt === 1 ? 'Übertragung läuft …' : `Übertragung läuft (Versuch ${attempt}) …`);
        const r = kind === 'trace' ? await downloadStream(0x02, FRAME_SIZE) : await downloadStream(0x03, EVENT_SIZE);
        const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
        const lostTxt = r.lost ? `, ${r.lost} ältere Einträge waren schon überschrieben` : '';
        if (kind === 'trace') { saveFile(`can-trace-${stamp}.asc`, toAsc(r.buf)); dmsg(`${r.count} Frames gespeichert${lostTxt}.`); }
        else { saveFile(`ereignislog-${stamp}.txt`, eventsToText(r.buf)); dmsg(`${r.count} Ereignisse gespeichert${lostTxt}.`); }
        break;
      } catch (e) {
        try { await chTraceCtrl.writeValueWithResponse(new Uint8Array([0x05])); } catch (_) {}
        if (attempt >= 3 || /Anmeld|berechtigt|beschäftigt/.test(e.message)) { dmsg('Download fehlgeschlagen: ' + e.message); break; }
        await sleep(500);
      }
    }
  } finally {
    prog.hidden = true;
    buttons.forEach(b => { b.disabled = false; });
  }
}
$('dl-trace').addEventListener('click', () => runDownload('trace'));
$('dl-events').addEventListener('click', () => runDownload('events'));

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
render();
