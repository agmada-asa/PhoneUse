/** Shares checkout paths and LAN discovery between the manual CLI and managed MCP launcher. */
import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Checkout location is independent of the MCP host's working directory. */
export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Private pairing state stays in the checkout unless explicitly overridden. */
export const stateDir = resolve(
  process.env.PHONEUSE_STATE_DIR ?? resolve(repositoryRoot, ".phoneuse"),
);

/** Chooses a private IPv4 LAN address, preferring a Mac's primary interface. */
export function lanAddress(): string {
  const interfaces = networkInterfaces();
  const names = Object.keys(interfaces).sort((a, b) => Number(b === "en0") - Number(a === "en0"));

  for (const name of names) {
    for (const item of interfaces[name] ?? []) {
      if (
        !item.internal &&
        item.family === "IPv4" &&
        /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address)
      ) {
        return item.address;
      }
    }
  }

  return "127.0.0.1";
}

/** Rejects invalid environment ports before opening listeners or creating pairing state. */
export function environmentPort(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : /^\d+$/.test(value) ? Number(value) : NaN;

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error("Phone Use ports must be integers between 1 and 65535.");
  }

  return parsed;
}
