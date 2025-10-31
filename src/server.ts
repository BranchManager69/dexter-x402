import express, { NextFunction, Request, Response } from "express";
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
import { $, bold, cyan, dim, gray, green, magenta, red, underline, yellow } from "kleur/colors";
import { env } from "./config.js";

type LogLevel = "info" | "error";
type ParsedPaymentRequirements = ReturnType<typeof PaymentRequirementsSchema.parse>;

const LOG_PREFIX = "[x402]";
const MAX_DETAIL_LINES = 4;

$.enabled = true;

function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string") {
    return value.includes(" ") ? `"${value}"` : value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value);
  }
}

function levelColor(level: LogLevel) {
  return level === "error" ? red : green;
}

function logLine(
  level: LogLevel,
  message: string,
  meta?: Record<string, unknown>,
  error?: unknown,
) {
  const iso = new Date().toISOString();
  const header = `${dim(LOG_PREFIX)} ${dim(iso)} ${levelColor(level)(level.toUpperCase())} ${message}`;
  const details: string[] = [];

  if (meta && Object.keys(meta).length) {
    const entries = Object.entries(meta).slice(0, MAX_DETAIL_LINES);
    for (const [label, value] of entries) {
      details.push(`  ${dim("•")} ${gray(label.padEnd(11))}${formatValue(value)}`);
    }
  }

  const output = [header, ...details].join("\n");

  if (level === "error") {
    console.error(output);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    } else if (error && typeof error !== "undefined") {
      console.error(formatValue(error));
    }
  } else {
    console.log(output);
  }
}

const logger = {
  info: (...args: unknown[]) => {
    if (args.length === 1 && typeof args[0] === "string") {
      logLine("info", args[0] as string);
      return;
    }

    let message = "";
    const meta: Record<string, unknown> = {};

    for (const arg of args) {
      if (typeof arg === "string") {
        message = message ? `${message} ${arg}` : arg;
      } else if (arg && typeof arg === "object") {
        Object.assign(meta, arg as Record<string, unknown>);
      }
    }

    logLine("info", message, Object.keys(meta).length ? meta : undefined);
  },
  error: (...args: unknown[]) => {
    let message = "";
    const meta: Record<string, unknown> = {};
    let err: unknown;

    for (const arg of args) {
      if (typeof arg === "string") {
        message = message ? `${message} ${arg}` : arg;
      } else if (arg instanceof Error) {
        err = arg;
      } else if (arg && typeof arg === "object") {
        Object.assign(meta, arg as Record<string, unknown>);
      }
    }

    logLine("error", message, Object.keys(meta).length ? meta : undefined, err);
  },
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

const DEFAULT_DECIMALS = 6;
const MS_IN_DAY = 24 * 60 * 60 * 1000;

type SettlementEntry = {
  timestamp: number;
  asset: string;
  decimals: number;
  amountAtomic: bigint;
};

type RollingTotals = Map<string, { asset: string; decimals: number; amountAtomic: bigint }>;

const settlementWindow: SettlementEntry[] = [];

const KNOWN_ASSET_LABELS = new Map<string, string>([
  ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "USDC"],
  ["So11111111111111111111111111111111111111112", "SOL"],
]);

type StructuredField = { label: string; value: string };

function shortenResource(resource: string | undefined): string {
  if (!resource) return "unknown";
  try {
    const parsed = new URL(resource);
    return parsed.pathname || parsed.href;
  } catch (_error) {
    return resource;
  }
}

function emitStructuredLog(level: LogLevel, title: string, fields: StructuredField[]) {
  const timestamp = new Date().toISOString();
  const header =
    `${dim(LOG_PREFIX)} ${dim(timestamp)} ${levelColor(level)(level.toUpperCase())} ${title}`;

  const detailLines = fields
    .slice(0, MAX_DETAIL_LINES)
    .map(({ label, value }) => `  ${dim("•")} ${gray(label.padEnd(11))}${value}`);

  const output = [header, ...detailLines].join("\n");
  if (level === "error") {
    console.error(output);
  } else {
    console.log(output);
  }
}

