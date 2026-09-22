import rolesRef from "../reference/approval-roles.json" with { type: "json" };
import { addWorkingHours } from "./calendar.js";
import {
  assessRisk,
  buildChain,
  buildSnapshot,
  canonicalHash,
  diffDocuments,
  diffSections,
  evaluateNode,
  sectionHashes,
  watchedSections,
} from "./rules.js";
import { newId } from "./util.js";

const FINAL_STATUSES = new Set(["withdrawn"]);

export class ApprovalEngine {
  constructor({ store, calendar, clock = () => new Date(), roles = rolesRef, timeoutHours, escalationHours, maxCasRetries = 5 }) {
    this.store = store;
    this.calendar = calendar;
    this.clock = clock;
    this.roles = roles;
    this.timeoutHours = timeoutHours ?? Object.fromEntries(
      Object.entries(roles.timeouts).filter(([key]) => key.endsWith("_hours")).map(([key, value]) => [key.replace(/_hours$/, ""), value]),
    );
    this.escalationHours = escalationHours ?? roles.timeouts.escalationHours ?? 8;
    this.maxCasRetries = maxCasRetries;
  }

  now() {
    return this.clock();
  }

  // ---- 读 ----
  getApplication(id) {
    const { state } = this.store.load();
    const app = state.applications[id];
    if (!app) throw notFound("application_not_found");
    return app;
  }

  listApplications() {
    return Object.values(this.store.load().state.applications);
  }

