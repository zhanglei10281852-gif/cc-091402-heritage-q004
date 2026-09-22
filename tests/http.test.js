import assert from "node:assert/strict";
import test from "node:test";
import { createApp, createEngine } from "../src/app.js";
import { MemoryStore } from "../src/store.js";
import { loadCalendar } from "../src/calendar.js";
import calendarRef from "../reference/workday-calendar-2026.json" with { type: "json" };
import rolesRef from "../reference/approval-roles.json" with { type: "json" };
import { ACTORS, validApplication, manifestFor } from "./helpers.js";
import { approveChain } from "./workflow-shared.js";

async function startServer() {
  const engine = createEngine({ store: new MemoryStore(), calendar: loadCalendar(calendarRef), roles: rolesRef });
  const server = createApp(engine);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, engine, port: server.address().port };
}

async function jsonRequest(port, { method = "GET", path, body, actor }) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(actor ? { "x-actor-id": actor } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

const APPROVER = {
  curator_dept: ACTORS.curator,
  registrar: ACTORS.registrar,
  conservator: ACTORS.conservator,
  risk_manager: ACTORS.risk,
  museum_director: ACTORS.director,
};

test("HTTP：提交、查询卡点、逐级批准、装箱全流程", async (context) => {
  const { server, port } = await startServer();
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const created = await jsonRequest(port, { method: "POST", path: "/applications", body: validApplication(), actor: ACTORS.applicant });
  assert.equal(created.status, 201);
  const applicationId = created.body.applicationId;

  const blocked = await jsonRequest(port, { path: `/applications/${applicationId}` });
  assert.equal(blocked.body.chain[0].status, "active");
  assert.equal(blocked.body.currentBlock.length, 4);

  for (const node of ["curator_dept", "registrar", "conservator", "risk_manager", "museum_director"]) {
    const res = await jsonRequest(port, { method: "POST", path: `/applications/${applicationId}/decisions`, body: { node, decision: "approve" }, actor: APPROVER[node] });
    assert.equal(res.status, 200, `${node} 应可批准：${JSON.stringify(res.body)}`);
  }
  const locked = await jsonRequest(port, { path: `/applications/${applicationId}` });
  assert.equal(locked.body.status, "locked");

  const pack = await jsonRequest(port, { method: "POST", path: `/applications/${applicationId}/pack`, body: { manifest: manifestFor(validApplication()) }, actor: "packer" });
  assert.equal(pack.status, 200);
  const finalView = await jsonRequest(port, { path: `/applications/${applicationId}` });
  assert.equal(finalView.body.packingConsistency.matchesApprovedVersion, true);
});

test("HTTP：运输险缺失时风控节点阻断，批准返回 409 与阻塞条件", async (context) => {
  const { server, engine, port } = await startServer();
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const exhibitionOnly = validApplication({
    insurance: { policies: [{ policyNo: "P-EXH", insurer: "x", documentId: "c1", amount: 1000000, phases: ["exhibition"], startAt: "2026-06-10T09:00:00+08:00", endAt: "2026-07-11T18:00:00+08:00" }] },
  });
  const created = await jsonRequest(port, { method: "POST", path: "/applications", body: exhibitionOnly, actor: ACTORS.applicant });
  const applicationId = created.body.applicationId;
  approveChain(engine, applicationId, { through: "conservator" });

  const bad = await jsonRequest(port, { method: "POST", path: `/applications/${applicationId}/decisions`, body: { node: "risk_manager", decision: "approve" }, actor: ACTORS.risk });
  assert.equal(bad.status, 409);
  assert.equal(bad.body.error, "blocked_precondition");
  assert.ok(bad.body.detail.blockers.some((item) => item.code === "insurance_covers_transport"));
});

test("HTTP：缺少身份头返回 401", async (context) => {
  const { server, port } = await startServer();
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const res = await jsonRequest(port, { method: "POST", path: "/applications", body: validApplication() });
  assert.equal(res.status, 401);
});

test("HTTP：已装箱申请撤回返回 409 packed_cannot_withdraw", async (context) => {
  const { server, engine, port } = await startServer();
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const created = await jsonRequest(port, { method: "POST", path: "/applications", body: validApplication(), actor: ACTORS.applicant });
  const applicationId = created.body.applicationId;
  approveChain(engine, applicationId);
  await jsonRequest(port, { method: "POST", path: `/applications/${applicationId}/pack`, body: { manifest: manifestFor(validApplication()) }, actor: "packer" });
  const res = await jsonRequest(port, { method: "POST", path: `/applications/${applicationId}/withdraw`, body: {}, actor: ACTORS.applicant });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "packed_cannot_withdraw");
});

test("HTTP：健康检查仍返回 200", async (context) => {
  const { server, port } = await startServer();
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const res = await jsonRequest(port, { path: "/health" });
  assert.equal(res.status, 200);
  assert.equal(res.body.service, "loan-approval-service");
});
