# 阿里云百炼 Managed Agents 商品异常分析 Agent 技术方案
> **版本**：V1.0（初稿）
> **说明**：基于阿里云百炼（Model Studio）Managed Agents（agentstudio）官方公开文档编写，对应火山引擎 MA 方案的同场景落地。标注「待核实」处需以官方文档 / POC 为准。
> **方案边界**：本方案仅覆盖百炼 Managed Agents 平台侧对接、Agent/Environment/Session/Skill/MCP/事件处理与资源管理，不包含 leyosys 业务系统、业务规则引擎的后端开发与运维。

---

## 一、项目概述
### 1.1 背景与目标
基于阿里云百炼 Managed Agents 构建商品异常分析智能 Agent，复用已开发的 leyosys 沙箱自定义取数能力，结合可动态调整的业务分析规则，自动完成多维度商品异常诊断，输出结构化处理决策建议与分析报告，支撑业务人员高效定位问题、制定处置策略。

核心建设目标：
1.  复用 leyosys 取数能力，按用户维度鉴权调用业务接口，实现多源数据自动拉取与整合
2.  **支持业务分析规则热更新**，规则调整无需重建沙箱、无需中断在线会话，全量同步生效
3.  输出双形态产物：对话式文字结论 + 结构化分析报告文件，报告法定留存 30 天
4.  支撑约 1000 名内部业务用户稳定使用，单次单用户分析原始数据量 ≤10MB

### 1.2 建设范围
- ✅ 一期（本版落地）：Agent 编排设计、自定义 Skill / MCP 集成、会话管理、凭据管理（Node 后端持有凭据，一期不依赖平台密钥库）、文件归档存储、SSE 事件对接、成本与运维设计
- ⏭️ 二期（进阶）：密钥库 / 凭据托管（待官方 API）、精细化权限、历史查询与归档管理
- ❌ 不包含：leyosys 业务系统开发、业务规则逻辑本身的研发、前端页面开发、业务侧后端服务

### 1.3 用户与使用模式
- 目标用户：约 1000 名内部业务运营 / 分析人员
- 触发方式：用户主动发送分析指令触发任务
- 交互形态：单轮完整分析 + 多轮追问细化
- 鉴权粒度：leyosys 业务接口为**用户级独立鉴权**，每个用户凭据隔离
- 数据规模：单次单用户分析原始数据量 ≤10MB，沙箱内内存处理，不落地持久化

### 1.4 核心交付产物
1.  对话式文字分析结论：异常类型、原因判断、处理建议、依据说明
2.  结构化分析报告文件：Markdown / Excel 格式，归档到自有 OSS，法定留存 30 天，可历史追溯

---

## 二、整体架构与核心链路
### 2.1 总体架构分层
| 层级 | 说明 | 本方案范围 |
|---|---|---|
| 用户交互层 | 前端对话入口、文件下载与历史查询 | 不涉及 |
| 接入转发层 | Node.js 自研后端，负责用户鉴权、请求转发、事件透传、资源管理、规则与凭据编排 | 仅涉及百炼 MA 对接相关逻辑 |
| **MA 平台层（核心）** | 阿里云百炼 Managed Agents 托管环境（agentstudio） | ✅ 本方案全覆盖 |
| 业务依赖层 | leyosys 业务系统接口、业务规则配置源 | 不涉及，仅定义对接契约 |

MA 平台层内部拆解：
- **Agent 调度层**：大模型推理、指令解析、多 Skill/MCP 编排调度、结果整合
- **Skill / 工具执行层**：leyosys 取数（自定义 Skill 或 MCP）、规则执行引擎、内置 bash/文件工具
- **基础资源层**：云端沙箱 Environment、Session、Files、自定义 Skill 版本库；凭据托管（一期由 Node 后端自持，二期视官方「密钥库」API 开放情况接入）

