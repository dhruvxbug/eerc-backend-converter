import { ethers } from "hardhat";
import { deployLibrary, deployVerifiers } from "../../test/helpers";
import { DECIMALS } from "../constants";
import { saveDeploymentData, currentNetworkName } from "../../src/utils";

const main = async () => {
	// get deployer
	const [deployer] = await ethers.getSigners();

	// deploy verifiers
	// if true, deploys verifiers for prod, generated with proper trusted setup
	const {
		registrationVerifier,
		mintVerifier,
		withdrawVerifier,
		transferVerifier,
		burnVerifier,
	} = await deployVerifiers(deployer);

	// deploy babyjub library
	const babyJubJub = await deployLibrary(deployer);

	console.log("📋 Deployed basic components for standalone EncryptedERC:");

	// Create deployment data object for standalone mode
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
			registrar: "",
			encryptedERC: "",
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
	});

	// Save deployment data using utility function (standalone mode)
	saveDeploymentData(deploymentData, __dirname, false);
};

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});