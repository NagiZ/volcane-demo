# 研发 Agent 技术方案选型（快速落地版）

> 版本：v1.1（结合三平台调研）
> 日期：2026-08-27
> 依据：[研发 Agent 产品开发、部署、观测与评估架构设计方案](研发Agent产品开发部署观测评估架构设计方案.md)
> 平台调研：[阿里百炼 / 火山方舟 / 腾讯云 ADP 横向对比](../参考资料/AI客服技术调研/平台调研/三平台横向对比.md)
> 目标：优先支撑定价 Agent 的“日巡检—证据聚合—诊断解释—建议卡片—人工决策留痕—复盘”样板闭环，不以首期建成完整平台为目标

---

## 1. 选型结论

首期建议采用 **“自有业务控制面 + 阿里百炼工作流托管能力”的混合方案**：React/FastAPI/PostgreSQL 承担业务工作台、确定性引擎、版本快照、权限审批和审计；阿里百炼工作流承担首期 LLM 编排、模型调用、可选 MCP/RAG、Agent Trace 和辅助评测。

该选择不是认定阿里百炼在所有 Agent 场景中最优，而是结合当前定价 Agent 的特点做出的 POC 排序：

- 当前流程以定时日巡检、API 取数、确定性计算和结构化解释为主，百炼工作流的定时/Webhook 触发、API/代码/MCP 节点能较快拼出闭环。
- 当前已有自研工作台，不依赖多渠道发布，因此 Agent 2.0 仅支持 API 的限制不是首期关键问题。
- 百炼已有基于 OpenTelemetry 的 Trace，并能从线上 Span 回流评测集，有利于尽快验证“观测—评测—发布”链路。
- 业务版本、规则、数据快照、审批和审计仍由自有系统保存，避免业务事实被锁定在平台控制台。

火山 AgentKit/VeADK 作为 **代码优先生产化备选**；腾讯云 ADP 作为 **知识问答、审核流和企微渠道占主导时的备选**。三者的具体能力边界来自 2026-08-21 的现有调研，正式采购和生产使用前仍需 POC 复核。

```text
React + TypeScript + Ant Design
              │
  FastAPI BFF / 自有业务控制面
              │
┌─────────────┴─────────────────────────────────────┐
│ 自有事实与强约束                                  │
│ Agent/Asset Registry │ Domain Engine │ Tool Policy│
│ Run/Event/Audit      │ Approval      │ Eval Gate  │
└────────┬─────────────────┬────────────────────────┘
         │                 │
 PostgreSQL/对象存储    阿里百炼工作流/Agent API
 版本/快照/审计/样本    LLM编排/模型/MCP/RAG/Trace/辅助评测
         │                 │
         └──── trace_id / run_id / snapshot_id ────┘
                          │
               PMS/BI/数仓只读 Domain API

备选适配器：火山 AgentKit/Managed Agents、腾讯云 ADP
自建兜底：LangGraph + LiteLLM + OTel/Phoenix
```

混合方案不让平台直接访问生产数据库，也不让平台版本号成为唯一版本事实。百炼工作流只能调用已注册的只读 Domain API；所有平台请求必须携带自有 `run_id`、`snapshot_id` 和权限范围，所有平台返回都需经过结构化校验和确定性数值回检。

### 1.1 首期基础设施最小集合

开发环境只需启动以下自有服务：

1. `web`：React 工作台。
2. `api`：FastAPI BFF、Domain API、工具策略、审批和审计入口。
3. `worker`：处理批量取数、确定性计算、回放和平台调用；与 `api` 使用同一镜像。
4. `postgres`：运行状态、版本、审计、评测集和业务闭环数据。
5. `redis`：确有并发批任务时再启用，用于队列、短期缓存和分布式锁。

外部使用阿里百炼 Dev/Eval/Prod 独立业务空间；工作流 DSL、Prompt、工具 Schema 和平台应用 ID 映射需导出或登记到 Git。LiteLLM、Phoenix、LangGraph 不作为首期必装服务，只作为跨模型、跨平台或平台能力不满足时的兜底。

对象存储、SSO、API 网关、Grafana/Prometheus/Loki 等能力优先复用公司现有设施，不在本项目重复建设。

---

## 2. 各板块技术选型