### 2.2 核心 Skill / 工具分工与职责边界
| 能力 | 形态 | 职责 | 输入 | 输出 |
|---|---|---|---|---|
| leyosys 取数 | 自定义 Skill（zip+SKILL.md）或 MCP | 调用业务接口拉取商品异常原始数据，按用户鉴权隔离 | 商品范围、时间维度、异常类型等 | 结构化异常原始数据集（单用户单次 ≤10MB） |
| 规则执行引擎 | 自定义 Skill / MCP（稳定执行器） | 加载最新业务规则，执行规则匹配、异常分级、根因诊断 | 原始异常数据集 + 动态规则数据 | 异常诊断结论、根因判断、决策建议、依据明细 |
| Agent 主模型 | 百炼托管大模型（qwen 系列） | 指令理解、参数提取、Skill/MCP 调度、结果整合、多轮对话 | 用户自然语言指令 | 最终文字回复、文件生成指令 |

> **形态说明（一期）**：百炼 Managed Agents 的扩展能力有两类：①「自定义 Skill」——以 zip 包上传（≤10MB，根目录含 SKILL.md），在沙箱内执行；②「MCP 服务」——接入外部工具服务，凭据由 MCP 服务自身管理。取数与规则执行既可做成 Skill 在沙箱内直连业务接口，也可封装为 MCP 由服务端执行。二者在鉴权模型上差异显著，需按 3.1/3.4 明确后落地。

### 2.3 完整执行主流程
1.  用户发送自然语言分析指令（指定商品范围、时间、异常类型等）
2.  Node 后端校验用户身份，查询对应用户的会话与资源绑定关系
3.  Agent 解析指令，提取结构化查询参数
4.  调度 leyosys 取数能力，使用当前用户凭据拉取对应维度的商品异常数据（≤10MB，内存处理）
5.  调度规则执行引擎，从业务侧规则配置源拉取全量最新业务规则（内存处理），执行异常诊断
6.  Agent 整合诊断结论，生成自然语言文字回复
7.  如需生成报告，调用文件能力写入沙箱产物目录，Node 后端转存到自有 OSS 归档目录
8.  Node 后端异步更新用户级元数据（偏好、历史分析索引）
9.  所有中间事件与最终结果通过 SSE 事件流推送至前端
10. 任务结束，Session 回到 idle，停止计费；原始数据随沙箱内存释放，不持久化留存

---

## 三、核心模块详细设计
### 3.1 自定义 Skill / MCP 集成设计
#### 3.1.1 leyosys 取数
- **部署形态**：二选一，需在评审时定案
  - **Skill 形态**：自定义 Skill（zip ≤10MB，根目录 SKILL.md），挂载到 Agent 时锁定具体版本；Skill 在云端沙箱内执行、直连业务接口
  - **MCP 形态**：将 leyosys 取数封装为自定义 MCP 服务，Agent 通过 `mcp_servers` 引用；执行与凭据管理在 MCP 服务侧完成
- **鉴权方式（一期）**：百炼 agentstudio 公开 API 总览仅列 Agent / Environment / Session / Event / Files / Skill，**无 Vault / 密钥库端点，也没有火山 MA 那样的 `environment_with_overrides` 按会话注入凭据的能力**（控制台会话页虽有「密钥库」标签页，但截至本版未开放对应 API）
  - 落地：由 Node 后端持有用户凭据完成取数（MCP 服务或回调 Node），沙箱不直接接触明文凭据
  - 进阶：若官方后续开放「密钥库 / 环境变量注入」，可切换为 Skill 沙箱内读取注入凭据直连业务接口（详见 3.4.2）
- **数据处理策略**：单次单用户原始数据 ≤10MB，沙箱内存可承载，全程内存流转，不写本地持久化文件；任务结束随上下文释放
- **用户隔离**：不同用户会话 / 凭据隔离，无交叉访问
- **超时与错误约定**：配置合理超时阈值；标准化错误码与错误信息，Agent 按错误类型给出话术

