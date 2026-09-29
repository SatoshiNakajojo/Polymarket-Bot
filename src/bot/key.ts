import { readFileSync } from "node:fs";

export function readKey(): string {
  const file = process.env.POLY_KEY_FILE;
  if (file) return readFileSync(file, "utf8");
  const fromEnv = process.env.POLY_PRIVATE_KEY;
  if (fromEnv) return fromEnv;
  throw new Error("POLY_KEY_FILE manquant. Fichier chmod 600, uniquement sur cette machine.");
}

export function hasKey(): boolean {
  return Boolean(process.env.POLY_KEY_FILE || process.env.POLY_PRIVATE_KEY);
}

export function builderFromEnv(): { key: string; secret: string; passphrase: string } | undefined {
  const key = process.env.POLY_BUILDER_KEY?.trim() ?? "";
  const secret = process.env.POLY_BUILDER_SECRET?.trim() ?? "";
  const passphrase = process.env.POLY_BUILDER_PASSPHRASE?.trim() ?? "";
  if (!key || !secret || !passphrase) return undefined;
  return { key, secret, passphrase };
}
