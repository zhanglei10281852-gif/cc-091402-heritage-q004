import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const referenceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../reference");

function loadJson(name) {
  return JSON.parse(readFileSync(path.join(referenceDir, name), "utf8"));
}

export function loadReference() {
  return {
    matrix: loadJson("risk-matrix.json"),
    roles: loadJson("approval-roles.json"),
    calendar: loadJson("work-calendar.json"),
  };
}

export function resolveDataFile() {
  return process.env.LOAN_DATA_FILE
    ?? path.join(os.tmpdir(), "loan-approval-service", "data.json");
}

export const ADMIN_ROLE = "管理员";
