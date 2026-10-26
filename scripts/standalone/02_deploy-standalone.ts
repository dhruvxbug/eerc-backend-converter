import { ethers } from "hardhat";
import { EncryptedERC__factory } from "../../typechain-types";
import { DECIMALS } from "../constants";
import { saveDeploymentData, currentNetworkName } from "../../src/utils";
import * as fs from "fs";
import * as path from "path";

const main = async () => {
	// get deployer
	const [deployer] = await ethers.getSigners();
    const latestDeployment = JSON.parse(fs.readFileSync(path.join(__dirname, "../../deployments/standalone/latest-standalone.json"), "utf8"));
    const { contracts } = latestDeployment;
    const { registrationVerifier, mintVerifier, withdrawVerifier, transferVerifier, burnVerifier, babyJubJub } = contracts;

    const allContractsDeployed = registrationVerifier && mintVerifier && withdrawVerifier && transferVerifier && burnVerifier && babyJubJub; 
    if (!allContractsDeployed) {
        console.log("No verifiers found in latest standalone deployment. Please run 01_deploy-basics.ts first.");
        return;
    }

	console.log("🔧 Deploying standalone EncryptedERC system...");

	// deploy registrar contract
	const registrarFactory = await ethers.getContractFactory("Registrar");
	const registrar = await registrarFactory.deploy(registrationVerifier);
	await registrar.waitForDeployment();

	console.log("✅ Registrar deployed:", registrar.target);

	// deploy standalone eERC20 (NOT in converter mode)
	const encryptedERCFactory = new EncryptedERC__factory({
		"contracts/libraries/BabyJubJub.sol:BabyJubJub": babyJubJub,
	});
	const encryptedERC_ = await encryptedERCFactory.connect(deployer).deploy({
		registrar: registrar.target,
		isConverter: false, // This is a standalone eERC (NOT converter)
		name: "Private Token",
		symbol: "PRIV",
		mintVerifier,
		withdrawVerifier,
		transferVerifier,
		burnVerifier,
		decimals: DECIMALS,
	});
	await encryptedERC_.waitForDeployment();

	console.log("✅ Standalone EncryptedERC deployed:", encryptedERC_.target);

	// Create deployment data object
	const deploymentData = {
		network: await currentNetworkName(),
		deployer: deployer.address,
		deploymentTimestamp: new Date().toISOString(),
		contracts: {
			registrationVerifier: registrationVerifier,
			mintVerifier: mintVerifier,
			withdrawVerifier: withdrawVerifier,
			transferVerifier: transferVerifier,
			burnVerifier: burnVerifier,
			babyJubJub: babyJubJub,
			registrar: registrar.target,
			encryptedERC: encryptedERC_.target,
		},
		metadata: {
			isConverter: false,
			decimals: DECIMALS,
			erc20Name: "Private Token",
			erc20Symbol: "PRIV",
		}
	};

	// Display in console
	console.table({
		registrationVerifier,
		mintVerifier,
		withdrawVerifier,
		transferVerifier,
		burnVerifier,
		babyJubJub,
		registrar: registrar.target,
		encryptedERC: encryptedERC_.target,
	});

	// Save deployment data using utility function (standalone mode)
	saveDeploymentData(deploymentData, __dirname, false);

	console.log("\n🎯 Standalone EncryptedERC System Deployed!");
	console.log("📋 Key differences from converter mode:");
	console.log("   • This is a native encrypted token (PRIV)");
	console.log("   • Uses mint() instead of deposit() to create tokens");
	console.log("   • Uses burn() instead of withdraw() to destroy tokens");
	console.log("   • No ERC20 token wrapping - this IS the token");
	
	console.log("\n🚀 Next Steps:");
	console.log("   1. Register users with: npx hardhat run scripts/standalone/03_register-user.ts --network fuji");
	console.log("   2. Set auditor with: npx hardhat run scripts/standalone/04_set-auditor.ts --network fuji");
	console.log("   3. Private mint tokens with: npx hardhat run scripts/standalone/05_mint.ts --network fuji");
	console.log("   4. Check balances with: npx hardhat run scripts/standalone/06_check-balance.ts --network fuji");
	console.log("   5. Transfer privately with: npx hardhat run scripts/standalone/07_transfer.ts --network fuji");
};

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
