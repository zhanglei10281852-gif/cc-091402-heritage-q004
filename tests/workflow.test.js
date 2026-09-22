import assert from "node:assert/strict";
import test from "node:test";
import { ACTORS, makeHarness, validApplication, exhibitionOnlyInsuranceApplication, manifestFor, errorCode } from "./helpers.js";
import { approveChain } from "./workflow-shared.js";

const { curator, curator2, registrar, conservator, risk, deputy, director, outsider, applicant } = ACTORS;

test("完整合规申请：多级审批通过后锁定可执行版本", () => {
  const harness = makeHarness();
  const { applicationId } = harness.engine.submitApplication({ input: validApplication(), actor: applicant });
  const explanation = harness.engine.explain(applicationId);

  // 二级文物 + 境内直达 + 航空/公路：风险 medium，链条不含副馆长加签
  assert.equal(explanation.risk.level, "medium");
  assert.deepEqual(explanation.chain.map((node) => node.node), ["curator_dept", "registrar", "conservator", "risk_manager", "museum_director"]);
  // 首个节点可审批，其余被前置签名阻塞
  assert.equal(explanation.chain[0].status, "active");
  assert.equal(explanation.chain[1].status, "blocked");
  assert.ok(explanation.chain[1].blockers.some((blocker) => blocker.code === "all_predecessors_signed"));

  approveChain(harness.engine, applicationId);
  const done = harness.engine.explain(applicationId);
  assert.equal(done.status, "locked");
  assert.equal(done.approvedVersion.seq, 1);
  assert.ok(done.approvedVersion.hash);
});

test("高风险（一级文物+公路运输）自动插入分管副馆长加签节点", () => {
  const harness = makeHarness();
  const input = validApplication({
    items: [{ artifactId: "artifact-1001", name: "青花梅瓶", grade: 1, quantity: 1, declaredValue: 2000000, envRequirement: { tempMin: 18, tempMax: 22, rhMin: 50, rhMax: 60 } }],
    route: { type: "domestic_transfer", transportModes: ["road"] },
    insurance: { policies: [{ policyNo: "P-MIX-001", insurer: "x", documentId: "cert-1", amount: 2000000, phases: ["exhibition", "transport"], startAt: "2026-06-09T00:00:00+08:00", endAt: "2026-07-13T23:59:00+08:00" }] },
  });
  const { applicationId } = harness.engine.submitApplication({ input, actor: applicant });
  assert.equal(harness.engine.explain(applicationId).risk.level, "high");
  const chain = harness.engine.explain(applicationId).chain.map((node) => node.node);
  assert.deepEqual(chain, ["curator_dept", "registrar", "conservator", "risk_manager", "deputy_director", "museum_director"]);
});

test("题设场景：保险只覆盖展柜（展期）未覆盖运输风险，风控节点被阻断并给出解释", () => {
  const harness = makeHarness();
  const { applicationId } = harness.engine.submitApplication({ input: exhibitionOnlyInsuranceApplication(), actor: applicant });
  approveChain(harness.engine, applicationId, { through: "conservator" });

  const explanation = harness.engine.explain(applicationId);
  const riskNode = explanation.chain.find((node) => node.node === "risk_manager");
  assert.equal(riskNode.status, "blocked");
  const codes = riskNode.blockers.map((blocker) => blocker.code);
  assert.ok(codes.includes("insurance_covers_transport"), `应报告运输险缺失，实际：${codes}`);
  assert.ok(!codes.includes("insurance_covers_exhibition"));
  assert.equal(explanation.currentBlock[0].node, "risk_manager");
  assert.match(riskNode.blockers[0].message, /运输/);

  // 馆长此时不能批准：前置签名缺失
  assert.equal(
    errorCode(() => harness.engine.decide({ applicationId, node: "museum_director", actor: director, action: "approve" })),
    "blocked_precondition",
  );
});

