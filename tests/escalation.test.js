import assert from "node:assert/strict";
import test from "node:test";
import { ACTORS, makeHarness, validApplication, errorCode } from "./helpers.js";
import { approveChain } from "./workflow-shared.js";

const { applicant, curator, registrar, director } = ACTORS;

test("节点超时后扫描触发升级，升级目标可代为批准", () => {
  // 保管部节点审批时限 3 分钟（工作小时），升级宽限同为 3 分钟
  const harness = makeHarness({ now: "2026-06-08T09:00:00+08:00", timeoutHours: { curator_dept: 0.05 }, escalationHours: 0.05 });
  const { applicationId } = harness.engine.submitApplication({ input: validApplication(), actor: applicant });

  const before = harness.engine.explain(applicationId).activeNodes[0];
  assert.equal(before.node, "curator_dept");
  assert.equal(before.deadline, new Date("2026-06-08T09:03:00+08:00").toISOString());
  assert.equal(before.escalationDeadline, new Date("2026-06-08T09:06:00+08:00").toISOString());

  // 未到升级时刻：无事发生
  harness.setTime("2026-06-08T09:05:00+08:00");
  assert.deepEqual(harness.engine.sweepEscalations().escalated, []);

  harness.setTime("2026-06-08T09:07:00+08:00");
  const sweep = harness.engine.sweepEscalations();
  assert.equal(sweep.escalated[0].node, "curator_dept");
  assert.equal(sweep.escalated[0].target, "museum_director");

  // 升级后馆长可以代批（保管部无前置节点，条件齐备）
  harness.engine.decide({ applicationId, node: "curator_dept", actor: director, action: "approve", onBehalfOfEscalation: true });
  const explanation = harness.engine.explain(applicationId);
  const decision = explanation.decisions.find((item) => item.node === "curator_dept");
  assert.equal(decision.onBehalfOfEscalation, true);
  assert.equal(explanation.chain.find((node) => node.node === "curator_dept").status, "approved");
});

test("超时升级不能越过缺失的前置签名：前置被新版本打回后，代批被拒绝", () => {
  const harness = makeHarness({ now: "2026-06-08T09:00:00+08:00", timeoutHours: { registrar: 0.05 }, escalationHours: 0.05 });
  const { applicationId } = harness.engine.submitApplication({ input: validApplication(), actor: applicant });
  harness.engine.decide({ applicationId, node: "curator_dept", actor: curator, action: "approve" });
  // 外借专员节点进入 active 后超时升级
  harness.setTime("2026-06-08T10:00:00+08:00");
  harness.engine.sweepEscalations();
  assert.equal(harness.engine.explain(applicationId).activeNodes[0].node, "registrar");

  // 关键条件变化：清单（保管部关注）被修订 → 保管部签名失效，外借专员失去前置签名
  harness.engine.submitApplication({
    applicationId,
    input: validApplication({ items: [{ artifactId: "artifact-2042", name: "鎏金铜带钩", grade: 2, quantity: 2, declaredValue: 800000, envRequirement: { tempMin: 18, tempMax: 22, rhMin: 50, rhMax: 60 } }] }),
    actor: applicant,
  });
  const explanation = harness.engine.explain(applicationId);
  assert.equal(explanation.chain.find((node) => node.node === "registrar").status, "blocked");
  assert.ok(explanation.chain.find((node) => node.node === "registrar").blockers.some((blocker) => blocker.code === "all_predecessors_signed"));

  // 馆长尝试以升级名义直接代批外借专员 → 被挡住
  assert.equal(
    errorCode(() => harness.engine.decide({ applicationId, node: "registrar", actor: director, action: "approve", onBehalfOfEscalation: true })),
    "blocked_precondition",
  );
});

test("从未进入 active 的阻塞节点不会被超时升级放行", () => {
  const harness = makeHarness({ timeoutHours: { risk_manager: 0.001 }, escalationHours: 0.001 });
  const { applicationId } = harness.engine.submitApplication({ input: validApplication(), actor: applicant });
  harness.advance(10 * 3600 * 1000);
  harness.engine.sweepEscalations();
  // 风控节点仍因前置签名缺失而 blocked
  assert.equal(harness.engine.explain(applicationId).chain.find((node) => node.node === "risk_manager").status, "blocked");
  assert.equal(
    errorCode(() => harness.engine.decide({ applicationId, node: "risk_manager", actor: director, action: "approve", onBehalfOfEscalation: true })),
    "blocked_precondition",
  );
});

test("服务重启后继续使用持久化的截止时间计算升级", () => {
  const harness = makeHarness({ now: "2026-06-08T09:00:00+08:00", timeoutHours: { curator_dept: 0.05 }, escalationHours: 0.05, persistent: true });
  const { applicationId } = harness.engine.submitApplication({ input: validApplication(), actor: applicant });
  const deadlineBefore = harness.engine.explain(applicationId).activeNodes[0].escalationDeadline;

  // 模拟服务重启：用同一状态文件构造全新引擎实例
  const restarted = harness.makeEngine();
  harness.setTime("2026-06-08T09:07:00+08:00");
  const sweep = restarted.sweepEscalations();
  assert.equal(sweep.escalated[0].applicationId, applicationId);

  const after = restarted.explain(applicationId);
  assert.equal(after.activeNodes[0].escalationDeadline, deadlineBefore);
  assert.ok(after.activeNodes[0].escalatedAt);
  harness.cleanup();
});
