import assert from "node:assert/strict";
import test from "node:test";
import { loadReference } from "../src/config.js";
import { requiredNodes } from "../src/risk.js";
import { APPLICANT, baseApplication, expectServiceError, makeHarness } from "./helpers.js";

test("三级文物走航空：主管部门的前置馆领导自动补齐，审批链可走通", async () => {
  const { matrix } = loadReference();
  const data = baseApplication({
    items: [{ artifactId: "a3", name: "陶罐", grade: "三级", quantity: 1, agreedValue: 10000 }],
    climate: { temperatureMin: 12, temperatureMax: 26, humidityMin: 40, humidityMax: 70 },
    insuranceCertificate: { certNo: "I-AIR", coverage: ["display", "transport"], amount: 10000 },
    route: { ...baseApplication().route, mode: "航空" },
  });
  assert.deepEqual(requiredNodes(matrix, data),
    ["insurance", "conservation", "security", "curator", "leader", "authority"]);

  const h = makeHarness();
  const view = await h.service.create(APPLICANT, data);
  for (const node of ["insurance", "conservation", "security", "curator", "leader", "authority"]) {
    const before = h.service.getView(view.id);
    assert.equal(before.nodes[node].actionable, true, `${node} 应可受理（前置已补齐）`);
    await h.service.decide({ id: `u-${node}`, role: node }, view.id, node, "approve");
  }
  assert.equal(h.service.getView(view.id).state, "locked");
});

test("提交与当前版本完全相同的材料不产生新版本", async () => {
  const h = makeHarness();
  const view = await h.service.create(APPLICANT, baseApplication());
  await expectServiceError(
    h.service.submitVersion(APPLICANT, view.id, baseApplication()),
    409, "no_changes",
  );
  assert.equal(h.service.getView(view.id).currentVersion, 1);
});

test("仅修改与关键条件无关的字段（联系电话）产生新版本，但不触发任何节点重签", async () => {
  const h = makeHarness();
  let view = await h.service.create(APPLICANT, baseApplication());
  for (const node of ["insurance", "conservation", "security", "curator", "leader", "authority"]) {
    view = await h.service.decide({ id: `u-${node}`, role: node }, view.id, node, "approve");
  }
  assert.equal(view.state, "locked");

  const tweaked = baseApplication();
  tweaked.borrower = { ...tweaked.borrower, phone: "0571-11112222" };
  view = await h.service.submitVersion(APPLICANT, view.id, tweaked);
  assert.equal(view.currentVersion, 2);
  assert.deepEqual(view.versions[1].changedGroups, [], "没有关键条件分组变化");
  for (const node of ["insurance", "conservation", "security", "curator", "leader", "authority"]) {
    assert.equal(view.nodes[node].status, "approved", `${node} 签字应保留`);
  }
  assert.equal(view.state, "locked");
  assert.equal(view.approvedVersion, 2, "非关键变更的新版本自动成为锁定的可执行版本");
});