#### 3.1.2 分析规则热更新设计
##### 设计原则：执行器与规则数据解耦，全量热更新不中断会话
- **规则执行引擎**：稳定执行器本体，封装规则解析、匹配、计算逻辑，版本迭代频率低
- **规则数据**：独立于 Skill 包，由业务侧集中维护与更新，业务调整即时生效

##### 规则存储与加载方案
采用 **业务侧规则配置源实时拉取** 方案（规则不存平台侧）：
1.  **存储位置**：规则数据由业务侧规则配置源统一维护版本，不写入百炼 Files / 记忆
2.  **加载方式**：规则执行引擎每次执行时，直接调用业务侧规则接口拉取最新全量规则（内存处理，不落地）
3.  **生效时机**：**无需重建沙箱、无需中断在线会话**，每次执行拉最新，全量用户即时生效
4.  **版本管理**：规则带版本号，业务侧保留最近 3 个历史版本；回滚在业务侧配置源完成，下次执行自然拉取回滚后版本
5.  **降级兜底**：规则接口加载异常时重试；仍失败则返回明确错误提示，引导稍后重试，避免用错误规则产出结论

#### 3.1.3 Skill 间协作机制
- 串行调度：先取数，后分析，由 Agent 大模型统一调度
- 数据传递：前一能力输出作为后一能力输入，通过模型上下文传递，不依赖沙箱本地文件
- 异常中断：任一能力执行失败，Agent 终止后续流程，返回对应错误提示

### 3.2 会话管理设计
#### 3.2.1 会话复用策略
- **策略**：**一人一会话（one user one session）**，约 1000 个常驻 Session
- **理由**：多轮追问场景多，复用会话保留上下文；沙箱 / 资源一次创建，全程复用；规则热更新不依赖会话重建
- **快照语义**：创建 Session 时服务端**快照当时的 Agent 配置**，后续更新 Agent（版本号 +1）不影响已有会话
- **并发限制**：同一 Session 不支持并发处理两条消息，后端需排队或拒绝（返回"上一任务进行中"）

#### 3.2.2 状态机与交互模式
| 状态 | 含义 | 可执行操作 |
|---|---|---|
| `idle`（stop_reason=null/end_turn/retries_exhausted） | 可交互空闲 | 发送新消息、挂载文件、归档/删除 |
| `idle`（stop_reason=requires_action） | 存在 always_ask 工具审批待裁决 | 提交审批或中断，**不能用普通消息继续** |
| `running` | 处理中 | 中断 |
| `terminated` | 归档/删除/不可恢复错误 | 查看历史，新建会话继续 |

- 单轮完整分析 + 多轮追问；上下文保留在平台事件流中，无需业务侧存储

#### 3.2.3 中断与审批
- 长耗时分析可通过中断事件（interrupt）中止当前轮，不销毁沙箱、不删除会话
- 对高风险写操作可将工具配置为 `always_ask`，触发 `tool_approval_request` → `idle(requires_action)` → 提交 `tool_approval_response` 裁决后继续

### 3.3 持久化与记忆设计
> 与火山 MA 的关键差异：百炼 Managed Agents 的 agentstudio API 未提供火山 MA 那样的「Memory Store」资源；长期记忆在百炼是独立的「记忆库」产品（面向智能体应用，需另评估是否接入）。本方案一期不依赖平台侧 Memory Store，用户级元数据由 Node 后端自建存储。

#### 3.3.1 存储内容与位置
| 存储项 | 说明 | 位置 |
|---|---|---|
| 用户分析偏好 | 常用分析维度、默认时间范围、输出格式偏好、默认品类权限 | Node 后端（Redis/DB） |
| 历史分析文件索引 | 任务 ID、时间、摘要、OSS 路径、文件大小 | Node 后端（Redis/DB） |
| 用户权限标识 | 可访问的商品品类、数据范围权限标记 | Node 后端（Redis/DB） |

