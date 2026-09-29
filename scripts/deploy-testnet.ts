/**
 * @file deploy-testnet.ts
 * @description Phase 18: Automated Testnet Deployment Script
 *
 * Deploys Treasury.sol and ArbitrageExecutor.sol to the specified testnet
 * (e.g. Base Sepolia or Sepolia or Localhost).
 *
 * Security Mandate:
 * - Uses deployer signer provided by Hardhat config.
 * - Never asks for, prints, or stores private keys or seed phrases.
 * - Exports deterministic contract artifacts to `deployments/`.
 */

import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { TESTNET_CONFIGS } from "../src/config/testnet";

async function main() {
  console.log("============================================================");
  console.log("🚀 STARTING TESTNET SMART CONTRACT DEPLOYMENT");
  console.log("============================================================");

  const [deployer] = await ethers.getSigners();
  const networkInfo = await ethers.provider.getNetwork();
  const chainId = Number(networkInfo.chainId);

  console.log(`📡 Network: ${network.name}`);
  console.log(`⛓️  Chain ID: ${chainId}`);
  console.log(`👤 Deployer: ${deployer.address}`);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`💰 Deployer Balance: ${ethers.formatEther(balance)} ETH`);

  if (balance === 0n) {
    console.warn("⚠️  Deployer has 0 ETH balance! For testnets, fund via a public faucet first.");
  }

  // 1. Deploy Treasury.sol
  console.log("\n--- [1/4] Deploying Treasury Contract ---");
  const TreasuryFactory = await ethers.getContractFactory("Treasury");
  // Temporary initialExecutor is deployer address until ArbitrageExecutor is deployed
  const treasury = await TreasuryFactory.deploy(deployer.address, deployer.address);
  await treasury.waitForDeployment();
  const treasuryAddress = await treasury.getAddress();
  const treasuryTx = treasury.deploymentTransaction();
  console.log(`✅ Treasury Deployed: ${treasuryAddress}`);
  console.log(`   Tx Hash: ${treasuryTx?.hash || "N/A"}`);

  // 2. Deploy ArbitrageExecutor.sol
  console.log("\n--- [2/4] Deploying ArbitrageExecutor Contract ---");
  const ExecutorFactory = await ethers.getContractFactory("ArbitrageExecutor");
  const arbitrageExecutor = await ExecutorFactory.deploy(deployer.address, treasuryAddress);
  await arbitrageExecutor.waitForDeployment();
  const executorAddress = await arbitrageExecutor.getAddress();
  const executorTx = arbitrageExecutor.deploymentTransaction();
  console.log(`✅ ArbitrageExecutor Deployed: ${executorAddress}`);
  console.log(`   Tx Hash: ${executorTx?.hash || "N/A"}`);

  // 3. Configure Roles & Permissions
  console.log("\n--- [3/4] Configuring Cross-Contract Roles & Whitelists ---");
  const ARBITRAGE_EXECUTOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ARBITRAGE_EXECUTOR_ROLE"));
  const TREASURY_MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("TREASURY_MANAGER_ROLE"));

  const grantTx1 = await treasury.grantRole(ARBITRAGE_EXECUTOR_ROLE, executorAddress);
  await grantTx1.wait();
  console.log(`✅ Granted ARBITRAGE_EXECUTOR_ROLE on Treasury to ${executorAddress}`);

  const grantTx2 = await treasury.grantRole(TREASURY_MANAGER_ROLE, deployer.address);
  await grantTx2.wait();
  console.log(`✅ Granted TREASURY_MANAGER_ROLE on Treasury to ${deployer.address}`);

  // Whitelist Testnet Tokens & Routers if configured for this chain
  const testnetConfig = TESTNET_CONFIGS[chainId];
  if (testnetConfig) {
    for (const [symbol, token] of Object.entries(testnetConfig.tokens)) {
      const tx = await arbitrageExecutor.setTokenWhitelist(token.address, true);
      await tx.wait();
      const txTreasury = await treasury.setTokenWhitelist(token.address, true);
      await txTreasury.wait();
      console.log(`✅ Whitelisted Token: ${symbol} (${token.address})`);
    }

    for (const [name, router] of Object.entries(testnetConfig.dexRouters)) {
      const tx = await arbitrageExecutor.setRouterWhitelist(router.routerAddress, true);
      await tx.wait();
      console.log(`✅ Whitelisted Router: ${name} (${router.routerAddress})`);
    }
  }

  // 4. Record Deployment Metadata
  console.log("\n--- [4/4] Writing Deployment Record ---");
  const deploymentsDir = path.join(__dirname, "../deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  const deploymentData = {
    network: network.name,
    chainId,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    contracts: {
      Treasury: {
        address: treasuryAddress,
        deploymentTxHash: treasuryTx?.hash || null,
      },
      ArbitrageExecutor: {
        address: executorAddress,
        deploymentTxHash: executorTx?.hash || null,
        associatedTreasury: treasuryAddress,
      },
    },
    whitelistedTokens: testnetConfig ? testnetConfig.tokens : {},
    whitelistedRouters: testnetConfig ? testnetConfig.dexRouters : {},
  };

  const outFile = path.join(deploymentsDir, `deployment-${chainId}.json`);
  fs.writeFileSync(outFile, JSON.stringify(deploymentData, null, 2));
  console.log(`📄 Saved deployment details to: ${outFile}`);

  console.log("============================================================");
  console.log("🎉 TESTNET DEPLOYMENT COMPLETED SUCCESSFULLY");
  console.log("============================================================");
}

main().catch((error) => {
  console.error("❌ Deployment failed:", error);
  process.exitCode = 1;
});
