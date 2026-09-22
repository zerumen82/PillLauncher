import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
assert.notEqual(conf.app.security.csp, null, 'CSP must not be null');
assert.ok(conf.app.security.csp.includes("default-src 'self'"), 'CSP must default to self');
assert.equal(conf.app.security.assetProtocol.enable, false, 'assetProtocol must be disabled');

const caps = JSON.parse(read('src-tauri/capabilities/default.json'));
const perms = caps.permissions.map(p => (typeof p === 'string' ? p : p.identifier));
assert.ok(!perms.some(p => p.startsWith('fs:')), `no fs:* permissions, got: ${perms}`);
assert.ok(!perms.some(p => p.startsWith('shell:')), `no shell:* permissions, got: ${perms}`);

const mainRs = read('src-tauri/src/main.rs');
for (const needle of ['fn debug_attach', 'fn debug_cmd', 'fn ensure_allowed', 'fn register_root']) {
  assert.ok(mainRs.includes(needle), `main.rs must contain ${needle}`);
}
assert.ok(!mainRs.includes('tauri_plugin_shell'), 'shell plugin must not be registered');

const cargo = read('src-tauri/Cargo.toml');
assert.ok(!cargo.includes('tauri-plugin-shell'), 'Cargo.toml must not depend on tauri-plugin-shell');
assert.ok(!cargo.includes('tauri-plugin-fs'), 'Cargo.toml must not depend on tauri-plugin-fs');

const pkg = JSON.parse(read('package.json'));
assert.ok(!pkg.dependencies['@tauri-apps/plugin-shell'], 'package.json must not depend on plugin-shell');
assert.ok(pkg.scripts.test?.includes('node --test'), 'package.json test script must use node --test');
assert.ok(pkg.scripts.lint, 'package.json must define lint script');

const indexHtml = read('index.html');
assert.ok(!/<script>(?!<\/script>)/.test(indexHtml.replace(/\s/g, '')) || !indexHtml.includes('<script>console'), 'index.html must not contain inline debug script');

const mainJsx = read('src/main.jsx');
assert.ok(!mainJsx.includes('document.body.innerHTML'), 'main.jsx must not use document.body.innerHTML');
assert.ok(mainJsx.includes('relativeTo(ws.path, f)'), 'git badges must be keyed by relative path');

console.log('config regression tests passed');
