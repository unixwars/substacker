import { isIP } from "node:net";

export class BlockedAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedAddressError";
  }
}

function v4Bytes(ip: string): number[] | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return nums.some((n) => !(n >= 0 && n <= 255)) ? undefined : nums;
}

function blockedV4(b: number[]): boolean {
  const [a = 0, c = 0, d = 0] = b;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && c >= 64 && c <= 127) ||
    (a === 169 && c === 254) ||
    (a === 172 && c >= 16 && c <= 31) ||
    (a === 192 && c === 168) ||
    (a === 192 && c === 0 && d === 0) ||
    (a === 198 && (c === 18 || c === 19)) ||
    a >= 224
  );
}

/** The 8 groups of an IPv6 address, or undefined if it does not parse. */
function v6Groups(input: string): number[] | undefined {
  let ip = input.split("%")[0] ?? "";
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (tail?.[1]) {
    const b = v4Bytes(tail[1]);
    if (!b) return undefined;
    ip = ip.slice(0, -tail[1].length) + ((b[0]! << 8) | b[1]!).toString(16) + ":" + ((b[2]! << 8) | b[3]!).toString(16);
  }
  const halves = ip.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return undefined;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...rest].map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
  return groups.length === 8 && groups.every((g) => !Number.isNaN(g)) ? groups : undefined;
}

const embedded = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];

/** Whether an IP address must never be fetched: loopback, private, link-local, and the like. Unparseable input counts as blocked. */
export function isBlockedAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "");
  const kind = isIP(bare.split("%")[0] ?? "");
  if (kind === 4) {
    const b = v4Bytes(bare);
    return !b || blockedV4(b);
  }
  if (kind !== 6) return true;
  const g = v6Groups(bare);
  if (!g) return true;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  if (g.every((x) => x === 0)) return true; // ::
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    return g6 === 0 && g7 === 1 ? true : blockedV4(embedded(g6, g7)); // ::1, mapped, compatible
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return blockedV4(embedded(g6, g7)); // NAT64
  if (g0 === 0x2002) return blockedV4(embedded(g1, g2)); // 6to4
  if (g0 === 0x2001 && g1 === 0) return true; // Teredo
  return (g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0 || (g0 & 0xff00) === 0xff00;
}

export interface UrlPolicy {
  /** Test and dry-run only: allow loopback/private targets and plain http. Never set from the user's configuration. */
  allowPrivate?: boolean;
}

/**
 * Checks that need no DNS: the scheme, and a literal address or `localhost` host.
 * `URL` has already turned decimal, hex and octal hosts into dotted form.
 */
export function checkUrlShape(url: URL, policy: UrlPolicy = {}): void {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new BlockedAddressError(`refused scheme ${url.protocol}`);
  if (policy.allowPrivate) return;
  if (url.protocol !== "https:") throw new BlockedAddressError("refused: only https is fetched");
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) throw new BlockedAddressError(`refused local host ${host}`);
  if (isIP(host) !== 0 && isBlockedAddress(host)) throw new BlockedAddressError(`refused private or loopback address ${host}`);
}
