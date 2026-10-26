import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-ethers";
import "@solarity/chai-zkit";
import "@solarity/hardhat-zkit";
import "@typechain/hardhat";
import "hardhat-gas-reporter";
import type { HardhatUserConfig } from "hardhat/config";
import "solidity-coverage";

import dotenv from "dotenv";
dotenv.config();

const RPC_URL = process.env.RPC_URL || "https://api.avax.network/ext/bc/C/rpc";

// The local Jurisdiction-Aware Chain. Its RPC path uses the generated
// blockchain ID, not the alias and not the chainId, so run
// `node ../network/resolve-rpc.mjs` (or `node ../network/deploy_l1.sh`) and
// export L1_RPC_URL before deploying.
const L1_RPC_URL = process.env.L1_RPC_URL || "http://127.0.0.1:9654";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.27",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    hardhat: {
      forking: {
        url: RPC_URL,
        blockNumber: 59121339,
        enabled: !!process.env.FORKING,
      },
    },
    fuji: {
      url: "https://api.avax-test.network/ext/bc/C/rpc",
      chainId: 43113,
      accounts: [process.env.PRIVATE_KEY || "", process.env.PRIVATE_KEY_2 || ""],
    },
    // Permissioned L1: the TxAllowList precompile rejects transactions from
    // any address that has not been granted a role, so the deploying account
    // must be a genesis Admin. The ewoq development key qualifies.
    jurisdictionChain: {
      url: L1_RPC_URL,
      chainId: 99999,
      accounts: [
        process.env.ADMIN_PRIVATE_KEY ||
          process.env.PRIVATE_KEY ||
          "0x56289e99c94b6912bfc12adc093c9b51124f0dc54ac7a766b2bc5ccf558d8027",
        process.env.PRIVATE_KEY_2 || "",
      ].filter(Boolean),
    },
  },
  gasReporter: {
    enabled: !!process.env.REPORT_GAS,
    currency: "USD",
    coinmarketcap: process.env.COINMARKETCAP_API_KEY,
    excludeContracts: ["contracts/mocks/"],
    outputFile: "gas-report.txt",
    L1: "avalanche",
    showMethodSig: true,
  },
  zkit: {
    compilerVersion: "2.1.9",
    circuitsDir: "circom",
    compilationSettings: {
      artifactsDir: "zkit/artifacts",
      onlyFiles: [],
      skipFiles: [],
      c: false,
      json: false,
      optimization: "O2",
    },
    setupSettings: {
      contributionSettings: {
        provingSystem: "groth16",
        contributions: 0,
      },
      onlyFiles: [],
      skipFiles: [],
      ptauDir: undefined,
      ptauDownload: true,
    },
    verifiersSettings: {
      verifiersDir: "contracts/verifiers",
      verifiersType: "sol",
    },
    typesDir: "generated-types/zkit",
    quiet: false,
  },
};

export default config;
