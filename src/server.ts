import express, { Request, Response } from "express";
import cors from "cors";
import { verify, settle } from "x402/facilitator";
import {
  PaymentPayloadSchema,
  PaymentRequirementsSchema,
  SupportedPaymentKind,
  SupportedSVMNetworks,
  createSigner,
  isSvmSignerWallet,
} from "x402/types";
import { env } from "./config.js";

const logger = {
  info: (...args: unknown[]) => console.log("[x402-facilitator]", ...args),
  error: (...args: unknown[]) => console.error("[x402-facilitator]", ...args),
};

type SolanaNetwork = (typeof SupportedSVMNetworks)[number];
type SvmSigner = Awaited<ReturnType<typeof createSigner>>;

const allowedNetworks = new Set<SolanaNetwork>(
  env.FACILITATOR_NETWORKS.map(network => {
    if (!SupportedSVMNetworks.includes(network as SolanaNetwork)) {
      throw new Error(`Unsupported network configured: ${network}`);
    }
    return network as SolanaNetwork;
  }),
);

const signerCache = new Map<SolanaNetwork, Promise<SvmSigner>>();

function resolveNetwork(network: string): SolanaNetwork {
  if (!allowedNetworks.has(network as SolanaNetwork)) {
    throw new Error(`Network ${network} is not enabled for this facilitator`);
  }
  return network as SolanaNetwork;
}

async function getSigner(network: SolanaNetwork): Promise<SvmSigner> {
  if (!signerCache.has(network)) {
    signerCache.set(network, createSigner(network, env.SOLANA_PRIVATE_KEY));
  }
  return signerCache.get(network)!;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

if (env.ALLOWED_ORIGINS) {
  const origins = env.ALLOWED_ORIGINS.split(",").map(origin => origin.trim()).filter(Boolean);
  if (origins.length) {
    app.use(cors({ origin: origins }));
  }
}

app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok", networks: Array.from(allowedNetworks) });
});

app.get("/supported", async (_req, res) => {
  try {
    const kinds: SupportedPaymentKind[] = [];
    for (const network of allowedNetworks) {
      const signer = await getSigner(network);
      const feePayer = isSvmSignerWallet(signer) ? signer.address : undefined;
      kinds.push({
        x402Version: 1,
        scheme: "exact",
        network,
        extra: feePayer ? { feePayer } : undefined,
      });
    }
    res.json({ kinds });
  } catch (error) {
    logger.error("failed to build supported network list", error);
    res.status(500).json({ error: getErrorMessage(error) });
  }
});

type VerifyBody = {
  paymentPayload: unknown;
  paymentRequirements: unknown;
};

app.post("/verify", async (req: Request<unknown, unknown, VerifyBody>, res: Response) => {
  try {
    const paymentRequirements = PaymentRequirementsSchema.parse(req.body.paymentRequirements);
    const paymentPayload = PaymentPayloadSchema.parse(req.body.paymentPayload);

    const network = resolveNetwork(paymentRequirements.network);
    const signer = await getSigner(network);
    const result = await verify(signer, paymentPayload, paymentRequirements);
    return res.json(result);
  } catch (error) {
    logger.error("verify failed", error);
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

app.post("/settle", async (req: Request<unknown, unknown, VerifyBody>, res: Response) => {
  try {
    const paymentRequirements = PaymentRequirementsSchema.parse(req.body.paymentRequirements);
    const paymentPayload = PaymentPayloadSchema.parse(req.body.paymentPayload);

    const network = resolveNetwork(paymentRequirements.network);
    const signer = await getSigner(network);

    if (!isSvmSignerWallet(signer)) {
      throw new Error("Configured Solana signer does not expose a wallet address");
    }

    const result = await settle(signer, paymentPayload, paymentRequirements);
    return res.json(result);
  } catch (error) {
    logger.error("settle failed", error);
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

app.use((error: Error, _req: Request, res: Response) => {
  logger.error("Unhandled facilitator error", error);
  res.status(500).json({ error: "Internal server error" });
});

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "Unknown error";
}

const port = env.PORT;
app.listen(port, () => {
  logger.info({ port, networks: Array.from(allowedNetworks) }, "Solana x402 facilitator listening");
});

export { app };
