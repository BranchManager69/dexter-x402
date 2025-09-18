import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const schema = z
  .object({
    PORT: z.coerce.number().int().positive().default(4070),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    FACILITATOR_NETWORKS: z
      .string()
      .trim()
      .default("solana")
      .transform(value =>
        value
          .split(",")
          .map(v => v.trim())
          .filter(Boolean),
      ),
    SOLANA_PRIVATE_KEY: z
      .string()
      .trim()
      .min(1, "SOLANA_PRIVATE_KEY must be a base58-encoded secret key"),
    ALLOWED_ORIGINS: z.string().trim().optional(),
  })
  .transform(value => ({
    ...value,
    FACILITATOR_NETWORKS: value.FACILITATOR_NETWORKS as string[],
  }));

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid facilitator environment configuration");
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;