| 架构板块 | 首期主选 | 快速落地方式 | 暂不选择 / 后续升级条件 |
|---|---|---|---|
| Web 工作台 | React + TypeScript + Vite + Ant Design | 先做任务列表、任务详情/证据、决策卡、运行详情四类页面；对话仅作伴随入口 | 不先建低代码页面平台；多 Agent 稳定复用后再抽公共组件库 |
| Runtime/API Gateway | FastAPI + Pydantic | 一个 API 服务承接鉴权上下文、Agent 路由、Run 创建、SSE 进度和结构化响应 | 不先上 Kong/APISIX；复用现有企业网关。跨团队 API 数量和治理复杂度明显上升后再独立网关 |
| Agent/Asset Registry | Git 中的 YAML/JSON/SQL + Pydantic/JSON Schema 校验；发布后同步 PostgreSQL | Git 是设计事实源，数据库是运行时查询和发布记录；每次发布生成不可变 `snapshot_id` | 不先建独立 Registry 管理后台、Backstage 或 MLflow；Agent 数量增加、非研发人员需要频繁配置时再建设 UI |
| Agent 编排 | 阿里百炼工作流；自有 FastAPI 控制 Run | 百炼负责 LLM、条件/API/MCP 等软编排；数据质量、规则、状态迁移和护栏仍由 Domain Engine 一次性返回结构化结果 | 需要代码优先、复杂状态恢复或摆脱云平台时切 LangGraph；需要企业级代码 Agent 灰度与全生命周期时 POC 火山 AgentKit |
| 异步任务/定时巡检 | 百炼定时/Webhook 触发 + 自有 Worker | 平台触发后先向自有 API 创建 `run_id`；批量取数、幂等重跑和批次熔断在 Worker 内完成，平台不直接循环调用生产数据源 | 平台触发器稳定性或批量能力不满足时切 K8s CronJob/Celery；不先引入 Kafka/Pulsar |
| Model Gateway | 百炼模型 API + 自有 `ModelProvider` 适配接口 | 业务只引用内部模型别名，平台应用 ID、模型、超时和成本标签通过环境配置映射 | 要同时路由多家模型或快速切换平台时引入 LiteLLM；公司已有统一大模型网关则优先复用 |
| Tool/MCP Gateway | 自有 Python Tool SDK + FastAPI/HTTP Adapter；百炼 MCP/API 节点只作调用方 | 工具注册表保存 `tool_id/schema_version/risk_level/timeout/owner`；平台只能访问最小权限工具入口，每次调用统一鉴权、脱敏、审计和 Trace | 百炼 MCP 支持较全，可用于 POC 接入；但 MCP 不替代内部权限和审计边界。需要存量 HTTP→MCP 统一治理时评估火山 AgentKit Gateway |
| Domain Engine | 独立 Python 包；Pydantic + Pandera/SQL 断言 + pytest | 金额、利润、规则、优先级、状态迁移使用纯函数或显式服务；输入输出均为版本化模型 | 不使用 LLM 生成或覆盖数值结论；数据规模超出单机内存后，将批量计算下推到数仓 SQL/Spark，而非重写业务契约 |
| 语义资产 | Git 版本化 YAML/SQL + PostgreSQL 发布快照 | 指标、规则、参数、假设、实体映射、LLM 契约各有稳定 ID；发布时做引用完整性和双向索引校验 | 不先建设完整语义平台；跨多个 Agent 后再抽独立 Semantic Service |
| 数据访问 | 只读 Domain Data Adapter；优先调用现有 API/数仓视图 | 每次取数返回 `source/data_time/quality_status/snapshot_id`；原始快照写现有对象存储，PostgreSQL 只存索引和摘要 | 禁止 LLM 直连数据库和动态拼生产 SQL；数据源多且 SLA 独立后再拆 Domain Data Service |
| 主数据库 | PostgreSQL + SQLAlchemy + Alembic | 同库分 schema 或表前缀隔离 registry、runtime、audit、evaluation、pricing；关键事件只追加、不原地覆盖 | 不先引入多种数据库；单表规模、冷热分层或查询负载达到明确瓶颈后再拆 OLAP/日志存储 |
| 缓存/锁/队列 | Redis（按需） | 批量并发出现后用于 Worker 队列、短期缓存、限流计数和幂等锁；低并发 POC 可先用 PostgreSQL 任务表 | 不把 Redis 用作审批、运行结果或审计的唯一存储 |
| 知识/RAG | 非首期必选；需要时先 POC 百炼知识库 | 仅用于制度、历史复盘和产品资料；结构化定价证据仍走 Domain API。知识条目必须带来源、版本、时间和权限范围 | 若知识审核、逐条溯源、企微渠道成为核心，优先复测腾讯 ADP；若需自有存储与跨平台迁移，再用 PostgreSQL 全文检索 + pgvector |
| Approval/Action Gateway | 首期内置决策卡 + PostgreSQL 审批/决策事件；外部审批用 Adapter | P0/P1 只读或生成草稿；L2 才接企业现有审批，动作带幂等键、审批凭证和回滚关系 | 不首期自建通用审批引擎；L3 批量写操作保持关闭 |
| 权限 | 企业 SSO/OIDC + 应用内 RBAC/数据范围规则 | 请求入口固化 `user/org/company/data_scope`；工具层再次强制校验，不信任 Prompt | 不先上 OPA/Casbin；跨多个服务共享复杂 ABAC 策略后再抽 Policy Decision Point |
| 观测 | 百炼 OTel Trace + 自有 OTel 埋点 + 现有 Grafana | 用统一 `trace_id/run_id` 关联平台 Span 与 Domain/Tool/Decision 事件；验证百炼 Trace 导出、保留期和敏感字段策略 | 平台 Trace 不能外送、跨平台比较或自定义 Span 不足时，引入 OTel Collector + Phoenix；火山 AgentKit 的六类 Span 作为生产化备选 |
| 评测 | pytest/代码评分 + 百炼评测集/自动与人工评测 + 自有发布门禁 | Trace Span 只作为候选样本；经业务标注后进入自有黄金/边界集，平台执行模型辅助评分，结果回写 `eval_result` | 百炼缺少所需灰度/审核流时，自有系统控制 Go/No-Go；知识型 Agent 可评估腾讯 ADP 的规则/Python/人工审核能力 |
| CI/CD | 现有 Git CI + 百炼 DSL/版本登记 + Docker 镜像 | 合并请求执行 lint、类型、单测、Agent 包校验和小样本回放；发布同时记录 Git SHA、平台应用/版本 ID、Agent/资产快照 | 平台配置无法稳定导出/API 管理时，不允许直接手工改 Prod；改用代码编排或增加配置变更登记门禁 |
| 灰度与开关 | PostgreSQL 灰度策略表 + 自有 Runtime 路由 | 不依赖百炼是否原生支持流量灰度；按组织/公司/场景路由到不同平台应用/版本，并保留“新 Run、某 Agent、某工具、所有写操作”四级开关 | 若转火山 AgentKit，可复用其流量灰度和版本锁定，但自有停止开关仍保留 |
| 密钥 | 复用公司 Secret Manager/K8s Secret | Dev 可用本地 `.env` 且不入库；生产只通过运行环境注入，Agent 包只保存密钥引用 | 不在 Prompt、YAML、Trace 和评测集中保存真实密钥 |

