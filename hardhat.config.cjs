const { task } = require('hardhat/config');
const { TASK_COMPILE } = require('hardhat/builtin-tasks/task-names');
const { buildInput } = require('./scripts/build-input.cjs');
const { SOLC_VERSION, SOLC_LONG_VERSION, compileProduction } = require('./scripts/compile.cjs');

// One canonical local-solc pipeline for standard JSON, tests and deployable
// Hardhat artifacts. The default Hardhat resolver does not honor our vendored
// source/remapping layout, so do not fall back to a second compiler pipeline.
task(TASK_COMPILE).setAction(async ({ quiet }, hre) => {
  const { input, output } = compileProduction();
  if (!quiet) {
    for (const warning of output.errors || []) console.warn(warning.formattedMessage);
  }
  const buildInfo = await hre.artifacts.saveBuildInfo(SOLC_VERSION, SOLC_LONG_VERSION, input, output);
  let count = 0;
  for (const [sourceName, contracts] of Object.entries(output.contracts)) {
    for (const [contractName, contract] of Object.entries(contracts)) {
      await hre.artifacts.saveArtifactAndDebugFile({
        _format: 'hh-sol-artifact-1', contractName, sourceName, abi: contract.abi,
        bytecode: `0x${contract.evm.bytecode.object}`,
        deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
        linkReferences: contract.evm.bytecode.linkReferences,
        deployedLinkReferences: contract.evm.deployedBytecode.linkReferences,
      }, buildInfo);
      ++count;
    }
  }
  if (!quiet) console.log(`Compiled ${Object.keys(input.sources).length} sources into ${count} Hardhat artifacts with ${SOLC_LONG_VERSION}; canonical settings.json`);
});

// Hardhat's native resolver cannot consume remappings. The compile task above
// passes the complete canonical settings (including remappings) to local solc.
const { remappings: _remappings, ...hardhatSettings } = buildInput().settings;
module.exports = {
  solidity: { version: SOLC_VERSION, settings: hardhatSettings },
  // Local-only verification; no public network/account/private key configured.
  networks: { hardhat: { hardfork: 'cancun', chainId: 31337 } },
};
