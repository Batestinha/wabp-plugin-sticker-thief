// Writes wa-plugin.json from the compiled manifest so package metadata (read
// before plugin code is loaded) cannot drift from the runtime manifest.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { stickerThiefManifest: m } = require('../dist/manifest.js');
const { stickerThiefControls, stickerThiefConfigPaths } = require('../dist/controls.js');
const pkg = require('../package.json');

const metadata = {
  schemaVersion: 1,
  pluginId: m.pluginId,
  name: 'Sticker Thief',
  description: pkg.description,
  kind: m.kind,
  version: m.version,
  coreApiRange: m.coreApiRange,
  entrypoint: 'dist/index.js',
  messageNamespace: m.messageNamespace,
  descriptionKey: m.descriptionKey,
  commands: m.commands,
  help: m.help,
  eventSubscriptions: m.eventSubscriptions,
  requiredPermissions: m.requiredPermissions,
  requiredBotCapabilities: m.requiredBotCapabilities,
  dangerousActions: m.dangerousActions,
  backgroundJobs: m.backgroundJobs,
  databases: m.databases,
  dataVersion: m.dataVersion,
  cancellation: m.cancellation,
  dependencies: m.dependencies,
  assistant: m.assistant,
  operatorConsole: {
    configPaths: stickerThiefConfigPaths(),
    controls: stickerThiefControls.map(c => ({ pluginId: m.pluginId, ...c })),
    internalConfigPaths: []
  }
};
fs.writeFileSync(path.join(root, 'wa-plugin.json'), JSON.stringify(metadata, null, 2) + '\n');
console.log('wrote wa-plugin.json', m.pluginId, m.version);