> **不存储**：原始业务明细数据、完整异常清单、规则数据（规则由业务侧配置源承载）

#### 3.3.2 读写与生命周期
- 用户级元数据由 Node 后端统一读写，Skill 不直接写，避免篡改
- 生命周期：随用户账号生命周期；文件索引与 OSS 归档文件同步（30 天），到期同步清理

### 3.4 凭据管理设计
#### 3.4.1 一期方案（本版落地）：Node 后端持有凭据 + MCP / 回调取数
- **事实依据**：百炼 agentstudio 公开 API 总览仅列出 Agent / Environment / Session / Event / Files / Skill 六类资源，**未提供 Vault / 密钥库端点，也没有火山 MA 那样的按会话环境变量注入能力**；控制台会话页虽存在「密钥库」标签页，但截至本版撰写时未开放对应 API。
- **落地方式**：用户凭据由 Node 自研后端统一持有，leyosys 取数封装为 **MCP 服务或 Node 回调**完成，沙箱内不接触用户明文凭据。
- **鉴权链路**：前端 → Node 校验用户身份 → 由 Node/MCP 侧以该用户凭据调用 leyosys → 结果返回 Agent。每个用户凭据隔离，互不可见。
- **安全边界**：后端不向前端暴露凭据；日志、SSE 事件流、Agent 消息不打印完整凭据；凭据支持定期轮换并留存审计。

#### 3.4.2 二期进阶：密钥库 / 凭据托管（待官方 API）
- **目标**：若官方后续开放「密钥库」API 与按会话注入能力，则升级为**一用户一凭据（库）**，Skill 沙箱内读取注入凭据直连业务接口，与火山 Vault 方案对齐。
- **上线前待核实项**：凭据创建/更新 API、是否运行期生效、注入与读取机制，均须以官方文档 / POC 为准，不得写死结论。
- **隔离性**：不同用户凭据完全隔离，会话之间不互通。

#### 3.4.3 资源绑定关系
通过业务映射表 `user_agent_bind` 统一维护：
`biz_user_id ↔ default_session_id ↔ 凭据标识（二期）↔ 用户元数据键`

### 3.5 文件 30 天归档存储设计
#### 3.5.1 存储方案选型
- 百炼 Managed Agents 的 Files 已核实配额：**单文件 ≤10MB、工作空间总容量 100GB、保留期 30 天（超期可能被自动清理）**；文件仅支持硬删除、不支持归档，删除后不可恢复。
- 挂载规则已核实：创建 Session 时在 `resources[]` 指定 `file_id` 与 `mount_path`；运行时可通过 `POST /sessions/{session_id}/resources` 追加挂载；填写的 `mount_path` 会被平台自动加上 `/mnt/session/uploads` 前缀（如 `/workspace/report.xlsx` 实际为 `/mnt/session/uploads/workspace/report.xlsx`）。挂载时服务端做内部拷贝并生成 session 级 `file_id`，原始文件不受会话内修改影响。
- 报告产物由 Agent 写入沙箱产物目录后，Node 后端通过 `GET /files/{file_id}/content` 拉取，**转存到自有 OSS 桶**实现可控的历史追溯与 30 天留存（平台 Files 同样为 30 天保留期且删除不可恢复，不建议作为唯一归档介质）。

#### 3.5.2 目录与命名规范
- 按用户分目录：`/archive/{biz_user_id}/year/month/`
- 文件命名：`{分析类型}_{商品范围}_{时间}_{任务ID}.xlsx/md`
- 索引关联：文件归档后，将路径、大小、时间写入 Node 后端历史分析索引

#### 3.5.3 生命周期与成本
- 报告自生成之日起标准存储 30 天，到期自动删除，同步清理索引
- 容量测算：单份报告约 200KB，1000 用户日均 1 份，30 天留存总量约 6GB；OSS 存储单价以官方 OSS 定价为准

---

