import crypto from "node:crypto";

// 风险规则：文物等级 + 路线风险决定审批节点；节点条件解释“卡在哪”。
// 关键条件分组指纹用于版本比对：哪一组变了，对应节点及其后置节点全部重新进入。

export const NODE_ORDER = ["insurance", "conservation", "security", "curator", "leader", "authority"];

export const NODE_NAMES = {
  insurance: "保险审核",
  conservation: "保护科技审核",
  security: "安全保卫审核",
  curator: "藏品部审核",
  leader: "馆领导审批",
  authority: "主管部门审批",
};

export const CONDITION_MESSAGES = {
  display_coverage: "保险凭证须覆盖陈列期间（展柜）风险",
  transport_coverage: "保险凭证须覆盖运输途中（含装卸）风险，不得只保展柜",
  coverage_amount: "保险金额不得低于借展文物协议价合计",
  climate_present: "须提交温度与相对湿度承诺区间",
  temperature_band: "温度承诺区间超出该文物等级允许范围，或下限大于上限",
  humidity_band: "湿度承诺区间超出该文物等级允许范围，或下限大于上限",
  route_complete: "路线信息不完整：承运商、运输方式、起运地、目的地、起止时间缺一不可",
  transport_insurance: "运输风险尚未投保，安全保卫节点不能放行（仅保展柜的凭证在此同样受阻）",
  items_present: "借展清单不能为空",
  item_fields: "清单文物存在编号、名称、等级、数量或协议价缺失/非法",
  contract_accepted: "申请方须接受借展合同条款",
};

// 节点“拥有”的关键条件分组；任一分组变化，该节点重新进入
export const NODE_GROUPS = {
  insurance: ["insurance"],
  conservation: ["climate"],
  security: ["route"],
  curator: ["items", "contract"],
  leader: [],
  authority: [],
};

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function fingerprint(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function groupFingerprints(data) {
  return {
    items: fingerprint(data.items ?? []),
    route: fingerprint(data.route ?? null),
    climate: fingerprint(data.climate ?? null),
    insurance: fingerprint(data.insuranceCertificate ?? null),
    contract: fingerprint({
      borrowerName: data.borrower?.name ?? null,
      exhibitionName: data.exhibition?.name ?? null,
      exhibitionVenue: data.exhibition?.venue ?? null,
      contractAccepted: data.contractAccepted ?? false,
    }),
  };
}

// 整体载荷指纹：任何字段变化（含非关键的联系方式）都产生新版本；
// 是否触发重新签署只由 groupFingerprints 的关键分组决定
export function payloadFingerprint(data) {
  return fingerprint(data);
}

export function highestGrade(matrix, items) {
  let best = null;
  for (const item of items) {
    const grade = matrix.grades.find((g) => g.key === item.grade);
    if (!grade) continue;
    if (!best || grade.rank < best.rank) best = grade;
  }
  return best;
}

export function requiredNodes(matrix, data) {
  const top = highestGrade(matrix, data.items ?? []);
  const nodes = new Set(matrix.baseNodes);
  if (top) for (const n of matrix.gradeNodes[top.key] ?? []) nodes.add(n);
  const mode = data.route?.mode;
  if (mode && matrix.routeModeNodes[mode]) {
    for (const n of matrix.routeModeNodes[mode]) nodes.add(n);
  }
  if (data.route?.international) {
    for (const n of matrix.internationalRouteNodes) nodes.add(n);
  }
  // 沿前置闭包补齐：例如三级文物走航空需要主管部门，其前置馆领导也必须在链上
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of [...nodes]) {
      for (const prereq of matrix.prerequisites[node] ?? []) {
        if (!nodes.has(prereq)) {
          nodes.add(prereq);
          changed = true;
        }
      }
    }
  }
  return NODE_ORDER.filter((n) => nodes.has(n));
}

function totalAgreedValue(items) {
  return items.reduce((sum, item) => {
    const qty = Number(item.quantity) || 0;
    const value = Number(item.agreedValue) || 0;
    return sum + qty * value;
  }, 0);
}

