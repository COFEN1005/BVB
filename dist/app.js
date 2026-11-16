import { defaults, settingsFrom, timingBounds, payloadFor, MAX_BYTES, isPhrase, normalizePhrase, PhraseGate } from './core.js';
import { Bridge } from './transport.js';
const $ = id => document.getElementById(id);
const storageKey = 'bvb.settings.v2';
let settings = { ...defaults }, composing = false, phraseTimer;
try { settings = settingsFrom(JSON.parse(localStorage.getItem(storageKey))); } catch { /* usable without storage */ }
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const theme = settings.theme || (systemTheme.matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#111918' : '#f7f9fc';
}
applyTheme(); systemTheme.addEventListener('change', () => { if (!settings.theme) applyTheme(); });
function save() {
  try { localStorage.setItem(storageKey, JSON.stringify(settings)); return true; }
  catch { message('設定を保存できません。この画面でのみ有効です', true); return false; }
}
function message(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
const gate = new PhraseGate();
const bridge = new Bridge(() => { clearTimeout(phraseTimer); update(); observePhrase(); }, text => message(text));
function configured() { return !!settings.os && !!settings.layout; }
function eligible() { return bridge.ready && !bridge.busy && !bridge.connecting && configured() && !document.hidden && !$('settings').open; }
function observePhrase() { gate.observe($('text').value, isPhrase($('text').value, settings), eligible(), composing); }
function update() {
  const text = $('text').value;
  let size = 0, error = '';
  try { size = payloadFor(settings.target, text, settings.os).length; } catch (e) { error = e.message; }
  $('count').textContent = `${[...text].length}文字`;
  $('capacity').textContent = error || `${size} / ${MAX_BYTES} B`;
  $('capacity').classList.toggle('over', !!error || size > MAX_BYTES);
  const blocked = !bridge.ready || bridge.busy || !configured() || composing;
  $('chrome').disabled = blocked;
  $('send').disabled = blocked || !!error || size === 0 || size > MAX_BYTES;
  $('clear').disabled = bridge.busy || !text;
  $('enter').disabled = bridge.busy;
  $('settings-fields').disabled = bridge.busy;
  $('connect').disabled = bridge.busy || bridge.connecting;
  $('connect').classList.toggle('connected', bridge.ready);
  $('connection-label').textContent = bridge.connecting ? '接続中' : bridge.busy ? '処理中' : bridge.ready ? '接続済み' : '未接続';
  $('connect').setAttribute('aria-label', bridge.ready ? 'ESP32から切断' : 'ESP32に接続');
}
async function execute(kind) {
  if (!eligible() || composing) return;
  clearTimeout(phraseTimer);
  try {
    const bytes = payloadFor(kind, $('text').value, settings.os);
    message('ESP32へ送信中');
    await bridge.execute(kind, bytes, { ...settings });
    message('HIDキー操作を送出。PCを確認してください');
  } catch (error) { message(error.message, true); }
  update();
}
function schedulePhrase() {
  clearTimeout(phraseTimer); observePhrase();
  if (composing || !eligible()) return;
  const snapshot = $('text').value;
  phraseTimer = setTimeout(() => {
    if ($('text').value !== snapshot) return;
    if (gate.take(snapshot, isPhrase(snapshot, settings), eligible(), composing)) void execute('open');
  }, 1200);
}
$('text').addEventListener('input', () => { update(); schedulePhrase(); });
$('text').addEventListener('compositionstart', () => { composing = true; clearTimeout(phraseTimer); update(); });
$('text').addEventListener('compositionend', () => { composing = false; update(); schedulePhrase(); });
document.addEventListener('visibilitychange', () => { clearTimeout(phraseTimer); observePhrase(); });
window.addEventListener('pagehide', () => { clearTimeout(phraseTimer); bridge.disconnect(); });
$('chrome').addEventListener('click', () => {
  if (isPhrase($('text').value, settings)) gate.attempted = true;
  void execute('open');
});
$('send').addEventListener('click', () => {
  if (isPhrase($('text').value, settings)) {
    if (gate.take($('text').value, true, eligible(), composing)) void execute('open');
    else message('合言葉は実行済みです。再実行にはクリアしてください');
    return;
  }
  void execute(settings.target);
});
$('clear').addEventListener('click', () => { $('text').value = ''; message(''); update(); schedulePhrase(); $('text').focus(); });
$('enter').checked = settings.enter;
$('enter').addEventListener('change', () => { settings.enter = $('enter').checked; save(); });
$('connect').addEventListener('click', async () => {
  clearTimeout(phraseTimer);
  if (bridge.ready) { bridge.disconnect(); message('切断しました'); return; }
  try { await bridge.connect(); message(configured() ? '接続しました' : '設定で対象PCと配列を選択してください'); }
  catch (e) { message(e.message || '接続できませんでした', true); }
});
const fields = { os: 'os', layout: 'layout', theme: 'theme', target: 'target', phrase: 'phrase',
  shortcutMs: 'shortcut-ms', launchMs: 'launch-ms', focusMs: 'focus-ms', keyMs: 'key-ms' };
$('settings-open').addEventListener('click', () => {
  clearTimeout(phraseTimer);
  for (const [key, id] of Object.entries(fields)) $(id).value = key === 'theme' ? document.documentElement.dataset.theme : settings[key];
  $('phrase-enabled').checked = settings.phraseEnabled;
  $('settings-message').textContent = '';
  $('settings').showModal(); observePhrase();
});
$('settings-close').addEventListener('click', () => $('settings').close());
$('settings-form').addEventListener('submit', event => {
  event.preventDefault();
  if (bridge.busy) return;
  const next = { ...settings, phraseEnabled: $('phrase-enabled').checked };
  for (const [key, id] of Object.entries(fields)) next[key] = key in timingBounds ? Number($(id).value) : $(id).value;
  if (!normalizePhrase(next.phrase)) { $('settings-message').textContent = '合言葉を入力してください'; return; }
  settings = settingsFrom(next); save(); applyTheme(); $('settings').close(); update(); observePhrase();
});
update();
