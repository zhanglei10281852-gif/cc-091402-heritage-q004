import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkCalendar } from "../src/calendar.js";
import { loadReference } from "../src/config.js";
import { JsonStore } from "../src/store.js";
import { LoanService } from "../src/service.js";

export function user(role, id) {
  return { id: id ?? `u-${role}`, role, name: `${role}-${id ?? 1}` };
}

export function baseApplication(overrides = {}) {
  return {
    borrower: { name: "某市博物馆", contact: "张三", phone: "0571-88888888" },
    exhibition: { name: "青铜文明特展", venue: "市博物馆一号厅" },
    items: [
      { artifactId: "artifact-0001", name: "青铜鼎", grade: "一级", quantity: 1, agreedValue: 5000000 },
    ],
    route: {
      carrier: "安运文物运输有限公司",
      mode: "公路",
      origin: "省博物馆库房",
      destination: "市博物馆一号厅",
      stops: [],
      international: false,
      departAt: "2026-11-02T08:00:00+08:00",
      arriveAt: "2026-11-03T18:00:00+08:00",
    },
    climate: { temperatureMin: 19, temperatureMax: 21, humidityMin: 52, humidityMax: 58 },
    insuranceCertificate: {
      certNo: "INS-0001",
      insurer: "XX财产保险股份有限公司",
      coverage: ["display", "transport"],
      amount: 5000000,
      issuedAt: "2026-09-18T10:00:00+08:00",
    },
    contractAccepted: true,
    ...overrides,
  };
}

export function makeHarness(initialNow = new Date("2026-09-22T10:00:00+08:00")) {
  const reference = loadReference();
  const dir = mkdtempSync(path.join(os.tmpdir(), "loan-test-"));
  const dataFile = path.join(dir, "data.json");
  let current = new Date(initialNow);
  const calendar = new WorkCalendar(reference.calendar);
  const store = new JsonStore(dataFile);
  const service = new LoanService({
    store,
    reference,
    calendar,
    now: () => current,
  });
  return {
    reference,
    calendar,
    dataFile,
    service,
    get now() {
      return current;
    },
    setNow(value) {
      current = value instanceof Date ? value : new Date(value);
    },
    advance(hours) {
      current = new Date(current.getTime() + hours * 3600 * 1000);
    },
    // 用同一数据文件重建服务，模拟进程重启（截止时间是绝对时刻，应原样恢复）
    restart() {
      const restartedStore = new JsonStore(dataFile);
      const restarted = new LoanService({
        store: restartedStore,
        reference,
        calendar,
        now: () => current,
      });
      return { service: restarted, store: restartedStore };
    },
  };
}

export async function expectServiceError(promise, status, code) {
  try {
    await promise;
  } catch (error) {
    if (error.status !== status || error.code !== code) {
      throw new Error(`期望 ${status}/${code}，实际 ${error.status}/${error.code}: ${error.message}`);
    }
    return error;
  }
  throw new Error(`期望抛出 ${status}/${code}，但未抛出`);
}

export const APPLICANT = user("申请方", "borrower-1");

// 按依赖顺序批准全部所需节点
export async function approveAll(service, id, view) {
  const order = ["insurance", "conservation", "security", "curator", "leader", "authority"];
  let current = view;
  for (const node of order) {
    if (!current.requiredNodes.includes(node)) continue;
    if (current.nodes[node]?.status === "approved") continue;
    current = await service.decide(user(node), id, node, "approve", "同意");
  }
  return current;
}