test("凭证替换：保留版本血缘（parentSeq 与 documentLineage），旧版本不被覆盖", () => {
  const harness = makeHarness();
  const first = validApplication();
  const { applicationId } = harness.engine.submitApplication({ input: first, actor: applicant });
  approveChain(harness.engine, applicationId);
  assert.equal(harness.engine.explain(applicationId).status, "locked");

  // 临近出展才补运输险凭证
  const fixed = validApplication({
    insurance: {
      policies: [
        {
          policyNo: "P-EXH-002",
          insurer: "中国人保",
          documentId: "cert-insurance-exhibition-only",
          amount: 1000000,
          phases: ["exhibition"],
          startAt: "2026-06-10T09:00:00+08:00",
          endAt: "2026-07-11T18:00:00+08:00",
        },
        {
          policyNo: "P-TRP-009",
          insurer: "中国人保",
          documentId: "cert-transport-final",
          amount: 1000000,
          phases: ["transport"],
          startAt: "2026-06-09T00:00:00+08:00",
          endAt: "2026-07-13T23:59:00+08:00",
        },
      ],
    },
  });
  const v2 = harness.engine.submitApplication({ applicationId, input: fixed, actor: applicant });
  assert.equal(v2.seq, 2);
  assert.ok(v2.changedSections.includes("insurance"));
  assert.deepEqual(v2.documentLineage, [
    { type: "insurance", change: "revoked", policyNo: "P-MIX-001", from: "cert-insurance-v1" },
    { type: "insurance", change: "added", policyNo: "P-EXH-002", to: "cert-insurance-exhibition-only" },
    { type: "insurance", change: "added", policyNo: "P-TRP-009", to: "cert-transport-final" },
  ]);

  // 批准锁定已解除，风控节点因保险段落变化重新进入；此前未受影响节点（保管部等）保留签名
  const explanation = harness.engine.explain(applicationId);
  assert.equal(explanation.status, "in_review");
  assert.equal(explanation.approvedVersion, null);
  assert.equal(explanation.chain.find((node) => node.node === "curator_dept").status, "approved");
  assert.equal(explanation.chain.find((node) => node.node === "risk_manager").status, "active");
});

test("关键条件变化后相应节点重入，已签字但基于旧版本的签名标记为失效台账", () => {
  const harness = makeHarness();
  const { applicationId } = harness.engine.submitApplication({ input: validApplication(), actor: applicant });
  approveChain(harness.engine, applicationId, { until: "conservator" });

  // 温湿度承诺被放宽到超出文物耐受区间，无法保证所有文物安全
  const changed = validApplication({ environment: { tempMin: 10, tempMax: 28, rhMin: 30, rhMax: 80 } });
  harness.engine.submitApplication({ applicationId, input: changed, actor: applicant });

  const explanation = harness.engine.explain(applicationId);
  const conservatorNode = explanation.chain.find((node) => node.node === "conservator");
  assert.equal(conservatorNode.status, "blocked");
  assert.ok(conservatorNode.blockers.some((blocker) => blocker.code === "env_commitment_covers_requirements"));
  // 旧批准决定仍可在台账中查到
  const oldDecision = explanation.decisions.find((decision) => decision.node === "conservator");
  assert.equal(oldDecision.action, "approve");
  assert.equal(oldDecision.versionSeq, 1);
  // 保管部未受影响，签名继续有效
  assert.equal(explanation.chain.find((node) => node.node === "curator_dept").status, "approved");
});

test("并发审批同一节点只产生一个有效决定，第二个返回 decision_conflict", () => {
  const harness = makeHarness();
  const { applicationId } = harness.engine.submitApplication({ input: validApplication(), actor: applicant });
  const first = harness.engine.decide({ applicationId, node: "curator_dept", actor: curator, action: "approve" });
  assert.ok(first);
  assert.equal(
    errorCode(() => harness.engine.decide({ applicationId, node: "curator_dept", actor: curator2, action: "approve" })),
    "decision_conflict",
  );
  const explanation = harness.engine.explain(applicationId);
  assert.equal(explanation.chain.find((node) => node.node === "curator_dept").decidedBy, curator);
});

test("无权身份不能在节点作出决定", () => {
  const harness = makeHarness();
  const { applicationId } = harness.engine.submitApplication({ input: validApplication(), actor: applicant });
  assert.equal(
    errorCode(() => harness.engine.decide({ applicationId, node: "curator_dept", actor: outsider, action: "approve" })),
    "actor_not_authorized",
  );
});

test("驳回后申请停摆；提交修订版本后驳回节点重新开放", () => {
  const harness = makeHarness();
  const { applicationId } = harness.engine.submitApplication({ input: validApplication(), actor: applicant });
  harness.engine.decide({ applicationId, node: "curator_dept", actor: curator, action: "reject", note: "现状记录存疑" });
  assert.equal(harness.engine.explain(applicationId).status, "rejected");
  assert.equal(
    errorCode(() => harness.engine.decide({ applicationId, node: "curator_dept", actor: curator, action: "approve" })),
    "application_rejected",
  );
  // 修订（更换承运商）后，被驳回的节点重新开放
  harness.engine.submitApplication({ applicationId, input: validApplication({ route: { carrier: "华安文物运输（变更押运组）" } }), actor: applicant });
  const explanation = harness.engine.explain(applicationId);
  assert.equal(explanation.status, "in_review");
  assert.equal(explanation.chain.find((node) => node.node === "curator_dept").status, "active");
});

