import { z } from "zod";

export const CONFIG_FILE = "substacker.config.local.json";
export const EXAMPLE_FILE = "substacker.config.example.json";

export const ConfigSchema = z.object({
  feedUrl: z.url(),
  feedName: z.string().min(1),
  relayUrl: z.url().optional(),
  subscribeUrl: z.url().optional(),
  actions: z.array(z.enum(["comment", "share"])).default([]),
  utmSource: z.string().min(1).default("substacker"),
  hidden: z.array(z.string()).default([]),
});

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Resolve the configuration: `SUBSTACKER_CONFIG` (JSON in the environment) wins,
 * else `substacker.config.local.json`. `readFile` returns the file's text, or
 * undefined if it does not exist.
 */
export function loadConfig(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string | undefined,
): Config {
  const fromEnv = env["SUBSTACKER_CONFIG"];
  const text = fromEnv !== undefined && fromEnv.trim() !== "" ? fromEnv : readFile(CONFIG_FILE);
  const source = fromEnv !== undefined && fromEnv.trim() !== "" ? "SUBSTACKER_CONFIG" : CONFIG_FILE;
  if (text === undefined) {
    throw new ConfigError(
      `No configuration found. Set SUBSTACKER_CONFIG or create ${CONFIG_FILE}; copy ${EXAMPLE_FILE} as a template.`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ConfigError(`${source} is not valid JSON. See ${EXAMPLE_FILE}.`);
  }
  const result = ConfigSchema.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new ConfigError(`${source} is invalid at ${issue?.path.join(".") || "(root)"}: ${issue?.message}. See ${EXAMPLE_FILE}.`);
  }
  return result.data;
}
