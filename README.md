# 省博物馆借展审批服务

面向外借专员与借展单位的多级审批服务：申请方提交**借展清单、路线、温湿度承诺、保险凭证**，系统按文物等级与风险矩阵自动组织审批链；全部节点签署后**锁定可执行版本**，批准版本与装箱清单逐件比对。

零第三方依赖，Node.js 22 内置 `node:http` / `node:test`。

## 业务规则如何落实

| 要求 | 实现 |
| --- | --- |
| 按文物等级与风险组织多级审批 | `reference/risk-matrix.json`：三级四节点、二级加馆领导、一级加主管部门；航空/水路/国际路线追加主管部门；节点集合沿前置链自动补齐（如三级走航空时补齐馆领导） |
| 保险只覆盖展柜、缺运输风险 | 保险节点条件 `transport_coverage` 与安全节点条件 `transport_insurance` 同时阻塞，查询接口直接解释原因 |
| 审批人在旧版本签过字 | 签名绑定版本与关键条件分组指纹；新版本中分组变化的节点及其传递后置节点全部失效重签（`dependentClosure`），旧决定标记 `superseded` 但保留留痕 |
| 凭证替换留下版本关系 | 每次替换写入 `certificateLineage`（新凭证编号、版本、`supersedesCertNo`、经办人、时间），不覆盖旧凭证 |
| 任何关键条件变化重新进入相应节点 | 五类指纹分组 `items / route / climate / insurance / contract`，只失效对应所有者及其后置；无关字段（如联系电话）可更新但不重签 |
| 批准后锁定可执行版本 | 全部前置满足且签署后 `approvedVersion = currentVersion` 并记 `version_locked` 事件；新版本未批完前，旧锁定版本仍可查 |
| 已装箱不能直接撤回 | 撤回返回 `409 already_packed` 并留 `withdrawal_rejected` 事件；须保护人员走退回流程 |
| 并发审批只产生一个有效决定 | 所有变更经存储层串行“读-改-写”队列，同一 attempt 第二次决定返回 `409 already_decided` |
| 超时升级不越过缺失前置签名 | 升级沿 `approval-roles.json` 角色链；前置未签的节点既不能代办也不会被升级，即使早已超时 |
| 重启后继续计算截止时间 | 截止时间是**绝对时刻**（按工作日 09:00–17:00 Asia/Shanghai 计算），随 JSON 落盘；重启原样恢复，不重算、不暂停 |
| 查询解释卡点/决定历史/版本一致性 | `GET /applications/:id` 返回每节点 `waitingOn`（条件+前置）、全部决定（含 `superseded/effective`）、版本链、凭证链、装箱差异（缺失/多出/数量不符） |

### 审批节点与前置

```
insurance(保险审核)  conservation(保护科技)
        \\                  //
         security(安全保卫)
              |
         curator(藏品部) → leader(馆领导) → authority(主管部门，一级文物或高风险路线)
```

- 各节点在自身材料条件满足、且全部前置已签时才可受理；等待前置期间不计时。
- SLA（工作小时）见 `risk-matrix.json#slaWorkingHours`，超时后升级链：审核员→馆领导→馆长。升级只转移受理角色，签名仍记在原节点（`actedAsRole` 留痕）。

## 资料文件

- `reference/loan-contract.sample.json` — 借展合同样例（结构化条款与申请字段一一对应）
- `reference/risk-matrix.json` — 等级/路线节点、节点条件、前置关系、温湿度区间、SLA
- `reference/approval-roles.json` — 审批角色与超时升级链
- `reference/work-calendar.json` — 工作日历（法定假日、调休上班日、工作时段，Asia/Shanghai）

## 运行

```bash
npm ci
npm start                 # 默认 0.0.0.0:8000
LOAN_DATA_FILE=/data/loan.json npm start   # 数据落盘位置（默认系统临时目录）
npm test                  # 43 个测试
docker compose up --build
```

