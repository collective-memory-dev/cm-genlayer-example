import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient, createAccount as mkAccount } from "genlayer-js";
import { studionet, testnetBradbury } from "genlayer-js/chains";
import {
  TransactionStatus,
  isDecidedState,
  ExecutionResult,
} from "genlayer-js/types";

dotenv.config({ override: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const validatorSource = fs.readFileSync(
  path.join(__dirname, "./contracts/validator.py"),
);

/** @type {"studionet" | "testnet-bradbury"} */
const GENLAYER_CHAIN = (process.env.GENLAYER_CHAIN || "testnet-bradbury")
  .trim()
  .toLowerCase()
  .replace(/_/g, "-");

const chain =
  GENLAYER_CHAIN === "studionet"
    ? studionet
    : GENLAYER_CHAIN === "testnet-bradbury"
      ? testnetBradbury
      : null;

if (!chain) {
  throw new Error(
    `Unknown GENLAYER_CHAIN "${process.env.GENLAYER_CHAIN}". Use: studionet | testnet-bradbury`,
  );
}

const NETWORK = GENLAYER_CHAIN;
const PRIVATE_KEY = process.env.PRIVATE_KEY?.trim();
const RPC_URL = process.env.RPC_URL?.trim();
const VALIDATOR_CONTRACT_ADDRESS =
  process.env.VALIDATOR_CONTRACT_ADDRESS?.trim() || null;

if (!PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY in .env");
if (!RPC_URL) throw new Error("Missing RPC_URL in .env");

const client = createClient({
  chain,
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
/** Testnet deploy/consensus can exceed several minutes; tune via env. */
const POLL_INTERVAL_MS = Math.max(
  1000,
  Number.parseInt(process.env.GENLAYER_POLL_INTERVAL_MS || "4000", 10) || 4000,
);
const POLL_MAX_ATTEMPTS = Math.max(
  10,
  Number.parseInt(process.env.GENLAYER_POLL_MAX_ATTEMPTS || "200", 10) || 200,
);

function txStatus(tx) {
  return tx?.statusName || tx?.status_name || null;
}

/** Contract state for `gen_call` reads is only available once the tx has been accepted (or finalized). */
function canReadContractState(status) {
  return status === "ACCEPTED" || status === "FINALIZED";
}

const FAILED_STATUSES = new Set([
  "LEADER_TIMEOUT",
  "VALIDATORS_TIMEOUT",
  "UNDETERMINED",
  "CANCELED",
]);

function isFailedStatus(status) {
  return FAILED_STATUSES.has(status);
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
    shortMessage: err?.shortMessage ?? null,
    details: err?.details || err?.message || null,
    code: err?.code ?? null,
    metaMessages: Array.isArray(err?.metaMessages) ? err.metaMessages : null,
    cause: err?.cause
      ? {
          name: err.cause?.name ?? null,
          shortMessage: err.cause?.shortMessage ?? null,
          details: err.cause?.details || err.cause?.message || null,
          code: err.cause?.code ?? null,
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

function stateVariantForStatus(status) {
  if (status === "FINALIZED") return "latest-final";
  return "latest-nonfinal";
}

function executionSucceeded(tx) {
  return tx?.txExecutionResultName === ExecutionResult.FINISHED_WITH_RETURN;
}

function executionFailed(tx) {
  return tx?.txExecutionResultName === ExecutionResult.FINISHED_WITH_ERROR;
}

function extractValidationFromReturnData(hexData) {
  if (!hexData || typeof hexData !== "string") return null;
  try {
    const buf = Buffer.from(hexData.replace(/^0x/, ""), "hex");

    const strings = [];
    let current = "";
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      if (b >= 0x20 && b <= 0x7e) {
        current += String.fromCharCode(b);
      } else {
        if (current.length >= 3) strings.push(current);
        current = "";
      }
    }
    if (current.length >= 3) strings.push(current);

    let decision = null;
    let summary = null;

    for (const s of strings) {
      const lower = s.toLowerCase();
      if (
        !decision &&
        (lower === "authentic" ||
          lower === "suspicious" ||
          lower === "inconclusive")
      ) {
        decision = lower;
      }
    }

    const longStrings = strings
      .filter((s) => s.length > 30)
      .sort((a, b) => b.length - a.length);
    if (longStrings.length > 0) {
      summary = longStrings[0];
    }

    if (!decision) return null;

    return {
      decision,
      confidence: null,
      summary,
      contextCount: null,
      _source: "trace_return_data",
    };
  } catch {
    return null;
  }
}

async function readContractSafe({ address, functionName, args, status }) {
  const primary = stateVariantForStatus(status);
  const fallback =
    primary === "latest-final" ? "latest-nonfinal" : "latest-final";

  try {
    return await client.readContract({
      address,
      functionName,
      args,
      transactionHashVariant: primary,
    });
  } catch (primaryErr) {
    try {
      return await client.readContract({
        address,
        functionName,
        args,
        transactionHashVariant: fallback,
      });
    } catch (fallbackErr) {
      throw new Error(
        `readContract failed. primary="${primary}" err="${formatChainError(primaryErr)}" fallback="${fallback}" err="${formatChainError(fallbackErr)}"`,
      );
    }
  }
}

async function readLastValidation(address, status = "ACCEPTED") {
  const raw = await readContractSafe({
    address,
    functionName: "get_last_validation",
    args: [],
    status,
  });

  if (raw instanceof Map) {
    return {
      decision: raw.get("decision") ?? null,
      confidence: raw.get("confidence") ?? null,
      summary: raw.get("summary") ?? null,
      contextCount: raw.get("context_count") ?? null,
    };
  }
  if (raw && typeof raw === "object") {
    return {
      decision: raw.decision ?? null,
      confidence: raw.confidence ?? null,
      summary: raw.summary ?? null,
      contextCount: raw.context_count ?? null,
    };
  }
  return {
    decision: null,
    confidence: null,
    summary: null,
    contextCount: null,
  };
}

function normalizeMemoryInput(memory, label) {
  if (!memory || typeof memory !== "object" || Array.isArray(memory)) {
    throw new Error(`${label} must be an object`);
  }
  const description =
    typeof memory.description === "string" ? memory.description.trim() : "";
  const city = typeof memory.city === "string" ? memory.city.trim() : "";
  const country =
    typeof memory.country === "string" ? memory.country.trim() : "";
  const capturedAt =
    typeof memory.captured_at === "string" ? memory.captured_at.trim() : "";
  const mediaTypeRaw =
    typeof memory.media_type === "string"
      ? memory.media_type.trim().toLowerCase()
      : "";

  if (!description) throw new Error(`${label}.description is required`);
  if (!city) throw new Error(`${label}.city is required`);
  if (!country) throw new Error(`${label}.country is required`);
  if (!capturedAt) throw new Error(`${label}.captured_at is required`);
  if (!mediaTypeRaw) throw new Error(`${label}.media_type is required`);
  if (!["image", "video"].includes(mediaTypeRaw)) {
    throw new Error(`${label}.media_type must be "image" or "video"`);
  }
  return {
    description,
    city,
    country,
    captured_at: capturedAt,
    media_type: mediaTypeRaw,
  };
}

app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    network: NETWORK,
    rpcUrl: RPC_URL,
    consensusMainContract: chain?.consensusMainContract?.address || null,
    chainId: chain?.id ?? null,
    poll: { intervalMs: POLL_INTERVAL_MS, maxAttempts: POLL_MAX_ATTEMPTS },
    validator: {
      predeployedContract: VALIDATOR_CONTRACT_ADDRESS,
    },
    timestamp: new Date().toISOString(),
  }),
);

app.post("/validator/deploy", async (_req, res) => {
  try {
    const deployTxHash = await client.deployContract({
      code: validatorSource,
      args: [],
      leaderOnly: false,
    });
    console.log("[/validator/deploy] tx hash:", deployTxHash);
    const receipt = await waitForAcceptedOrTerminal(
      deployTxHash,
      "/validator/deploy",
      { logStatus: false },
    );
    const contractAddress = deployedAddress(receipt);
    if (!contractAddress) {
      throw new Error("No deployed validator contract address in receipt");
    }
    console.log("[/validator/deploy] contract:", contractAddress);
    return res.json({ contractAddress, deployTxHash });
  } catch (err) {
    return res.status(502).json({
      error: "Validator deploy failed",
      reason: formatChainError(err),
      rpcError: rpcError(err),
    });
  }
});

app.post("/validator/submit", async (req, res) => {
  let targetMemory;
  let contextMemories;
  try {
    targetMemory = normalizeMemoryInput(req.body?.targetMemory, "targetMemory");
    if (!Array.isArray(req.body?.contextMemories)) {
      return res.status(400).json({
        error: "contextMemories must be an array",
      });
    }
    if (req.body.contextMemories.length > 10) {
      return res.status(400).json({ error: "contextMemories max size is 10" });
    }
    contextMemories = req.body.contextMemories.map((item, index) =>
      normalizeMemoryInput(item, `contextMemories[${index}]`),
    );
  } catch (err) {
    return res.status(400).json({
      error: err?.message || "Invalid validator payload",
    });
  }

  const customPrompt =
    typeof req.body?.customPrompt === "string" ? req.body.customPrompt : "";
  if (customPrompt.length > 2000) {
    return res
      .status(400)
      .json({ error: "customPrompt max length is 2000 characters" });
  }

  const contractAddress = VALIDATOR_CONTRACT_ADDRESS;
  if (!contractAddress) {
    return res.status(400).json({
      error:
        "Missing VALIDATOR_CONTRACT_ADDRESS. Deploy validator first and set it in .env.",
    });
  }

  const payloadJson = JSON.stringify({ targetMemory, contextMemories });
  console.log(
    "[/validator/submit] payload length:",
    payloadJson.length,
    "customPrompt length:",
    customPrompt.length,
  );
  console.log("[/validator/submit] contract:", contractAddress);

  try {
    const txHash = await client.writeContract({
      address: contractAddress,
      functionName: "validate_user_content",
      args: [payloadJson, customPrompt],
      value: 0,
    });
    console.log("[/validator/submit] txHash:", txHash);

    return res.status(202).json({
      contractAddress,
      txHash,
      pending: true,
      message:
        "Transaction submitted. Poll GET /validator/tx/:hash for results.",
    });
  } catch (err) {
    console.error(
      "[/validator/submit] error:",
      JSON.stringify(err, Object.getOwnPropertyNames(err), 2),
    );
    return res.status(502).json({
      error: "Validator submit failed",
      reason: formatChainError(err),
      rpcError: rpcError(err),
      contractAddress,
    });
  }
});

app.get("/validator/tx/:hash", async (req, res) => {
  const { hash } = req.params;
  if (!isValidTxHash(hash)) {
    return res.status(400).json({ error: "Invalid transaction hash" });
  }
  try {
    const tx = await client.getTransaction({ hash });
    if (!tx) return res.status(404).json({ error: "Transaction not found" });

    const status = txStatus(tx);
    const contractAddress = tx?.recipient || tx?.to_address || null;
    const execResult = tx?.txExecutionResultName ?? null;
    let decision = null;
    let confidence = null;
    let summary = null;
    let contextCount = null;
    let readContractError = null;
    let readSkippedReason = null;

    if (isFailedStatus(status)) {
      readSkippedReason = `Transaction failed with status "${status}". No output produced.`;
    } else if (executionFailed(tx)) {
      readSkippedReason = `Contract execution failed (txExecutionResult=${execResult}). State was not modified. Use /validator/tx/:hash/trace to inspect the error.`;
    } else if (contractAddress && canReadContractState(status)) {
      if (executionSucceeded(tx) || execResult === null) {
        try {
          ({ decision, confidence, summary, contextCount } =
            await readLastValidation(contractAddress, status));
        } catch (err) {
          readContractError = err?.message || String(err);

          // Fallback: extract result from trace return_data when readContract fails
          try {
            const trace = await client.debugTraceTransaction({
              hash,
              round: 0,
            });
            if (trace?.result_code === 0 && trace?.return_data) {
              const extracted = extractValidationFromReturnData(
                trace.return_data,
              );
              if (extracted) {
                decision = extracted.decision;
                confidence = extracted.confidence;
                summary = extracted.summary;
                contextCount = extracted.contextCount;
                readContractError += " [recovered from trace]";
              }
            }
          } catch {
            // trace fallback failed silently
          }
        }
      } else {
        readSkippedReason = `Execution result is "${execResult}". Skipping state read.`;
      }
    } else if (contractAddress && status) {
      readSkippedReason = `readContract not attempted: transaction status is "${status}". State reads require ACCEPTED or FINALIZED. Poll GET /validator/tx/:hash until status changes.`;
    }

    const isFinal = canReadContractState(status) || isFailedStatus(status);

    return res.json({
      txHash: hash,
      status,
      contractAddress,
      executionResult: execResult,
      decision,
      confidence,
      summary,
      contextCount,
      pending: isFinal ? false : decision === null && summary === null,
      readContractError,
      readSkippedReason,
    });
  } catch (err) {
    return res.status(502).json({
      error: "Unable to fetch validator transaction",
      reason: formatChainError(err),
      rpcError: rpcError(err),
    });
  }
});

app.get("/validator/tx/:hash/debug", async (req, res) => {
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
    let readSkippedReason = null;
    const status = txStatus(tx);
    const contractAddress = tx?.recipient || tx?.to_address || null;
    if (contractAddress) {
      if (canReadContractState(status)) {
        try {
          readContractResult = await client.readContract({
            address: contractAddress,
            functionName: "get_last_validation",
            args: [],
          });
        } catch (err) {
          readContractError = err?.message || String(err);
        }
      } else {
        readSkippedReason = `readContract was skipped: status is "${status ?? "unknown"}". While the tx is e.g. PROPOSING or PENDING, the RPC returns "can not get contract state". Wait until status is ACCEPTED, then read again.`;
      }
    }

    return res.json({
      txHash: hash,
      executionResult: tx?.txExecutionResultName ?? null,
      tx,
      receipt,
      readContractResult,
      readContractError,
      readSkippedReason,
    });
  } catch (err) {
    return res.status(502).json({
      error: "Validator debug fetch failed",
      reason: formatChainError(err),
      rpcError: rpcError(err),
    });
  }
});

app.get("/validator/tx/:hash/trace", async (req, res) => {
  const { hash } = req.params;
  if (!isValidTxHash(hash)) {
    return res.status(400).json({ error: "Invalid transaction hash" });
  }
  try {
    const trace = await client.debugTraceTransaction({ hash, round: 0 });
    return res.json({ txHash: hash, trace });
  } catch (err) {
    return res.status(502).json({
      error: "Trace failed",
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
  console.log(
    `Pre-deployed validator contract: ${VALIDATOR_CONTRACT_ADDRESS || "(none)"}`,
  );
});
