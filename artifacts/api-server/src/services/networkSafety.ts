import { isIP } from "node:net";

/**
 * True when an IP literal is loopback, private, link-local, CGNAT, multicast,
 * or otherwise reserved. Source Vault retrieval uses this before fetching a
 * user-provided reference URL to prevent server-side request forgery.
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return a >= 224;
  }
  if (family === 6) {
    const normalized = ip.toLowerCase();
    if (normalized === "::1" || normalized === "::") return true;
    if (normalized.startsWith("fe80")) return true;
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
    const mapped = normalized.match(/::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u);
    return mapped ? isPrivateOrReservedIp(mapped[1]!) : false;
  }
  return false;
}
