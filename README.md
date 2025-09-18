# Dexter x402 Facilitator (Solana Mainnet)

This service wraps Coinbase's [x402](https://github.com/coinbase/x402) protocol so Dexter can verify and settle Solana-based micropayments for premium API traffic. It exposes the standard facilitator endpoints consumed by the `x402-express` middleware that will sit inside `dexter-api`.

## Endpoints
- `GET /healthz` – service status & enabled Solana networks.
- `GET /supported` – supported payment kinds (includes the configured fee payer address).
- `POST /verify` – validates an incoming `PaymentPayload` against the advertised requirements.
- `POST /settle` – signs and submits the transaction on-chain, returning the settlement receipt.

## Getting Started
```bash
cp .env.example .env
# populate SOLANA_PRIVATE_KEY with a base58-encoded mainnet secret key
npm install
npm run dev
```

The server defaults to `http://localhost:4070` and targets `solana`. If you ever need to run isolated tests, you can temporarily set `FACILITATOR_NETWORKS=solana-devnet`, but production deployments **must** stay on mainnet.

### Preparing the Solana key
1. Generate or import the fee payer keypair you want to dedicate to x402 settlements.
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
- Extend config only if we ever need multi-chain support; currently enforced Solana-only.
- Add metrics and structured tracing before mainnet launch.
