import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { privateMint, privateTransfer } from "../test/helpers";
import { deriveKeysFromUser, getWallet, createUserFromPrivateKey } from "../src/utils";
import { DECIMALS } from "./constants";

/**
 * Benchmark the eERC confidential-transfer lifecycle on the L1.
 *
 * Reports, per operation:
 *   - client_ms  : time to generate the Groth16 proof + calldata locally
 *   - submit_ms  : time from eth_sendRawTransaction to the receipt
 *   - gas        : gasUsed reported in the receipt
 *   - verifier_gas: pairing cost of the Groth16 verifier, measured in
 *                   isolation via eth_estimateGas against the verifier
 *                   contract, so proof checking can be separated from the rest
 *                   of the transaction
 *
 * This script only reads the eERC contracts; it does not modify them.
 * Run with:
 *   export L1_RPC_URL=<rpc>
 *   npx hardhat run scripts/benchmark-eerc.ts --network jurisdictionChain
 */

const ms = (a: bigint, b: bigint) => Number(b - a) / 1e6;

// Each Groth16 verifier takes a differently sized public-signal array, so the
// isolated pairing cost is measured with a per-circuit signature.
const VERIFIER_SIG: Record<string, string> = {
  registration:
    "function verifyProof(uint256[2] a, uint256[2][2] b, uint256[2] c, uint256[5] s) public view returns (bool)",
  mint:
    "function verifyProof(uint256[2] a, uint256[2][2] b, uint256[2] c, uint256[24] s) public view returns (bool)",
  transfer:
    "function verifyProof(uint256[2] a, uint256[2][2] b, uint256[2] c, uint256[32] s) public view returns (bool)",
};

/**
 * Gas for a bare verifyProof call, isolating the on-chain pairing cost.
 *
 * zkit's `generateCalldata` returns proofPoints as an object {a, b, c}, while
 * the test helpers return it as a positional array, so both are accepted.
 */
async function verifierGas(kind: string, verifierAddress: string, calldata: any, from: string) {
  try {
    const pp = calldata.proofPoints;
    const [a, b, c] = Array.isArray(pp) ? [pp[0], pp[1], pp[2]] : [pp.a, pp.b, pp.c];
    const iface = new ethers.Interface([VERIFIER_SIG[kind]]);
    const data = iface.encodeFunctionData("verifyProof", [
      a,
      b,
      c,
      calldata.publicSignals,
    ]);
    return Number(await ethers.provider.estimateGas({ to: verifierAddress, data, from }));
  } catch (e) {
    console.log(`  (${kind} verifier gas unavailable: ${(e as Error).message.slice(0, 70)})`);
    return null;
  }
}

const results: Record<string, any> = {};

function record(name: string, data: any) {
  results[name] = data;
  console.log(`\n[${name}]`);
  for (const [k, v] of Object.entries(data)) {
    console.log(`  ${k}: ${typeof v === "number" ? v : JSON.stringify(v)}`);
  }
}

async function loadUser(walletNumber: number) {
  const wallet = await getWallet(walletNumber);
  const address = await wallet.getAddress();
  const { privateKey, formattedPrivateKey, publicKey } =
    await deriveKeysFromUser(address, wallet);
  return { wallet, address, privateKey, formattedPrivateKey, publicKey };
}

type PointStruct = { x: bigint; y: bigint };
type EGCTStruct = { c1: PointStruct; c2: PointStruct };


function egctToFlat(result: unknown): bigint[] {
  const egct = (result as unknown as [EGCTStruct])[0];
  return [egct.c1.x, egct.c1.y, egct.c2.x, egct.c2.y];
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
    const { decryptPCT } = await import("../test/helpers");
    total += BigInt((await decryptPCT(privateKey, balancePCT))[0]);
  }
  for (const e of amountPCTs ?? []) {
    if (e.pct && e.pct.some((v) => v !== 0n)) {
      const { decryptPCT } = await import("../test/helpers");
      total += BigInt((await decryptPCT(privateKey, e.pct))[0]);
    }
  }
  return total;
}

