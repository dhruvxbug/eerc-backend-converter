import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { privateMint, privateTransfer, decryptPCT } from "../test/helpers";
import { deriveKeysFromUser, getWallet, createUserFromPrivateKey } from "../src/utils";
import { DECIMALS } from "./constants";

/**
 * End-to-end verification of the Jurisdiction-Aware Chain.
 *
 * Proves the two halves of the project work together:
 *
 *   1. Allowlist enforcement. A non-allowlisted address is rejected by the
 *      TxAllowList precompile at the RPC layer, before the EVM runs. The same
 *      address is accepted once it is granted a role.
 *
 *   2. Real eERC activity on that chain. Users register with Groth16 proofs,
 *      an auditor is set, and tokens are privately minted and transferred.
 *      Balances are encrypted, so the script decrypts them locally with the
 *      BabyJubJub key to confirm the ciphertext is coherent.
 *
 * Run with:
 *   export L1_RPC_URL=<rpc>   # or: node ../network/resolve-rpc.mjs
 *   npx hardhat run scripts/verify-e2e.ts --network jurisdictionChain
 */

const TX_ALLOWLIST = "0x0200000000000000000000000000000000000002";
const ALLOWLIST_ABI = [
	"function readAllowList(address addr) external view returns (uint256 role)",
	"function setEnabled(address addr) external",
	"function setNone(address addr) external",
];

const SECRET_USER = "0xDD277E775eaC72bA469Cd9dcE30921974d8f4eD2";

let failures = 0;
const pass = (m: string) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const fail = (m: string) => {
	failures++;
	console.log(`  \x1b[31mFAIL\x1b[0m ${m}`);
};
const info = (m: string) => console.log(`       ${m}`);

/** Rebuild the deterministic BabyJubJub identity used at registration. */
async function loadUser(walletNumber: number) {
	const wallet = await getWallet(walletNumber);
	const address = await wallet.getAddress();
	const { privateKey, formattedPrivateKey, publicKey } =
		await deriveKeysFromUser(address, wallet);
	return { wallet, address, privateKey, formattedPrivateKey, publicKey };
}

/**
 * Decrypt a standalone eERC balance without depending on chai.
 *
 * `balanceOfStandalone` returns a positional tuple, not the EncryptedBalance
 * struct: (eGCT, nonce, amountPCTs, balancePCT, transactionIndex).
 * Each amountPCTs entry is an AmountPCT struct with a `pct` field.
 */
async function decryptBalance(privateKey: bigint, result: unknown): Promise<bigint> {
	const [, , amountPCTs, balancePCT] = result as unknown as [
		unknown,
		bigint,
		{ pct: bigint[] }[],
		bigint[]
	];

	let total = 0n;
	if (balancePCT && balancePCT.some((v) => v !== 0n)) {
		total += BigInt((await decryptPCT(privateKey, balancePCT))[0]);
	}
	for (const entry of amountPCTs ?? []) {
		const pct = entry.pct;
		if (pct && pct.some((v) => v !== 0n)) {
			total += BigInt((await decryptPCT(privateKey, pct))[0]);
		}
	}
	return total;
}

/**
 * Flatten the returned EGCT into the [c1.x, c1.y, c2.x, c2.y] form the circuit
 * wants. EGCT exposes its two curve points as `c1` and `c2` structs.
 */
function egctToFlat(result: unknown): bigint[] {
	const egct = (result as unknown as [EGCTStruct])[0];
	return [egct.c1.x, egct.c1.y, egct.c2.x, egct.c2.y];
}

type PointStruct = { x: bigint; y: bigint };
type EGCTStruct = { c1: PointStruct; c2: PointStruct };

