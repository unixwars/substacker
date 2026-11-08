import { z } from "zod";

export const ShellConfigSchema = z.object({
  /** Where the served content lives; relative to the page, or absolute. */
  contentUrl: z.string().min(1),
  feedName: z.string().min(1),
  subscribeUrl: z.string().optional(),
  actions: z.array(z.enum(["comment", "share"])).default([]),
  utmSource: z.string().min(1).default("substacker"),
});

export type ShellConfig = z.infer<typeof ShellConfigSchema>;

/** Read `config.json` written at build time, next to the shell. */
export async function loadShellConfig(fetchFn: typeof fetch = fetch, url = "config.json"): Promise<ShellConfig> {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`config.json: HTTP ${res.status}`);
  return ShellConfigSchema.parse(await res.json());
}

/** Absolute address of the content root, resolved against the page. */
export function contentBase(config: ShellConfig, pageUrl: string): string {
  return new URL(config.contentUrl.endsWith("/") ? config.contentUrl : `${config.contentUrl}/`, pageUrl).toString();
}