const main = async () => {
  const net = await ethers.provider.getNetwork();
  const owner = await getWallet(1);
  const u1 = await loadUser(1);
  const u2 = await loadUser(2);

  const d = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../deployments/standalone/latest-standalone.json"),
      "utf8"
    )
  );
  const eERC = await ethers.getContractAt("EncryptedERC", d.contracts.encryptedERC, owner);
  const registrar = await ethers.getContractAt("Registrar", d.contracts.registrar, owner);

  console.log(`\neERC benchmark`);
  console.log(`  network: ${net.name} (chainId ${net.chainId})`);
  console.log(`  EncryptedERC: ${d.contracts.encryptedERC}`);
  console.log(`  verifier (transfer): ${await eERC.transferVerifier()}`);

  const auditorPk = await eERC.auditorPublicKey();
  const auditorKey = [BigInt(auditorPk.x), BigInt(auditorPk.y)];
  const u1Pk = (await registrar.getUserPublicKey(u1.address)).map(BigInt) as [bigint, bigint];
  const u2Pk = (await registrar.getUserPublicKey(u2.address)).map(BigInt) as [bigint, bigint];

  // ── Registration: a fresh identity, so this is a real proof ──────────
  // Registrar.register requires msg.sender == the address inside the proof, so
  // the tx has to come from the new wallet. That address is not allowlisted
  // yet, so this also measures the full compliance onboarding path:
  // setEnabled -> fund -> register.
  {
    const { zkit } = await import("hardhat");
    const fresh = ethers.Wallet.createRandom();
    const address = fresh.address;
    const { poseidon3 } = await import("poseidon-lite");
    const { privateKey, formattedPrivateKey, publicKey } = await deriveKeysFromUser(
      address,
      fresh
    );
    const registrationHash = poseidon3([
      BigInt(net.chainId),
      formattedPrivateKey,
      BigInt(address),
    ]);

    const circuit: any = await zkit.getCircuit("RegistrationCircuit");
    const input = {
      SenderPrivateKey: formattedPrivateKey,
      SenderPublicKey: [publicKey[0], publicKey[1]],
      SenderAddress: BigInt(address),
      ChainID: BigInt(net.chainId),
      RegistrationHash: registrationHash,
    };

    // Compliance onboarding: grant the address transaction permission.
    const allowT0 = process.hrtime.bigint();
    const allowlist = new ethers.Contract(
      "0x0200000000000000000000000000000000000002",
      ["function setEnabled(address addr) external", "function setNone(address addr) external"],
      owner
    );
    await (await allowlist.setEnabled(address)).wait(1, 120000);
    const allowT1 = process.hrtime.bigint();
    // Fund it so it can pay for its own registration transaction.
    await (
      await owner.sendTransaction({ to: address, value: ethers.parseEther("10") })
    ).wait(1, 120000);

    const t0 = process.hrtime.bigint();
    const proof = await circuit.generateProof(input);
    const t1 = process.hrtime.bigint();
    const calldata = await circuit.generateCalldata(proof);
    const t2 = process.hrtime.bigint();

    const regVerifier = await registrar.registrationVerifier();
    const vGas = await verifierGas("registration", regVerifier, calldata, owner.address);

    // register() requires msg.sender to equal the address inside the proof, so
    // the transaction is sent by the freshly generated wallet itself.
    const freshSigner = fresh.connect(ethers.provider);
    const registrarAsFresh = registrar.connect(freshSigner as any);
    const sub0 = process.hrtime.bigint();
    const rec = await (
      await registrarAsFresh.register(calldata as any, { gasLimit: 6_000_000 })
    ).wait(1, 600000);
    const sub1 = process.hrtime.bigint();

    // Leave the allowlist as we found it.
    await (await allowlist.setNone(address)).wait(1, 120000);

    record("registration", {
      allowlist_grant_ms: +ms(allowT0, allowT1).toFixed(2),
      client_proof_gen_ms: +ms(t0, t1).toFixed(2),
      client_calldata_ms: +ms(t1, t2).toFixed(2),
      submit_ms: +ms(sub0, sub1).toFixed(2),
      gas_total: rec!.gasUsed.toString(),
      verifier_gas: vGas,
      verifier_address: regVerifier,
    });
  }

  // ── Private mint ─────────────────────────────────────────────────────
  {
    const mintAmount = 100n * 10n ** BigInt(DECIMALS);
    const before = await decryptBalance(u1.privateKey, await eERC.balanceOfStandalone(u1.address));

    const t0 = process.hrtime.bigint();
    const proof = await privateMint(mintAmount, u1Pk, auditorKey);
    const t1 = process.hrtime.bigint();

    const vGas = await verifierGas(
      "mint",
      await eERC.mintVerifier(),
      proof,
      owner.address
    );

    const tx = await eERC.privateMint(u1.address, proof, { gasLimit: 6_000_000 });
    const sub0 = process.hrtime.bigint();
    const rec = await tx.wait(1, 600000);
    const sub1 = process.hrtime.bigint();

    const after = await decryptBalance(u1.privateKey, await eERC.balanceOfStandalone(u1.address));
    record("private_mint", {
      client_proof_gen_ms: +ms(t0, t1).toFixed(2),
      submit_ms: +ms(sub0, sub1).toFixed(2),
      gas_total: rec!.gasUsed.toString(),
      verifier_gas: vGas,
      amount_wei: mintAmount.toString(),
      balance_delta_wei: (after - before).toString(),
    });
  }

  // ── Private transfer ─────────────────────────────────────────────────
  {
    const sendAmount = 25n * 10n ** BigInt(DECIMALS);
    const before1 = await decryptBalance(u1.privateKey, await eERC.balanceOfStandalone(u1.address));
    const before2 = await decryptBalance(u2.privateKey, await eERC.balanceOfStandalone(u2.address));
    const senderEncryptedBalance = egctToFlat(await eERC.balanceOfStandalone(u1.address));
    const sender = createUserFromPrivateKey(u1.privateKey, u1.wallet);

    const t0 = process.hrtime.bigint();
    const { proof, senderBalancePCT } = await privateTransfer(
      sender,
      before1,
      u2Pk,
      sendAmount,
      senderEncryptedBalance,
      auditorKey
    );
    const t1 = process.hrtime.bigint();

    const vGas = await verifierGas(
      "transfer",
      await eERC.transferVerifier(),
      proof,
      owner.address
    );

    const tx = await eERC.transfer(u2.address, 0, proof, senderBalancePCT, { gasLimit: 6_000_000 });
    const sub0 = process.hrtime.bigint();
    const rec = await tx.wait(1, 600000);
    const sub1 = process.hrtime.bigint();

    const after1 = await decryptBalance(u1.privateKey, await eERC.balanceOfStandalone(u1.address));
    const after2 = await decryptBalance(u2.privateKey, await eERC.balanceOfStandalone(u2.address));

    record("private_transfer", {
      client_proof_gen_ms: +ms(t0, t1).toFixed(2),
      submit_ms: +ms(sub0, sub1).toFixed(2),
      gas_total: rec!.gasUsed.toString(),
      verifier_gas: vGas,
      amount_wei: sendAmount.toString(),
      sender_delta_wei: (after1 - before1).toString(),
      receiver_delta_wei: (after2 - before2).toString(),
    });
  }

  // ── Reference: plain ERC-20-style transfer for comparison ────────────
  {
    const rec = await (
      await owner.sendTransaction({ to: owner.address, value: 0n })
    ).wait(1, 120000);
    record("plain_transfer_baseline", {
      gas_total: rec!.gasUsed.toString(),
    });
  }

  fs.writeFileSync(
    path.join(__dirname, "../benchmarks/eerc-benchmark.json"),
    JSON.stringify({ chainId: net.chainId.toString(), timestamp: new Date().toISOString(), results }, null, 2)
  );
  console.log("\nJSON:");
  console.log(JSON.stringify(results, null, 2));
};

main().catch((e) => {
  console.error("ERROR:", e.shortMessage || e.message);
  process.exit(1);
});
