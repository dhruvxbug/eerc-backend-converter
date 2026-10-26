import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { privateMint, privateTransfer, decryptPCT } from "../test/helpers";
import { deriveKeysFromUser, getWallet, createUserFromPrivateKey, decryptEGCTBalance } from "../src/utils";
import { DECIMALS } from "./constants";

const TX_ALLOWLIST = "0x0200000000000000000000000000000000000002";
const ALLOWLIST_ABI = [
  "function readAllowList(address addr) external view returns (uint256 role)",
  "function setEnabled(address addr) external",
  "function setNone(address addr) external",
  "function setAdmin(address addr) external",
];

const ROLES: Record<string, string> = {
  "0": "None (Blocked)",
  "1": "Enabled (Transactor)",
  "2": "Admin (Governer)",
  "3": "Manager",
};

async function loadUser(walletNumber: number) {
  const wallet = await getWallet(walletNumber);
  const address = await wallet.getAddress();
  const keyFile = path.join(__dirname, `../deployments/standalone/user-keys-w${walletNumber}.json`);
  if (fs.existsSync(keyFile)) {
    const saved = JSON.parse(fs.readFileSync(keyFile, "utf8"));
    return {
      wallet,
      address,
      privateKey: BigInt(saved.privateKey.raw),
      formattedPrivateKey: BigInt(saved.privateKey.formatted),
      publicKey: [BigInt(saved.publicKey.x), BigInt(saved.publicKey.y)] as [bigint, bigint],
    };
  }
  const { privateKey, formattedPrivateKey, publicKey } = await deriveKeysFromUser(address, wallet);
  return { wallet, address, privateKey, formattedPrivateKey, publicKey };
}

async function decryptBalance(privateKey: bigint, result: unknown): Promise<bigint> {
  const [, , amountPCTs, balancePCT] = result as unknown as [
    unknown,
    bigint,
    { pct: bigint[] }[],
    bigint[]
  ];

  let total = 0n;
  if (balancePCT && balancePCT.some((v) => v !== 0n)) {
    try {
      const dec = await decryptPCT(privateKey, balancePCT);
      total += BigInt(dec[0]);
    } catch (e: any) {
      console.error("balancePCT error:", e.message);
    }
  }
  for (const entry of amountPCTs ?? []) {
    const pct = entry.pct;
    if (pct && pct.some((v) => v !== 0n)) {
      try {
        const dec = await decryptPCT(privateKey, pct);
        total += BigInt(dec[0]);
      } catch (e: any) {
        // foreign PCT
      }
    }
  }
  return total;
}

type PointStruct = { x: bigint; y: bigint };
type EGCTStruct = { c1: PointStruct; c2: PointStruct };

function egctToFlat(result: unknown): bigint[] {
  const egct = (result as unknown as [EGCTStruct])[0];
  return [egct.c1.x, egct.c1.y, egct.c2.x, egct.c2.y];
}

