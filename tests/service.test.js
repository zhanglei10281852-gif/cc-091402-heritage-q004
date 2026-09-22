import assert from "node:assert/strict";
import test from "node:test";
import {
  APPLICANT,
  approveAll,
  baseApplication,
  expectServiceError,
  makeHarness,
  user,
} from "./helpers.js";

async function create(harness, data = baseApplication()) {
  return harness.service.create(APPLICANT, data);
}

test("提交申请后按一级文物组织六级审批，未满足节点给出可解释的阻塞条件", async () => {
  const h = makeHarness();
  const view = await create(h, baseApplication({
    insuranceCertificate: { certNo: "DISPLAY-ONLY", coverage: ["display"], amount: 5000000 },
  }));
  assert.equal(view.state, "in_review");
  assert.deepEqual(view.requiredNodes,
    ["insurance", "conservation", "security", "curator", "leader", "authority"]);

  const insuranceBlocker = view.blockers.find((b) => b.node === "insurance");
  assert.match(insuranceBlocker.reasons.join(";"), /运输途中/);
  const securityBlocker = view.blockers.find((b) => b.node === "security");
  assert.match(securityBlocker.reasons.join(";"), /运输风险尚未投保/);
  assert.equal(view.nodes.insurance.actionable, false);
  // 保护科技节点材料齐备、无前置，可以受理
  assert.equal(view.nodes.conservation.actionable, true);
  assert.equal(view.nodes.insurance.deadline, null, "材料不齐的节点不计时，等待期间不给 SLA");
  assert.ok(view.nodes.conservation.deadline, "材料齐备的可受理节点应带有工作时截止时间");
});

test("前置签名缺失时后续节点不能审批，即使审批人角色更高", async () => {
  const h = makeHarness();
  const view = await create(h);
  // 馆领导试图在藏品部之前直接审批
  await expectServiceError(
    h.service.decide(user("leader"), view.id, "curator", "approve", "先批了"),
    409, "missing_prerequisite",
  );
  await expectServiceError(
    h.service.decide(user("leader"), view.id, "leader", "approve", "自批"),
    409, "missing_prerequisite",
  );
  // 安全节点要求保险先签
  await expectServiceError(
    h.service.decide(user("security"), view.id, "security", "approve", "同意"),
    409, "missing_prerequisite",
  );
});

test("走完依赖顺序后全部批准，版本锁定为可执行版本", async () => {
  const h = makeHarness();
  let view = await create(h);
  view = await approveAll(h.service, view.id, view);
  assert.equal(view.state, "locked");
  assert.equal(view.approvedVersion, 1);
  assert.equal(view.currentVersion, 1);
  assert.ok(view.lockedAt);
  assert.deepEqual(view.blockers, []);
  const lockEvent = view.events.find((e) => e.type === "version_locked");
  assert.equal(lockEvent.version, 1);
});

test("三级文物只需四级审批", async () => {
  const h = makeHarness();
  const data = baseApplication({
    items: [{ artifactId: "a3", name: "陶罐", grade: "三级", quantity: 2, agreedValue: 10000 }],
    climate: { temperatureMin: 12, temperatureMax: 26, humidityMin: 40, humidityMax: 70 },
    insuranceCertificate: { certNo: "I3", coverage: ["display", "transport"], amount: 20000 },
  });
  let view = await create(h, data);
  assert.deepEqual(view.requiredNodes, ["insurance", "conservation", "security", "curator"]);
  view = await approveAll(h.service, view.id, view);
  assert.equal(view.state, "locked");
});

