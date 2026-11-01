const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.argv[2]);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'wa-plugin.json')));
const plugin = require(path.join(root, manifest.entrypoint)).default;
assert.equal(plugin.manifest.pluginId, manifest.pluginId);
assert.equal(plugin.manifest.version, manifest.version);
assert.equal(plugin.manifest.coreApiRange, manifest.coreApiRange);
assert.equal(typeof plugin.registerHooks, 'function');
assert.equal(typeof plugin.registerCommands, 'function');
const pt = JSON.parse(fs.readFileSync(path.join(root, 'locales/pt-PT', manifest.messageNamespace + '.json')));
for (const key of Object.keys(plugin.manifest.defaultMessages)) assert.ok(pt[key]?.trim(), key);
for (const database of manifest.databases) assert.ok(fs.readdirSync(path.join(root, database.migrations)).length, database.name);
assert.ok(fs.existsSync(path.join(root, 'node_modules/@wabs/plugin-sdk/dist/managed-group-plugin.js')));
assert.ok(fs.existsSync(path.join(root, 'node_modules/zod/LICENSE')));
console.log(JSON.stringify({ pluginId: manifest.pluginId, version: manifest.version, standaloneLoad: true, translations: Object.keys(pt).length }));
