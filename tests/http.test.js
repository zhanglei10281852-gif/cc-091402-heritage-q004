import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { baseApplication } from "./helpers.js";

async function withServer(options, context, fn) {
  const server = createApp(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = (role, id) => (role
    ? { "content-type": "application/json", "x-user-id": id ?? `u-${role}`, "x-user-role": role }
    : { "content-type": "application/json" });

  async function api(method, url, body, role, id) {
    const response = await fetch(base + url, {
      method,
      headers: headers(role, id),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json();
    return { status: response.status, body: json };
  }
  return fn({ api, base, options });
}

test("无身份头提交申请返回 401", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "loan-http-"));
  await withServer({ dataFile: path.join(dir, "data.json") }, t, async ({ api }) => {
    const res = await api("POST", "/applications", baseApplication(), null);
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "unauthorized");
  });
});

test("参考资料接口可查询风险矩阵与角色链", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "loan-http-"));
  await withServer({ dataFile: path.join(dir, "data.json") }, t, async ({ api }) => {
    const res = await api("GET", "/reference");
    assert.equal(res.status, 200);
    assert.ok(res.body.matrix.prerequisites.curator.includes("security"));
    assert.equal(res.body.roles.roles[0].escalatesTo, "leader");
  });
});

test("题目主场景：只保展柜 → 查询解释卡点 → 替换凭证留版本关系 → 重新审批锁定 → 装箱 → 不能撤回", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "loan-http-"));
  const dataFile = path.join(dir, "data.json");
  const options = { dataFile, now: () => new Date("2026-09-22T10:00:00+08:00") };

  await withServer(options, t, async ({ api }) => {
    // 1. 临近出展才发现：凭证只保了展柜
    const created = await api("POST", "/applications", baseApplication({
      insuranceCertificate: { certNo: "CABINET-ONLY", coverage: ["display"], amount: 5000000 },
    }), "applicant", "borrower-7");
    assert.equal(created.status, 201);
    const id = created.body.id;

    let view = (await api("GET", `/applications/${id}`)).body;
    const insurance = view.nodes.insurance;
    assert.equal(insurance.status, "pending");
    assert.deepEqual(insurance.unmetConditions.map((c) => c.code), ["transport_coverage"]);
    assert.equal(insurance.actionable, false);
    assert.ok(view.blockers.some((b) => b.reasons.some((r) => r.includes("运输途中"))));

    // 2. 旧版本已签过字的审批人试图放行：条件不满足，422
    const forced = await api("POST", `/applications/${id}/decisions/insurance`,
      { decision: "approve" }, "insurance", "ins-old");
    assert.equal(forced.status, 422);
    assert.equal(forced.body.error, "conditions_unmet");

    // 3. 申请方通过凭证替换接口补上运输险
    const replaced = await api("POST", `/applications/${id}/certificate`, {
      certNo: "NAIL-TO-NAIL-2",
      insurer: "XX财产保险股份有限公司",
      coverage: ["display", "transport", "packing"],
      amount: 5000000,
      issuedAt: "2026-09-21T10:00:00+08:00",
    }, "applicant", "borrower-7");
    assert.equal(replaced.status, 200);
    assert.equal(replaced.body.currentVersion, 2);
    assert.deepEqual(replaced.body.certificateLineage[1], {
      certNo: "NAIL-TO-NAIL-2",
      version: 2,
      supersedesCertNo: "CABINET-ONLY",
      at: replaced.body.certificateLineage[1].at,
      by: { id: "borrower-7", role: "申请方", name: "" },
    });

    // 4. 按依赖顺序多级审批
    for (const node of ["insurance", "conservation", "security", "curator", "leader", "authority"]) {
      const res = await api("POST", `/applications/${id}/decisions/${node}`,
        { decision: "approve", comment: "同意" }, node);
      assert.equal(res.status, 200, `${node} 审批失败: ${JSON.stringify(res.body)}`);
    }
    view = (await api("GET", `/applications/${id}`)).body;
    assert.equal(view.state, "locked");
    assert.equal(view.approvedVersion, 2);

    // 5. 装箱完成后撤回被拒
    const packed = await api("POST", `/applications/${id}/packing`,
      { lines: [{ artifactId: "artifact-0001", quantity: 1, boxId: "BOX-1" }], complete: true },
      "conservator");
    assert.equal(packed.status, 200);
    assert.equal(packed.body.packing.consistent, true);

    const withdrawal = await api("POST", `/applications/${id}/withdraw`, {}, "applicant", "borrower-7");
    assert.equal(withdrawal.status, 409);
    assert.equal(withdrawal.body.error, "already_packed");
  });
});

test("同一节点并发审批只有一个生效", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "loan-http-"));
  await withServer({ dataFile: path.join(dir, "data.json") }, t, async ({ api }) => {
    const created = await api("POST", "/applications", baseApplication(), "applicant");
    const id = created.body.id;
    const results = await Promise.all([
      api("POST", `/applications/${id}/decisions/insurance`, { decision: "approve" }, "insurance", "i1"),
      api("POST", `/applications/${id}/decisions/insurance`, { decision: "approve" }, "insurance", "i2"),
    ]);
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 409]);
    assert.equal(results.find((r) => r.status === 409).body.error, "already_decided");
  });
});

test("重启后截止时间延续，列表接口可查全部申请", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "loan-http-"));
  const dataFile = path.join(dir, "data.json");
  let current = new Date("2026-09-22T10:00:00+08:00");
  const options = { dataFile, now: () => current };

  await withServer(options, t, async ({ api }) => {
    const created = await api("POST", "/applications", baseApplication(), "applicant");
    const id = created.body.id;
    for (const node of ["insurance", "conservation", "security"]) {
      (await api("POST", `/applications/${id}/decisions/${node}`, { decision: "approve" }, node));
    }
    let view = (await api("GET", `/applications/${id}`)).body;
    const deadline = view.nodes.curator.deadline;
    assert.ok(deadline);

    // “重启”：同一数据文件、新的容器实例
    current = new Date("2026-09-23T11:00:00+08:00");
    const { createApp: createAgain } = await import("../src/app.js");
    const server2 = createAgain({ dataFile, now: () => current });
    await new Promise((resolve) => server2.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server2.close(resolve)));
    const base2 = `http://127.0.0.1:${server2.address().port}`;
    const res = await fetch(`${base2}/applications/${id}`);
    view = await res.json();
    assert.equal(view.nodes.curator.deadline, deadline, "截止时间沿用落盘的绝对时刻");
    assert.equal(view.nodes.curator.overdue, true);
    assert.equal(view.nodes.curator.escalatedTo, "leader");
    // 馆领导升级代办
    const escalatedDecision = await fetch(`${base2}/applications/${id}/decisions/curator`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "leader-1", "x-user-role": "leader" },
      body: JSON.stringify({ decision: "approve", comment: "超时升级代办" }),
    });
    assert.equal(escalatedDecision.status, 200);

    const list = await (await fetch(`${base2}/applications`)).json();
    assert.equal(list.applications.length, 1);
    assert.equal(list.applications[0].id, id);
    assert.equal(list.applications[0].topGrade, "一级");
  });
});