  // ---- 带版本号重试的变更入口 ----
  #commit(mutator) {
    let loaded = this.store.load();
    for (let attempt = 0; ; attempt += 1) {
      try {
        return this.store.mutate(loaded.version, (state) => mutator(state)).result;
      } catch (error) {
        if (error.code !== "CAS_CONFLICT" || attempt >= this.maxCasRetries) throw error;
        loaded = this.store.load();
      }
    }
  }

  // ---- 提交 / 修订 ----
  submitApplication({ applicationId = null, input, actor }) {
    return this.#commit((state) => {
      const at = this.now().toISOString();
      const isFirst = !applicationId;
      let app = isFirst ? null : state.applications[applicationId];
      if (!isFirst && !app) throw notFound("application_not_found");
      if (app && FINAL_STATUSES.has(app.status)) throw conflict("application_terminal", `申请已${app.status === "withdrawn" ? "撤回" : "终结"}，不能再提交版本`);
      if (app?.status === "packed") throw conflict("packed_cannot_revise", "申请已装箱，不能直接修订，须先解除装箱");

      const snapshot = buildSnapshot(input);
      const hash = canonicalHash(snapshot);
      const hashes = sectionHashes(snapshot);

      if (isFirst) {
        applicationId = newId("app");
        app = {
          id: applicationId,
          applicantId: actor,
          createdAt: at,
          status: "in_review",
          versions: [],
          currentSeq: 0,
          approvedSeq: null,
          lock: null,
          packing: null,
          nodes: {},
          decisions: [],
          events: [],
        };
        state.applications[applicationId] = app;
      }

      const previous = app.versions.at(-1) ?? null;
      if (previous && previous.hash === hash) {
        throw conflict("version_unchanged", "提交内容与当前版本完全一致，未产生新版本");
      }

      const changedSections = diffSections(previous?.sectionHashes ?? null, hashes);
      const lineage = diffDocuments(previous?.snapshot ?? null, snapshot);
      const seq = app.versions.length + 1;
      app.versions.push({
        seq,
        submittedAt: at,
        submittedBy: actor,
        snapshot,
        hash,
        sectionHashes: hashes,
        parentSeq: previous?.seq ?? null,
        changedSections,
        documentLineage: lineage,
      });
      app.currentSeq = seq;

      // 批准锁定之后的修订：解除锁定，按关键条件变化回退到相应节点。
      if (app.lock) {
        app.events.push({ at, type: "lock_invalidated", detail: { lockedSeq: app.lock.seq, reason: "关键条件变化，提交新版本", changedSections } });
        app.lock = null;
        app.approvedSeq = null;
      }
      if (app.status === "approved" || app.status === "locked" || app.status === "rejected") app.status = "in_review";

      app.events.push({ at, type: "version_submitted", actor, detail: { seq, changedSections, documentLineage: lineage } });

      const risk = assessRisk(snapshot);
      const chain = buildChain(snapshot, risk, { roles: this.roles, matrix: undefined });
      app.risk = risk;
      app.chain = chain;

      // 关键条件变化 → 关注这些段落的节点重新进入（旧决定标记失效但保留台账）。
      // 被驳回的节点在任意修订后重新开放，避免申请卡死；未受影响的上游签名继续有效。
      for (const node of chain) {
        const nodeState = app.nodes[node];
        const watched = watchedSections(node);
        const affected = changedSections.some((section) => watched.includes(section));
        if (!nodeState) {
          app.nodes[node] = freshNode(node, seq);
        } else if (nodeState.status === "rejected" || affected || !chain.includes(node)) {
          if (nodeState.validDecision) {
            app.events.push({
              at,
              type: "node_reset",
              detail: { node, invalidatedDecision: nodeState.validDecision, changedSections: changedSections.filter((section) => watched.includes(section)) },
            });
          }
          app.nodes[node] = freshNode(node, seq);
        }
      }
      for (const node of Object.keys(app.nodes)) {
        if (!chain.includes(node)) delete app.nodes[node];
      }

      recomputeFlow(app, this.calendar, at, { timeoutHours: this.timeoutHours, escalationHours: this.escalationHours });
      return { applicationId, seq, changedSections, documentLineage: lineage, status: viewOf(app, this.calendar, at) };
    });
  }

  // ---- 审批决定 ----
  decide({ applicationId, node, actor, action, note = null, onBehalfOfEscalation = false }) {
    if (!["approve", "reject"].includes(action)) throw badRequest("invalid_action");
    return this.#commit((state) => {
      const at = this.now().toISOString();
      const app = state.applications[applicationId];
      if (!app) throw notFound("application_not_found");
      if (FINAL_STATUSES.has(app.status)) throw conflict("application_terminal", "申请已终结");

      const nodeState = app.nodes[node];
      if (!nodeState || !app.chain.includes(node)) throw notFound("node_not_in_chain");

      // 并发决定互斥：只有第一个决定能成为有效决定，后来者得到 decision_conflict。
      if (app.status === "rejected") throw conflict("application_rejected", "申请已被驳回，请提交修订版本后重新进入流程");
      if (nodeState.validDecision) {
        throw conflict("decision_conflict", "该节点已存在有效决定", {
          validDecision: app.decisions.find((decision) => decision.id === nodeState.validDecision),
        });
      }

      if (!this.#actorCanDecide(app, node, actor, onBehalfOfEscalation)) {
        throw forbidden("actor_not_authorized", `审批人 ${actor} 无权在节点 ${node} 作出决定`);
      }

      const snapshot = app.versions.at(-1).snapshot;
      const predecessorInfo = missingPredecessors(app, node);
      const evaluation = evaluateNode(node, snapshot, { risk: app.risk, missingPredecessors: predecessorInfo });

      // 关键条件不满足（含前置签名缺失）时，任何人都不能批准——超时升级同样在此被挡住。
      if (action === "approve" && !evaluation.ok) {
        throw conflict("blocked_precondition", "节点准入条件未满足，不能批准（升级不能越过缺失的前置签名）", { blockers: evaluation.blockers });
      }

      const decision = {
        id: newId("dec"),
        at,
        actor,
        node,
        action,
        versionSeq: app.currentSeq,
        onBehalfOfEscalation: onBehalfOfEscalation || null,
        note,
      };
      app.decisions.push(decision);
      nodeState.decisions.push(decision.id);
      nodeState.validDecision = decision.id;
      nodeState.status = action === "approve" ? "approved" : "rejected";
      nodeState.basisSeq = app.currentSeq;
      nodeState.lastBlockers = [];
      app.events.push({ at, type: `decision_${action}`, actor, detail: { node, decisionId: decision.id, versionSeq: app.currentSeq } });

      if (action === "reject") {
        app.status = "rejected";
        return { decision, status: viewOf(app, this.calendar, at) };
      }

      recomputeFlow(app, this.calendar, at, { timeoutHours: this.timeoutHours, escalationHours: this.escalationHours });
      maybeLock(app, at);
      return { decision, status: viewOf(app, this.calendar, at) };
    });
  }

  #actorCanDecide(app, node, actor, onBehalfOfEscalation) {
    const members = this.roles.roleMembers?.[node] ?? [];
    if (members.includes(actor)) return true;
    // 超时升级：升级目标角色可代为处理，但仍受准入条件（含前置签名）约束。
    if (onBehalfOfEscalation) {
      const target = this.roles.escalation?.[node];
      return Boolean(target) && (this.roles.roleMembers?.[target] ?? []).includes(actor);
    }
    return false;
  }

  // ---- 超时升级扫描（重启后立即执行；截止时间是持久化的绝对时刻）----
  sweepEscalations() {
    return this.#commit((state) => {
      const at = this.now().toISOString();
      const escalated = [];
      for (const app of Object.values(state.applications)) {
        if (app.status !== "in_review") continue;
        recomputeFlow(app, this.calendar, at, { timeoutHours: this.timeoutHours, escalationHours: this.escalationHours });
        for (const node of app.chain) {
          const nodeState = app.nodes[node];
          if (nodeState.status !== "active" || nodeState.escalatedAt || !nodeState.escalationDeadline) continue;
          if (new Date(at).getTime() >= new Date(nodeState.escalationDeadline).getTime()) {
            nodeState.escalatedAt = at;
            const target = this.roles.escalation?.[node];
            app.events.push({
              at,
              type: "escalated",
              detail: { node, target: target ?? null, reason: "审批超时，升级催办；缺失前置签名时不得代批" },
            });
            escalated.push({ applicationId: app.id, node, target });
          }
        }
      }
      return { escalated, at };
    });
  }

  // ---- 装箱 / 解除装箱 / 撤回 ----
  pack({ applicationId, actor, manifest }) {
    return this.#commit((state) => {
      const at = this.now().toISOString();
      const app = state.applications[applicationId];
      if (!app) throw notFound("application_not_found");
      if (app.status !== "locked") throw conflict("not_locked", "只有批准并锁定的申请可以装箱");

      const version = app.versions[app.lock.seq - 1];
      const expected = version.snapshot.checklist.items;
      const cleanManifest = (manifest?.items ?? []).map((item) => ({
        artifactId: String(item.artifactId),
        quantity: Number(item.quantity),
      }));
      const mismatches = compareManifest(expected, cleanManifest);
      if (mismatches.length > 0) {
        throw conflict("manifest_mismatch", "装箱清单与批准版本不一致，禁止装箱", { mismatches, approvedVersionHash: version.hash });
      }

      app.status = "packed";
      app.packing = {
        packedAt: at,
        packedBy: actor,
        manifestId: newId("man"),
        approvedVersionSeq: version.seq,
        approvedVersionHash: version.hash,
        items: cleanManifest,
      };
      app.events.push({ at, type: "packed", actor, detail: { manifestId: app.packing.manifestId, approvedVersionSeq: version.seq } });
      return { packing: app.packing, status: viewOf(app, this.calendar, at) };
    });
  }

  unpack({ applicationId, actor, reason }) {
    return this.#commit((state) => {
      const at = this.now().toISOString();
      const app = state.applications[applicationId];
      if (!app) throw notFound("application_not_found");
      if (app.status !== "packed") throw conflict("not_packed", "申请未处于装箱状态");
      app.events.push({ at, type: "unpacked", actor, detail: { reason: reason ?? null, previousManifest: app.packing?.manifestId } });
      app.packing = null;
      app.status = "locked";
      return { status: viewOf(app, this.calendar, at) };
    });
  }

  withdraw({ applicationId, actor, reason }) {
    return this.#commit((state) => {
      const at = this.now().toISOString();
      const app = state.applications[applicationId];
      if (!app) throw notFound("application_not_found");
      if (app.status === "packed") {
        // 硬性业务规则：已装箱的申请不能直接撤回。
        throw conflict("packed_cannot_withdraw", "申请已装箱，不能直接撤回；须先解除装箱并完成核验", { manifestId: app.packing?.manifestId });
      }
      if (FINAL_STATUSES.has(app.status)) throw conflict("application_terminal", "申请已终结");
      app.status = "withdrawn";
      app.withdrawnAt = at;
      app.withdrawnBy = actor;
      app.events.push({ at, type: "withdrawn", actor, detail: { reason: reason ?? null } });
      return { status: viewOf(app, this.calendar, at) };
    });
  }

  // ---- 查询解释 ----
  explain(applicationId) {
    const at = this.now().toISOString();
    const found = this.getApplication(applicationId);
    return buildExplanation(found, this.calendar, this.roles, at);
  }
}

