import { canonicalHash, canonicalStringify } from "./util.js";
import rolesRef from "../reference/approval-roles.json" with { type: "json" };
import matrixRef from "../reference/risk-matrix.json" with { type: "json" };

export const SECTIONS = ["identity", "exhibition", "contract", "checklist", "route", "environment", "insurance"];

/** 各节点关注的申请段落；段落变化即视为该节点的关键条件变化，须重新进入该节点。 */
const WATCHED_SECTIONS = {
  curator_dept: ["checklist"],
  registrar: ["identity", "exhibition", "contract"],
  conservator: ["checklist", "environment"],
  risk_manager: ["checklist", "route", "insurance", "exhibition"],
  deputy_director: ["checklist", "route", "environment", "insurance"],
  museum_director: ["identity", "exhibition", "contract", "checklist", "route", "environment", "insurance"],
};

export function loadRules(roles = rolesRef, matrix = matrixRef) {
  return { roles, matrix };
}

/** 从申请方提交内容构造规范化业务快照（剔除办理痕迹，只保留业务条件）。 */
export function buildSnapshot(input) {
  const items = (input.items ?? []).map((item) => ({
    artifactId: String(item.artifactId),
    name: item.name ?? "",
    grade: Number(item.grade),
    quantity: Number(item.quantity ?? 1),
    declaredValue: Number(item.declaredValue ?? 0),
    envRequirement: {
      tempMin: Number(item.envRequirement?.tempMin),
      tempMax: Number(item.envRequirement?.tempMax),
      rhMin: Number(item.envRequirement?.rhMin),
      rhMax: Number(item.envRequirement?.rhMax),
    },
  }));
  items.sort((a, b) => a.artifactId.localeCompare(b.artifactId));

  const policies = (input.insurance?.policies ?? []).map((policy) => ({
    policyNo: String(policy.policyNo),
    insurer: policy.insurer ?? "",
    documentId: String(policy.documentId ?? ""),
    amount: Number(policy.amount ?? 0),
    currency: policy.currency ?? "CNY",
    phases: [...(policy.phases ?? [])].map(String).sort(),
    startAt: policy.startAt ?? null,
    endAt: policy.endAt ?? null,
  }));
  policies.sort((a, b) => a.policyNo.localeCompare(b.policyNo));

  return {
    identity: {
      applicantId: String(input.applicantId ?? ""),
      borrowingOrg: String(input.borrowingOrg ?? ""),
      contractNo: String(input.contract?.contractNo ?? ""),
    },
    exhibition: {
      venue: String(input.exhibition?.venue ?? ""),
      installAt: input.exhibition?.installAt ?? null,
      startAt: input.exhibition?.startAt ?? null,
      endAt: input.exhibition?.endAt ?? null,
      dismantleAt: input.exhibition?.dismantleAt ?? null,
    },
    contract: {
      documentId: String(input.contract?.documentId ?? ""),
      borrower: String(input.contract?.borrower ?? input.borrowingOrg ?? ""),
      lender: String(input.contract?.lender ?? "省博物馆"),
      exhibitionStartAt: input.contract?.exhibitionStartAt ?? input.exhibition?.startAt ?? null,
      exhibitionEndAt: input.contract?.exhibitionEndAt ?? input.exhibition?.endAt ?? null,
      shipOutAt: input.contract?.shipOutAt ?? input.route?.shipOutAt ?? null,
      returnAt: input.contract?.returnAt ?? input.route?.returnAt ?? null,
    },
    checklist: { items },
    route: {
      type: String(input.route?.type ?? ""),
      transportModes: [...(input.route?.transportModes ?? [])].map(String).sort(),
      shipOutAt: input.route?.shipOutAt ?? null,
      returnAt: input.route?.returnAt ?? null,
      carrier: input.route?.carrier ?? "",
      legs: [...(input.route?.legs ?? [])].map((leg) => ({
        from: String(leg.from ?? ""),
        to: String(leg.to ?? ""),
        mode: String(leg.mode ?? ""),
        departAt: leg.departAt ?? null,
        arriveAt: leg.arriveAt ?? null,
      })),
    },
    environment: {
      tempMin: Number(input.environment?.tempMin ?? NaN),
      tempMax: Number(input.environment?.tempMax ?? NaN),
      rhMin: Number(input.environment?.rhMin ?? NaN),
      rhMax: Number(input.environment?.rhMax ?? NaN),
      monitoringIntervalMinutes: Number(input.environment?.monitoringIntervalMinutes ?? 0),
    },
    insurance: { policies },
  };
}

export function sectionHashes(snapshot) {
  return Object.fromEntries(SECTIONS.map((section) => [section, canonicalHash(snapshot[section])]));
}

export function highestGrade(snapshot) {
  return snapshot.checklist.items.reduce((max, item) => Math.min(max, item.grade), 3);
}

