const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validatePluginManifest } = require('@wabs/plugin-sdk/manifest');
const plugin = require('../dist/index.js').default;
const metadata = require('../wa-plugin.json');
const pkg = require('../package.json');
const { harness } = require('./helpers.cjs');

test('package metadata matches the executable manifest', () => {
  assert.equal(validatePluginManifest(plugin.manifest), plugin.manifest);
  for (const key of ['pluginId', 'version', 'coreApiRange', 'messageNamespace', 'commands', 'eventSubscriptions', 'requiredPermissions',
    'dangerousActions', 'backgroundJobs', 'databases', 'dataVersion', 'assistant', 'help', 'cancellation']) {
    assert.deepEqual(plugin.manifest[key], metadata[key], key);
  }
  assert.equal(metadata.version, pkg.version);
  // Pack sticker conformance in the host needs core API 0.3.19.
  assert.equal(metadata.coreApiRange, '^0.3.19');
});

test('every default message has a non-empty pt-PT translation and no extras', () => {
  const pt = JSON.parse(fs.readFileSync(path.join(__dirname, '../locales/pt-PT', metadata.messageNamespace + '.json')));
  assert.deepEqual(Object.keys(pt).sort(), Object.keys(plugin.manifest.defaultMessages).sort());
  for (const [key, value] of Object.entries(pt)) {
    assert.ok(value.trim(), key);
    assert.doesNotMatch(value, /\bvocê\b/i, `${key} must address the reader as tu`);
  }
});

test('console metadata covers every config path', () => {
  const console = metadata.operatorConsole;
  const covered = [...console.controls, ...console.internalConfigPaths].map(entry => entry.path);
  assert.deepEqual([...new Set(covered)].sort(), [...console.configPaths].sort());
  assert.deepEqual([...console.configPaths].sort(), Object.keys(plugin.manifest.configSchema.parse({})).sort());
});

test('registered commands match the declared commands and are member-scoped', () => {
  const h = harness();
  plugin.registerCommands(h.context);
  assert.deepEqual([...h.handlers.keys()].map(key => '/' + key).sort(), [...plugin.manifest.commands].sort());
  for (const [key, { metadata: command }] of h.handlers) {
    assert.equal(command.pluginId, plugin.manifest.pluginId, key);
    assert.equal(command.requiresCurrentManagedGroupMembership, true, key);
    assert.equal(command.privateManagedTarget.mode, 'infer_group_or_community', key);
    assert.equal(command.permission, key === 'stickers forget' ? 'sticker-thief.manage' : undefined, key);
    assert.ok(plugin.manifest.defaultMessages[command.help.descriptionKey], key);
  }
});

test('migrations ship in the package', () => {
  assert.ok(pkg.files.includes('migrations'));
  assert.ok(fs.existsSync(path.join(__dirname, '..', plugin.manifest.databases[0].migrations, '001_init.sql')));
});