function freshNode(node, sinceSeq) {
  return {
    node,
    status: "blocked",
    sinceSeq,
    firstActiveAt: null,
    deadline: null,
    escalationDeadline: null,
    escalatedAt: null,
    decisions: [],
    validDecision: null,
    basisSeq: null,
    lastBlockers: [],
  };
}

function missingPredecessors(app, node) {
  const index = app.chain.indexOf(node);
  const missing = [];
  for (const predecessor of app.chain.slice(0, index)) {
    const nodeState = app.nodes[predecessor];
    if (!nodeState || nodeState.status !== "approved") {
      missing.push({ node: predecessor, name: roleName(predecessor) });
    }
  }
  return missing;
}

function roleName(node) {
  return rolesRef.roles.find((role) => role.id === node)?.name ?? node;
}

/**
 * 按链条顺序重算每个节点状态：
 * blocked（条件/前置不满足）→ active（可审批并计时）→ approved/rejected。
 * 截止时间只在节点首次进入 active 时设定，持久化绝对时刻，重启不重算偏移。
 */
function recomputeFlow(app, calendar, at, { timeoutHours, escalationHours }) {
  const snapshot = app.versions.at(-1).snapshot;
  for (const node of app.chain) {
    const nodeState = app.nodes[node];
    if (nodeState.status === "approved" || nodeState.status === "rejected") continue;

    const predecessorInfo = missingPredecessors(app, node);
    const evaluation = evaluateNode(node, snapshot, { risk: app.risk, missingPredecessors: predecessorInfo });
    nodeState.lastBlockers = evaluation.blockers;

    if (!evaluation.ok) {
      if (nodeState.status === "active") {
        // 从 active 被打回 blocked：计时暂停并清除（前置签名补齐、条件修正后重新计时）。
        app.events.push({ at, type: "node_blocked", detail: { node, blockers: evaluation.blockers.map((blocker) => blocker.code) } });
      }
      nodeState.status = "blocked";
      nodeState.firstActiveAt = null;
      nodeState.deadline = null;
      nodeState.escalationDeadline = null;
      nodeState.escalatedAt = null;
      continue;
    }

    if (nodeState.status !== "active") {
      nodeState.status = "active";
      nodeState.firstActiveAt = at;
      const hours = timeoutHours[node];
      if (Number.isFinite(hours)) {
        nodeState.deadline = addWorkingHours(calendar, new Date(at), hours).toISOString();
        nodeState.escalationDeadline = addWorkingHours(calendar, new Date(at), hours + escalationHours).toISOString();
      }
      app.events.push({ at, type: "node_activated", detail: { node, deadline: nodeState.deadline } });
    }
  }
}

