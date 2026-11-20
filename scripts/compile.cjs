'use strict';
const fs = require('node:fs');
const path = require('node:path');
const solc = require('solc');
const { buildInput } = require('./build-input.cjs');

const SOLC_VERSION = '0.8.38';
const SOLC_LONG_VERSION = '0.8.38+commit.1835d247';

function compileInput(input) {
  const version = solc.version();
  if (version.split('.Emscripten')[0] !== SOLC_LONG_VERSION) {
    throw new Error(`Expected ${SOLC_LONG_VERSION}; installed compiler is ${version}`);
  }
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter(e => e.severity === 'error');
  if (errors.length) throw new Error(errors.map(e => e.formattedMessage).join('\n'));
  return output;
}

function compileProduction() {
  const input = buildInput();
  const checkedIn = JSON.parse(fs.readFileSync(path.join(__dirname, '../contracts/standard-json-input.json'), 'utf8'));
  // Never build/deploy silently from a stale exported source snapshot.
  require('node:assert/strict').deepEqual(checkedIn, input,
    'standard-json-input.json is stale; run npm run build:input and review the result');
  return { input, output: compileInput(input) };
}

module.exports = { SOLC_VERSION, SOLC_LONG_VERSION, compileInput, compileProduction };