test("锁定版本通过后才能装箱；装箱清单与批准版本不一致时拒绝", () => {
  const harness = makeHarness();
  const input = validApplication();
  const { applicationId } = harness.engine.submitApplication({ input, actor: applicant });
  assert.equal(errorCode(() => harness.engine.pack({ applicationId, actor: "packer", manifest: manifestFor(input) })), "not_locked");

  approveChain(harness.engine, applicationId);
  const badManifest = { items: [{ artifactId: "artifact-2042", quantity: 1 }, { artifactId: "artifact-9999", quantity: 1 }] };
  assert.equal(errorCode(() => harness.engine.pack({ applicationId, actor: "packer", manifest: badManifest })), "manifest_mismatch");

  harness.engine.pack({ applicationId, actor: "packer", manifest: manifestFor(input) });
  assert.equal(harness.engine.explain(applicationId).status, "packed");
});

test("已装箱申请不能直接撤回；解除装箱后可以撤回", () => {
  const harness = makeHarness();
  const input = validApplication();
  const { applicationId } = harness.engine.submitApplication({ input, actor: applicant });
  approveChain(harness.engine, applicationId);
  harness.engine.pack({ applicationId, actor: "packer", manifest: manifestFor(input) });

  assert.equal(errorCode(() => harness.engine.withdraw({ applicationId, actor: applicant })), "packed_cannot_withdraw");
  // 装箱期间也不能修订
  assert.equal(errorCode(() => harness.engine.submitApplication({ applicationId, input: validApplication({ route: { carrier: "另一家" } }), actor: applicant })), "packed_cannot_revise");

  harness.engine.unpack({ applicationId, actor: "packer", reason: "展品调整，解除装箱核验" });
  harness.engine.withdraw({ applicationId, actor: applicant, reason: "借展取消" });
  assert.equal(harness.engine.explain(applicationId).status, "withdrawn");
});

test("未装箱申请可以撤回；撤回后不能再提交", () => {
  const harness = makeHarness();
  const { applicationId } = harness.engine.submitApplication({ input: validApplication(), actor: applicant });
  harness.engine.withdraw({ applicationId, actor: applicant });
  assert.equal(
    errorCode(() => harness.engine.submitApplication({ applicationId, input: validApplication({ route: { carrier: "x" } }), actor: applicant })),
    "application_terminal",
  );
});

test("查询接口能解释：卡条件、决定人、批准版本与装箱单一致性", () => {
  const harness = makeHarness();
  const input = validApplication();
  const { applicationId } = harness.engine.submitApplication({ input, actor: applicant });
  harness.engine.decide({ applicationId, node: "curator_dept", actor: curator2, action: "approve" });

  const explanation = harness.engine.explain(applicationId);
  // 谁做过决定
  const curatorDecision = explanation.decisions.find((decision) => decision.node === "curator_dept");
  assert.equal(curatorDecision.actor, curator2);
  assert.equal(curatorDecision.versionSeq, 1);
  // 卡在哪里：保管部已批，外借专员为当前活动节点，其后节点仍被前置签名阻塞
  assert.deepEqual(explanation.currentBlock.map((block) => block.node), ["conservator", "risk_manager", "museum_director"]);
  assert.equal(explanation.activeNodes[0].node, "registrar");
  assert.ok(explanation.currentBlock[0].blockers.some((blocker) => blocker.code === "all_predecessors_signed"));

  approveChain(harness.engine, applicationId);
  harness.engine.pack({ applicationId, actor: "packer", manifest: manifestFor(input) });
  const packed = harness.engine.explain(applicationId);
  assert.equal(packed.packingConsistency.matchesApprovedVersion, true);
  assert.equal(packed.packingConsistency.packedAgainstCurrentVersion, true);
});

test("锁定后新版本使批准版本与装箱比对结论变为不一致（需重新批准才能再装箱）", () => {
  const harness = makeHarness();
  const input = validApplication();
  const { applicationId } = harness.engine.submitApplication({ input, actor: applicant });
  approveChain(harness.engine, applicationId);
  harness.engine.pack({ applicationId, actor: "packer", manifest: manifestFor(input) });
  harness.engine.unpack({ applicationId, actor: "packer", reason: "换展柜" });
  // 修订路线（关键条件）→ 锁失效
  harness.engine.submitApplication({ applicationId, input: validApplication({ route: { type: "cross_border", transportModes: ["air"] } }), actor: applicant });
  const explanation = harness.engine.explain(applicationId);
  assert.equal(explanation.status, "in_review");
  assert.equal(explanation.approvedVersion, null);
});