## 四、接口与事件规范
### 4.1 平台侧核心 API 清单（Node 后端调用）
基地址：`https://{workspace_id}.cn-beijing.maas.aliyuncs.com/api/v1/agentstudio`

| 类别 | 接口 | 用途 |
|---|---|---|
| Agent | `POST /agents`、`GET /agents/{id}`、`PATCH /agents/{id}`、`POST /agents/{id}/archive` | 创建/查询/更新/归档 Agent（模型、system、tools、mcp_servers、skills） |
| Environment | `POST /environments`、`GET /environments/{id}`、`PATCH /environments/{id}`、`DELETE /environments/{id}` | 创建/查询/更新/删除云端沙箱环境 |
| Session | `POST /sessions`、`GET /sessions/{id}`、`GET /sessions`、`PATCH /sessions/{id}`、`DELETE /sessions/{id}`、`POST /sessions/{id}/archive` | 创建/查询/更新/删除/归档会话；创建时绑定 Agent + Environment，可挂载 files（resources） |
| 事件写入 | `POST /sessions/{id}/events` | 提交用户消息、工具审批、中断（异步入队） |
| 事件流 | `GET /sessions/{id}/events/stream` | 订阅 SSE 事件流（`event_deltas[]` 可开启文本增量） |
| 事件历史 | `GET /sessions/{id}/events` | 分页查询历史事件（`types` / `order` / `limit` / `page`），断线补偿 |
| 资源挂载 | `POST /sessions/{id}/resources` | 运行时追加挂载 / 卸载文件 |
| Files | `POST /files`、`GET /files/{id}`、`GET /files`、`GET /files/{id}/content`、`DELETE /files/{id}` | 上传/查询元数据/下载产物/删除文件 |
| Skill | `POST /skills`、`GET /skills/{id}`、`DELETE /skills/{id}`、`POST /skills/{id}/versions`、`GET /skills/{id}/versions/{version}`、`GET /skills/{id}/versions/{version}/download` | 上传/查询/删除 Skill 及版本管理、下载 Skill 包 |

### 4.2 SSE 核心事件类型与处理逻辑
> 事件类型以官方「会话事件流（SSE）」文档为准。注意：百炼事件命名与火山 MA（`user.message` / `agent.tool_use` 等）不同，接入层不可照搬字段名。

| 事件类型 | 触发时机 | 处理逻辑 |
|---|---|---|
| `message` | 助手生成文字回复（`role=assistant`）；用户侧消息（`role=user`） | 文字回复增量推送至前端；默认整条完成后下发，需实时增量时用 `event_deltas[]` 开启 delta |
| `tool_call` / `tool_call_output` | 内置工具开始执行 / 执行完成 | 记录日志、前端展示状态；`tool_call_output` 的 `is_error=true` 表示执行失败 |
| `mcp_call` / `mcp_call_output` | MCP 工具开始执行 / 执行完成 | 记录日志、前端展示状态 |
| `tool_approval_request` / `tool_approval_response` | always_ask 审批 | 暂停等待裁决，提交审批后继续 |
| `session_status` | 会话状态变化（running / idle / terminated），携带 `stop_reason` | 按 stop_reason 判断本轮是否真正结束，驱动前端状态机 |
| `error` | 运行期错误 | 错误在顶层 `error.code` / `error.message`，透传、前端提示、告警 |

`session_status` 事件（及 `GET /sessions/{session_id}`）携带 `stop_reason`，仅在会话 `idle` 时用于判断交互状态：
- `null`：会话刚创建、尚未处理，可发送普通消息
- `end_turn`：模型主动结束本轮，可发送普通消息
- `retries_exhausted`：重试耗尽，本轮结束，可发送普通消息（**不要当作永久禁聊**）
- `requires_action`：存在待裁决的 always_ask 审批，携带 `pending_batch_id` / `pending_call_ids`，**不能直接发普通消息**，需提交审批或 `interrupt`