test("保险只保展柜被拒后补换运输险：凭证留下版本关系，旧批次拒绝随新版本失效", async () => {
  const h = makeHarness();
  let view = await create(h, baseApplication({
    insuranceCertificate: { certNo: "DISPLAY-ONLY", coverage: ["display"], amount: 5000000 },
  }));
  // 材料不齐时不能批准，但可以拒绝
  await expectServiceError(
    h.service.decide(user("insurance"), view.id, "insurance", "approve"),
    422, "conditions_unmet",
  );
  await h.service.decide(user("insurance"), view.id, "insurance", "reject", "只保了展柜，缺运输险");
  view = h.service.getView(view.id);
  assert.equal(view.state, "rejected");

  // 申请方替换为钉到钉保单
  const newData = baseApplication({
    insuranceCertificate: { certNo: "NAIL-TO-NAIL", coverage: ["display", "transport"], amount: 5000000 },
  });
  view = await h.service.submitVersion(APPLICANT, view.id, newData);
  assert.equal(view.currentVersion, 2);
  assert.equal(view.nodes.insurance.status, "pending");
  assert.equal(view.nodes.insurance.attempt, 2);
  const rejected = view.decisions.find((d) => d.decision === "reject");
  assert.equal(rejected.superseded, true);
  assert.match(rejected.supersedeReason, /新版本/);

  // 凭证版本链：新凭证指向被替换的旧凭证
  assert.deepEqual(view.certificateLineage.map((c) => [c.version, c.certNo, c.supersedesCertNo]),
    [[1, "DISPLAY-ONLY", null], [2, "NAIL-TO-NAIL", "DISPLAY-ONLY"]]);
  assert.deepEqual(view.versions[1].changedGroups, ["insurance"]);

  view = await approveAll(h.service, view.id, view);
  assert.equal(view.state, "locked");
  assert.equal(view.approvedVersion, 2);
});

test("审批人在旧版本签过字，关键条件变化后签字失效，须在新版本重签", async () => {
  const h = makeHarness();
  let view = await create(h);
  view = await h.service.decide(user("insurance"), view.id, "insurance", "approve", "v1 保单可以");
  const v1Decision = view.decisions.at(-1);
  assert.equal(v1Decision.version, 1);

  // v2 更换保险凭证
  view = await h.service.submitVersion(APPLICANT, view.id, baseApplication({
    insuranceCertificate: { certNo: "INS-V2", coverage: ["display", "transport"], amount: 5000000 },
  }));
  assert.equal(view.nodes.insurance.status, "pending");
  assert.equal(view.nodes.insurance.attempt, 2);
  assert.equal(view.state, "in_review");
  const old = view.decisions.find((d) => d.id === v1Decision.id);
  assert.equal(old.superseded, true);
  assert.equal(old.effective, false);
  assert.equal(view.events.at(-1).type, "signature_revoked");

  view = await h.service.decide(user("insurance"), view.id, "insurance", "approve", "v2 保单复核通过");
  view = await approveAll(h.service, view.id, view);
  assert.equal(view.state, "locked");
  assert.equal(view.approvedVersion, 2);
  const effective = view.decisions.filter((d) => d.effective && d.node === "insurance");
  assert.equal(effective.length, 1);
  assert.equal(effective[0].version, 2);
});

test("路线变化使安全及其后置节点重新进入，但保险与保护科技签字保留", async () => {
  const h = makeHarness();
  let view = await create(h);
  view = await approveAll(h.service, view.id, view);
  assert.equal(view.state, "locked");

  // 申请方修改路线承运商（尚未装箱，可以变更）
  const v2 = baseApplication({
    route: { ...baseApplication().route, carrier: "新承运商有限公司" },
  });
  view = await h.service.submitVersion(APPLICANT, view.id, v2);
  assert.equal(view.nodes.insurance.status, "approved");
  assert.equal(view.nodes.conservation.status, "approved");
  assert.equal(view.nodes.security.status, "pending");
  assert.equal(view.nodes.curator.status, "pending");
  assert.equal(view.nodes.leader.status, "pending");
  assert.equal(view.nodes.authority.status, "pending");
  assert.equal(view.approvedVersion, 1, "旧锁定版本仍可查，但不再是当前可执行版本");
  assert.equal(view.state, "in_review");

  view = await approveAll(h.service, view.id, view);
  assert.equal(view.approvedVersion, 2);
});

