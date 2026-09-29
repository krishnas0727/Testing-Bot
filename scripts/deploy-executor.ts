import { ethers } from "hardhat";

async function main() {
  console.log("--- Deploying ArbitrageExecutor Contract ---");
  const [deployer] = await ethers.getSigners();
  console.log("Deployer address:", deployer.address);

  // Address of Treasury contract (if previously deployed)
  const treasuryAddress = process.env.TREASURY_CONTRACT_ADDRESS || ethers.ZeroAddress;

  const ArbitrageExecutor = await ethers.getContractFactory("ArbitrageExecutor");
  const executor = await ArbitrageExecutor.deploy(treasuryAddress);
  await executor.waitForDeployment();

  const contractAddress = await executor.getAddress();
  console.log("ArbitrageExecutor deployed to:", contractAddress);
  console.log("Associated Treasury:", treasuryAddress);
}

main().catch((error) => {
  console.error("Deployment failed:", error);
  process.exitCode = 1;
});
