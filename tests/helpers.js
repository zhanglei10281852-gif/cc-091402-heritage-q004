import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, JsonStore } from "../src/store.js";
import { loadCalendar } from "../src/calendar.js";
import { ApprovalEngine } from "../src/engine.js";
import roles from "../reference/approval-roles.json" with { type: "json" };
import calendarRef from "../reference/workday-calendar-2026.json" with { type: "json" };

export const ACTORS = {
  applicant: "u_applicant_01",
  curator: "u_cuigan",
  curator2: "u_cuigan_2",
  registrar: "u_registrar_li",
  conservator: "u_conservator_chen",
  risk: "u_risk_zhao",
  risk2: "u_risk_sun",
  deputy: "u_deputy_director",
  director: "u_director",
  outsider: "u_outsider",
};

export const DATES = {
  shipOut: "2026-06-09T08:00:00+08:00",
  install: "2026-06-10T09:00:00+08:00",
  start: "2026-06-12T09:00:00+08:00",
  end: "2026-07-10T17:00:00+08:00",
  dismantle: "2026-07-11T18:00:00+08:00",
  back: "2026-07-13T18:00:00+08:00",
};

/** 与借展合同样例一致的合规申请：境内直达+航空，二级文物，风险 medium。 */
export function validApplication(overrides = {}) {
  const base = {
    applicantId: ACTORS.applicant,
    borrowingOrg: "临江市美术馆",
    exhibition: { venue: "临江市美术馆三号展厅", installAt: DATES.install, startAt: DATES.start, endAt: DATES.end, dismantleAt: DATES.dismantle },
    contract: {
      contractNo: "L-2026-0312",
      documentId: "doc-contract-v1",
      borrower: "临江市美术馆",
      lender: "省博物馆",
      exhibitionStartAt: DATES.start,
      exhibitionEndAt: DATES.end,
      shipOutAt: DATES.shipOut,
      returnAt: DATES.back,
    },
    items: [
      { artifactId: "artifact-2042", name: "鎏金铜带钩", grade: 2, quantity: 1, declaredValue: 800000, envRequirement: { tempMin: 18, tempMax: 22, rhMin: 50, rhMax: 60 } },
      { artifactId: "artifact-3307", name: "彩绘陶壶", grade: 3, quantity: 1, declaredValue: 30000, envRequirement: { tempMin: 15, tempMax: 25, rhMin: 45, rhMax: 65 } },
    ],
    route: {
      type: "domestic_direct",
      transportModes: ["air", "road"],
      shipOutAt: DATES.shipOut,
      returnAt: DATES.back,
      carrier: "华安文物运输",
      legs: [{ from: "省博物馆库房", to: "临江市美术馆", mode: "air", departAt: DATES.shipOut, arriveAt: "2026-06-09T16:00:00+08:00" }],
    },
    environment: { tempMin: 18, tempMax: 22, rhMin: 50, rhMax: 60, monitoringIntervalMinutes: 15 },
    insurance: {
      policies: [
        {
          policyNo: "P-MIX-001",
          insurer: "中国人保",
          documentId: "cert-insurance-v1",
          amount: 1000000,
          currency: "CNY",
          phases: ["exhibition", "transport"],
          startAt: "2026-06-09T00:00:00+08:00",
          endAt: "2026-07-13T23:59:00+08:00",
        },
      ],
    },
  };
  return deepMerge(base, overrides);
}

/** 题设场景：保险只覆盖展期，没有运输险。 */
export function exhibitionOnlyInsuranceApplication() {
  return validApplication({
    insurance: {
      policies: [
        {
          policyNo: "P-EXH-002",
          insurer: "中国人保",
          documentId: "cert-insurance-exhibition-only",
          amount: 1000000,
          currency: "CNY",
          phases: ["exhibition"],
          startAt: DATES.install,
          endAt: DATES.dismantle,
        },
      ],
    },
  });
}

export function manifestFor(app) {
  // 从提交内容生成一致装箱清单
  return { items: app.items.map((item) => ({ artifactId: item.artifactId, quantity: item.quantity })) };
}

function deepMerge(base, override) {
  if (Array.isArray(override)) return structuredClone(override);
  if (override && typeof override === "object") {
    const out = Array.isArray(base) ? structuredClone(base) : { ...(base ?? {}) };
    for (const [key, value] of Object.entries(override)) {
      out[key] = key in out ? deepMerge(out[key], value) : structuredClone(value);
    }
    return out;
  }
  return override;
}

export function makeHarness({ now = "2026-06-08T09:00:00+08:00", timeoutHours, escalationHours = 8, persistent = false } = {}) {
  let clockIso = now;
  const clock = () => new Date(clockIso);
  let store;
  let dir;
  if (persistent) {
    dir = mkdtempSync(join(tmpdir(), "loan-approval-"));
    store = new JsonStore(join(dir, "state.json"));
  } else {
    store = new MemoryStore();
  }
  const calendar = loadCalendar(calendarRef);
  const makeEngine = () =>
    new ApprovalEngine({
      store,
      calendar,
      clock,
      roles,
      ...(timeoutHours ? { timeoutHours } : {}),
      escalationHours,
    });
  const engine = makeEngine();
  return {
    engine,
    makeEngine,
    calendar,
    setTime: (iso) => {
      clockIso = iso;
    },
    advance: (ms) => {
      clockIso = new Date(new Date(clockIso).getTime() + ms).toISOString();
    },
    cleanup: () => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function errorCode(callback) {
  try {
    callback();
    return null;
  } catch (error) {
    return error.code;
  }
}
