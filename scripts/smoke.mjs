/**
 * 端到端冒烟演示（不依赖测试框架）：
 *   node scripts/smoke.mjs
 * 覆盖：只保展柜被风控阻断 → 替换凭证留血缘 → 关键条件变化重入 → 全链批准锁定 →
 *       装箱一致校验 → 重启后截止时间继续计算。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonStore } from "../src/store.js";
import { loadCalendar } from "../src/calendar.js";
import { ApprovalEngine } from "../src/engine.js";
import calendarRef from "../reference/workday-calendar-2026.json" with { type: "json" };
import rolesRef from "../reference/approval-roles.json" with { type: "json" };
import scenario from "../tests/fixtures/scenario-exhibition-only.json" with { type: "json" };

const dir = mkdtempSync(join(tmpdir(), "loan-smoke-"));
const store = new JsonStore(join(dir, "state.json"));
const calendar = loadCalendar(calendarRef);
let now = new Date("2026-06-08T09:00:00+08:00");
const makeEngine = () => new ApprovalEngine({ store, calendar, clock: () => now, roles: rolesRef, timeoutHours: { curator_dept: 0.01 }, escalationHours: 0.01 });
const engine = makeEngine();

const { applicationId } = engine.submitApplication({ input: scenario, actor: "u_applicant_01" });
for (const [node, actor] of [["curator_dept", "u_cuigan"], ["registrar", "u_registrar_li"], ["conservator", "u_conservator_chen"]]) {
  engine.decide({ applicationId, node, actor, action: "approve" });
}
let view = engine.explain(applicationId);
console.log("① 风控节点卡点：");
for (const blocker of view.chain.find((n) => n.node === "risk_manager").blockers) console.log("   -", blocker.code, blocker.message);

// 临近出展才补运输险凭证（凭证替换/新增留版本血缘）
const fixed = structuredClone(scenario);
fixed.insurance.policies.push({
  policyNo: "P-TRP-009", insurer: "中国人保", documentId: "cert-transport-final", amount: 1000000,
  currency: "CNY", phases: ["transport"], startAt: "2026-06-09T00:00:00+08:00", endAt: "2026-07-13T23:59:00+08:00",
});
const v2 = engine.submitApplication({ applicationId, input: fixed, actor: "u_applicant_01" });
console.log("② 新版本血缘：seq", v2.seq, "变化段落", v2.changedSections);
console.log("   凭证血缘", JSON.stringify(v2.documentLineage));

engine.decide({ applicationId, node: "risk_manager", actor: "u_risk_zhao", action: "approve" });
engine.decide({ applicationId, node: "museum_director", actor: "u_director", action: "approve" });
view = engine.explain(applicationId);
console.log("③ 全链批准后状态：", view.status, "锁定版本 seq =", view.approvedVersion.seq);

engine.pack({ applicationId, actor: "packer", manifest: { items: scenario.items.map((i) => ({ artifactId: i.artifactId, quantity: i.quantity })) } });
view = engine.explain(applicationId);
console.log("④ 装箱一致性：", view.packingConsistency.matchesApprovedVersion, "| 状态：", view.status);

// 模拟重启：新引擎实例、同一状态文件；时间向后推进，超时升级仍按持久化截止时间计算
now = new Date("2026-06-08T09:00:00+08:00");
const anotherApp = makeEngine();
const id2 = anotherApp.submitApplication({ input: fixed, actor: "u_applicant_01" }).applicationId;
const deadlineBefore = anotherApp.explain(id2).chain[0].deadline;
now = new Date("2026-06-09T00:00:00+08:00");
const restarted = makeEngine();
const sweep = restarted.sweepEscalations();
const deadlineAfter = restarted.explain(id2).chain[0].deadline;
console.log("⑤ 重启后升级扫描：", sweep.escalated.length, "项；截止时间不变 =", deadlineBefore === deadlineAfter);

rmSync(dir, { recursive: true, force: true });