## HTTP 接口

身份经请求头传入：`x-user-id`、`x-user-role`。审批节点角色直接用键名（`insurance`/`conservation`/`security`/`curator`/`leader`/`authority`）；中文业务角色用 ASCII 别名：`applicant`（申请方）、`admin`（管理员）、`conservator`（保护人员）。

| 方法与路径 | 角色 | 说明 |
| --- | --- | --- |
| `POST /applications` | applicant | 提交借展申请（清单/路线/温湿度/保险凭证/合同接受） |
| `GET /applications` | 任意 | 申请列表 |
| `GET /applications/:id` | 任意 | **解释性视图**：节点、卡点、决定、版本、装箱一致性、事件流 |
| `POST /applications/:id/versions` | applicant | 提交整包新版本（无任何变化返回 409） |
| `POST /applications/:id/certificate` | applicant | 仅替换保险凭证（自动生成新版本与凭证链） |
| `POST /applications/:id/decisions/:node` | 节点角色/升级角色 | `{decision:"approve"|"reject", comment?}` |
| `POST /applications/:id/escalations` | 任意 | 显式登记已超时节点的升级（缺前置的节点不升级） |
| `POST /applications/:id/packing` | conservator/admin | 登记装箱明细；`complete:true` 时必须与批准版本逐件一致 |
| `POST /applications/:id/withdraw` | applicant | 撤回；已装箱返回 409 并留痕 |
| `POST /applications/:id/return` | conservator/admin | 装箱出展后办理退回 |
| `GET /reference` | 任意 | 查询当前生效的风险矩阵、角色链、日历 |

### 申请体示例

```json
{
  "borrower": { "name": "某市博物馆", "contact": "张三", "phone": "0571-11112222" },
  "exhibition": { "name": "青铜文明特展", "venue": "一号厅" },
  "items": [{ "artifactId": "artifact-0001", "name": "青铜鼎", "grade": "一级", "quantity": 1, "agreedValue": 5000000 }],
  "route": {
    "carrier": "安运文物运输有限公司", "mode": "公路",
    "origin": "省博物馆库房", "destination": "市博物馆一号厅",
    "stops": [], "international": false,
    "departAt": "2026-11-02T08:00:00+08:00", "arriveAt": "2026-11-03T18:00:00+08:00"
  },
  "climate": { "temperatureMin": 19, "temperatureMax": 21, "humidityMin": 52, "humidityMax": 58 },
  "insuranceCertificate": {
    "certNo": "INS-0001", "insurer": "XX财产保险股份有限公司",
    "coverage": ["display", "transport", "packing"], "amount": 5000000
  },
  "contractAccepted": true
}
```

### 查询视图关键字段

- `state`：`in_review / rejected / locked / partially_packed / packed / withdrawn / returned`
- `blockers[].reasons`：每个未完成节点卡在哪些材料条件、等哪个前置签名
- `nodes[].{status, deadline, overdue, escalatedTo, actionable, waitingOn, currentDecision}`
- `decisions[]`：每次决定的节点、批次 attempt、版本、经办人、代办角色、是否已被取代、是否当前有效
- `versions[]` 与 `certificateLineage[]`：版本关系与凭证替换链
- `packing.consistent`：批准版本与装箱清单逐件比对结果（`missing / extra / quantityMismatches`）

## 题目场景回放

申请提交时保单只含 `display`：保险节点给出「保险凭证须覆盖运输途中（含装卸）风险，不得只保展柜」，安全节点给出「运输风险尚未投保」。审批人无法强行批准（422）。申请方调用 `/certificate` 换成含 `transport` 的钉到钉保单 → 自动产生 v2，凭证链记录 `NAIL-TO-NAIL → supersedes → 旧凭证`，旧批次决定失效。六节点依序签署后 v2 锁定；装箱完成后撤回返回 409 并留痕，只能走退回流程。