> 判断「能否继续对话」应看 `stop_reason` 是否为 `requires_action`，而非仅看会话是否 `idle`。

---

## 五、可靠性与异常处理
### 5.1 核心异常场景与处理
| 异常场景 | 触发原因 | 处理策略 |
|---|---|---|
| 取数鉴权失败 | 用户凭据过期、权限变更 | 返回鉴权失败提示，引导重新认证；同步更新 Node 后端凭据 |
| 取数执行失败 | 接口超时、参数错误、数据为空 | 返回明确错误话术；数据为空给出空值说明 |
| 规则加载失败 | 业务侧规则接口不可用、版本不兼容 | 重试后仍失败则返回明确错误提示，引导稍后重试 |
| 数据量超限 | 单次分析数据超过 10MB | 提示缩小查询范围，分批分析，避免沙箱内存溢出 |
| 沙箱执行超时 | 分析任务耗时过长 | 中断任务，返回已完成部分结论，支持重新发起 |
| SSE 连接断开 | 网络波动、代理超时 | 自动重连 + 事件历史分页补偿（`GET /events`），不丢事件 |
| 模型调用失败 | 限流、服务异常 | 重试 1 次，仍失败返回友好提示并告警 |
| 文件归档失败 | OSS 写入异常、权限不足 | 先写沙箱本地临时目录，后台重试归档，记录告警 |

### 5.2 重试与幂等
- 取数接口指数退避重试 3 次；规则加载重试 2 次；模型调用重试 1 次
- 分析任务携带唯一 `request_id`，重复调用不重复生成文件、不重复计费
- 事件历史在服务端持久化，断连后可按事件游标续读，不重复推送

---

## 六、安全与合规
### 6.1 凭据安全
- 一期：凭据按用户隔离，不向前端暴露，日志 / 事件流不打印完整凭据
- 一期凭据仅存 Node 后端，定期轮换并留存审计
- 二期（密钥库）：一用户一凭据（库），能力与读写语义以官方 API 为准，迁移前完成 POC 验证
- 最小权限原则：仅注入业务接口调用所必需的凭据

### 6.2 数据安全
- 业务原始数据仅在沙箱内存中处理，不持久化到本地存储，任务结束即释放
- 用户元数据仅存配置与文件索引，不存原始业务明细与规则数据
- 自有 OSS 归档支持服务端加密、访问权限受控、30 天自动清理
- 不同用户会话、沙箱、资源完全隔离，数据不互通

### 6.3 审计追溯
- 所有 Skill/MCP 调用、文件生成、任务执行均有完整会话事件日志
- 支持按 `session_id`、`biz_user_id` 追溯完整执行链路与操作记录
- 规则更新、凭据更新均留存操作日志，可审计

---

## 七、成本与资源治理
### 7.1 1000 人规模月度成本估算（参考）
| 计费项 | 测算假设 | 月度预估 |
|---|---|---|
| 会话运行时费 | 0.5 元/小时，人均日 2 次、单次 5 分钟 running | 约 2500 元 |
| 模型调用费 | 按 qwen 系列模型 token 单价（如 qwen-plus 输入 0.004 元/千、输出 0.012 元/千），单次合计约 10k token | 约数百元（以官方模型定价为准） |
| 工具 / MCP 调用费 | 按实际工具/MCP 标准，单独计费 | 待实测 |
| 自有 OSS 归档 | 30 天留存约 6GB | 约数元（以 OSS 定价为准） |
| **总计** | - | **约 3000 元/月量级（待实测）** |

> 说明：沙箱费用按 0.5 元/小时 × 1000 人 × 2 次/日 × 5 分钟 ≈ 83 元/日 × 30 ≈ 2500 元/月；商业化为 2026-08-17 起，赠送 10 小时运行时额度。模型/工具/MCP 单价以官方定价为准。