function resolveAssetInfo(paymentRequirements: ParsedPaymentRequirements): { asset: string; decimals: number } {
  const assetField = paymentRequirements.asset as Record<string, unknown> | string | undefined;
  const extra = paymentRequirements.extra as Record<string, unknown> | undefined;
  const extraDecimals =
    typeof extra?.assetDecimals === "number" ? (extra.assetDecimals as number) : undefined;

  if (assetField && typeof assetField === "object" && "address" in assetField) {
    const address = String(((assetField as { address?: unknown }).address as string | undefined) ?? "unknown");
    const decimalsCandidate =
      extraDecimals ??
      (typeof (assetField as { decimals?: unknown }).decimals === "number"
        ? ((assetField as { decimals?: unknown }).decimals as number)
        : DEFAULT_DECIMALS);
    return { asset: address, decimals: decimalsCandidate };
  }

  if (typeof assetField === "string" && assetField.trim().length) {
    return { asset: assetField, decimals: extraDecimals ?? DEFAULT_DECIMALS };
  }

  return { asset: "unknown", decimals: extraDecimals ?? DEFAULT_DECIMALS };
}

function assetLabel(address: string): string {
  if (!address || address === "unknown") {
    return "unknown";
  }
  const known = KNOWN_ASSET_LABELS.get(address);
  if (known) return known;
  if (address.length <= 9) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function safeParseAtomic(raw: unknown): bigint | null {
  if (raw === null || raw === undefined) return null;
  try {
    if (typeof raw === "bigint") return raw;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return BigInt(Math.trunc(raw));
    }
    const text = String(raw).trim();
    if (!text) return null;
    return BigInt(text);
  } catch (_error) {
    return null;
  }
}

function formatAtomicAmount(amountAtomic: bigint, decimals: number): string {
  if (decimals <= 0) {
    return amountAtomic.toString();
  }

  const divisor = BigInt(10) ** BigInt(decimals);
  const negative = amountAtomic < 0n;
  const abs = negative ? -amountAtomic : amountAtomic;
  const whole = abs / divisor;
  const fraction = abs % divisor;
  const padded = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  const base = padded ? `${whole.toString()}.${padded}` : whole.toString();
  return negative ? `-${base}` : base;
}

function pruneSettlementWindow(now: number) {
  const cutoff = now - MS_IN_DAY;
  while (settlementWindow.length && settlementWindow[0].timestamp < cutoff) {
    settlementWindow.shift();
  }
}

function recordSettlement(now: number, asset: string, decimals: number, amountAtomic: bigint): {
  totals: RollingTotals;
  count: number;
} {
  settlementWindow.push({ timestamp: now, asset, decimals, amountAtomic });
  pruneSettlementWindow(now);

  const totals: RollingTotals = new Map();
  for (const entry of settlementWindow) {
    const key = `${entry.asset}|${entry.decimals}`;
    const existing = totals.get(key);
    if (existing) {
      existing.amountAtomic += entry.amountAtomic;
    } else {
      totals.set(key, {
        asset: entry.asset,
        decimals: entry.decimals,
        amountAtomic: entry.amountAtomic,
      });
    }
  }

  return { totals, count: settlementWindow.length };
}

function formatVolumeSummary(totals: RollingTotals): string {
  if (!totals.size) {
    return `${dim("volume")} ${yellow("0")}`;
  }

  const parts = Array.from(totals.values()).map(entry => {
    const amount = formatAtomicAmount(entry.amountAtomic, entry.decimals);
    return `${yellow(amount)} ${assetLabel(entry.asset)}`;
  });

  return `${dim("volume")} ${parts.join(dim(" + "))}`;
}

function buildSolscanLink(signature: string | null | undefined, network: string): string | null {
  if (!signature) return null;
  const base = `https://solscan.io/tx/${signature}`;
  if (network === "solana") return base;
  if (network === "solana-devnet") return `${base}?cluster=devnet`;
  return base;
}