test("并发/重复审批同一批次只能产生一个有效决定", async () => {
  const h = makeHarness();
  const view = await create(h);
  // 两个保险审核员几乎同时批准
  const [a, b] = await Promise.allSettled([
    h.service.decide(user("insurance", "ins-1"), view.id, "insurance", "approve", "甲同意"),
    h.service.decide(user("insurance", "ins-2"), view.id, "insurance", "approve", "乙同意"),
  ]);
  assert.equal(a.status, "fulfilled");
  assert.equal(b.status, "rejected");
  assert.equal(b.reason.code, "already_decided");
  const after = h.service.getView(view.id);
  const effective = after.decisions.filter((d) => d.node === "insurance" && d.effective);
  assert.equal(effective.length, 1);
  assert.equal(effective[0].by.id, "ins-1");

  // 已批准后再拒绝也被挡回
  await expectServiceError(
    h.service.decide(user("insurance", "ins-3"), view.id, "insurance", "reject"),
    409, "already_decided",
  );
});

test("超时升级只转移受理权：前置签名缺失时升级链角色也不能代办", async () => {
  const h = makeHarness(new Date("2026-09-22T10:00:00+08:00"));
  let view = await create(h);
  // 只签保险和保护科技，安全未签，藏品部缺前置
  view = await h.service.decide(user("insurance"), view.id, "insurance", "approve");
  view = await h.service.decide(user("conservation"), view.id, "conservation", "approve");
  // 推进很久，所有在计时的节点都超时
  h.advance(200);
  // 馆领导想趁“超时”直接替藏品部签字——安全前置缺失，拒绝
  const error = await expectServiceError(
    h.service.decide(user("leader"), view.id, "curator", "approve", "特事特办"),
    409, "missing_prerequisite",
  );
  assert.equal(error.details.missingPrerequisites[0].node, "security");

  // 显式升级操作同样不会越过缺前置的节点
  const result = await h.service.escalate(user("管理员"), view.id);
  assert.ok(!result.escalated.some((e) => e.node === "curator"));
});

test("节点超时后升级链角色可以受理，截止时间为绝对时刻且服务重启后继续有效", async () => {
  const h = makeHarness(new Date("2026-09-22T10:00:00+08:00"));
  let view = await create(h);
  // 藏品部 SLA 8 工作小时：先把前置签完
  view = await h.service.decide(user("insurance"), view.id, "insurance", "approve");
  view = await h.service.decide(user("conservation"), view.id, "conservation", "approve");
  view = await h.service.decide(user("security"), view.id, "security", "approve");
  const deadlineBefore = view.nodes.curator.deadline;
  assert.ok(deadlineBefore);
  // curator 周二 10:00 起算（前置节点耗时为 0），8h => 当天剩 7h + 周三 1h = 周三 10:00
  assert.equal(new Date(deadlineBefore).toISOString(),
    new Date("2026-09-23T10:00:00+08:00").toISOString());

  // 重启：从同一数据文件恢复
  const restarted = h.restart();
  let restartedView = restarted.service.getView(view.id);
  assert.equal(restartedView.nodes.curator.deadline, deadlineBefore, "截止时间不随重启重算");
  assert.equal(restartedView.nodes.curator.overdue, false);

  // 越过截止时间后重启的服务也判超时
  h.setNow("2026-09-23T10:30:00+08:00");
  restartedView = restarted.service.getView(view.id);
  assert.equal(restartedView.nodes.curator.overdue, true);
  assert.equal(restartedView.nodes.curator.escalatedTo, "leader");
  // 升级受理：馆领导替藏品部签字
  restartedView = await restarted.service
    .decide(user("leader"), view.id, "curator", "approve", "超时升级代办");
  assert.equal(restartedView.nodes.curator.currentDecision.by.role, "leader");
  assert.equal(restartedView.nodes.curator.currentDecision.comment, "超时升级代办");
});