### 2.1 这些选型为什么适合首期

- 现有横向调研确认，三家平台共同收敛到“原生 Agent + Skill/工具 + 工作流”的混合形态，因此本项目不需要在纯 Agent 与纯工作流之间二选一。[三平台横向对比](../参考资料/AI客服技术调研/平台调研/三平台横向对比.md)
- 百炼工作流在现有调研中具备定时/事件/Webhook 触发、API/代码/MCP 节点、版本回滚、OTel Trace、自动/人工评测和 Trace 回流评测集，能够覆盖定价样板最需要的托管能力。[阿里百炼调研](../参考资料/AI客服技术调研/平台调研/阿里百炼-Manage-Agents.md)
- 火山 Managed Agents 更适合长时有状态 Agent 和云端沙箱，AgentKit 则覆盖代码优先开发、Gateway、六类 Span、评测和灰度；当定价 Agent 从工作流样板进入多 Agent 生产化时，它比 Coze 更值得作为第二轮 POC。[火山方舟调研](../参考资料/AI客服技术调研/平台调研/火山方舟-Manage-Agents.md)
- 腾讯 ADP 在 RAG、逐条溯源、人工审核、规则/Python 评测和企微渠道方面更强，但公开调研中 OTel 兼容、日志投递和按流量灰度仍待核实，因此不是当前结构化定价流程的第一顺位。[腾讯云 ADP 调研](../参考资料/AI客服技术调研/平台调研/腾讯云-ADP.md)
- FastAPI 原生围绕 OpenAPI、JSON Schema 和 Pydantic 校验构建，适合把 Agent、工具和卡片输出统一为强类型契约。[FastAPI 官方特性](https://fastapi.tiangolo.com/features/)、[Pydantic JSON Schema](https://docs.pydantic.dev/latest/concepts/json_schema/)
- OpenTelemetry 是厂商中立的 Trace/Metric/Log 标准；即使首期使用百炼 Trace，自有代码仍按 OTel 埋点，方便后续切换火山 AgentKit、Phoenix 或其他后端。[OpenTelemetry Collector](https://opentelemetry.io/docs/collector/)

---

## 3. 关键板块的方案比较

### 3.1 三平台对定价 Agent 的适配结论

| 平台/产品线 | 对当前定价样板的优势 | 关键限制/待核实 | 本项目定位 |
|---|---|---|---|
| 阿里百炼工作流 | 定时/Webhook、API/代码/MCP 节点；工作流成熟；OTel Trace；Span 回流评测；API 接入自研工作台 | Agent 2.0 与多渠道割裂；不支持 BYOM；原生灰度、外部 Trace 导出和审计细节需 POC | **首期主选 POC**：托管软编排、模型、Trace 和辅助评测 |
| 火山 AgentKit/VeADK | 代码优先；兼容 LangGraph；MCP Gateway；Model/Skill/Tool/MCP/RAG 六类 Span；灰度和回滚较完整 | 比 Managed Agents 更重；价格和企业开通条件不透明；依赖火山生态 | **生产化备选**：多 Agent、复杂工具和平台治理增强后复测 |
| 火山 Managed Agents | Agent/Environment/Session/Events 完整；适合长时有状态任务、沙箱、断点续跑 | 自定义工具需客户端处理；知识库偏间接；生产观测需 AgentKit；云托管无私有环境 | **专项备选**：代码/文件/长任务场景，不承载日巡检主流程 |
| 腾讯云 ADP | RAG、逐条溯源、审核流、规则/Python/人工评测、企微/公众号渠道强 | OTel、日志投递、按流量灰度待核实；自定义模型仅企业版 | **知识型 Agent 备选**：制度问答、知识运营和企微入口权重上升时复测 |
| 自建 LangGraph + LiteLLM + Phoenix | 代码与数据可控、跨模型、跨平台、便于深度定制 | 需要自行运维运行时、观测和评测组件，首期建设面更大 | **退出与兜底路线**：平台限制或合规边界不能接受时启用 |

采用百炼主选方案仍要遵守三条边界：

1. 百炼只管理平台应用和工作流版本；完整依赖快照由自有 `asset_snapshot` 固化。
2. 百炼只调用最小权限 Domain/Tool API，平台不持有生产数据库账号和写接口凭证。
3. 所有平台输出必须回到 FastAPI/Pydantic 校验；平台 Trace、评测和版本记录同步关联到自有 `run_id`，不能成为唯一审计事实。

#### 百炼 POC 的 Go/No-Go 检查

| 验证项 | 通过条件 | 不通过后的路线 |
|---|---|---|
| 网络与鉴权 | 工作流能稳定调用最小权限 Domain API，凭证可轮换，平台无生产库直连权限 | 改为自有 Worker 主动调用百炼模型 API；仍不满足则自建/现有模型网关 |
| 结构化输出 | 目标模型按 JSON Schema 稳定返回，失败可识别、有限重试并降级 | FastAPI 侧增加约束重试；稳定性仍不足则更换模型/平台 |
| 版本快照 | 能记录工作流/Prompt/模型/工具版本或 checksum，并与自有 `snapshot_id` 对齐 | 平台只用于无状态模型调用，编排迁至 LangGraph |
| Trace 关联 | 可按 `trace_id/run_id` 查询模型、工具、检索和耗时；敏感字段可控 | 自有 OTel 为主；平台只留最少调用信息 |
| 评测回流 | 线上 Span 可进入候选集，评测结果可导出或回写自有系统 | 自有 Eval Runner + Phoenix，平台评测仅作人工参考 |
| 环境与回滚 | Dev/Eval/Prod 空间隔离；可明确回退平台应用/工作流版本 | 自有 Runtime 按多个应用 ID 路由并保留旧版本；无法安全回退则 No-Go |
| 灰度与停止 | 自有路由能按组织/公司/场景切版本，平台故障时可停止新调用或退化为结构化结果 | 不依赖平台原生灰度；若平台端无法阻断副作用则 No-Go |
| 成本与配额 | 按真实回放样本测出 Token、调用、知识库/工具及 Trace 存储成本，峰值 QPS 不触发不可接受限流 | 对比火山 AgentKit/模型 API 或自建路线 |

### 3.2 观测评测：平台快速起步，自有事实关联

| 关注对象 | 工具 | 首期职责 |
|---|---|---|
| 平台 Agent Trace | 阿里百炼 OTel Trace | 查看工作流、模型、检索和工具 Span，候选失败样例回流平台评测集 |
| 自有业务 Trace | OTel + 现有 Grafana/日志平台 | 查看 Data/Rule/Approval/Action Span，通过 `trace_id/run_id` 关联平台链路 |
| 离线评测 | pytest + 百炼自动/人工评测 | 确定性断言由代码执行，表达质量由平台辅助评测，Go/No-Go 由自有发布记录决定 |
| API/Worker/DB/队列 | Prometheus + Grafana | 可用性、延迟、错误率、资源、队列积压、批任务吞吐 |
| 应用日志 | 现有 Loki/日志平台 | 结构化运行日志；通过 `trace_id/run_id` 与百炼 Trace 关联 |
| 跨平台遥测（按需） | OpenTelemetry Collector + Phoenix | 平台 Trace 无法统一查看或需要跨版本/跨厂商对比时启用 |

不建议让百炼、AgentKit、ADP、Phoenix 或 Langfuse 中的记录直接替代业务审计表。Trace 可采样、会受平台保留期影响；审批、动作、版本快照和责任人必须由 PostgreSQL 的追加事件记录保存。

### 3.3 RAG：先证明必要性，再建检索能力

定价 Agent 首期的核心证据主要来自结构化业务数据和确定性规则，因此 RAG 不是 P1 前置条件。只有“规章制度、谈判经验、历史复盘、产品说明”等非结构化资料确实进入验收场景时，才启用：

```text
路径 A（快速 POC）：授权文档 → 百炼知识库 → 权限/来源/版本验证 → 引用返回
路径 B（需自有存储）：授权文档 → 对象存储 + PostgreSQL/pgvector
                               → 权限过滤 → 引用返回 → 百炼/其他模型组织表达
```

首期检索必须验收“引用正确、时间正确、权限正确”，而不是只看回答是否流畅。

### 3.4 Registry：Git 管设计，PostgreSQL 管运行

```text
Git 中的 Agent 包
  → CI 校验 manifest、引用、Schema、权限和评测门槛
  → 生成不可变 artifact + checksum
  → 发布表登记 agent_version / asset_versions / git_sha
  → Runtime 只读取已发布快照
```

这样可以立即获得评审、diff、回滚和责任人，又不需要首期开发一套配置管理后台。数据库不得反向修改 Git 中的生产资产；若将来开放业务配置 UI，应采用“生成变更草稿—评审—发布新版本”，而不是原地改生产记录。

---

## 4. 最小数据模型

首期建议至少落以下表，先满足可追溯和回放，再补平台 UI：

| 表/对象 | 核心内容 |
|---|---|
| `agent_release` | Agent ID、版本、Git SHA、负责人、状态、发布时间、回滚版本 |
| `asset_snapshot` | 参数/指标/规则/假设/映射/Prompt/工具 Schema 的版本和 checksum |
| `run` | run_id、入口、用户/组织、Agent 版本、版本快照、数据快照、状态、开始/结束时间 |
| `run_step` | 确定性步骤状态、重试、输入输出引用；用于业务回放，不复制全部 Trace |
| `decision_event` | 建议、采纳/驳回/修改/暂缓、原因、责任人和时间 |
| `approval_event` | 审批实例/凭证、结果、审批人、动作范围 |
| `action_event` | 动作、幂等键、执行前后引用、结果、回滚关系 |
| `review_event` | 7/14/28 天结果、归因状态、复盘结论 |
| `tool_registry` | 工具 ID、Schema 版本、风险级别、负责人、权限策略、超时/重试 |
| `eval_case` | 样本类型、输入/期望、数据快照、标注状态、脱敏等级 |
| `eval_run/eval_result` | 候选版本、基线版本、评分器版本、逐样本结果、Go/No-Go |
| `outbox_event` | 需异步投递的业务事件，确保数据库提交与事件发布一致 |

原始数据快照、模型长文本、附件等大对象存对象存储，表中保存 URI、checksum、权限和保留期。

---

## 5. 代码与仓库建议结构

```text
ops-pricing-agent/
├── apps/
│   ├── web/                    # React 工作台
│   ├── api/                    # FastAPI 接入与控制平面
│   └── worker/                 # 批处理/回放任务，与 api 共用核心包
├── agents/
│   └── pricing-management/     # manifest、workflow、prompt、policy、eval 引用
├── platform/
│   ├── bailian/                # 工作流 DSL/版本、应用 ID 映射、发布说明
│   ├── agentkit/               # 备选平台适配器与 POC 记录
│   └── adp/                    # 备选平台适配器与 POC 记录
├── packages/
│   ├── runtime/                # Run、版本快照、平台路由；LangGraph 为自建兜底
│   ├── tool_gateway/           # 工具注册、权限、审计、幂等、脱敏
│   ├── platform_adapter/       # 百炼/AgentKit/ADP 的最小统一接口
│   ├── model_gateway/          # 内部模型别名；LiteLLM 为多模型兜底
│   ├── domain_pricing/         # 定价确定性计算与规则
│   ├── semantic_assets/        # 资产模型、加载、校验和发布
│   ├── observability/          # OTel/OpenInference 统一埋点
│   └── evaluation/             # 回放、评分器、门禁
├── evals/
│   ├── golden/
│   ├── boundary/
│   └── replay/
├── migrations/                # Alembic
├── deploy/
│   ├── compose.yaml
│   └── otel-collector.yaml     # 跨平台遥测需要时启用
└── tests/
```

关键原则是“一个发布单元、多个清晰模块”。`domain_pricing` 不能依赖具体模型 SDK；`tool_gateway` 不能依赖某个 Agent 的 Prompt；`agents/pricing-management` 只能通过公开契约引用平台模块。

---

## 6. 首个样板的运行链路

```text
定时任务/人工触发
  → FastAPI 创建 run_id，固化用户/组织/数据范围
  → 解析已发布 Agent 与资产快照
  → Worker 读取 PMS/BI/数仓，只保存快照引用
  → Domain Engine 做数据质量、利润、规则、优先级和护栏计算
  → 计算不满足最低证据集：生成“待补数据”卡，停止强建议
  → 计算满足：调用百炼工作流，传入结构化结果、run_id 和 snapshot_id
  → 百炼调用批准模型，仅生成结构化解释/建议表达并记录平台 Trace
  → 返回 FastAPI，Pydantic 校验输出，数值与 Domain Engine 逐字段回检
  → 生成建议卡，业务人员采纳/驳回/修改/暂缓
  → 追加 decision_event；首期不执行生产写操作
  → 百炼 Span 生成候选评测样本，经人工筛选后写入自有 eval_case
  → 7/14/28 天追加 review_event，形成可回放样本
```

模型输出校验失败时只允许有限次数重试；仍失败则退化为确定性结构化结果，不允许模型自由文本绕过卡片契约。

---

## 7. 分三步落地

### 第一步：跑通一条可追溯链路

交付：

- 建立 Python/React 工程骨架、百炼 Dev/Eval 空间和平台适配器。
- 定义 `agent manifest`、资产快照、Run/Event、工具和卡片 Pydantic 模型。
- 接入一个脱敏/历史数据源、一个确定性规则和一个百炼工作流版本。
- 跑通“输入—计算—解释—卡片—人工决策—Trace”。

通过标准：同一输入和同一版本快照重跑，确定性结果一致；任一结果可定位 Git SHA、自有 Agent/资产版本、百炼应用/工作流版本、数据快照、工具调用和模型调用。

### 第二步：形成日巡检和评测闭环

交付：

- 百炼触发器 + 自有 Worker、幂等和失败重跑；若平台触发不满足批处理要求，再切 K8s CronJob/Celery。
- 接入 MVP 规则及最低证据集，形成固定黄金集和边界集。
- 百炼 Trace 回流/评测 + CI 确定性门禁；平台评测结果回写自有评测记录。
- 任务列表、证据详情、决策卡和运行详情页面。

通过标准：新版本能与当前基线逐样本比较；结构化失败、数值不一致、越权建议和关键样本退化可阻断发布。

### 第三步：影子运行和试点

交付：

- 真实只读数据影子运行、按组织/公司/场景灰度。
- 百炼 Trace 与自有 OTel/Grafana 关联、告警、敏感字段过滤和保留策略；跨平台需要时再增加 OTel Collector/Phoenix。
- 人工盲评、采纳/驳回原因、7/14/28 天复盘回流。
- 停止新 Run、停止 Agent、停止工具和停止写操作四级开关。

通过标准：影子结果不触发外部副作用；业务负责人可查看固定样本对比并给出 Go/No-Go；所有生产 Trace 均能关联业务审计记录。

---

## 8. 明确暂缓的建设项

| 暂缓项 | 暂缓原因 | 启动条件 |
|---|---|---|
| 微服务拆分 | 增加部署、调用和一致性成本，对首个样板无直接价值 | 某模块需要独立扩缩容、故障隔离、独立团队发布或独立合规边界 |
| Kafka/Pulsar | 首期消费者少，PostgreSQL Outbox + Celery 足够 | 多系统订阅、事件长期重放、高吞吐或队列成为瓶颈 |
| Temporal | 运维和学习成本高 | 大量跨服务长事务、复杂补偿、数日工作流和严格恢复需求 |
| 独立向量数据库 | 首期 RAG 不是核心，新增运维面 | pgvector 经压测无法满足文档量、QPS、过滤或隔离要求 |
| 自建通用低代码 Agent 平台 | 百炼/AgentKit/ADP 已能覆盖探索期编排，首期自建编辑器价值低 | 多 Agent 流程稳定、平台锁定成本或非研发配置需求已有实证 |
| OPA/统一策略中心 | 首期策略范围可由应用代码和数据库表清晰表达 | 多服务需要共享复杂 ABAC、策略需独立发布和审计 |
| 自动执行 L2/L3 | 尚未经过只读影子验证 | 数据、规则、评测、审批、幂等、回滚和停止开关逐场景通过评审 |
| 多 Agent 自主协商 | 增加不确定性、成本和调试难度 | 单 Agent 中明确出现上下文隔离、失败隔离或并行收益证据 |

---

## 9. POC 前必须确认的外部条件

以下不是技术框架选择题，但会直接改变部署边界：

1. 公司现有容器平台、CI、API 网关、SSO、Secret Manager、对象存储和 Grafana 能力清单。
2. PMS、BI、数仓的只读接口、数据刷新时间、公司/用户数据范围和限流要求。
3. 阿里百炼账号、地域和 Dev/Eval/Prod 空间能否开通；工作流 DSL 导出、版本 API、Trace 导出、审计、告警与灰度能力实测结果。
4. 百炼可用模型、结构化输出能力、数据是否允许出域、平台日志是否留存以及敏感字段策略。
5. 百炼工作流调用内网 Domain API 的网络路径、鉴权方式、QPS、超时和失败重试边界。
6. Trace、审计、评测样本和原始快照的保留期、脱敏等级和查询权限。
7. 若百炼 POC 未通过，是否具备火山 AgentKit 企业开通条件；若知识型场景优先，是否具备腾讯 ADP 企业版和企微渠道条件。
8. 首批黄金集、边界集、人工盲评人和业务 Go/No-Go 责任人。

---

## 10. 最终建议

首期不要重复建设“大而全 Agent 平台”，而要利用已调研平台快速交付一个业务事实仍由自己掌握的定价样板：

```text
自有 React/FastAPI/PostgreSQL 业务控制面
+ 强类型 Agent/Tool/Asset 契约
+ 确定性 Domain Engine
+ Git 版本事实源
+ PostgreSQL 运行与审计事实源
+ 阿里百炼工作流/模型/MCP/Trace/辅助评测
+ 平台 Adapter 与 run_id/snapshot_id 关联
+ LangGraph/LiteLLM/Phoenix 自建退出路线
+ 只读影子运行
```

推荐先用阿里百炼完成一轮平台辅助 POC，验证原架构方案中最关键的五件事：**可追溯、可回放、可评测、可灰度、可停止**。若百炼在 BYOM、灰度、审计、网络或数据出域方面不满足，再按问题类型选择火山 AgentKit 或自建 LangGraph 路线；若后续场景转向知识问答、审核和企微入口，再复测腾讯 ADP。平台切换不能改变 Domain Engine、Tool Policy、业务审计和评测门禁的自有边界。
