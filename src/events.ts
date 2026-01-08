import { env } from "./config.js";

export type FacilitatorEvent = {
  eventType: "verify" | "settle";
  status: "ok" | "error";
  network?: string | null;
  payTo?: string | null;
  payer?: string | null;
  feePayer?: string | null;
  asset?: string | null;
  amountAtomic?: string | number | bigint | null;
  feeSponsoredLamports?: string | number | bigint | null;
  transaction?: string | null;
  errorReason?: string | null;
  errorCode?: string | null;
  occurredAt?: string;
  metadata?: Record<string, unknown> | null;
};

const EVENTS_URL = env.FACILITATOR_EVENTS_URL;
const EVENTS_TOKEN = env.FACILITATOR_METRICS_TOKEN?.trim();

function normalizeAmount(value: string | number | bigint | null | undefined): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === "string") return value.trim() || null;
  return null;
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

async function postEvent(payload: FacilitatorEvent): Promise<void> {
  if (!EVENTS_URL || !EVENTS_TOKEN) return;

  const body = {
    ...payload,
    occurredAt: payload.occurredAt ?? new Date().toISOString(),
    amountAtomic: normalizeAmount(payload.amountAtomic),
    feeSponsoredLamports: normalizeAmount(payload.feeSponsoredLamports),
    network: normalizeString(payload.network ?? null),
    payTo: normalizeString(payload.payTo ?? null),
    payer: normalizeString(payload.payer ?? null),
    feePayer: normalizeString(payload.feePayer ?? null),
    asset: normalizeString(payload.asset ?? null),
    transaction: normalizeString(payload.transaction ?? null),
    errorReason: normalizeString(payload.errorReason ?? null),
    errorCode: normalizeString(payload.errorCode ?? null),
  };

  try {
    const response = await fetch(EVENTS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-facilitator-metrics-token": EVENTS_TOKEN,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    });

    if (!response.ok && env.LOG_LEVEL === "debug") {
      const text = await response.text().catch(() => "");
      console.debug(`[events] ingest rejected (${response.status}): ${text.slice(0, 160)}`);
    }
  } catch (error: any) {
    if (env.LOG_LEVEL === "debug") {
      console.debug(`[events] ingest failed: ${error?.message || String(error)}`);
    }
  }
}

export function emitFacilitatorEvent(event: FacilitatorEvent): void {
  if (!EVENTS_URL || !EVENTS_TOKEN) return;
  void postEvent(event);
}





