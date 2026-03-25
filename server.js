import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient, createAccount as mkAccount } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { TransactionStatus, isDecidedState } from "genlayer-js/types";

dotenv.config({ override: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const stakebotSource = fs.readFileSync(
  path.join(__dirname, "./contracts/stake.py"),
);

const NETWORK = "testnet-bradbury";
const PRIVATE_KEY = process.env.PRIVATE_KEY?.trim();
const RPC_URL = process.env.RPC_URL?.trim();
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS?.trim() || null;

if (!PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY in .env");
if (!RPC_URL) throw new Error("Missing RPC_URL in .env");

const client = createClient({
  chain: testnetBradbury,
  endpoint: RPC_URL,
  account: mkAccount(PRIVATE_KEY),
});

const app = express();
const port = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());
app.set("json replacer", (_k, v) => (typeof v === "bigint" ? v.toString() : v));
app.use((req, _res, next) => {
  console.log(`→ ${req.method} ${req.path}`);
  next();
});

const ACCEPTED = TransactionStatus.ACCEPTED;
const POLL_INTERVAL_MS = 4000;
const POLL_MAX_ATTEMPTS = 100;

function txStatus(tx) {
  return tx?.statusName || tx?.status_name || null;
}

function isValidTxHash(hash) {
  return typeof hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(hash);
}

function formatChainError(err) {
  return err?.details || err?.shortMessage || err?.message || "Unknown error";
}

function rpcError(err) {
  return {
    name: err?.name ?? null,
    details: err?.details || err?.message || null,
    cause: err?.cause
      ? {
          name: err.cause?.name ?? null,
          details: err.cause?.details || err.cause?.message || null,
        }
      : null,
  };
}

function deployedAddress(receipt) {
  return (
    receipt?.txDataDecoded?.contractAddress ||
    receipt?.data?.contract_address ||
    null
  );
}

async function waitForAcceptedOrTerminal(
  hash,
  label,
  { logStatus = true } = {},
) {
  for (let i = 1; i <= POLL_MAX_ATTEMPTS; i += 1) {
    try {
      return await client.waitForTransactionReceipt({
        hash,
        status: ACCEPTED,
        retries: 1,
        interval: POLL_INTERVAL_MS,
      });
    } catch {
      // keep polling
    }

    let tx;
    try {
      tx = await client.getTransaction({ hash });
    } catch {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }

    const status = txStatus(tx);
    if (status && isDecidedState(status) && status !== ACCEPTED) {
      throw new Error(`Transaction ${hash} ended in terminal state: ${status}`);
    }
    if (logStatus) {
      console.log(
        `[${label}] status: ${status ?? "unknown"} (${i}/${POLL_MAX_ATTEMPTS})`,
      );
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Transaction ${hash} did not reach ACCEPTED`);
}

async function readLastReview(address) {
  const raw = await client.readContract({
    address,
    functionName: "get_last_review",
    args: [],
  });

  if (raw instanceof Map) {
    return {
      decision: raw.get("decision") ?? null,
      explanation: raw.get("explanation") ?? null,
    };
  }
  if (raw && typeof raw === "object") {
    return {
      decision: raw.decision ?? null,
      explanation: raw.explanation ?? null,
    };
  }
  return { decision: null, explanation: null };
}

let reviewInFlight = false;

app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    network: NETWORK,
    rpcUrl: RPC_URL,
    consensusMainContract:
      testnetBradbury?.consensusMainContract?.address || null,
    predeployedContract: CONTRACT_ADDRESS,
    timestamp: new Date().toISOString(),
  }),
);

app.post("/review", async (req, res) => {
  const description =
    typeof req.body?.description === "string"
      ? req.body.description.trim()
      : "";
  if (!description)
    return res.status(400).json({ error: "Missing or invalid `description`" });
  if (reviewInFlight)
    return res.status(429).json({ error: "Review already in progress" });

  let deployTxHash = null;
  let contractAddress = CONTRACT_ADDRESS;
  reviewInFlight = true;
  try {
    if (!contractAddress) {
      deployTxHash = await client.deployContract({
        code: stakebotSource,
        args: [],
        leaderOnly: false,
      });
      console.log("[/review deploy] tx hash:", deployTxHash);
      const deployReceipt = await waitForAcceptedOrTerminal(
        deployTxHash,
        "/review deploy",
        { logStatus: false },
      );
      contractAddress = deployedAddress(deployReceipt);
      if (!contractAddress)
        throw new Error("No deployed contract address in receipt");
      console.log("[/review deploy] contract:", contractAddress);
    }

    const txHash = await client.writeContract({
      address: contractAddress,
      functionName: "review_image",
      args: [description],
      value: 0,
    });
    console.log("[/review write] tx hash:", txHash);
    await waitForAcceptedOrTerminal(txHash, "/review write");

    let decision = null;
    let explanation = null;
    let readContractError = null;
    try {
      ({ decision, explanation } = await readLastReview(contractAddress));
    } catch (err) {
      readContractError = err?.message || String(err);
    }

    return res.json({
      contractAddress,
      deployTxHash,
      txHash,
      decision,
      explanation,
      pending: decision === null && explanation === null,
      readContractError,
    });
  } catch (err) {
    return res.status(502).json({
      error: "Review failed",
      reason: formatChainError(err),
      rpcError: rpcError(err),
      deployTxHash,
      contractAddress,
    });
  } finally {
    reviewInFlight = false;
  }
});

app.get("/tx/:hash", async (req, res) => {
  const { hash } = req.params;
  if (!isValidTxHash(hash)) {
    return res.status(400).json({ error: "Invalid transaction hash" });
  }
  try {
    const tx = await client.getTransaction({ hash });
    if (!tx) return res.status(404).json({ error: "Transaction not found" });

    const status = txStatus(tx);
    const contractAddress = tx?.recipient || tx?.to_address || null;
    let decision = null;
    let explanation = null;
    let readContractError = null;

    if (contractAddress && (status === "ACCEPTED" || status === "FINALIZED")) {
      try {
        ({ decision, explanation } = await readLastReview(contractAddress));
      } catch (err) {
        readContractError = err?.message || String(err);
      }
    }

    return res.json({
      txHash: hash,
      status,
      contractAddress,
      decision,
      explanation,
      pending: decision === null && explanation === null,
      readContractError,
    });
  } catch (err) {
    return res.status(502).json({
      error: "Unable to fetch transaction",
      reason: formatChainError(err),
      rpcError: rpcError(err),
    });
  }
});

app.get("/tx/:hash/debug", async (req, res) => {
  const { hash } = req.params;
  if (!isValidTxHash(hash)) {
    return res.status(400).json({ error: "Invalid transaction hash" });
  }
  try {
    const tx = await client.getTransaction({ hash });
    if (!tx) return res.status(404).json({ error: "Transaction not found" });

    let receipt = null;
    try {
      receipt = await client.waitForTransactionReceipt({
        hash,
        status: ACCEPTED,
        retries: 1,
        interval: 1000,
        fullTransaction: true,
      });
    } catch {
      // allow incomplete tx data during debugging
    }

    let readContractResult = null;
    let readContractError = null;
    const contractAddress = tx?.recipient || tx?.to_address || null;
    if (contractAddress) {
      try {
        readContractResult = await client.readContract({
          address: contractAddress,
          functionName: "get_last_review",
          args: [],
        });
      } catch (err) {
        readContractError = err?.message || String(err);
      }
    }

    return res.json({
      txHash: hash,
      tx,
      receipt,
      readContractResult,
      readContractError,
    });
  } catch (err) {
    return res.status(502).json({
      error: "Debug fetch failed",
      reason: formatChainError(err),
      rpcError: rpcError(err),
    });
  }
});


app.listen(port, () => {
    console.log(`API listening on http://localhost:${port}`);
    console.log(`Network: ${NETWORK}`);
    console.log(`RPC: ${RPC_URL}`);
    console.log(`Key loaded: ${Boolean(PRIVATE_KEY)}`);
    console.log(`Pre-deployed contract: ${CONTRACT_ADDRESS || "(none)"}`);
  });