export function assessRisk(snapshot, matrix = matrixRef) {
  const grade = highestGrade(snapshot);
  let score = matrix.gradeBase[String(grade)] ?? 0;
  const reasons = [matrix.gradeBaseReason[String(grade)]];

  const routeRule = matrix.routeType[snapshot.route.type];
  if (routeRule) {
    score += routeRule.delta;
    reasons.push(`路线类型「${snapshot.route.type}」+${routeRule.delta}：${routeRule.description}`);
  } else {
    reasons.push("路线类型缺失或未登记，按未完成风险评估处理");
  }

  let modeDelta = 0;
  // 航空/铁路为专业可控运输段；与之搭配的公路接驳不另计风险。
  // 仅全程公路或含海运时按较高风险段计分。
  if (!(snapshot.route.transportModes.includes("air") || snapshot.route.transportModes.includes("rail"))) {
    for (const mode of snapshot.route.transportModes) {
      const rule = matrix.transportMode[mode];
      if (rule && rule.delta > modeDelta) modeDelta = rule.delta;
    }
  }
  if (modeDelta > 0) {
    score += modeDelta;
    reasons.push(`运输方式存在较高风险段 +${modeDelta}`);
  }

  if (!environmentCoversAll(snapshot).ok) {
    score += matrix.environmentOutOfRange.delta;
    reasons.push(`温湿度承诺不覆盖部分文物要求 +${matrix.environmentOutOfRange.delta}`);
  }

  score = Math.min(score, 2);
  const level = score >= 2 ? "high" : score === 1 ? "medium" : "low";
  return { score, level, highestGrade: grade, reasons };
}

/** 按文物等级取基础链条，再按风险规则插入加签节点。 */
export function buildChain(snapshot, risk, rules = loadRules()) {
  const base = rules.roles.chainByHighestGrade[String(risk.highestGrade)];
  const chain = [...base];
  if (risk.level === "high") {
    const insert = rules.roles.highRiskInsert;
    const index = chain.indexOf(insert.before);
    chain.splice(index, 0, insert.node);
  }
  return chain;
}

export function watchedSections(node) {
  return WATCHED_SECTIONS[node] ?? [];
}

function environmentCoversAll(snapshot) {
  const env = snapshot.environment;
  const failures = [];
  for (const item of snapshot.checklist.items) {
    const req = item.envRequirement;
    // 承诺的展柜/运输环境必须落在文物自身可耐受区间之内（承诺区间为耐受区间的子集）。
    const covers =
      Number.isFinite(env.tempMin) && Number.isFinite(env.tempMax) &&
      Number.isFinite(env.rhMin) && Number.isFinite(env.rhMax) &&
      env.tempMin >= req.tempMin && env.tempMax <= req.tempMax &&
      env.rhMin >= req.rhMin && env.rhMax <= req.rhMax &&
      env.tempMin <= env.tempMax && env.rhMin <= env.rhMax;
    if (!covers) {
      failures.push({
        artifactId: item.artifactId,
        required: req,
        committed: { tempMin: env.tempMin, tempMax: env.tempMax, rhMin: env.rhMin, rhMax: env.rhMax },
      });
    }
  }
  return { ok: failures.length === 0, failures };
}

function timeCompare(value, bound) {
  if (!value || !bound) return false;
  return new Date(value).getTime() <= new Date(bound).getTime();
}

/**
 * 评估节点全部准入条件。返回 { ok, blockers: [{code, message, detail}] }。
 * 前置签名条件由服务层根据决定台账注入 predecessorResults。
 */
export function evaluateNode(node, snapshot, context) {
  const blockers = [];
  const fail = (code, message, detail = undefined) => blockers.push({ code, message, ...(detail ? { detail } : {}) });

  if (node === "curator_dept") {
    if (snapshot.checklist.items.length === 0) fail("checklist_present", "借展清单为空，须提交至少一件文物");
    const invalid = snapshot.checklist.items.filter((item) => ![1, 2, 3].includes(item.grade) || item.declaredValue <= 0);
    if (invalid.length > 0) {
      fail("grades_valid", "清单中存在等级无效或申报价值缺失的文物", invalid.map((item) => item.artifactId));
    }
  }

  if (node === "registrar") {
    const c = snapshot.contract;
    if (!c.documentId) {
      fail("contract_aligned", "缺少借展合同文本凭证");
    } else {
      const mismatches = [];
      if (c.borrower !== snapshot.identity.borrowingOrg) mismatches.push("borrower");
      if (c.exhibitionStartAt !== snapshot.exhibition.startAt) mismatches.push("exhibitionStartAt");
      if (c.exhibitionEndAt !== snapshot.exhibition.endAt) mismatches.push("exhibitionEndAt");
      if (c.shipOutAt !== snapshot.route.shipOutAt) mismatches.push("shipOutAt");
      if (c.returnAt !== snapshot.route.returnAt) mismatches.push("returnAt");
      if (mismatches.length > 0) {
        fail("contract_aligned", "合同关键信息与申请的展期/路线不一致", mismatches);
      }
    }
  }

  if (node === "conservator") {
    const result = environmentCoversAll(snapshot);
    if (!result.ok) {
      fail("env_commitment_covers_requirements", "温湿度承诺无法覆盖清单全部文物的保存要求", result.failures);
    }
  }

  if (node === "risk_manager") {
    failIfInsuranceGap(blockers, snapshot, "transport");
    failIfInsuranceGap(blockers, snapshot, "exhibition");
  }

  if (node === "deputy_director" && context.risk?.level !== "high") {
    fail("risk_high", "仅高风险运输需要分管副馆长加签");
  }

  if ((context.missingPredecessors ?? []).length > 0) {
    fail(
      "all_predecessors_signed",
      `前置节点尚未签字：${context.missingPredecessors.map((missing) => missing.name).join("、")}`,
      context.missingPredecessors,
    );
  }

  return { ok: blockers.length === 0, blockers };
}