function maybeLock(app, at) {
  if (app.status !== "in_review") return;
  const allApproved = app.chain.every((node) => app.nodes[node]?.status === "approved");
  if (!allApproved) return;
  const version = app.versions.at(-1);
  app.status = "locked";
  app.approvedSeq = version.seq;
  app.lock = { seq: version.seq, hash: version.hash, lockedAt: at };
  app.events.push({ at, type: "locked", detail: { seq: version.seq, hash: version.hash } });
}

function compareManifest(expectedItems, manifestItems) {
  const mismatches = [];
  const expectedMap = new Map(expectedItems.map((item) => [item.artifactId, item.quantity]));
  const actualMap = new Map(manifestItems.map((item) => [item.artifactId, item.quantity]));
  for (const [artifactId, quantity] of expectedMap) {
    if (!actualMap.has(artifactId)) mismatches.push({ code: "missing_artifact", artifactId, expectedQuantity: quantity });
    else if (actualMap.get(artifactId) !== quantity) {
      mismatches.push({ code: "quantity_mismatch", artifactId, expectedQuantity: quantity, actualQuantity: actualMap.get(artifactId) });
    }
  }
  for (const artifactId of actualMap.keys()) {
    if (!expectedMap.has(artifactId)) mismatches.push({ code: "unexpected_artifact", artifactId });
  }
  return mismatches;
}

