import { z } from "zod";

/**
 * Env vars always arrive as strings (or undefined). These preprocessors turn
 * them into the right primitive type before zod validates it, while leaving
 * unparseable input as the original string so zod's error names the field and
 * shows what was actually received, instead of a bare "expected number".
 */

function toNumber(v: unknown): unknown {
  if (v === undefined || v === "") return undefined;
  if (typeof v !== "string") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

function toBool(v: unknown): unknown {
  if (v === undefined || v === "") return undefined;
  if (typeof v !== "string") return v;
  const t = v.trim().toLowerCase();
  if (t === "true") return true;
  if (t === "false") return false;
  return v;
}

function toList(v: unknown): unknown {
  if (v === undefined || v === "") return undefined;
  if (typeof v !== "string") return v;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function numberField(defaultValue: number) {
  return z.preprocess(toNumber, z.number().default(defaultValue));
}

export function requiredNumberField() {
  return z.preprocess(toNumber, z.number());
}

export function intField(defaultValue: number) {
  return z.preprocess(toNumber, z.number().int().default(defaultValue));
}

export function boolField(defaultValue: boolean) {
  return z.preprocess(toBool, z.boolean().default(defaultValue));
}

export function listField(defaultValue: string[]) {
  return z.preprocess(toList, z.array(z.string().min(1)).default(defaultValue));
}

/** Comma-separated numbers, e.g. STUCK_BACKOFF_SECONDS=30,60,120. At least one value. */
export function numberListField(defaultValue: number[]) {
  return z.preprocess(
    (v) => {
      const list = toList(v);
      return Array.isArray(list) ? list.map((s) => toNumber(s)) : list;
    },
    z.array(z.number()).min(1).default(defaultValue),
  );
}

export function requiredStringField() {
  return z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1));
}

export function optionalStringField(defaultValue = "") {
  return z.preprocess((v) => (v === undefined ? defaultValue : v), z.string());
}

export function enumField<T extends [string, ...string[]]>(values: T, defaultValue: T[number]) {
  return z.preprocess((v) => (v === undefined || v === "" ? defaultValue : v), z.enum(values));
}
