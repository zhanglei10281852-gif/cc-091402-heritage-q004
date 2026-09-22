import assert from "node:assert/strict";
import test from "node:test";
import { loadReference } from "../src/config.js";
import {
  requiredNodes,
  unmetConditions,
  groupFingerprints,
  changedGroups,
  dependentClosure,
  highestGrade,
} from "../src/risk.js";
import { baseApplication } from "./helpers.js";

const { matrix } = loadReference();

test("文物等级决定节点：三级只有基础四节点", () => {
  const data = baseApplication({ items: [{ artifactId: "a3", name: "陶罐", grade: "三级", quantity: 1, agreedValue: 10000 }] });
  assert.deepEqual(requiredNodes(matrix, data), ["insurance", "conservation", "security", "curator"]);
});

test("一级文物追加馆领导与主管部门", () => {
  assert.deepEqual(requiredNodes(matrix, baseApplication()),
    ["insurance", "conservation", "security", "curator", "leader", "authority"]);
});

test("二级文物追加馆领导", () => {
  const data = baseApplication({ items: [{ artifactId: "a2", name: "瓷器", grade: "二级", quantity: 1, agreedValue: 200000 }] });
  assert.deepEqual(requiredNodes(matrix, data),
    ["insurance", "conservation", "security", "curator", "leader"]);
});

test("航空/水路或国际路线追加主管部门", () => {
  const byAir = baseApplication({ route: { ...baseApplication().route, mode: "航空" } });
  assert.ok(requiredNodes(matrix, byAir).includes("authority"));
  const international = baseApplication({
    route: { ...baseApplication().route, international: true, mode: "公路" },
  });
  assert.ok(requiredNodes(matrix, international).includes("authority"));
});

test("多件文物取最高等级", () => {
  const data = baseApplication({
    items: [
      { artifactId: "a3", name: "陶罐", grade: "三级", quantity: 1, agreedValue: 10000 },
      { artifactId: "a1", name: "青铜鼎", grade: "一级", quantity: 1, agreedValue: 5000000 },
    ],
  });
  assert.equal(highestGrade(matrix, data.items).key, "一级");
});

test("只覆盖展柜的保险：保险节点与安全节点同时受阻", () => {
  const data = baseApplication({
    insuranceCertificate: { certNo: "BAD", coverage: ["display"], amount: 5000000 },
  });
  assert.deepEqual(unmetConditions(matrix, "insurance", data).map((c) => c.code), ["transport_coverage"]);
  assert.deepEqual(unmetConditions(matrix, "security", data).map((c) => c.code), ["transport_insurance"]);
});

test("保险金额低于协议价合计时保险节点受阻", () => {
  const data = baseApplication({
    insuranceCertificate: { certNo: "LOW", coverage: ["display", "transport"], amount: 4999999 },
  });
  assert.deepEqual(unmetConditions(matrix, "insurance", data).map((c) => c.code), ["coverage_amount"]);
});

test("温湿度承诺超出一级文物区间时保护科技节点受阻", () => {
  const data = baseApplication({ climate: { temperatureMin: 17, temperatureMax: 23, humidityMin: 50, humidityMax: 60 } });
  assert.deepEqual(unmetConditions(matrix, "conservation", data).map((c) => c.code), ["temperature_band"]);
});

test("三级文物温湿度区间更宽", () => {
  const data = baseApplication({
    items: [{ artifactId: "a3", name: "陶罐", grade: "三级", quantity: 1, agreedValue: 10000 }],
    climate: { temperatureMin: 12, temperatureMax: 26, humidityMin: 40, humidityMax: 70 },
    insuranceCertificate: { certNo: "I3", coverage: ["display", "transport"], amount: 10000 },
  });
  assert.deepEqual(unmetConditions(matrix, "conservation", data), []);
});

test("路线信息不完整时安全节点受阻", () => {
  const data = baseApplication({ route: { ...baseApplication().route, carrier: "" } });
  assert.deepEqual(unmetConditions(matrix, "security", data).map((c) => c.code), ["route_complete"]);
});

test("未接受合同条款时藏品部节点受阻", () => {
  const data = baseApplication({ contractAccepted: false });
  assert.deepEqual(unmetConditions(matrix, "curator", data).map((c) => c.code), ["contract_accepted"]);
});

test("凭证替换只改变 insurance 分组", () => {
  const before = groupFingerprints(baseApplication());
  const after = groupFingerprints(baseApplication({
    insuranceCertificate: { ...baseApplication().insuranceCertificate, certNo: "INS-NEW" },
  }));
  assert.deepEqual(changedGroups(before, after), ["insurance"]);
});

test("保险分组变化的失效闭包覆盖整条后置链", () => {
  const closure = dependentClosure(matrix, ["insurance"]);
  assert.deepEqual([...closure], ["insurance", "security", "curator", "leader", "authority"]);
});

test("路线变化不影响保险节点，但级联到其后置", () => {
  const closure = dependentClosure(matrix, ["security"]);
  assert.deepEqual([...closure], ["security", "curator", "leader", "authority"]);
});