### 7.2 成本优化策略
1.  **模型分层**：简单查询用轻量模型，复杂深度分析用 qwen3-max 等
2.  **及时终止**：Session 处于 running 即计费，任务结束及时让会话回到 idle / 终止不再使用的会话
3.  **任务优化**：减少空转，预处理与规则计算尽量收敛在 Skill/MCP 内
4.  **规则加载优化**：规则接口侧配置缓存/压缩，一期保持实时拉取以保证热更新即时性
5.  **存储精简**：报告文件控制大小，30 天自动清理

### 7.3 资源生命周期管理
- **用户维度**：离职/失效时同步清理会话、用户元数据（二期含凭据）
- **会话维度**：长期闲置会话及时归档或删除，避免无效运行成本
- **文件维度**：OSS 配置 30 天生命周期，到期自动删除并同步清理索引
- **规则维度**：业务侧配置源保留最近 3 版，历史版本定期清理

---

## 八、运维与可观测性
### 8.1 日志体系
- 会话事件日志：平台原生完整事件流，用于全链路排查
- Skill/MCP 执行日志：沙箱内标准输出 / MCP 服务日志
- 接入层日志：Node 后端请求、SSE 连接、重连、错误、规则加载日志

### 8.2 核心监控指标
- 业务指标：在线会话数、日任务量、任务成功率、平均响应时长
- 资源指标：会话运行时长、Token 消耗、文件生成量、OSS 用量
- 异常指标：错误率、SSE 重连次数、Skill/MCP 失败率、鉴权失败率
- 规则指标：规则更新频率、加载成功率、版本分布

### 8.3 排障路径
1.  按 `session_id` 拉取完整会话事件流，定位失败节点
2.  查看对应 Skill/MCP 执行日志，定位代码/参数/接口问题
3.  核对 Environment、Files 挂载与权限配置，以及凭据注入
4.  核查模型调用与限流情况
5.  规则异常时核对业务侧规则配置源的版本与内容

---

## 九、方案落地实施建议
1.  **一期优先落地核心链路**：会话管理 + 取数能力 + 规则热更新（业务侧配置源实时拉取）+ 报告生成，验证主流程通畅
2.  **一期已定且需 POC 验证**：凭据由 Node 后端持有、取数经 MCP / 回调完成；Files 产物保留期（30 天）与挂载路径前缀（`/mnt/session/uploads`）已按官方文档核实，上线前再以 POC 复核
3.  **二期扩展能力**：密钥库 / 凭据托管、精细化权限、历史查询与归档管理
4.  **灰度验证**：先小范围用户试点，验证性能、成本、稳定性后全量推广


## 参考文档（阿里云百炼官方）
- [Managed Agents 产品简介](https://help.aliyun.com/zh/model-studio/managed-agents-introduction)
- [API 总览与认证](https://help.aliyun.com/zh/model-studio/managed-agents-api-overview)
- [Managed Agents API 快速开始](https://help.aliyun.com/zh/model-studio/managed-agents-quickstart)
- [发起会话](https://help.aliyun.com/zh/model-studio/managed-agents-session-event)
- [管理会话（状态机 / 审批 / 中断）](https://help.aliyun.com/zh/model-studio/managed-agents-session-operations)
- [会话事件流（SSE）](https://help.aliyun.com/zh/model-studio/managed-agents-event-stream)
- [列出 Event](https://help.aliyun.com/zh/model-studio/event-list)
- [创建 Agent](https://help.aliyun.com/zh/model-studio/agent-create)
- [Agent Skills](https://help.aliyun.com/zh/model-studio/managed-agents-skill)
- [云端托管环境](https://help.aliyun.com/zh/model-studio/managed-agents-configure-environment)
- [文件上传与挂载](https://help.aliyun.com/zh/model-studio/managed-agents-file)
- [文件 API](https://help.aliyun.com/zh/model-studio/files-api/)
- [Managed Agents 计费说明](https://help.aliyun.com/zh/model-studio/managed-agents-billing)