function logVerificationEvent(paymentRequirements: ParsedPaymentRequirements) {
  const { asset, decimals } = resolveAssetInfo(paymentRequirements);
  const amountAtomic = safeParseAtomic(paymentRequirements.maxAmountRequired);
  const amountUi =
    amountAtomic !== null
      ? formatAtomicAmount(amountAtomic, decimals)
      : paymentRequirements.maxAmountRequired;

  const resourceUrl = paymentRequirements.resource ?? "unknown";
  const resourcePath = shortenResource(resourceUrl);
  const header =
    `${magenta("VERIFY")} ${bold(resourcePath)} ${dim(`[${paymentRequirements.network}]`)} ${green("✓")}`;

  const amountLine =
    amountAtomic !== null
      ? `${yellow(amountUi)} ${assetLabel(asset)} ${dim(`(${amountAtomic.toString()})`)}`
      : `${yellow(amountUi)} ${assetLabel(asset)}`;

  const assetLine =
    asset === "unknown"
      ? gray("unknown asset")
      : `${assetLabel(asset)} ${dim(`(${asset})`)}`;

  const fields: StructuredField[] = [
    { label: "resource", value: `${cyan(resourceUrl)} ${dim(`[${paymentRequirements.network}]`)}` },
    { label: "amount", value: amountLine },
    { label: "asset", value: assetLine },
  ];

  if (paymentRequirements.description) {
    fields.push({ label: "detail", value: paymentRequirements.description });
  }

  emitStructuredLog("info", header, fields);
}

function logSettlementEvent(paymentRequirements: ParsedPaymentRequirements, transaction: string | null | undefined) {
  const { asset, decimals } = resolveAssetInfo(paymentRequirements);
  const amountAtomic = safeParseAtomic(paymentRequirements.maxAmountRequired);
  const now = Date.now();
  let totalsSummary = `${dim("volume")} ${yellow("0")}`;
  let countSummary = `${dim("count")} ${yellow("0")}`;

  if (amountAtomic !== null) {
    const { totals, count } = recordSettlement(now, asset, decimals, amountAtomic);
    totalsSummary = formatVolumeSummary(totals);
    countSummary = `${dim("count")} ${yellow(String(count))}`;
  }

  const amountUi =
    amountAtomic !== null
      ? formatAtomicAmount(amountAtomic, decimals)
      : paymentRequirements.maxAmountRequired;
  const solscan = buildSolscanLink(transaction, paymentRequirements.network);

  const resourceUrl = paymentRequirements.resource ?? "unknown";
  const resourcePath = shortenResource(resourceUrl);
  const header =
    `${green("SETTLE")} ${bold(resourcePath)} ${dim(`[${paymentRequirements.network}]`)} ${green("✓")}`;

  const amountLine =
    amountAtomic !== null
      ? `${yellow(amountUi)} ${assetLabel(asset)} ${dim(`(${amountAtomic.toString()})`)}`
      : `${yellow(amountUi)} ${assetLabel(asset)}`;

  const fields: StructuredField[] = [
    { label: "resource", value: `${cyan(resourceUrl)} ${dim(`[${paymentRequirements.network}]`)}` },
    { label: "amount", value: amountLine },
    {
      label: "solscan",
      value: solscan ? underline(cyan(solscan)) : gray("unavailable"),
    },
    { label: "metrics", value: `${totalsSummary} ${dim("•")} ${countSummary}`.trim() },
  ];

  emitStructuredLog("info", header, fields);
}

if (env.ALLOWED_ORIGINS) {
  const origins = env.ALLOWED_ORIGINS.split(",").map(origin => origin.trim()).filter(Boolean);
  if (origins.length) {
    app.use(cors({ origin: origins }));
  }
}

app.get("/", (req, res) => {
  const preferredType = req.accepts(["json", "html"]);

  if (preferredType === "html") {
    return res.redirect(302, "https://dexter.cash/facilitator");
  }

  res.status(200).json({
    service: "Dexter x402 facilitator",
    status: "ok",
    networks: Array.from(allowedNetworks),
  });
});

app.get(["/health", "/healthz"], (_req, res) => {
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
    logVerificationEvent(paymentRequirements);
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
    const transaction = (result as any)?.transaction ?? null;
    logSettlementEvent(paymentRequirements, transaction);
    return res.json(result);
  } catch (error) {
    logger.error("settle failed", error);
    return res.status(400).json({ error: getErrorMessage(error) });
  }
});

app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
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
