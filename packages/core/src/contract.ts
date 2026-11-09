import { z } from "zod";

/**
 * Version of the content contract (the format of the served files) this build of the core
 * understands. Not the package release: that is `VERSION`.
 */
export const CONTRACT_VERSION = 1;

const version = z.number().int().nonnegative();

export const EntrySchema = z.object({
  slug: z.string().min(1),
  title: z.string(),
  /** ISO 8601 publication date. */
  date: z.string().min(1),
  excerpt: z.string(),
  /** Path relative to the served content root, an absolute URL, or null. */
  cover: z.string().nullable(),
});

export const IndexSchema = z.object({
  version,
  title: z.string(),
  /** Newest first. Hidden posts are not listed. */
  posts: z.array(EntrySchema),
});

export const PostSchema = EntrySchema.extend({
  version,
  /** Sanitized HTML. Image paths are relative to the served content root. */
  html: z.string(),
  /** The post's own address on Substack, without its query. */
  sourceUrl: z.string().min(1),
  /** Hash of the raw feed item the post was derived from. */
  contentHash: z.string().min(1),
  /** Number of images still pointing at Substack because no local copy exists. */
  unlocalized: z.number().int().nonnegative(),
});

export const DocSchema = z.object({
  slug: z.string().min(1),
  title: z.string(),
  text: z.string(),
});

export const DocsSchema = z.array(DocSchema);

export type Entry = z.infer<typeof EntrySchema>;
export type Index = z.infer<typeof IndexSchema>;
export type Post = z.infer<typeof PostSchema>;
export type Doc = z.infer<typeof DocSchema>;

export type ContractErrorReason = "malformed" | "newer";

/** Thrown when a payload is not a valid contract document. */
export class ContractError extends Error {
  readonly reason: ContractErrorReason;

  constructor(reason: ContractErrorReason, message: string) {
    super(message);
    this.name = "ContractError";
    this.reason = reason;
  }
}

function guardVersion(json: unknown): void {
  if (typeof json === "object" && json !== null && "version" in json) {
    const v = (json as { version: unknown }).version;
    if (typeof v === "number" && v > CONTRACT_VERSION) {
      throw new ContractError("newer", `content contract version ${v} is newer than supported version ${CONTRACT_VERSION}`);
    }
  }
}

function parseWith<T>(schema: z.ZodType<T>, json: unknown, what: string): T {
  const result = schema.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
    throw new ContractError("malformed", `malformed ${what}${where}: ${issue?.message ?? "invalid"}`);
  }
  return result.data;
}

export function parseIndex(json: unknown): Index {
  guardVersion(json);
  return parseWith(IndexSchema, json, "index");
}

export function parsePost(json: unknown): Post {
  guardVersion(json);
  return parseWith(PostSchema, json, "post");
}

export function parseDocs(json: unknown): Doc[] {
  return parseWith(DocsSchema, json, "search documents");
}
