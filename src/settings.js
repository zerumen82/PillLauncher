import { Store } from '@tauri-apps/plugin-store';

const DEFAULTS = {
  editor_font_size: 12,
  console_font_size: 11,
  debug_port: 5005,
  debug_suspend: true,
  breakpoints: {},
  recent: [],
  last_project: '',
  project_order: [],
};

let store = null;
let cache = { ...DEFAULTS };
let ready = false;
const listeners = [];

async function init() {
  if (store) return;
  store = await Store.load('settings.json');
  for (const key of Object.keys(DEFAULTS)) {
    const val = await store.get(key);
    if (val !== undefined && val !== null) {
      cache[key] = val;
    }
  }
  ready = true;
  listeners.forEach(fn => fn());
  listeners.length = 0;
}

async function get(key) {
  if (!ready) await init();
  return cache[key] ?? DEFAULTS[key];
}

async function set(key, value) {
  cache[key] = value;
  if (!store) await init();
  await store.set(key, value);
  await store.save();
}

async function getAll() {
  if (!ready) await init();
  return { ...cache };
}

function onReady(fn) {
  if (ready) { fn(); return; }
  listeners.push(fn);
}

export default { init, get, getAll, set, onReady, DEFAULTS };