test("批准并锁定后才能装箱；装箱清单必须与批准版本逐件一致", async () => {
  const h = makeHarness();
  let view = await create(h);
  await expectServiceError(
    h.service.pack(user("保护人员"), view.id,
      [{ artifactId: "artifact-0001", quantity: 1 }], true),
    409, "not_approved",
  );

  view = await approveAll(h.service, view.id, view);
  assert.equal(view.state, "locked");

  // 装入批准清单之外的文物
  await expectServiceError(
    h.service.pack(user("保护人员"), view.id,
      [{ artifactId: "artifact-9999", quantity: 1 }], false),
    422, "unknown_item",
  );
  // 超数量装
  await expectServiceError(
    h.service.pack(user("保护人员"), view.id,
      [{ artifactId: "artifact-0001", quantity: 2 }], false),
    422, "over_packed",
  );

  // 按批准清单装箱并完成
  view = await h.service.pack(user("保护人员"), view.id,
    [{ artifactId: "artifact-0001", quantity: 1, boxId: "BOX-1" }], true);
  assert.equal(view.packing.status, "complete");
  assert.equal(view.packing.consistent, true);
  assert.equal(view.state, "packed");
});

test("已装箱的申请不能直接撤回，须办理退回", async () => {
  const h = makeHarness();
  let view = await create(h);
  view = await approveAll(h.service, view.id, view);
  view = await h.service.pack(user("保护人员"), view.id,
    [{ artifactId: "artifact-0001", quantity: 1 }], true);

  const error = await expectServiceError(
    h.service.withdraw(APPLICANT, view.id),
    409, "already_packed",
  );
  assert.ok(error.details.packedCount >= 1);
  view = h.service.getView(view.id);
  assert.equal(view.withdrawnAt, null);
  assert.equal(view.events.at(-1).type, "withdrawal_rejected");

  // 未装箱的申请可以正常撤回
  const other = await create(h);
  const withdrawn = await h.service.withdraw(APPLICANT, other.id);
  assert.equal(withdrawn.state, "withdrawn");
  assert.ok(withdrawn.withdrawnAt);

  // 装箱完成后走退回流程
  view = await h.service.markReturned(user("管理员"), view.id);
  assert.equal(view.state, "returned");
});

test("查询视图解释卡点、决定历史、版本与装箱一致性", async () => {
  const h = makeHarness();
  const view = await create(h);
  // 安全节点：条件齐备但缺保险前置
  const security = view.nodes.security;
  assert.equal(security.actionable, false);
  assert.deepEqual(security.waitingOn.conditions, []);
  assert.deepEqual(security.waitingOn.prerequisites, ["保险审核"]);
  assert.deepEqual(security.prerequisites.map((p) => p.node), ["insurance"]);

  // 谁在什么时候做过决定（含角色与版本）
  await h.service.decide(user("insurance", "ins-9"), view.id, "insurance", "approve", "保单核对无误");
  const decided = h.service.getView(view.id);
  assert.deepEqual(decided.decisions.map((d) => [d.node, d.decision, d.by.id, d.effective]),
    [["insurance", "approve", "ins-9", true]]);

  // 未装箱时一致性状态为 not_started
  assert.equal(decided.packing.status, "none");
  assert.equal(decided.packing.consistent, true);
  assert.equal(decided.packing.reason, "not_started");
});

test("拒绝后申请停在被拒节点，事件流完整留痕", async () => {
  const h = makeHarness();
  const view = await create(h);
  await h.service.decide(user("conservation"), view.id, "conservation", "reject", "温湿度不达标");
  const after = h.service.getView(view.id);
  assert.equal(after.state, "rejected");
  const blocker = after.blockers.find((b) => b.node === "conservation");
  assert.match(blocker.reasons.join(";"), /已拒绝/);
  assert.ok(after.events.some((e) => e.type === "application_rejected"));
});
