# Dexter x402 Facilitator v1 (Solana Mainnet)

# OUTDATED -- SEE V2 GUIDE!

This service wraps the [x402](https://github.com/coinbase/x402) protocol so Dexter can verify and settle paid traffic for Dexter’s premium API endpoints. It exposes the standard facilitator endpoints consumed by the `x402-express` middleware inside `dexter-api`.

## Endpoints
- `GET /healthz` – service status & enabled Solana networks.
- `GET /supported` – supported payment kinds (includes the configured fee payer address).
- `POST /verify` – validates an incoming `PaymentPayload` against the advertised requirements.
- `POST /settle` – signs and submits the transaction on-chain, returning the settlement receipt.

## Getting Started
```bash
cp .env.example .env
# required: HELIUS_API_KEY (mainnet RPC) and SOLANA_PRIVATE_KEY (base58 mainnet fee payer)
npm install
npm run dev
```

The server defaults to `http://localhost:4070` and targets Solana mainnet. Production is mainnet-only; do not configure devnet/testnet for this service.

Base (EVM) settlement is supported when you also provide `BASE_PRIVATE_KEY` (and optionally `BASE_RPC_URL`) and list `base` in `FACILITATOR_NETWORKS`.

### Environment
- `HELIUS_API_KEY` (required): Solana mainnet RPC access; service will refuse to start without it.
- `SOLANA_PRIVATE_KEY` (required for Solana): base58 fee-payer secret.
- `FACILITATOR_NETWORKS`: comma list of enabled mainnet networks (e.g., `solana`, `base`).
- `BASE_PRIVATE_KEY` (required if `base` enabled); `BASE_RPC_URL` optional override.
- `ALLOWED_ORIGINS` (optional): comma list for CORS.
- `PORT`, `LOG_LEVEL` as in `.env.example`.

### Preparing the Solana key
1. Generate or import the Solana fee payer keypair you want to dedicate to x402 settlements.
   ```bash
   solana-keygen new --outfile solana-fee-payer.json
   ```
2. Convert the secret key array to base58 for the facilitator (one-off helper):
   ```bash
   node -e "const fs=require('fs');const {base58}=require('@scure/base');const key=JSON.parse(fs.readFileSync('solana-fee-payer.json'));console.log(base58.encode(Uint8Array.from(key)));"
   ```
3. Copy the printed string into `SOLANA_PRIVATE_KEY` and fund the public address with enough SOL (transaction fees) plus the SPL asset you plan to charge (e.g. USDC mint `EPjFWdd5AufqSSqeM2q1gBcxEzZp3n9Zx6Fh1An7y4`).

## Roadmap
- Add `/discovery` endpoints once we expose a public catalog of paid resources.
- Add metrics and structured tracing before mainnet launch.
