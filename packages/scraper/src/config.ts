import { z } from "zod";

export const CONFIG_FILE = "substacker.config.local.json";
export const EXAMPLE_FILE = "substacker.config.example.json";

/**
 * An http(s) address. Not `z.httpUrl()`, which also refuses `localhost` and IP hosts that the
 * test suites' local servers use; whether plain http is acceptable is decided where it is used
 * (the fetcher for the feed, `loadConfig` for the relay).
 */
const httpUrl = z.string().refine((v) => URL.canParse(v) && /^https?:$/.test(new URL(v).protocol) && new URL(v).hostname !== "", "must be an http(s) URL");

export const ConfigSchema = z.object({
  feedUrl: httpUrl,
  feedName: z.string().min(1),
  relayUrl: httpUrl.optional(),
  subscribeUrl: httpUrl.optional(),
  actions: z.array(z.enum(["comment", "share"])).default([]),
  utmSource: z.string().min(1).default("substacker"),
  /** Ask search engines not to index the reader. On by default: it is a second public copy of the posts. */
  noindex: z.boolean().default(true),
  hidden: z.array(z.string()).default([]),
  /** Image downloads in flight at once (at most 2 per host). */
  maxConcurrentDownloads: z.number().int().min(1).max(8).optional(),
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
  /** `allowPrivate` is for the test suites and the dry run only, never for a user's configuration: it lets `relayUrl` be plain http on a local address. */
  opts: { allowPrivate?: boolean } = {},
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
  const relay = result.data.relayUrl ? new URL(result.data.relayUrl) : undefined;
  if (relay && relay.protocol !== "https:") {
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(relay.hostname);
    if (!(opts.allowPrivate && local)) {
      throw new ConfigError(`${source} is invalid at relayUrl: the relay must be an https address (the secret travels with every request). See ${EXAMPLE_FILE}.`);
    }
  }
  return result.data;
}