function buildExplanation(app, calendar, roles, at) {
  const version = app.versions.at(-1);
  const nodes = app.chain.map((node) => {
    const nodeState = app.nodes[node];
    const role = roles.roles.find((item) => item.id === node);
    const decision = nodeState?.validDecision
      ? app.decisions.find((item) => item.id === nodeState.validDecision)
      : null;
    let signatureCurrent = null;
    if (decision) {
      // 签名仍有效 = 决定作出之后，该节点关注的段落均未变化。
      const basis = app.versions[decision.versionSeq - 1];
      signatureCurrent = watchedSections(node).every((section) => basis.sectionHashes[section] === version.sectionHashes[section]);
    }
    return {
      node,
      name: role?.name ?? node,
      duty: role?.duty ?? null,
      status: nodeState?.status ?? "absent",
      blockers: nodeState?.lastBlockers ?? [],
      decidedBy: decision?.actor ?? null,
      decidedAt: decision?.at ?? null,
      decisionAction: decision?.action ?? null,
      basisVersionSeq: nodeState?.basisSeq ?? null,
      currentVersionSeq: app.currentSeq,
      signatureCurrent,
      // 该节点历史上基于旧版本作出、现已失效的签名（旧版本审批留痕，永不从台账删除）。
      supersededDecisions: app.decisions
        .filter((item) => item.node === node && (!nodeState?.validDecision || item.id !== nodeState.validDecision))
        .map((item) => ({ decisionId: item.id, actor: item.actor, action: item.action, at: item.at, versionSeq: item.versionSeq })),
      firstActiveAt: nodeState?.firstActiveAt ?? null,
      deadline: nodeState?.deadline ?? null,
      overdue: nodeState?.deadline ? new Date(at).getTime() > new Date(nodeState.deadline).getTime() && nodeState.status === "active" : false,
      escalationDeadline: nodeState?.escalationDeadline ?? null,
      escalatedAt: nodeState?.escalatedAt ?? null,
    };
  });

  const lockedVersion = app.lock ? app.versions[app.lock.seq - 1] : null;
  let packingConsistency = null;
  if (app.packing) {
    const mismatches = compareManifest(lockedVersion?.snapshot.checklist.items ?? [], app.packing.items);
    packingConsistency = {
      packed: true,
      matchesApprovedVersion: mismatches.length === 0,
      approvedVersionSeq: app.packing.approvedVersionSeq,
      approvedVersionHash: app.packing.approvedVersionHash,
      currentVersionSeq: app.currentSeq,
      packedAgainstCurrentVersion: app.packing.approvedVersionSeq === app.currentSeq,
      mismatches,
    };
  } else if (app.lock) {
    packingConsistency = { packed: false, matchesApprovedVersion: null, approvedVersionSeq: app.lock.seq, approvedVersionHash: app.lock.hash };
  }

  return {
    applicationId: app.id,
    status: app.status,
    currentVersionSeq: app.currentSeq,
    currentVersionHash: version?.hash ?? null,
    risk: app.risk ?? null,
    chain: nodes,
    currentBlock: nodes
      .filter((node) => node.status === "blocked")
      .map((node) => ({ node: node.node, name: node.name, blockers: node.blockers })),
    activeNodes: nodes.filter((node) => node.status === "active").map((node) => ({
      node: node.node,
      name: node.name,
      deadline: node.deadline,
      overdue: node.overdue,
      escalationDeadline: node.escalationDeadline,
      escalatedAt: node.escalatedAt,
    })),
    decisions: app.decisions.map((decision) => ({
      id: decision.id,
      node: decision.node,
      nodeName: roles.roles.find((role) => role.id === decision.node)?.name ?? decision.node,
      actor: decision.actor,
      action: decision.action,
      at: decision.at,
      versionSeq: decision.versionSeq,
      onBehalfOfEscalation: decision.onBehalfOfEscalation ?? false,
      note: decision.note,
    })),
    approvedVersion: app.lock ? { seq: app.lock.seq, hash: app.lock.hash, lockedAt: app.lock.lockedAt } : null,
    packing: app.packing
      ? { packedAt: app.packing.packedAt, packedBy: app.packing.packedBy, manifestId: app.packing.manifestId, items: app.packing.items }
      : null,
    packingConsistency,
    events: app.events,
    explainedAt: at,
  };
}

function viewOf(app, calendar, at) {
  return {
    id: app.id,
    status: app.status,
    currentSeq: app.currentSeq,
    approvedSeq: app.approvedSeq,
    risk: app.risk?.level ?? null,
    chain: app.chain?.map((node) => ({ node, status: app.nodes[node]?.status })) ?? [],
    lock: app.lock ?? null,
    packing: app.packing ? { manifestId: app.packing.manifestId, packedAt: app.packing.packedAt } : null,
  };
}

// 供 HTTP 层复用
export { buildExplanation };

function notFound(code, message, detail) {
  return Object.assign(new Error(message ?? code), { statusCode: 404, code, detail });
}
function conflict(code, message, detail) {
  return Object.assign(new Error(message ?? code), { statusCode: 409, code, detail });
}
function badRequest(code, message, detail) {
  return Object.assign(new Error(message ?? code), { statusCode: 400, code, detail });
}
function forbidden(code, message, detail) {
  return Object.assign(new Error(message ?? code), { statusCode: 403, code, detail });
}