function failIfInsuranceGap(blockers, snapshot, phase) {
  const matrix = matrixRef;
  const phaseRule = matrix.requiredInsurancePhases.find((item) => item.phase === phase);
  const totalValue = snapshot.checklist.items.reduce((sum, item) => sum + item.declaredValue * item.quantity, 0);

  let windowStart;
  let windowEnd;
  if (phase === "transport") {
    windowStart = snapshot.route.shipOutAt;
    windowEnd = snapshot.route.returnAt;
  } else {
    windowStart = snapshot.exhibition.installAt ?? snapshot.exhibition.startAt;
    windowEnd = snapshot.exhibition.dismantleAt ?? snapshot.exhibition.endAt;
  }

  const covering = snapshot.insurance.policies.filter((policy) => policy.phases.includes(phase));
  if (covering.length === 0) {
    blockers.push({
      code: `insurance_covers_${phase}`,
      message: `保险凭证未覆盖${phaseRule.name}（缺少 ${phase} 险别）`,
      detail: { requiredWindow: { startAt: windowStart, endAt: windowEnd } },
    });
    blockers.push({ code: `insurance_${phase}_amount_sufficient`, message: `因缺少${phaseRule.name}保单，保额无法核定` });
    return;
  }

  const validInWindow = covering.filter(
    (policy) => timeCompare(policy.startAt, windowStart) && new Date(policy.endAt).getTime() >= new Date(windowEnd).getTime(),
  );
  if (validInWindow.length === 0) {
    blockers.push({
      code: `insurance_covers_${phase}`,
      message: `${phaseRule.name}保单起止期未能覆盖要求窗口（${phaseRule.reason}）`,
      detail: {
        requiredWindow: { startAt: windowStart, endAt: windowEnd },
        policies: covering.map((policy) => ({ policyNo: policy.policyNo, startAt: policy.startAt, endAt: policy.endAt })),
      },
    });
  }

  const bestAmount = Math.max(...validInWindow.map((policy) => policy.amount), 0);
  if (bestAmount < totalValue) {
    blockers.push({
      code: `insurance_${phase}_amount_sufficient`,
      message: `${phaseRule.name}保额不足`,
      detail: { coveredAmount: bestAmount, requiredAmount: totalValue, currency: matrix.currency },
    });
  }
}

/** 版本间凭证血缘：合同与保险单的替换、撤销、新增。 */
export function diffDocuments(oldSnapshot, newSnapshot) {
  const lineage = [];
  if (oldSnapshot) {
    const oldContract = oldSnapshot.contract.documentId;
    const newContract = newSnapshot.contract.documentId;
    if (oldContract && newContract && oldContract !== newContract) {
      lineage.push({ type: "contract", change: "replaced", from: oldContract, to: newContract });
    }
    const oldPolicies = new Map(oldSnapshot.insurance.policies.map((policy) => [policy.policyNo, policy]));
    const newPolicies = new Map(newSnapshot.insurance.policies.map((policy) => [policy.policyNo, policy]));
    for (const [no, oldPolicy] of oldPolicies) {
      const newPolicy = newPolicies.get(no);
      if (!newPolicy) {
        lineage.push({ type: "insurance", change: "revoked", policyNo: no, from: oldPolicy.documentId });
      } else if (newPolicy.documentId !== oldPolicy.documentId) {
        lineage.push({ type: "insurance", change: "certificate_replaced", policyNo: no, from: oldPolicy.documentId, to: newPolicy.documentId });
      }
    }
    for (const [no, newPolicy] of newPolicies) {
      if (!oldPolicies.has(no)) {
        lineage.push({ type: "insurance", change: "added", policyNo: no, to: newPolicy.documentId });
      }
    }
  }
  return lineage;
}

export function diffSections(oldHashes, newHashes) {
  if (!oldHashes) return SECTIONS.slice();
  return SECTIONS.filter((section) => oldHashes[section] !== newHashes[section]);
}

export { canonicalHash, canonicalStringify };