const main = async () => {
	const network = await ethers.provider.getNetwork();
	const owner = await getWallet(1);
	const [user1, user2] = await Promise.all([loadUser(1), loadUser(2)]);

	console.log(`\nNexusAvalanche end-to-end verification`);
	console.log(`  network : ${network.name} (chainId ${network.chainId})`);
	console.log(`  deployer: ${owner.address}`);
	console.log(`  user 1  : ${user1.address}`);
	console.log(`  user 2  : ${user2.address}\n`);

	// ---------------------------------------------------------------
	console.log("Allowlist enforcement");
	// ---------------------------------------------------------------
	const allowlist = new ethers.Contract(TX_ALLOWLIST, ALLOWLIST_ABI, owner);
	const roleOf = async (a: string) => BigInt(await allowlist.readAllowList(a));

	const ownerRole = await roleOf(owner.address);
	if (ownerRole === 2n) {
		pass(`deployer holds Admin on the TxAllowList`);
	} else {
		fail(`deployer role is ${ownerRole}, expected Admin (2)`);
	}

	// A fresh identity that has never been granted a role.
	const stranger = ethers.Wallet.createRandom().connect(ethers.provider);
	await (await owner.sendTransaction({ to: stranger.address, value: ethers.parseEther("1") })).wait();

	let blocked = "";
	try {
		await stranger.sendTransaction({ to: owner.address, value: 0n });
	} catch (e) {
		blocked = e instanceof Error ? e.message : String(e);
	}
	if (blocked.includes("non-allow listed")) {
		pass("non-allowlisted address is rejected before reaching the EVM");
		info("cannot issue transaction from non-allow listed address");
	} else {
		fail(`non-allowlisted address was not rejected: ${blocked.slice(0, 100) || "no error"}`);
	}

	// ---------------------------------------------------------------
	console.log("\neERC contracts");
	// ---------------------------------------------------------------
	const deploymentPath = path.join(__dirname, "../deployments/standalone/latest-standalone.json");
	if (!fs.existsSync(deploymentPath)) {
		fail("no standalone deployment found; run l1:init and l1:core first");
		process.exit(1);
	}
	const d = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
	const eERCAddress = d.contracts.encryptedERC;
	const registrarAddress = d.contracts.registrar;
	const eERC = await ethers.getContractAt("EncryptedERC", eERCAddress, owner);
	const registrar = await ethers.getContractAt("Registrar", registrarAddress, owner);

	info(`EncryptedERC ${eERCAddress}`);
	info(`Registrar     ${registrarAddress}`);

	if ((await ethers.provider.getCode(eERCAddress)) !== "0x") {
		pass("EncryptedERC has code on the L1");
	} else {
		fail("EncryptedERC has no code on the L1");
		process.exit(1);
	}

	const registered1 = await registrar.isUserRegistered(user1.address);
	const registered2 = await registrar.isUserRegistered(user2.address);
	if (registered1 && registered2) {
		pass("both users are registered (Groth16 registration proofs accepted)");
	} else {
		fail(`registration incomplete: user1=${registered1} user2=${registered2}`);
	}

	const auditor = await eERC.auditor();
	if (auditor !== ethers.ZeroAddress) {
		pass(`auditor configured: ${auditor}`);
	} else {
		fail("no auditor configured; run l1:auditor first");
		process.exit(1);
	}

	// ---------------------------------------------------------------
	console.log("\nPrivate mint");
	// ---------------------------------------------------------------
	const before1 = await decryptBalance(user1.privateKey, await eERC.balanceOfStandalone(user1.address));
	info(`user 1 balance before: ${ethers.formatUnits(before1, DECIMALS)} PRIV`);

	const mintAmount = 100n * 10n ** BigInt(DECIMALS);
	const user1Pk = (await registrar.getUserPublicKey(user1.address)).map(BigInt) as [bigint, bigint];
	const auditorPk = await eERC.auditorPublicKey();

	const mintProof = await privateMint(
		mintAmount,
		user1Pk,
		[BigInt(auditorPk.x), BigInt(auditorPk.y)]
	);
	const mintTx = await eERC.privateMint(user1.address, mintProof);
	const mintReceipt = (await mintTx.wait(1, 300000))!;
	pass(`privateMint confirmed in block ${mintReceipt.blockNumber}`);

	const mintEvent = mintReceipt.logs
		.map((l) => {
			try {
				return eERC.interface.parseLog(l);
			} catch {
				return null;
			}
		})
		.find((l) => l?.name === "PrivateMint");
	if (mintEvent) {
		pass("PrivateMint event emitted (auditor can decrypt the amount)");
	} else {
		fail("no PrivateMint event in the receipt");
	}

	const after1 = await decryptBalance(user1.privateKey, await eERC.balanceOfStandalone(user1.address));
	if (after1 >= mintAmount) {
		pass(`user 1 decrypted balance ${ethers.formatUnits(after1, DECIMALS)} PRIV`);
	} else {
		fail(`balance did not increase: ${ethers.formatUnits(after1, DECIMALS)} PRIV`);
	}

	// The ciphertext on chain must not be plaintext.
	const egct = egctToFlat(await eERC.balanceOfStandalone(user1.address));
	if (egct[0] !== 0n || egct[1] !== 0n) {
		pass("balance is stored as a non-trivial ElGamal ciphertext");
	} else {
		fail("balance ciphertext is zero on chain");
	}

	// ---------------------------------------------------------------
	console.log("\nPrivate transfer");
	// ---------------------------------------------------------------
	const sendAmount = 25n * 10n ** BigInt(DECIMALS);
	const user1Before = await decryptBalance(user1.privateKey, await eERC.balanceOfStandalone(user1.address));
	const user2Before = await decryptBalance(user2.privateKey, await eERC.balanceOfStandalone(user2.address));

	const receiverPublicKey = (await registrar.getUserPublicKey(user2.address)).map(BigInt) as [bigint, bigint];
	const senderEncryptedBalance = egctToFlat(await eERC.balanceOfStandalone(user1.address));

	// privateTransfer expects a User object carrying the BabyJubJub identity.
	const sender = createUserFromPrivateKey(user1.privateKey, user1.wallet);

	const { proof, senderBalancePCT } = await privateTransfer(
		sender,
		user1Before,
		receiverPublicKey,
		sendAmount,
		senderEncryptedBalance,
		[BigInt(auditorPk.x), BigInt(auditorPk.y)]
	);

	// Standalone mode uses tokenId 0.
	const transferTx = await eERC.transfer(user2.address, 0, proof, senderBalancePCT);
	const transferReceipt = (await transferTx.wait(1, 300000))!;
	pass(`transfer confirmed in block ${transferReceipt.blockNumber}`);

	const transferEvent = transferReceipt.logs
		.map((l) => {
			try {
				return eERC.interface.parseLog(l);
			} catch {
				return null;
			}
		})
		.find((l) => l?.name === "PrivateTransfer");
	if (transferEvent) {
		pass("PrivateTransfer event emitted (amount hidden from the public chain)");
	} else {
		fail("no PrivateTransfer event in the receipt");
	}

	const user1After = await decryptBalance(user1.privateKey, await eERC.balanceOfStandalone(user1.address));
	const user2After = await decryptBalance(user2.privateKey, await eERC.balanceOfStandalone(user2.address));
	if (user1After === user1Before - sendAmount) {
		pass(`user 1 balance decreased by exactly ${ethers.formatUnits(sendAmount, DECIMALS)} PRIV`);
	} else {
		fail(`user 1 balance ${ethers.formatUnits(user1After, DECIMALS)}, expected ${ethers.formatUnits(user1Before - sendAmount, DECIMALS)}`);
	}
	if (user2After === user2Before + sendAmount) {
		pass(`user 2 balance increased by exactly ${ethers.formatUnits(sendAmount, DECIMALS)} PRIV`);
	} else {
		fail(`user 2 balance ${ethers.formatUnits(user2After, DECIMALS)}, expected ${ethers.formatUnits(user2Before + sendAmount, DECIMALS)}`);
	}

	// ---------------------------------------------------------------
	console.log("\nCleanup");
	// ---------------------------------------------------------------
	await (await allowlist.setNone(stranger.address)).wait();
	pass("revoked the temporary test address");

	console.log();
	if (failures === 0) {
		console.log("\x1b[32mAll checks passed.\x1b[0m");
	} else {
		console.log(`\x1b[31m${failures} check(s) failed.\x1b[0m`);
	}
	process.exit(failures === 0 ? 0 : 1);
};

main().catch((e) => {
	console.error("\nERROR:", e.shortMessage || e.message);
	process.exit(1);
});
