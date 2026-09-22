import { createHash } from "node:crypto";

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalHash(value) {
  return sha256(canonicalStringify(value));
}

/** 稳定序列化：对象键排序，避免键顺序导致同内容不同哈希。 */
export function canonicalStringify(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortValue(value[key])]),
    );
  }
  return value;
}

export function newId(prefix) {
  return `${prefix}_${sha256(`${prefix}:${process.pid}:${Math.random()}:${Date.now()}`).slice(0, 12)}`;
}

export function defaultClock() {
  return new Date();
}
