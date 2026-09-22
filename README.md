# 文物借展审批服务

面向省博物馆外借业务的 Node.js 审批服务：申请方提交**借展清单、路线、温湿度承诺、保险凭证**，系统按**文物等级 + 风险矩阵**组织多级审批，全部通过后**锁定唯一可执行版本**，并据此核验装箱清单。

需要 Node.js 22+，无第三方运行时依赖。

## 运行

```bash
npm ci
npm start                 # 默认 0.0.0.0:8000，数据写入 .data/approvals.json
PORT=8000 DATA_FILE=/var/lib/loan/approvals.json npm start
npm test                  # 28 个测试（工作日历/流程/升级/HTTP）
node scripts/smoke.mjs    # 端到端场景演示
# 或 docker compose up --build
```

## 参考资料（reference/）

| 文件 | 内容 |
| --- | --- |
| `loan-contract-sample.md` | 借展合同样例：清单、展期、路线、温湿度承诺、保险条款（明确运输险与展期险不得有空窗） |
| `risk-matrix.json` | 风险矩阵：文物等级基准分、路线类型、运输方式、温湿度偏差叠加规则；各险种须覆盖的时间窗口 |
| `approval-roles.json` | 审批角色、按等级的链条模板、高风险加签点、节点准入条件、超时与升级规则、并发规则 |
| `workday-calendar-2026.json` | 2026 年节假日与调休工作日（依据国务院办公厅 2026 年放假安排通知） |

## 审批链与风险定级

- 三级文物：藏品保管部 → 外借专员 → 风控/法务 → 馆长
- 一/二级文物：在风控前增加 **文保科技部**
- 综合风险为 **high**（等级基准分 + 路线/运输方式/温湿度偏差叠加封顶 2 分）时，在馆长前插入 **分管副馆长**加签

每节点带准入条件（清单有效、合同与申请一致、温湿度承诺落入文物耐受区间、保险按险别覆盖时间窗且保额不低于文物总价值、前置节点全部签字）。条件不满足时节点保持 `blocked`，**任何人（含超时升级代批人）都不能批准**。

## 关键业务规则

1. **版本与凭证血缘**：每次提交生成不可变快照（规范化 + SHA-256），版本保留 `parentSeq`、变化段落与凭证血缘（保单新增/撤销/换发、合同替换）。题设中“审批人在旧版本签过字”的签名不会被删除，新版本相关节点重入后在 `supersededDecisions` 中可查。
2. **关键条件变化重入节点**：各节点按“关注段落”失效——改保险只重开风控/馆长等关注保险的节点，改温湿度重开文保科技部，未受影响的上游签名继续有效。
3. **批准锁定**：链条全部批准后锁定当前版本（seq + hash）。锁定后任何修订都会使锁失效并回到相应节点；装箱以锁定版本为准。
4. **装箱与撤回**：装箱清单与批准版本逐件比对（缺件、多件、数量不符均拒绝）；**已装箱不能直接撤回，也不能修订**，须先 `unpack` 解除装箱核验。
5. **并发决定互斥**：存储采用版本号条件写（CAS + 原子落盘），同一节点并发审批只有第一个决定生效，其余返回 `decision_conflict`。
6. **超时升级不越过前置签名**：节点首次进入 `active` 时按**工作日工作时间**（节假日/调休日历，09:00–18:00）计算截止与升级时刻；升级只把待办交给上级，代批仍走同一准入条件校验，前置签名缺失时一律拒绝。
7. **重启续算**：截止时间是持久化的绝对时刻，服务重启后立即扫描升级，不重新起算。

## HTTP 接口

身份通过 `x-actor-id` 请求头传递（不可变字符串）。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /applications` | 提交申请（body 为申请内容） |
| `POST /applications/:id/versions` | 提交修订版本（自动生成版本血缘） |
| `GET  /applications/:id` | **解释视图**：每节点状态/阻塞条件（机器码+中文说明）、活动节点与截止时间、全部决定台账、批准版本、装箱一致性 |
| `POST /applications/:id/decisions` | `{node, decision:"approve|reject", note?, onBehalfOfEscalation?}` |
| `POST /applications/:id/pack` / `unpack` / `withdraw` | 装箱 / 解除装箱 / 撤回 |
| `POST /admin/sweep-escalations` | 立即扫描超时升级（服务启动时与每分钟自动执行） |
| `GET  /applications` / `/health` | 列表 / 存活检查 |

典型错误码：`blocked_precondition`(409，附 blockers)、`decision_conflict`(409)、`manifest_mismatch`(409)、`packed_cannot_withdraw`(409)、`packed_cannot_revise`(409)、`actor_not_authorized`(403)。

### 题设场景示例

保险凭证只有 `exhibition` 险别时，风控节点解释为：

```
insurance_covers_transport   保险凭证未覆盖运输风险（缺少 transport 险别）
insurance_transport_amount_sufficient  因缺少运输风险保单，保额无法核定
```

申请方补交含 `transport` 险别且起止期覆盖出库—回库窗口的凭证后，风控节点重新进入，批准后锁定新版本；旧版本、旧签名与凭证替换关系全程保留。

## 代码结构

```
src/
  calendar.js   工作日/工作时间推算（固定 UTC+8，节假日+调休）
  rules.js      快照规范化、风险定级、链条生成、节点条件评估、版本/凭证差异
  store.js      JSON 原子存储 + 版本号 CAS（另含测试用 MemoryStore）
  engine.js     审批引擎：提交/修订、决定、升级扫描、装箱、撤回、解释视图
  app.js        HTTP 路由；index.js 启动与定时升级扫描
```
