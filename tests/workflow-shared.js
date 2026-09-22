import { ACTORS } from "./helpers.js";

const { curator, registrar, conservator, risk, deputy, director } = ACTORS;

/** 依次按链条批准（含 through 指定节点；不给 through 则批完整条链）。 */
export function approveChain(engine, applicationId, { through = null, actorByNode = {} } = {}) {
  const chain = ["curator_dept", "registrar", "conservator", "risk_manager", "deputy_director", "museum_director"];
  const defaults = { curator_dept: curator, registrar, conservator, risk_manager: risk, deputy_director: deputy, museum_director: director };
  for (const node of chain) {
    // 已存在有效决定的节点直接跳过（测试可能预先用指定审批人批过）。
    const nodeState = engine.getApplication(applicationId).nodes[node];
    if (nodeState?.validDecision) continue;
    let result;
    try {
      result = engine.decide({ applicationId, node, actor: actorByNode[node] ?? defaults[node], action: "approve" });
    } catch (error) {
      if (error.code === "node_not_in_chain") continue;
      throw error;
    }
    if (result.status.status === "locked") return result;
    if (through && node === through) return result;
  }
}
