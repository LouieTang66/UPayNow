'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..', 'contracts');
function buildInput(base = root) {
  const sources = {};
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.name.endsWith('.sol')) {
        sources[path.relative(base, absolute).split(path.sep).join('/')] = {
          content: fs.readFileSync(absolute, 'utf8'),
        };
      }
    }
  }
  walk(path.join(base, 'src'));
  walk(path.join(base, 'lib'));
  return {
    language: 'Solidity', sources,
    settings: JSON.parse(fs.readFileSync(path.join(base, 'settings.json'), 'utf8')),
  };
}
if (require.main === module) {
  const input = buildInput();
  fs.writeFileSync(path.join(root, 'standard-json-input.json'), JSON.stringify(input, null, 2) + '\n');
  console.log(`Standard JSON generated: ${Object.keys(input.sources).length} Solidity sources; settings at top level`);
}
module.exports = { buildInput };