// 评估单个节点的未满足条件；空数组表示材料层面已满足（仍可能等待前置签名）
export function unmetConditions(matrix, node, data) {
  const cert = data.insuranceCertificate ?? {};
  const coverage = new Set(cert.coverage ?? []);
  const climate = data.climate ?? {};
  const items = data.items ?? [];
  const top = highestGrade(matrix, items);
  const result = [];
  const fail = (code) => result.push({ code, message: CONDITION_MESSAGES[code] ?? code });

  for (const code of matrix.nodeConditions[node] ?? []) {
    switch (code) {
      case "display_coverage":
        if (!coverage.has("display")) fail(code);
        break;
      case "transport_coverage":
        if (!coverage.has("transport")) fail(code);
        break;
      case "coverage_amount": {
        const amount = Number(cert.amount);
        if (!Number.isFinite(amount) || amount < totalAgreedValue(items)) fail(code);
        break;
      }
      case "climate_present":
        if ([climate.temperatureMin, climate.temperatureMax, climate.humidityMin, climate.humidityMax]
          .some((v) => typeof v !== "number" || !Number.isFinite(v))) fail(code);
        break;
      case "temperature_band": {
        const band = top ? matrix.climateRequirements[top.key].temperature : null;
        if (!band) fail(code);
        else if (climate.temperatureMin > climate.temperatureMax
          || climate.temperatureMin < band[0] || climate.temperatureMax > band[1]) fail(code);
        break;
      }
      case "humidity_band": {
        const band = top ? matrix.climateRequirements[top.key].humidity : null;
        if (!band) fail(code);
        else if (climate.humidityMin > climate.humidityMax
          || climate.humidityMin < band[0] || climate.humidityMax > band[1]) fail(code);
        break;
      }
      case "route_complete": {
        const r = data.route ?? {};
        const modes = Object.keys(matrix.routeModeNodes);
        const timesOk = !Number.isNaN(Date.parse(r.departAt)) && !Number.isNaN(Date.parse(r.arriveAt))
          && Date.parse(r.arriveAt) > Date.parse(r.departAt);
        if (!r.carrier || !modes.includes(r.mode) || !r.origin || !r.destination || !timesOk) fail(code);
        break;
      }
      case "transport_insurance":
        if (!coverage.has("transport")) fail(code);
        break;
      case "items_present":
        if (items.length === 0) fail(code);
        break;
      case "item_fields": {
        const validGrades = new Set(matrix.grades.map((g) => g.key));
        const bad = items.some((it) => !it.artifactId || !it.name || !validGrades.has(it.grade)
          || !Number.isInteger(it.quantity) || it.quantity <= 0
          || typeof it.agreedValue !== "number" || it.agreedValue < 0);
        if (bad) fail(code);
        break;
      }
      case "contract_accepted":
        if (data.contractAccepted !== true) fail(code);
        break;
      default:
        fail(code);
    }
  }
  return result;
}

// 前置闭包：某节点失效时，传递依赖它的节点也要失效
export function dependentClosure(matrix, seeds) {
  const result = new Set(seeds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [node, prereqs] of Object.entries(matrix.prerequisites)) {
      if (!result.has(node) && prereqs.some((p) => result.has(p))) {
        result.add(node);
        changed = true;
      }
    }
  }
  return result;
}

export function changedGroups(before, after) {
  return Object.keys(after).filter((group) => before[group] !== after[group]);
}

// 申请结构的最小校验：结构不合法直接拒收；业务条件不满足由节点条件体现
export function validateShape(data) {
  const errors = [];
  if (!data || typeof data !== "object") return ["请求体必须是 JSON 对象"];
  if (!data.borrower?.name) errors.push("borrower.name 不能为空");
  if (!Array.isArray(data.items)) errors.push("items 必须是数组");
  if (!data.route || typeof data.route !== "object") errors.push("route 必须是对象");
  if (!data.climate || typeof data.climate !== "object") errors.push("climate 必须是对象");
  if (!data.insuranceCertificate || typeof data.insuranceCertificate !== "object") {
    errors.push("insuranceCertificate 必须是对象");
  }
  return errors;
}
