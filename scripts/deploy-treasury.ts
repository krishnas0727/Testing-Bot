import { ethers } from "hardhat";

async function main() {
  console.log("--- Deploying Treasury Vault Contract ---");
  const [deployer] = await ethers.getSigners();
  console.log("Deployer address:", deployer.address);

  // Distribution BPS: 60% Trading Capital, 20% Gas Reserve, 20% Profit Reserve
  const tradingCapitalBps = 6000;
  const emergencyReserveBps = 2000;
  const profitReserveBps = 2000;

  const Treasury = await ethers.getContractFactory("Treasury");
  const treasury = await Treasury.deploy(tradingCapitalBps, emergencyReserveBps, profitReserveBps);
  await treasury.waitForDeployment();

  const contractAddress = await treasury.getAddress();
  console.log("Treasury deployed to:", contractAddress);
  console.log("Distribution BPS configured: 6000 (60%) / 2000 (20%) / 2000 (20%)");
}

main().catch((error) => {
  console.error("Deployment failed:", error);
  process.exitCode = 1;
});
