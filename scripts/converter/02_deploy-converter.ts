import { ethers } from "hardhat";
import { EncryptedERC__factory } from "../../typechain-types";
import { DECIMALS } from "../constants";
import { saveDeploymentData, currentNetworkName } from "../../src/utils";
import * as fs from "fs";
import * as path from "path";

const main = async () => {
	// get deployer
	const [deployer] = await ethers.getSigners();
    const latestDeployment = JSON.parse(fs.readFileSync(path.join(__dirname, "../../deployments/converter/latest-converter.json"), "utf8"));
    const { contracts } = latestDeployment;
    const { registrationVerifier, mintVerifier, withdrawVerifier, transferVerifier, burnVerifier, babyJubJub, testERC20 } = contracts;

    const allContractsDeployed = registrationVerifier && mintVerifier && withdrawVerifier && transferVerifier && burnVerifier && babyJubJub && testERC20; 
    if (!allContractsDeployed) {
        console.log("No verifiers found in latest deployment. Deploying new verifiers...");
        return;
    }

	// deploy registrar contract
	const registrarFactory = await ethers.getContractFactory("Registrar");
	const registrar = await registrarFactory.deploy(registrationVerifier);
	await registrar.waitForDeployment();

	// deploy eERC20
	const encryptedERCFactory = new EncryptedERC__factory({
		"contracts/libraries/BabyJubJub.sol:BabyJubJub": babyJubJub,
	});
	const encryptedERC_ = await encryptedERCFactory.connect(deployer).deploy({
		registrar: registrar.target,
		isConverter: true, // This is a converter eERC
		name: "",
		symbol: "",
		mintVerifier,
		withdrawVerifier,
		transferVerifier,
		burnVerifier,
		decimals: DECIMALS,
	});
	await encryptedERC_.waitForDeployment();


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
			testERC20: testERC20,
		},
		metadata: {
			isConverter: true,
			decimals: DECIMALS,
			testTokensMinted: "10000",
			erc20Name: "Test",
			erc20Symbol: "TEST",
		}
	};

	// Display in console
	console.table({
		registrationVerifier,
		mintVerifier,
		withdrawVerifier,
		transferVerifier,
		babyJubJub,
		registrar: registrar.target,
		encryptedERC: encryptedERC_.target,
		testERC20: testERC20,
	});

	// Save deployment data using utility function
	saveDeploymentData(deploymentData, __dirname);
};

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
