import {
  requiredNodes,
  unmetConditions,
  groupFingerprints,
  payloadFingerprint,
  changedGroups,
  dependentClosure,
  NODE_GROUPS,
  NODE_NAMES,
  highestGrade,
  validateShape,
} from "./risk.js";

export class ServiceError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const APPLICANT_ROLES = new Set(["申请方", "管理员"]);

export class LoanService {
  constructor({ store, reference, calendar, now = () => new Date() }) {
    this.store = store;
    this.matrix = reference.matrix;
    this.rolesConfig = reference.roles;
    this.calendar = calendar;
    this.now = now;
    this.roleNames = new Map(reference.roles.roles.map((r) => [r.key, r.name]));
    this.escalationChain = new Map(reference.roles.roles.map((r) => [r.key, r.escalatesTo]));
  }

  #iso(date) {
    return date.toISOString();
  }

  #getApplication(id) {
    const app = this.store.read().applications[id];
    if (!app) throw new ServiceError(404, "not_found", `借展申请 ${id} 不存在`);
    return app;
  }

  #requireActor(actor) {
    if (!actor?.id || !actor?.role) {
      throw new ServiceError(401, "unauthorized", "缺少经办人身份（x-user-id / x-user-role）");
    }
    return actor;
  }

  #appendEvent(app, type, payload) {
    app.events.push({ at: this.#iso(this.now()), type, ...payload });
  }

  #freshNode(attempt = 1) {
    return {
      status: "pending",
      attempt,
      deadline: null,
      deadlineAttempt: null,
      decidedBy: null,
      decidedAt: null,
      decisionVersion: null,
      decisionComment: null,
      escalations: [],
    };
  }

  // 每次变更后重算：节点集合、失效签名、可受理状态、工作时截止时间（绝对时刻，仅在首次进入批次时设定）
  #reconcile(app) {
    const current = app.versions[app.versions.length - 1];
    const data = current.data;
    const needed = requiredNodes(this.matrix, data);

    for (const [node, record] of Object.entries(app.nodes)) {
      if (!needed.includes(node)) record.status = "obsolete";
    }
    for (const node of needed) {
      let record = app.nodes[node];
      if (!record || record.status === "obsolete") {
        app.nodes[node] = this.#freshNode();
        continue;
      }
      // 签名停留在旧版本且本版本已不适用：新批次重新进入
      if (record.status === "approved" && record.decisionVersion !== app.currentVersion
        && !this.#signatureStillValid(app, node)) {
        this.#invalidateNode(app, node, "关键条件在新版本中发生变化");
      }
    }

    for (const node of needed) {
      const record = app.nodes[node];
      if (record.status !== "pending") {
        // 已决节点不再计时；重新进入（attempt 增加）时才会获得新的截止时间
        record.deadline = null;
        record.deadlineAttempt = null;
        continue;
      }
      const actionable = this.#isActionable(app, node);
      if (actionable && record.deadlineAttempt !== record.attempt) {
        const sla = this.matrix.slaWorkingHours[node] ?? 24;
        record.deadline = this.#iso(this.calendar.addWorkingHours(this.now(), sla));
        record.deadlineAttempt = record.attempt;
      }
      if (!actionable) {
        // 等待前置期间不计时：重新可受理时再给完整 SLA
        record.deadline = null;
        record.deadlineAttempt = null;
      }
    }

    const allApproved = needed.every((n) => app.nodes[n].status === "approved");
    if (allApproved && app.approvedVersion !== app.currentVersion) {
      app.approvedVersion = app.currentVersion;
      app.lockedAt = this.#iso(this.now());
      this.#appendEvent(app, "version_locked", {
        version: app.currentVersion,
        note: "全部节点签署完成，该版本锁定为可执行版本",
      });
    }

    return current;
  }

  #signatureStillValid(app, node) {
    // 该节点最近一次决定后，它所负责的关键条件分组未再变化
    const record = app.nodes[node];
    if (record.status !== "approved") return false;
    const decidedVersion = record.decisionVersion;
    const current = app.versions[app.versions.length - 1];
    const groups = NODE_GROUPS[node];
    return groups.every((g) => decidedVersion == null
      || current.fingerprints[g] === app.versions[decidedVersion - 1].fingerprints[g]);
  }

  #invalidateNode(app, node, reason) {
    const record = app.nodes[node];
    const oldAttempt = record.attempt;
    for (const decision of app.decisions) {
      if (decision.node === node && decision.attempt === oldAttempt && !decision.superseded) {
        decision.superseded = true;
        decision.supersedeReason = reason;
        decision.supersededAt = this.#iso(this.now());
      }
    }
    record.attempt = oldAttempt + 1;
    record.status = "pending";
    record.deadline = null;
    record.deadlineAttempt = null;
    record.decidedBy = null;
    record.decidedAt = null;
    record.decisionVersion = null;
    record.decisionComment = null;
    record.escalations = [];
    this.#appendEvent(app, "signature_revoked", { node, nodeName: NODE_NAMES[node], reason, newAttempt: record.attempt });
  }

  #isActionable(app, node) {
    const data = app.versions[app.versions.length - 1].data;
    if (unmetConditions(this.matrix, node, data).length > 0) return false;
    const prereqs = this.matrix.prerequisites[node] ?? [];
    return prereqs.every((p) => app.nodes[p]?.status === "approved");
  }

  create(actor, data) {
    this.#requireActor(actor);
    if (!APPLICANT_ROLES.has(actor.role)) throw new ServiceError(403, "forbidden", "仅申请方可以提交借展申请");
    const shapeErrors = validateShape(data);
    if (shapeErrors.length > 0) throw new ServiceError(400, "invalid_shape", "申请材料结构不合法", { shapeErrors });

    return this.store.mutate((root) => {
      root.seq += 1;
      const id = `LA-${String(root.seq).padStart(6, "0")}`;
      const at = this.#iso(this.now());
      const fingerprints = groupFingerprints(data);
      const app = {
        id,
        createdAt: at,
        createdBy: actor,
        currentVersion: 1,
        approvedVersion: null,
        lockedAt: null,
        withdrawnAt: null,
        returnedAt: null,
        versions: [{
          version: 1,
          at,
          submittedBy: actor,
          data,
          fingerprints,
          payloadHash: payloadFingerprint(data),
          change: { changedGroups: [], replacedCertificate: null },
        }],
        nodes: {},
        decisions: [],
        certificateLineage: [{
          certNo: data.insuranceCertificate?.certNo ?? null,
          version: 1,
          supersedesCertNo: null,
          at,
          by: actor,
        }],
        packing: { status: "none", lines: [] },
        events: [],
      };
      root.applications[id] = app;
      this.#appendEvent(app, "application_created", { by: actor, version: 1 });
      this.#reconcile(app);
      return this.getView(id);
    });
  }

  #ensureMutable(app) {
    if (app.withdrawnAt) throw new ServiceError(409, "withdrawn", "申请已撤回，不能再变更");
    if (app.returnedAt) throw new ServiceError(409, "returned", "申请已办理退回，不能再变更");
    if (app.packing.status !== "none") {
      throw new ServiceError(409, "packing_started", "已开始装箱，不能直接修改申请，须按合同办理撤展或退回");
    }
  }

  submitVersion(actor, id, data) {
    this.#requireActor(actor);
    if (!APPLICANT_ROLES.has(actor.role)) throw new ServiceError(403, "forbidden", "仅申请方可以更新借展申请");
    const shapeErrors = validateShape(data);
    if (shapeErrors.length > 0) throw new ServiceError(400, "invalid_shape", "申请材料结构不合法", { shapeErrors });

    return this.store.mutate(() => {
      const app = this.#getApplication(id);
      return this.#submitVersionLocked(app, actor, data);
    });
  }

  // 调用方必须已持有 store 变更队列（同一读-改-写事务）
  #submitVersionLocked(app, actor, data) {
    this.#ensureMutable(app);
    const previous = app.versions[app.versions.length - 1];
    const fingerprints = groupFingerprints(data);
    const groups = changedGroups(previous.fingerprints, fingerprints);
    if (payloadFingerprint(data) === previous.payloadHash) {
      throw new ServiceError(409, "no_changes", "与当前版本相比没有任何材料变化，不产生新版本", {
        currentVersion: app.currentVersion,
      });
    }
    const version = app.currentVersion + 1;
    const at = this.#iso(this.now());

    let replacedCertificate = null;
    if (fingerprints.insurance !== previous.fingerprints.insurance) {
      const oldCertNo = previous.data.insuranceCertificate?.certNo ?? null;
      const newCertNo = data.insuranceCertificate?.certNo ?? null;
      replacedCertificate = { certNo: newCertNo, supersedesCertNo: oldCertNo };
      app.certificateLineage.push({
        certNo: newCertNo,
        version,
        supersedesCertNo: oldCertNo,
        at,
        by: actor,
      });
      this.#appendEvent(app, "certificate_replaced", {
        version, oldCertNo, newCertNo, by: actor,
      });
    }

    app.versions.push({
      version,
      at,
      submittedBy: actor,
      data,
      fingerprints,
      payloadHash: payloadFingerprint(data),
      change: { changedGroups: groups, replacedCertificate },
    });
    app.currentVersion = version;
    this.#appendEvent(app, "version_submitted", { version, by: actor, changedGroups: groups });

    // 关键条件分组变化 → 对应节点及传递依赖它的节点全部重新签署
    const owners = new Set();
    for (const group of groups) {
      for (const [node, owned] of Object.entries(NODE_GROUPS)) {
        if (owned.includes(group)) owners.add(node);
      }
    }
    const toRevisit = dependentClosure(this.matrix, [...owners]);
    for (const node of requiredNodes(this.matrix, data)) {
      const record = app.nodes[node];
      if (!record) continue;
      if (toRevisit.has(node) && record.status === "approved") {
        this.#invalidateNode(app, node, `关键条件变化：${groups.join("、")}`);
      } else if (record.status === "rejected") {
        // 被拒后提交新版本：拒绝随旧版本失效，节点重新进入
        this.#invalidateNode(app, node, "申请方已提交新版本");
      }
    }
    // 新提交即新材料：所有待决节点重新计时（#reconcile 会按当前时刻重算截止时间）
    for (const record of Object.values(app.nodes)) {
      if (record.status === "pending") {
        record.deadline = null;
        record.deadlineAttempt = null;
      }
    }
    this.#reconcile(app);
    return this.getView(app.id);
  }

  replaceCertificate(actor, id, certificate) {
    this.#requireActor(actor);
    if (!certificate || typeof certificate !== "object" || !certificate.certNo) {
      throw new ServiceError(400, "invalid_certificate", "保险凭证须包含凭证编号 certNo");
    }
    return this.store.mutate(() => {
      const app = this.#getApplication(id);
      const current = structuredClone(app.versions[app.versions.length - 1].data);
      current.insuranceCertificate = certificate;
      const shapeErrors = validateShape(current);
      if (shapeErrors.length > 0) {
        throw new ServiceError(400, "invalid_shape", "替换凭证后的申请材料结构不合法", { shapeErrors });
      }
      return this.#submitVersionLocked(app, actor, current);
    });
  }

  decide(actor, id, node, decision, comment) {
    this.#requireActor(actor);
    if (!["approve", "reject"].includes(decision)) {
      throw new ServiceError(400, "invalid_decision", "decision 仅支持 approve / reject");
    }

    return this.store.mutate(() => {
      const app = this.#getApplication(id);
      const data = app.versions[app.versions.length - 1].data;
      const needed = requiredNodes(this.matrix, data);
      if (!needed.includes(node)) throw new ServiceError(404, "node_not_required", "当前版本不需要该审批节点");
      if (app.withdrawnAt || app.returnedAt) throw new ServiceError(409, "closed", "申请已结案，不能再审批");
      const record = app.nodes[node];
      if (!record) throw new ServiceError(404, "node_not_required", "该审批节点尚未生成");
      // 并发/重复提交：同一批次只能产生一个有效决定
      if (record.status === "approved") {
        throw new ServiceError(409, "already_decided", "该节点本批次已有有效同意决定", {
          effectiveDecision: { by: record.decidedBy, at: record.decidedAt, version: record.decisionVersion },
        });
      }
      if (record.status === "rejected") {
        throw new ServiceError(409, "already_decided", "该节点本批次已被拒绝，须由申请方提交新版本", {
          effectiveDecision: { by: record.decidedBy, at: record.decidedAt },
        });
      }

      // 超时升级只转移受理角色，不能越过缺失的前置签名
      const prereqs = this.matrix.prerequisites[node] ?? [];
      const missingPrereqs = prereqs.filter((p) => app.nodes[p]?.status !== "approved");
      if (missingPrereqs.length > 0) {
        throw new ServiceError(409, "missing_prerequisite", "前置审批尚未签署完成，不能审批或升级代办", {
          missingPrerequisites: missingPrereqs.map((p) => ({ node: p, name: NODE_NAMES[p] })),
        });
      }

      const allowedRole = this.#resolveDecisionRole(app, node, actor.role);
      if (!allowedRole) {
        throw new ServiceError(403, "forbidden", "该角色无权受理此节点（可能尚未超时升级）", {
          expectedRole: node,
        });
      }
      if (allowedRole !== node && record.escalations.length === 0) {
        record.escalations.push({ at: this.#iso(this.now()), from: node, to: allowedRole });
        this.#appendEvent(app, "node_escalated", { node, from: node, to: allowedRole, by: actor });
      }

      const conditions = unmetConditions(this.matrix, node, data);
      if (decision === "approve" && conditions.length > 0) {
        throw new ServiceError(422, "conditions_unmet", "关键条件未满足，不能批准", {
          unmetConditions: conditions,
        });
      }

      const at = this.#iso(this.now());
      app.decisionSeq = (app.decisionSeq ?? 0) + 1;
      const entry = {
        id: `${app.id}-D${String(app.decisionSeq).padStart(3, "0")}`,
        node,
        nodeName: NODE_NAMES[node],
        attempt: record.attempt,
        version: app.currentVersion,
        decision,
        by: actor,
        actedAsRole: allowedRole,
        at,
        comment: comment ?? null,
        superseded: false,
      };
      app.decisions.push(entry);
      record.status = decision === "approve" ? "approved" : "rejected";
      record.decidedBy = actor;
      record.decidedAt = at;
      record.decisionVersion = app.currentVersion;
      record.decisionComment = comment ?? null;
      this.#appendEvent(app, "node_decided", {
        node, decision, by: actor, actedAsRole: allowedRole, attempt: record.attempt, version: app.currentVersion,
      });

      if (decision === "reject") {
        this.#appendEvent(app, "application_rejected", { node, by: actor, comment: comment ?? null });
      }
      this.#reconcile(app);
      return this.getView(app.id);
    });
  }

  // 沿升级链寻找 actor 角色；升级仅在节点超时时成立
  #resolveDecisionRole(app, node, actorRole) {
    if (actorRole === node) return node;
    if (actorRole === "管理员") return node;
    const record = app.nodes[node];
    if (!record.deadline || !this.calendar.isOverdue(new Date(record.deadline), this.now())) return null;
    let cursor = this.escalationChain.get(node);
    while (cursor) {
      if (actorRole === cursor) return cursor;
      cursor = this.escalationChain.get(cursor);
    }
    return null;
  }

  escalate(actor, id) {
    this.#requireActor(actor);
    return this.store.mutate(() => {
      const app = this.#getApplication(id);
      this.#reconcile(app);
      const escalated = [];
      for (const [node, record] of Object.entries(app.nodes)) {
        if (record.status !== "pending" || !record.deadline) continue;
        if (!this.calendar.isOverdue(new Date(record.deadline), this.now())) continue;
        const prereqs = this.matrix.prerequisites[node] ?? [];
        const missing = prereqs.filter((p) => app.nodes[p]?.status !== "approved");
        if (missing.length > 0) continue; // 缺前置签名：即使超时也不升级
        const to = this.escalationChain.get(node);
        if (!to) continue;
        const already = record.escalations.some((e) => e.to === to && e.attempt === record.attempt);
        if (!already) {
          record.escalations.push({ at: this.#iso(this.now()), from: node, to });
          this.#appendEvent(app, "node_escalated", { node, from: node, to, by: actor });
          escalated.push({ node, name: NODE_NAMES[node], to });
        }
      }
      return { id: app.id, escalated };
    });
  }

  pack(actor, id, lines, complete) {
    this.#requireActor(actor);
    if (!["管理员", "保护人员"].includes(actor.role)) {
      throw new ServiceError(403, "forbidden", "仅保护人员/管理员可以登记装箱");
    }
    if (!Array.isArray(lines) || (lines.length === 0 && !complete)) {
      throw new ServiceError(400, "invalid_packing", "装箱明细不能为空（宣告装箱完成时可只传 complete=true）");
    }
    return this.store.mutate(() => {
      const app = this.#getApplication(id);
      if (app.withdrawnAt || app.returnedAt) throw new ServiceError(409, "closed", "申请已结案");
      if (app.approvedVersion !== app.currentVersion || app.approvedVersion == null) {
        throw new ServiceError(409, "not_approved", "申请尚未完成全部审批并锁定可执行版本，不能装箱");
      }
      const approvedData = app.versions[app.approvedVersion - 1].data;
      const approvedItems = new Map(approvedData.items.map((it) => [it.artifactId, it]));
      for (const line of lines) {
        const item = approvedItems.get(line.artifactId);
        if (!item) throw new ServiceError(422, "unknown_item", `文物 ${line.artifactId} 不在批准版本清单中`);
        if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
          throw new ServiceError(400, "invalid_packing", "装箱数量必须为正整数");
        }
        const already = app.packing.lines
          .filter((l) => l.artifactId === line.artifactId)
          .reduce((sum, l) => sum + l.quantity, 0);
        if (already + line.quantity > item.quantity) {
          throw new ServiceError(422, "over_packed", `文物 ${line.artifactId} 装箱数量超过批准数量`);
        }
      }
      for (const line of lines) {
        app.packing.lines.push({
          artifactId: line.artifactId,
          name: approvedItems.get(line.artifactId).name,
          quantity: line.quantity,
          boxId: line.boxId ?? null,
          packedAt: this.#iso(this.now()),
          by: actor,
        });
      }
      app.packing.status = complete ? "complete" : "partial";
      this.#appendEvent(app, "packing_recorded", {
        complete: Boolean(complete), count: lines.length, by: actor,
      });
      if (complete) {
        const consistency = this.#packingConsistency(app);
        if (!consistency.consistent) {
          throw new ServiceError(422, "packing_mismatch", "装箱清单与批准版本不一致，不能宣告装箱完成", consistency);
        }
      }
      return this.getView(app.id);
    });
  }

  #packingConsistency(app) {
    if (app.packing.status === "none") {
      return { consistent: true, reason: "not_started", missing: [], extra: [], quantityMismatches: [] };
    }
    if (app.approvedVersion == null) {
      return { consistent: false, reason: "no_approved_version", missing: [], extra: [], quantityMismatches: [] };
    }
    const approvedData = app.versions[app.approvedVersion - 1].data;
    const approved = new Map(approvedData.items.map((it) => [it.artifactId, it.quantity]));
    const packed = new Map();
    for (const line of app.packing.lines) {
      packed.set(line.artifactId, (packed.get(line.artifactId) ?? 0) + line.quantity);
    }
    const missing = [];
    const quantityMismatches = [];
    for (const [artifactId, qty] of approved) {
      if (!packed.has(artifactId)) missing.push({ artifactId, approvedQuantity: qty });
      else if (packed.get(artifactId) !== qty) {
        quantityMismatches.push({ artifactId, approvedQuantity: qty, packedQuantity: packed.get(artifactId) });
      }
    }
    const extra = [...packed.keys()].filter((id) => !approved.has(id)).map((artifactId) => ({ artifactId }));
    return {
      consistent: missing.length === 0 && extra.length === 0 && quantityMismatches.length === 0,
      missing,
      extra,
      quantityMismatches,
    };
  }

  withdraw(actor, id) {
    this.#requireActor(actor);
    if (!APPLICANT_ROLES.has(actor.role)) throw new ServiceError(403, "forbidden", "仅申请方可以撤回申请");
    return this.store.mutate(() => {
      const app = this.#getApplication(id);
      if (app.withdrawnAt) throw new ServiceError(409, "already_withdrawn", "申请已处于撤回状态");
      if (app.returnedAt) throw new ServiceError(409, "returned", "申请已退回");
      if (app.packing.status !== "none") {
        const packedCount = app.packing.lines.reduce((sum, l) => sum + l.quantity, 0);
        this.#appendEvent(app, "withdrawal_rejected", { reason: "已装箱的申请不能直接撤回", packedCount, by: actor });
        const error = new ServiceError(409, "already_packed", "已装箱的申请不能直接撤回，须按合同办理撤展或退回", {
          packedCount,
        });
        error.committedMutation = true;
        throw error;
      }
      app.withdrawnAt = this.#iso(this.now());
      this.#appendEvent(app, "application_withdrawn", { by: actor });
      return this.getView(app.id);
    });
  }

  markReturned(actor, id) {
    this.#requireActor(actor);
    if (!["管理员", "保护人员"].includes(actor.role)) {
      throw new ServiceError(403, "forbidden", "仅保护人员/管理员可以办理退回");
    }
    return this.store.mutate(() => {
      const app = this.#getApplication(id);
      if (app.packing.status !== "complete") {
        throw new ServiceError(409, "not_packed", "仅已完成装箱/出展的申请可以办理退回");
      }
      if (app.returnedAt) throw new ServiceError(409, "already_returned", "申请已办理退回");
      app.returnedAt = this.#iso(this.now());
      this.#appendEvent(app, "application_returned", { by: actor });
      return this.getView(app.id);
    });
  }

  #stateOf(app) {
    if (app.returnedAt) return "returned";
    if (app.withdrawnAt) return "withdrawn";
    if (app.packing.status === "complete") return "packed";
    if (app.packing.status === "partial") return "partially_packed";
    const needed = requiredNodes(this.matrix, app.versions[app.versions.length - 1].data);
    if (needed.some((n) => app.nodes[n]?.status === "rejected")) return "rejected";
    if (app.approvedVersion === app.currentVersion) return "locked";
    return "in_review";
  }

  list() {
    const root = this.store.read();
    return Object.values(root.applications).map((app) => {
      const data = app.versions[app.versions.length - 1].data;
      return {
        id: app.id,
        state: this.#stateOf(app),
        currentVersion: app.currentVersion,
        approvedVersion: app.approvedVersion,
        borrower: data.borrower?.name ?? null,
        exhibition: data.exhibition?.name ?? null,
        topGrade: highestGrade(this.matrix, data.items ?? [])?.key ?? null,
        createdAt: app.createdAt,
      };
    });
  }

  getView(id) {
    const app = this.#getApplication(id);
    const version = app.versions[app.versions.length - 1];
    const data = version.data;
    const needed = requiredNodes(this.matrix, data);
    const now = this.now();

    const nodes = {};
    const blockers = [];
    for (const node of needed) {
      const record = app.nodes[node];
      const conditions = unmetConditions(this.matrix, node, data);
      const prereqs = this.matrix.prerequisites[node] ?? [];
      const prereqState = prereqs.map((p) => ({
        node: p,
        name: NODE_NAMES[p],
        signed: app.nodes[p]?.status === "approved",
        status: app.nodes[p]?.status ?? "missing",
      }));
      const missingPrereqs = prereqState.filter((p) => !p.signed);
      const overdue = record.deadline != null && this.calendar.isOverdue(new Date(record.deadline), now);
      const escalatedTo = overdue
        ? (record.escalations.at(-1)?.to ?? this.escalationChain.get(node))
        : (record.escalations.at(-1)?.to ?? null);

      nodes[node] = {
        name: NODE_NAMES[node],
        role: node,
        roleName: this.roleNames.get(node) ?? node,
        status: record.status,
        attempt: record.attempt,
        deadline: record.deadline,
        overdue,
        escalatedTo,
        currentDecision: record.decidedAt
          ? {
              by: record.decidedBy,
              at: record.decidedAt,
              version: record.decisionVersion,
              comment: record.decisionComment,
            }
          : null,
        unmetConditions: conditions,
        prerequisites: prereqState,
        actionable: conditions.length === 0 && missingPrereqs.length === 0 && record.status === "pending",
        waitingOn: {
          conditions: conditions.map((c) => c.message),
          prerequisites: missingPrereqs.map((p) => p.name),
        },
      };

      if (record.status !== "approved") {
        blockers.push({
          node,
          name: NODE_NAMES[node],
          status: record.status,
          reasons: [
            ...conditions.map((c) => c.message),
            ...missingPrereqs.map((p) => `等待${p.name}签署`),
            ...(record.status === "rejected" ? ["该节点已拒绝，等待申请方提交新版本"] : []),
          ],
        });
      }
    }

    const decisions = app.decisions.map((d) => {
      const statusForDecision = d.decision === "approve" ? "approved" : "rejected";
      return {
        id: d.id,
        node: d.node,
        nodeName: d.nodeName,
        attempt: d.attempt,
        version: d.version,
        decision: d.decision,
        by: d.by,
        actedAsRole: d.actedAsRole,
        at: d.at,
        comment: d.comment,
        superseded: d.superseded,
        supersedeReason: d.supersedeReason ?? null,
        effective: !d.superseded && app.nodes[d.node]?.status === statusForDecision
          && app.nodes[d.node]?.attempt === d.attempt,
      };
    });

    const versions = app.versions.map((v) => ({
      version: v.version,
      at: v.at,
      submittedBy: v.submittedBy,
      changedGroups: v.change.changedGroups,
      replacedCertificate: v.change.replacedCertificate,
      certificate: {
        certNo: v.data.insuranceCertificate?.certNo ?? null,
        coverage: v.data.insuranceCertificate?.coverage ?? [],
        amount: v.data.insuranceCertificate?.amount ?? null,
      },
    }));

    return {
      id: app.id,
      state: this.#stateOf(app),
      createdAt: app.createdAt,
      currentVersion: app.currentVersion,
      approvedVersion: app.approvedVersion,
      lockedAt: app.lockedAt,
      withdrawnAt: app.withdrawnAt,
      returnedAt: app.returnedAt,
      borrower: data.borrower,
      exhibition: data.exhibition ?? null,
      topGrade: highestGrade(this.matrix, data.items ?? [])?.key ?? null,
      requiredNodes: needed,
      blockers,
      nodes,
      decisions,
      versions,
      certificateLineage: app.certificateLineage,
      packing: {
        status: app.packing.status,
        lines: app.packing.lines,
        ...this.#packingConsistency(app),
      },
      events: app.events,
    };
  }
}