async function main() {
  const action = process.env.EERC_ACTION || "status";
  const arg1 = process.env.EERC_ARG1 || "";
  const arg2 = process.env.EERC_ARG2 || "";
  const arg3 = process.env.EERC_ARG3 || "";

  const deploymentPath = path.join(__dirname, "../deployments/standalone/latest-standalone.json");
  if (!fs.existsSync(deploymentPath)) {
    throw new Error("No standalone deployment found. Deploy contracts first.");
  }
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  const owner = await getWallet(1);
  const eERC = await ethers.getContractAt("EncryptedERC", deployment.contracts.encryptedERC, owner);
  const registrar = await ethers.getContractAt("Registrar", deployment.contracts.registrar, owner);
  const allowlist = new ethers.Contract(TX_ALLOWLIST, ALLOWLIST_ABI, owner);

  if (action === "status") {
    const network = await ethers.provider.getNetwork();
    const blockNumber = await ethers.provider.getBlockNumber();
    const auditor = await eERC.auditor();
    const auditorPk = await eERC.auditorPublicKey();

    const output = {
      success: true,
      network: {
        name: "Jurisdiction-Aware L1 (NexusAvalanche)",
        chainId: Number(network.chainId),
        blockNumber,
        rpcUrl: process.env.L1_RPC_URL || "http://127.0.0.1:9654",
      },
      contracts: {
        encryptedERC: deployment.contracts.encryptedERC,
        registrar: deployment.contracts.registrar,
        txAllowListPrecompile: TX_ALLOWLIST,
        registrationVerifier: deployment.contracts.registrationVerifier,
        mintVerifier: deployment.contracts.mintVerifier,
        transferVerifier: deployment.contracts.transferVerifier,
        withdrawVerifier: deployment.contracts.withdrawVerifier,
        burnVerifier: deployment.contracts.burnVerifier,
        babyJubJub: deployment.contracts.babyJubJub,
      },
      auditor: {
        address: auditor,
        publicKey: {
          x: auditorPk.x.toString(),
          y: auditorPk.y.toString(),
        },
      },
      demoAccounts: [
        {
          id: 1,
          name: "User 1 (Deployer / Token Owner)",
          address: "0xA1602f982E36ca8294e0f7B32b2054f28aa6317f",
          role: "Admin",
        },
        {
          id: 2,
          name: "User 2 (Auditor / Recipient)",
          address: "0xDD277E775eaC72bA469Cd9dcE30921974d8f4eD2",
          role: "Enabled",
        },
      ],
    };
    console.log(JSON.stringify(output));
    return;
  }

  if (action === "balance") {
    const target = arg1 || "1";
    let walletNum = 1;
    let address = "";
    if (target === "1" || target.toLowerCase() === "0xa1602f982e36ca8294e0f7b32b2054f28aa6317f") {
      walletNum = 1;
      address = "0xA1602f982E36ca8294e0f7B32b2054f28aa6317f";
    } else if (target === "2" || target.toLowerCase() === "0xdd277e775eac72ba469cd9dce30921974d8f4ed2") {
      walletNum = 2;
      address = "0xDD277E775eaC72bA469Cd9dcE30921974d8f4eD2";
    } else {
      address = target;
      walletNum = 0;
    }

    const isRegistered = await registrar.isUserRegistered(address);
    const roleNum = Number(await allowlist.readAllowList(address));
    const rawBalance = await eERC.balanceOfStandalone(address);

    const [eGCT, nonce, amountPCTs, balancePCT, transactionIndex] = rawBalance as any;
    const c1x = eGCT?.c1?.x?.toString() || "0";
    const c1y = eGCT?.c1?.y?.toString() || "0";
    const c2x = eGCT?.c2?.x?.toString() || "0";
    const c2y = eGCT?.c2?.y?.toString() || "0";

    let decrypted = "0.0";
    let rawDecryptedBigInt = 0n;
    if (walletNum > 0 && isRegistered) {
      const u = await loadUser(walletNum);
      rawDecryptedBigInt = await decryptBalance(u.privateKey, rawBalance);
      decrypted = ethers.formatUnits(rawDecryptedBigInt, DECIMALS);
    }

    const output = {
      success: true,
      address,
      walletNumber: walletNum,
      isRegistered,
      allowlistRole: roleNum,
      allowlistRoleName: ROLES[String(roleNum)] || "Unknown",
      isPermitted: roleNum > 0,
      decryptedBalance: decrypted,
      rawDecrypted: rawDecryptedBigInt.toString(),
      decimals: DECIMALS,
      tokenSymbol: "PRIV",
      ciphertext: {
        c1: { x: c1x, y: c1y },
        c2: { x: c2x, y: c2y },
        isZero: c1x === "0" && c1y === "0" && c2x === "0" && c2y === "0",
        amountPCTsCount: amountPCTs?.length || 0,
        transactionIndex: transactionIndex?.toString() || "0",
        nonce: nonce?.toString() || "0",
      },
    };
    console.log(JSON.stringify(output));
    return;
  }

  if (action === "transfer") {
    const senderWalletNum = Number(arg1) || 1;
    const receiverAddress = arg2 || "0xDD277E775eaC72bA469Cd9dcE30921974d8f4eD2";
    const amountFloat = parseFloat(arg3 || "10");
    const sendAmount = BigInt(Math.round(amountFloat * 10 ** DECIMALS));

    const senderUser = await loadUser(senderWalletNum);
    const auditorPk = await eERC.auditorPublicKey();

    const senderBalanceRaw = await eERC.balanceOfStandalone(senderUser.address);
    const senderBeforeDecrypted = await decryptBalance(senderUser.privateKey, senderBalanceRaw);

    if (senderBeforeDecrypted < sendAmount) {
      throw new Error(
        `Insufficient balance: current ${ethers.formatUnits(senderBeforeDecrypted, DECIMALS)} PRIV, trying to send ${amountFloat} PRIV`
      );
    }

    const receiverPublicKey = (await registrar.getUserPublicKey(receiverAddress)).map(BigInt) as [bigint, bigint];
    const senderEncryptedBalance = egctToFlat(senderBalanceRaw);
    const senderObj = createUserFromPrivateKey(senderUser.privateKey, senderUser.wallet);

    const { proof, senderBalancePCT } = await privateTransfer(
      senderObj,
      senderBeforeDecrypted,
      receiverPublicKey,
      sendAmount,
      senderEncryptedBalance,
      [BigInt(auditorPk.x), BigInt(auditorPk.y)]
    );

    // Call transfer from sender's wallet
    const eERCSender = eERC.connect(senderUser.wallet);
    const tx = await eERCSender.transfer(receiverAddress, 0, proof, senderBalancePCT);
    const receipt = (await tx.wait(1, 300000))!;

    const senderAfterRaw = await eERC.balanceOfStandalone(senderUser.address);
    const senderAfterDecrypted = await decryptBalance(senderUser.privateKey, senderAfterRaw);

    const output = {
      success: true,
      operation: "PrivateTransfer",
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      sender: senderUser.address,
      receiver: receiverAddress,
      amountSent: amountFloat.toString(),
      newSenderBalance: ethers.formatUnits(senderAfterDecrypted, DECIMALS),
      proofVerification: "Groth16 Pairing Verified On-Chain",
      privacyNotice: "Transaction amount is encrypted on-chain. Decryptable only by sender, receiver, and authorized auditor.",
    };
    console.log(JSON.stringify(output));
    return;
  }

  if (action === "mint") {
    const recipient = arg1 || "0xA1602f982E36ca8294e0f7B32b2054f28aa6317f";
    const amountFloat = parseFloat(arg2 || "50");
    const mintAmount = BigInt(Math.round(amountFloat * 10 ** DECIMALS));

    const recipientPk = (await registrar.getUserPublicKey(recipient)).map(BigInt) as [bigint, bigint];
    const auditorPk = await eERC.auditorPublicKey();

    const mintProof = await privateMint(
      mintAmount,
      recipientPk,
      [BigInt(auditorPk.x), BigInt(auditorPk.y)]
    );

    const tx = await eERC.privateMint(recipient, mintProof);
    const receipt = (await tx.wait(1, 300000))!;

    const output = {
      success: true,
      operation: "PrivateMint",
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      recipient,
      amountMinted: amountFloat.toString(),
      proofVerification: "Groth16 Mint Proof Verified On-Chain",
    };
    console.log(JSON.stringify(output));
    return;
  }

  if (action === "allowlist-role") {
    const target = arg1;
    const role = Number(await allowlist.readAllowList(target));
    console.log(
      JSON.stringify({
        success: true,
        address: target,
        role,
        roleName: ROLES[String(role)] || "Unknown",
        isPermitted: role > 0,
      })
    );
    return;
  }

  throw new Error(`Unknown action: ${action}`);
}

main().catch((err) => {
  console.log(
    JSON.stringify({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    })
  );
  process.exit(1);
});
