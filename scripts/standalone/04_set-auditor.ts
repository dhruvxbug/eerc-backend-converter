import { EncryptedERC__factory, Registrar__factory } from "../../typechain-types";
import * as fs from "fs";
import * as path from "path";
import { getWallet } from "../../src/utils";

const main = async () => {
    // Wallet 1 is the contract owner. The auditor is normally wallet 2, which
    // keeps the auditor key separate from the owner's.
    const WALLET_NUMBER = parseInt(process.env.WALLET_NUMBER || "2", 10);

    const deployer = await getWallet(1);
    const auditorWallet = await getWallet(WALLET_NUMBER);
    const auditorAddress = await auditorWallet.getAddress();

    // Read addresses from the latest standalone deployment
    const deploymentPath = path.join(__dirname, "../../deployments/standalone/latest-standalone.json");
    const deploymentData = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));

    const eERCAddress = deploymentData.contracts.encryptedERC;

    const encryptedERC = await EncryptedERC__factory.connect(eERCAddress, deployer);
    let auditor: any;
    try {
        console.log("🔧 Setting auditor for standalone EncryptedERC...");
        console.log("EncryptedERC Address:", eERCAddress);
        console.log("Auditor Address:", auditorAddress);

        // setAuditorPublicKey is onlyOwner onlyIfUserRegistered, so the auditor
        // must be registered in the Registrar first. Fail with a clear hint
        // rather than an opaque "execution reverted".
        const registrarAddress = deploymentData.contracts.registrar;
        const registrar = await Registrar__factory.connect(registrarAddress, deployer);
        const isRegistered = await registrar.isUserRegistered(auditorAddress);
        if (!isRegistered) {
            console.error(`❌ Auditor ${auditorAddress} is not registered.`);
            console.error("   Run the registration step for this wallet first:");
            console.error(`   WALLET_NUMBER=${WALLET_NUMBER} npx hardhat run scripts/standalone/03_register-user.ts --network <network>`);
            process.exitCode = 1;
            return;
        }

        auditor = await encryptedERC.setAuditorPublicKey(auditorAddress);
        const receipt = await auditor.wait();
        console.log("Transaction confirmed in block:", receipt?.blockNumber);

         const onChainAuditor = await encryptedERC.auditor();
         const auditorPublicKey = await encryptedERC.auditorPublicKey();

         console.log("✅ Auditor successfully configured for standalone mode");
         console.log("Auditor address:", onChainAuditor);
         console.log("Auditor public key X:", auditorPublicKey.x.toString());
         console.log("Auditor public key Y:", auditorPublicKey.y.toString());
         
         console.log("\n🎯 Standalone System Ready!");
         console.log("📋 The system is now configured for private minting:");
         console.log("   • Auditor can decrypt transaction amounts for compliance");
         console.log("   • Owner can now mint tokens privately to registered users");
         console.log("   • All operations will be recorded for audit purposes");
         
         console.log("\n🚀 Next Steps:");
         console.log("   • Register users: npx hardhat run scripts/standalone/03_register-user.ts --network fuji");
         console.log("   • Mint tokens: npx hardhat run scripts/standalone/05_mint.ts --network fuji");
         
    } catch (error) {
        console.error("❌ Error setting auditor:", error);
        
        // Show more error details
        if (error instanceof Error) {
            console.error("Error message:", error.message);
            
            if (error.message.includes("User not registered")) {
                console.error("💡 Hint: The auditor address needs to be registered first");
                console.error("   Run: npx hardhat run scripts/standalone/03_register-user.ts --network fuji");
                console.error("   (Make sure to use the auditor's private key)");
            } else if (error.message.includes("Ownable: caller is not the owner")) {
                console.error("💡 Hint: Only the contract owner can set the auditor");
            }
        }
    }
};

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});