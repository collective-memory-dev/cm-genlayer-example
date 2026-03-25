# cm-genlayer-example

A small **Express** service that talks to [GenLayer](https://genlayer.com) on **Testnet Bradbury**. It deploys (or reuses) an on-chain **StakeBot** contract that uses an LLM to classify a text **image description** as “stake” or “do not stake”, then exposes the result over HTTP.

## What it does

1. **`POST /review`** — Optionally deploys `contracts/stake.py` if no address is configured, then calls `review_image(description)` on the contract.
2. The Python contract runs a prompt, uses `gl.eq_principle.prompt_comparative` for consistency, and stores the latest `decision` and `explanation` on-chain.
3. The server polls until transactions reach **ACCEPTED**, then reads `get_last_review` and returns JSON.

## Requirements

- **Node.js** (18+ recommended; project uses ES modules via `"type": "module"`)

## Setup

```bash
npm install
```

Create a `.env` file in the project root (see [Environment variables](#environment-variables)). Never commit real keys; `.env` is listed in `.gitignore`.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PRIVATE_KEY` | Yes | Wallet private key used by `genlayer-js` (`createAccount`). |
| `RPC_URL` | Yes | GenLayer RPC endpoint URL for Testnet Bradbury. |
| `CONTRACT_ADDRESS` | No | If set, the server skips deploy and uses this contract for reviews. |
| `PORT` | No | HTTP port (default `3000`). |

Example shape (use your own values):

```env
PRIVATE_KEY=0x...
RPC_URL=https://...
CONTRACT_ADDRESS=
PORT=3000
```

## Run

```bash
npm start
```

The server logs the listening URL, network, RPC, and whether a pre-deployed contract is configured.

## HTTP API

### `GET /health`

Liveness and configuration snapshot: `ok`, `network`, `rpcUrl`, consensus contract address, optional `predeployedContract`, `timestamp`.

### `POST /review`

Body (JSON):

```json
{ "description": "A short text description of the image content." }
```

- Returns **400** if `description` is missing or not a non-empty string.
- Returns **429** if a review is already in progress (single-flight lock).
- Returns **502** on chain/RPC failure with `reason` and optional `rpcError`.

Success payload includes:

- `contractAddress` — Contract used for this review  
- `deployTxHash` — Set only when a new contract was deployed in this request  
- `txHash` — `review_image` transaction  
- `decision` — `"stake"` or `"do not stake"` (or `null` if read failed)  
- `explanation` — Short rationale string  
- `pending` — `true` when both decision and explanation could not be read  
- `readContractError` — Present if `get_last_review` failed after the write  

### `GET /tx/:hash`

Looks up a transaction by **0x-prefixed 64-hex** hash. If the tx is to a contract and status is `ACCEPTED` or `FINALIZED`, it also tries to read `get_last_review` for that contract address.

### `GET /tx/:hash/debug`

Same hash validation; returns raw `tx`, optional `receipt`, raw `readContractResult` from `get_last_review`, and any read error. Useful for troubleshooting.

## Contract (`contracts/stake.py`)

- **Class:** `StakeBot` — GenLayer `gl.Contract` with `last_decision` and `last_explanation` storage.
- **`review_image(description)`** — Builds a prompt, runs `gl.nondet.exec_prompt`, then `gl.eq_principle.prompt_comparative` so the **decision** field matches across validators. Parses JSON (with fallbacks), normalizes to `"stake"` / `"do not stake"`, and stores the result.
- **`get_last_review()`** — View returning `{ "decision", "explanation" }`.

The server reads the contract source at startup and passes it to `deployContract({ code: stakebotSource, ... })` when no `CONTRACT_ADDRESS` is set.

## Scripts

| Script | Command |
|--------|---------|
| Start server | `npm start` |