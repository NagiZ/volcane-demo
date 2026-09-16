# 火山引擎 Managed Agents 商品异常分析Agent 技术方案
> **版本**：V1.6（评审修订稿）
> **V1.3 修订**：① **一期不做分析（规则执行引擎）Skill**，诊断分析能力整体后移二期；一期链路为「指令理解 → leyosys 取数 Skill（鉴权/接口选择已在 Skill 内闭环）→ 结果对话/文件交付」。② **明确多 Skill 大数据传递机制（见 3.1.3）**：同会话多 Skill 的沙箱本地文件系统不互通、也不能编程互调；大数据经**会话共享目录约定路径**中转——取数 Skill 写共享目录、返回值带路径，Agent 将路径作为显式入参传给分析 Skill，分析 Skill 定义路径入参读文件，数据本身不过模型上下文。
> **V1.4 修订**：① 完善 `business_agent_session` 支持「会话升级只读」——新增 `biz_status=2`、`skill_version`、`frozen_reason`、`frozen_at`；② 新增 `agent_event_log` 会话事件流水表，逐事件落库保存消息与工具调用，用于评估/审计。
> **V1.5 修订**：接入层由 Node.js 自研后端改为 **Java 自研后端（火山官方 `ark-runtime` SDK）**；新增 4.0「Java SDK（ark-runtime）对接说明」，并将全文「Node 后端」统一替换为「Java 后端」（Skill 内部的 `Node 子进程` 描述保留，指既有 Skill 实现细节）。
> **V1.6 修订**：技术方案平台解耦。① 对外只暴露业务接口，隐藏平台概念；② 接入层引入 `AgentPlatform` 防腐层，火山为首个实现，预留百炼/腾讯 ADP；③ 四张表加 `platform`/`platform_config`/`config_snapshot`，主键改 UUID，`tool_fee` 单列；④ 移除 Vault/凭据库，统一为「创建会话时注入环境变量」管控 token；⑤ 新增三平台事件映射与规范事件枚举。
> **更新说明**：V1.1 修订：① 一期鉴权改用会话环境变量注入，Vault 调整为二期进阶方案（需同步改造 leyosys/Skill）；② Memory Store 改为每用户独立单库，全局规则改由业务侧配置源实时拉取；③ 修正 SSE 事件语义（custom_tool 前缀、requires_action、file/error 事件），补充单会话并发限制与成本假设出处。仍保留：leyosys 用户级鉴权、规则全量热更新不中断会话、报告法定留存 30 天、单次单用户数据≤10MB、约 1000 名内部用户。
> **V1.2 修订**：新增 3.7 数据表结构设计（`business_user_agent_binding` / `business_agent_session` / `agent_call_log` / `agent_report_file` 四张表）；历史分析文件索引由 Memory Store 迁至 `agent_report_file` 表，Memory Store 仅保留用户偏好与权限标识。
> **方案边界**：本方案仅覆盖火山引擎 Managed Agents 平台侧的对接设计、Agent 配置、Skill 集成、资源管理、会话与事件处理，不包含 leyosys 业务系统本身、业务规则引擎的后端开发与运维。

---

## 怎么读本文档

- **先看「待确认项清单」**：P0 决定编码前必须敲定，P1/P2/P3 不影响主线通读。
- **再读「二、整体架构与核心链路」**建立全局；实现细节看三、四，可靠/安全/成本/运维按需看五~八，落地节奏看九。
- **阶段约定**：正文以「一期 / 二期」标注交付阶段；架构图中虚线表示二期能力。

## 待确认项清单（评审决策用 · 先读）
> 每项按「设计目的（解决什么问题）→ 为何待确认 → 需确认的因素」列出。**P0 不定不编码；P1 不挡编码、上线前必须验完；P2 为内部业务/商务确认，不阻塞技术开发；P3 属二期。**

### P0：编码前必须确定

#### P0-1 一期取数结果文件是否需要 30 天留存（决定挂不挂私有 TOS）
- **设计目的**：私有 TOS 方案要解决的问题只有一个——文件在沙箱回收/平台默认存储 7 天删除之后仍可下载，满足 30 天留存与历史追溯。
- **为何待确认**：30 天的依据是「分析报告法定留存」，一期不做分析、产物是取数结果 Excel，该留存要求是否适用于取数文件尚未经合规确认；这直接决定一期要不要挂 TOS。
- **需确认的因素**：
  1. 合规/法务：取数结果文件是否属于法定留存范围、留存多久；
  2. 业务方：即便不法定，是否仍要求 N 天历史回溯下载，N 取多少；
  3. 结论为「7 天内即可」→ 用平台默认存储（产物发现链路已确认：写 `/mnt/session/outputs`、`GET /files` 带 `purpose=agent`，见 4.2），砍掉桶挂载/归档/清理任务；结论为「需 30 天」→ 保留 3.5 方案，并补验挂载 TOS 目录是否同样注册到 Files API（若否则 Java 后端直接列举桶对象取 `oss_path`）。

#### P0-2 同一 Session 并发请求的处理策略
- **设计目的**：平台约束同一 Session 不能并发处理两条消息，后端必须决定用户在上一任务未结束时再发消息怎么办，防止平台报错或请求互相覆盖（3.2.1）。
- **为何待确认**：「排队」与「拒绝」对应两套完全不同的 Java 实现（队列+状态机+超时通知 vs 前置状态校验直接返回）和前端交互，属产品决策，不能由开发自行选择。
- **需确认的因素**：
  1. 产品取舍：排队等待（队列长度、排队超时、前端提示）还是直接拒绝（"上一任务进行中"）；
  2. 是否允许为同用户创建临时独立会话做并行分析（上下文不复用的代价是否接受）；
  3. 并发状态的落点：`business_agent_session.platform_status` + 行锁，还是 Redis 锁。

### P1：不挡编码，上线前必须验证（字段/事件映射级）

#### P1-1 `span.model_request_end` 的 usage / request_id 字段结构与累加口径
- **设计目的**：一轮任务含 N 次模型请求，Java 后端需把 N 份 usage 累加为一行汇总落 `agent_call_log`，用于成本回算与账单对账（3.7.0）。
- **为何待确认**：事件名称与「一轮 N 次、成对下发」已由实测确认，但事件体内 usage、request_id 的**准确字段名与层级**未以官方文档逐字核实（外网受限）；属映射层风险，不影响表结构。
- **需确认的因素**：
  1. usage 四字段的准确名称/层级（input/output/cache_read/cache_creation）；
  2. request_id 字段位置，确认其确为单次模型请求粒度（不落库、仅对账回查）；
  3. N 次累加的边界（以哪些事件界定一轮）。

#### P1-2 官方会话事件类型清单复核
- **设计目的**：事件解析、任务收口（只认真正的 `session.status_idle`，`requires_action` 不算结束）、工具计数与错误归一化（4.2）。
- **为何待确认**：当前事件名与语义来自调研项目实测记录，非官方文档原文，需在编码对接前以官方「会话事件类型」文档逐字复核。
- **需确认的因素**：custom tool 事件前缀、`requires_action` 语义与续跑方式、error 事件的归一化口径。

### P2：内部业务/商务确认（不阻塞开发）

#### P2-1 `agent_call_log` 审计保留周期
- **设计目的**：确定审计表按月分区/归档策略与存储容量（3.7.6）。
- **为何待确认**：保留周期取决于财务对账与合规要求，技术侧不能自定。
- **需确认的因素**：保留月数（建议 ≥90 天）、是否按月分区、归档介质与查询方式。

#### P2-2 成本单价核对
- **设计目的**：7.1 月度成本测算作为立项/采购输入，数字不能是臆测值。
- **为何待确认**：TOS（0.0015 元/GB/时）、模型 token、沙箱（0.5 元/时）单价均需以官方价目页/购买页为准。
- **需确认的因素**：三项官方现价、缓存 token 折扣单价、ArkClaw 席位当期报价与最低 5 席规则。

#### P2-3 超时阈值取值与「超时」口径统一
- **设计目的**：既避免异常长任务空耗沙箱，又不误杀正常的长耗时分析。
- **为何待确认**：已明确**等待 Agent 事件不设总超时、SSE 靠断点续传**；但 3.1.1「合理超时阈值」、5.1「超出运行阈值中断任务」措辞含糊，开发可能误加任务级总超时；取数分页的单次 HTTP 超时值也缺数据支撑。
- **需确认的因素**：
  1. leyosys 接口 P95/P99 响应时间 → 单次分页 HTTP 超时取值；
  2. 分页页数/数据量上限（与 ≤10MB、超限提示联动）；
  3. 是否保留任务级软超时（只告警/可中断，而非连接层硬超时），并据此统一 3.1.1、5.1 文字。

### P3：二期 POC（不挡一期）
1. 会话共享目录的挂载形态，以及接近 10MB 单文件的读写实测（3.1.3）；
2. 会话级环境变量注入在百炼/腾讯的等价能力（3.4.1 待验）。

---

## 一、项目概述
### 1.1 背景与目标
基于火山引擎 Managed Agents 构建商品异常分析智能 Agent，复用已开发完成的 leyosys 沙箱自定义取数能力，结合可动态调整的业务分析规则，自动完成多维度商品异常诊断，输出结构化处理决策建议与分析报告，支撑业务人员高效定位问题、制定处置策略。

核心建设目标：
1.  复用 leyosys 自定义 Skill，按用户维度鉴权调用业务接口，实现多源数据自动拉取与整合（鉴权、接口选择均在 Skill 内闭环）——**一期**
2.  取数结果分层交付：对话呈现 + 结构化结果文件，文件留存 30 天——**一期**；异常诊断、规则匹配与业务分析规则热更新（规则调整无需重建沙箱、无需中断会话）——**二期**
3.  支撑约 1000 名内部业务用户稳定使用，单次单用户原始数据量≤10MB

### 1.2 建设范围
- ✅ 一期（本版落地）：Agent 编排设计、**leyosys 取数 Skill 集成（鉴权、接口选择、取数均已在 Skill 内实现）**、取数结果对话/文件交付、会话管理、每用户独立 Memory Store 设计、创建会话时直接注入用户凭据环境变量、文件归档存储、SSE 事件对接、成本与运维设计。**一期不含分析/规则引擎 Skill**
- ⏭️ 二期（进阶）：**分析（规则执行引擎）Skill 与规则配置源热更新**（多 Skill 大数据按 3.1.3 会话共享目录模式接入）
- ❌ 不包含：leyosys 业务系统开发、业务规则逻辑本身的研发、前端页面开发、业务侧后端服务

### 1.3 用户与使用模式
- 目标用户：约 1000 名内部业务运营/分析人员
- 触发方式：用户主动发送分析指令触发任务
- 交互形态：单轮完整分析 + 多轮追问细化（如调整维度、重算、补充说明）
- 鉴权粒度：leyosys 业务接口为**用户级独立鉴权**，每个用户凭据隔离；通过创建会话时注入环境变量承载用户 token
- 数据规模：单次单用户分析原始数据量≤10MB，沙箱内内存处理，不落地持久化

### 1.4 核心交付产物
1.  **一期**：取数结果对话呈现（数据摘要/明细）+ 结构化结果文件（Excel 等），私有 TOS 归档，留存 30 天，可历史追溯
2.  **二期**：对话式文字分析结论（异常类型、原因判断、处理建议、依据说明）与结构化分析报告文件（Markdown / Excel）

### 1.5 平台环境与版本说明
1. 本方案按**平台无关核心 + 平台适配器**组织：对外接口、表结构、防腐层、规范事件与火山/百炼/腾讯三家无关；火山方舟 Managed Agents 为首个实现，通过 `AgentPlatform` 适配器接入。
2. 平台兼容范围：火山方舟（含 ArkClaw 企业版）、阿里百炼 Managed Agents、腾讯云 ADP；本方案一期只落地火山，百炼/腾讯保留映射占位与 POC 待验项。
3. 本方案默认按最低兼容路径设计，确保快速上线；ArkClaw 企业版环境下可额外启用原生规则文件、企业级资源管控等增强能力，作为可选优化项。
---

## 二、整体架构与核心链路
### 2.1 总体架构分层
| 层级 | 说明 | 本方案范围 |
|---|---|---|
| 用户交互层 | 前端对话入口、文件下载与历史查询 | 不涉及 |
| 接入转发层 | Java 自研后端 + `AgentPlatform` 防腐层，负责用户鉴权、对外业务接口、事件透传、资源管理 | 仅涉及 MA 对接相关逻辑 |
| **MA 平台层（核心）** | 托管 Agent 平台（火山为首个实现，预留百炼/腾讯 ADP） | ✅ 本方案全覆盖 |
| 业务依赖层 | leyosys 业务系统接口、业务规则配置源 | 不涉及，仅定义对接契约 |

MA 平台层内部拆解：
- **Agent 调度层**：大模型推理、指令解析、多 Skill 编排调度、结果整合
- **Skill 执行层**：leyosys 取数 Skill、规则执行引擎 Skill、内置文件生成能力
- **基础资源层**：沙箱运行环境、平台记忆/知识（火山 Memory Store 等，按平台能力映射）、产物归档存储（火山私有 TOS 等）

**架构总览（组件与数据流视图）：**

```mermaid
flowchart TB
    subgraph L1["用户交互层（本方案不涉及）"]
        FE["前端对话入口<br/>文件下载 / 历史查询"]
    end

    subgraph L2["接入转发层（仅涉及 MA 对接逻辑）"]
        JAVA["Java 自研后端<br/>AgentPlatform 防腐层<br/>用户鉴权 · 对外业务接口<br/>事件透传 · 资源管理"]
    end

    subgraph L3["MA 平台层（火山 Managed Agents，核心）"]
        subgraph L3A["Agent 调度层"]
            LLM["大模型<br/>指令解析 · Skill 编排 · 结果整合"]
        end
        subgraph SBX["沙箱运行环境"]
            subgraph L3B["Skill 执行层"]
                S1["leyosys 取数 Skill（一期）"]
                S2["规则执行引擎 Skill（二期）"]
                FGEN["内置文件生成能力"]
            end
        end
        subgraph L3C["基础资源层（随会话挂载）"]
            MS[("Memory Store<br/>每用户一库<br/>偏好 + 权限标识")]
            TOS[("私有 TOS 归档<br/>30 天留存")]
        end
    end

    subgraph L4["业务依赖层（本方案不涉及，仅定义契约）"]
        LEY["leyosys 业务系统接口<br/>用户级鉴权"]
        RULE["业务规则配置源（二期）"]
    end

    DB[("MySQL<br/>binding / session<br/>call_log / report_file")]

    FE <-->|"SSE / HTTP"| JAVA
    JAVA -->|"创建会话 / 发送事件<br/>SSE 事件流"| LLM
    JAVA -->|"读写用户偏好与权限"| MS
    JAVA -->|"资源绑定 / 会话<br/>审计 / 文件索引"| DB
    JAVA -->|"文件下载链接"| TOS
    LLM -->|"编排调用"| S1
    LLM -->|"二期：data_path 入参"| S2
    LLM -->|"生成结果文件"| FGEN

    S1 -->|"HTTP 取数<br/>（会话环境变量凭据）"| LEY
    S2 -->|"拉取最新规则"| RULE
    FGEN -->|"写 /mnt/session/outputs"| TOS

    S1 -.->|"二期：会话共享目录<br/>写文件 + 返回路径"| S2
```

### 2.2 核心 Skill 分工与职责边界
| Skill 名称 | 形态 | 职责 | 输入 | 输出 |
|---|---|---|---|---|
| leyosys 取数 Skill | 沙箱内自定义 Skill（已开发完成，**一期**） | Skill 内部完成鉴权与接口选择，拉取商品数据并按用户隔离 | Agent 提取的业务查询参数（商品范围、时间维度等） | 一期：结构化结果回传 Agent + 结果文件导出；二期对接分析 Skill 时：大结果写会话共享目录、返回路径（见 3.1.3）。单用户单次≤10MB |
| 规则执行引擎 Skill（分析 Skill） | 沙箱内自定义 Skill（**二期**，一期不建设） | 加载最新业务规则，执行规则匹配、异常分级、根因诊断 | **入参为取数 Skill 写入共享目录的文件路径**（显式 path 入参）+ 动态规则数据 | 异常诊断结论、根因判断、决策建议、依据明细 |
| Agent 主模型 | 平台内置大模型 | 指令理解、参数提取、Skill 调度、结果整合、多轮对话；多 Skill 时传递共享目录路径 | 用户自然语言指令 | 最终文字回复、文件生成指令 |

> **Skill 形态说明**：leyosys 取数 Skill（一期）与规则执行引擎 Skill（二期）均按**沙箱内自定义 Skill**实现，Skill 在沙箱内直接发起 HTTP 请求（取数调 leyosys 接口、规则调业务侧规则接口），不采用 custom_tool 回调 Java 后端的链路。若后续改为回调 Java 后端执行，需切换为 `agent.custom_tool_use` + `requires_action` 事件流。

### 2.3 完整执行主流程
1.  用户发送自然语言分析指令（指定商品范围、时间、异常类型等）
2.  Java 后端校验用户身份，查询对应用户的会话与资源绑定关系
3.  Agent 解析指令，提取结构化查询参数
4.  **【一期】** 调度 leyosys 取数 Skill（Skill 内自行鉴权、选接口），使用当前用户独立凭据拉取对应维度的商品数据（≤10MB，内存处理；大结果导出文件）
5.  **【二期，一期不执行】** 取数 Skill 将数据写入会话共享目录约定路径并返回路径（见 3.1.3）；Agent 把路径作为显式入参调度规则执行引擎 Skill，Skill 读文件、从业务侧规则配置源拉取全量最新规则（内存处理），执行异常诊断
6.  Agent 整合结果生成自然语言文字回复：一期为取数结果说明，二期为诊断结论与建议
7.  如需生成文件，调用文件生成能力输出结构化文件至私有 TOS 归档目录
8.  Java 后端异步更新用户偏好至 Memory Store，并将结果文件写入 `agent_report_file` 表
9.  所有中间事件与最终结果通过 SSE 事件流推送至前端
10. 任务结束，会话进入 idle 状态，沙箱停止计费；原始数据随沙箱内存释放，不持久化留存（归档文件除外）

### 2.4 对外业务接口（平台无关，前端只认这一套）
> 原则：对外接口不暴露任何平台概念（session_id、平台 event_type、stop_reason、vault、memory_store 等）。`conversation_id` / `task_id` 均为我方生成的 UUID；接入层负责把我方接口翻译到 `AgentPlatform` 的火山/百炼/腾讯实现。

| 接口 | 说明 |
|---|---|
| `POST /conversations` | 创建（或返回已有）业务会话，返回 `conversation_id` |
| `POST /conversations/{conversation_id}/messages` | 发送用户消息，返回 `task_id`（本轮分析任务） |
| `POST /conversations/{conversation_id}/interrupt` | 中断当前轮 |
| `GET /conversations/{conversation_id}/tasks/{task_id}` | 查询本轮任务状态与用量 |
| `GET /conversations/{conversation_id}/files` | 查询历史产物文件列表 |
| `GET /files/{file_id}/download` | 下载产物文件 |
| `SSE /conversations/{conversation_id}/events` | 推送**我方规范事件**（见 4.3） |

对外 SSE 事件（我方规范事件，与平台无关）：`user_message` / `message` / `tool_call` / `tool_result` / `approval` / `turn_end` / `error`。

---

## 三、核心模块详细设计
### 3.0 平台适配层（AgentPlatform 防腐层，平台无关）
业务逻辑只依赖 `AgentPlatform` 接口，不直接依赖火山/百炼/腾讯 SDK。火山为第一个实现（见 4.0），百炼/腾讯为后续实现。

```java
public interface AgentPlatform {
    PlatformSession createSession(CreateSessionCmd cmd);           // 挂资源、注入环境变量凭据
    PlatformSession getSession(String platformSessionId);
    void deleteSession(String platformSessionId);

    void sendMessage(String platformSessionId, String text);        // 用户消息
    void sendInterrupt(String platformSessionId);
    void submitToolResult(String platformSessionId, String toolCallId, Object result);

    Flowable<NormalizedEvent> streamEvents(String platformSessionId); // 平台事件 → 规范事件
    List<NormalizedEvent> listEvents(String platformSessionId, String afterEventId);

    Usage getUsage(String platformSessionId, String taskId);         // 归一化用量
    List<ArtifactRef> listArtifacts(String platformSessionId);       // 产物发现
    String downloadArtifact(String fileId);                          // 返回下载地址/内容
}
```

关键抽象：
- `PlatformSession`：`platform` + `platformSessionId` + `platformStatus` + `configSnapshot`。
- `NormalizedEvent`：`platform` + `eventType`（我方规范枚举）+ `eventId` + `seq` + `content` + `rawPayload`。
- `Usage`：`inputTokens / outputTokens / cacheReadTokens / cacheCreationTokens / runningDurationMs / toolCallCount / toolFee`。
- `ArtifactRef`：`fileId` + `fileName` + `size` + `url/path`。
- 凭据抽象 `CredentialProvider`：`injectEnv(Map<String,String> env)`（火山环境变量注入型）或 `resolveCredential(userId)`（百炼/腾讯后端持有型）。
- 产物抽象 `ArtifactStore`：`register / list / download / archive`，屏蔽火山 TOS、百炼 Files、腾讯知识库/附件差异。

### 3.1 自定义 Skill 集成设计
#### 3.1.1 leyosys 取数 Skill
- **部署形态**：沙箱内本地运行的自定义 Skill，随沙箱启动加载
- **鉴权方式**：通过创建会话时注入该用户的 leyosys 鉴权凭据（会话级环境变量），Skill 内直接读取环境变量调用业务接口。凭据仅在会话创建时注入、运行期不可变，凭据轮换时由后端重建会话加载新凭据
- **数据处理策略**：
  - 单次单用户原始数据量≤10MB，沙箱内存可承载，数据全程在内存中流转处理
  - 不写入沙箱本地持久化文件，避免 IO 开销与数据残留
  - 任务结束后数据随上下文释放，沙箱销毁后完全清除，符合数据安全要求
- **用户隔离**：不同用户会话注入各自的环境变量凭据，沙箱与会话完全隔离，无交叉访问风险
- **超时配置**：配置合理超时阈值，避免长耗时接口占用沙箱时长
- **错误约定**：标准化错误码与错误信息，Agent 可根据错误类型给出对应话术

#### 3.1.2 分析规则热更新设计（**二期，随分析 Skill 一起上线；一期不建设**）
##### 设计原则：执行器与规则数据解耦，全量热更新不中断会话
- **规则执行引擎 Skill**：作为稳定的执行器本体，封装规则解析、匹配、计算逻辑，版本迭代频率低
- **规则数据**：独立于 Skill 包，由业务侧集中维护与更新，业务调整即时生效

##### 规则存储与加载方案
采用 **业务侧规则配置源实时拉取** 方案（规则不存 Memory Store），兼顾热更新与每用户库隔离：
1.  **存储位置**：规则数据独立于 Skill 包，由业务侧规则配置源统一维护版本，不写入 Memory Store
2.  **加载方式**：规则执行引擎 Skill 每次执行时，直接调用业务侧规则接口拉取最新全量规则（内存处理，不落地）
3.  **生效时机**：**无需重建沙箱、无需中断在线会话**，每次执行拉最新，全量用户即时生效
4.  **版本管理**：规则带版本号，业务侧保留最近 3 个历史版本；回滚在业务侧配置源完成，Skill 下次执行自然拉取回滚后版本
5.  **降级兜底**：规则接口加载异常时，按 5.1 重试；仍失败则返回明确错误提示，引导用户稍后重试，避免用错误规则产出结论

#### 3.1.3 Skill 间协作机制（一期单 Skill；多 Skill 大数据走会话共享目录）

**一期**：只上线 leyosys 取数 Skill，无 Skill 间数据传递；Agent 提取参数 → 调取数 Skill → 结果对话交付/文件导出。

> **二期接入分析 Skill 时的大数据传递机制（已确认）**：
>
> 1. **约束**：同会话多 Skill 之间**不能直接跨沙箱共享本地文件**（各自执行环境的本地文件系统不互通），也不能编程互调，只能由 Agent 编排；
> 2. **禁止**：把完整结果集放进工具返回值经模型上下文传递——10MB 量级（数百万 token）物理上无法过模型；
> 3. **机制：会话共享目录 + 路径参数**：
>    1. 取数 Skill 把结果写入**会话共享目录**的约定路径（如 `/{shared_root}/{task_id}/raw_{接口标识}.{jsonl|xlsx}`，`task_id` 由取数 Skill 自行生成（如 uuid），路径规范在 Skill 契约中固化，格式与分析 Skill 的读取契约对齐）
>    2. 取数 Skill 的返回值只放小载荷：**路径 + 行数/字段/字节数/摘要**
>    3. Agent 取到该路径后，将其作为**显式入参**传给分析 Skill；**分析 Skill 必须定义路径入参（如 `data_path`）来接收并读文件**，不得自行扫目录或猜路径
>    4. 分析 Skill 读文件后在其进程内完成诊断，只把结论返回给 Agent，数据不进模型上下文
> 4. **安全**：路径由 Skill 生成、不由用户输入决定；分析 Skill 对入参路径做前缀校验（必须在共享目录约定前缀内），防路径穿越
> 5. **生命周期**：共享目录文件随会话沙箱生命周期，**不作长期留存**；需 30 天留存的报告/结果另行导出至 TOS（见 3.5），二者职责分开
> 6. **异常**：路径不存在、格式不符或越权 → 分析 Skill 返回标准化错误，由 Agent 重新调取数 Skill 或告知用户；分析 Skill 自身失败则终止诊断，取数文件保留
>
> 【一期不触发】上述机制随二期分析 Skill 验证落地，需 POC 确认会话共享目录的具体挂载形态与单文件大小上限（接近 10MB 的文件实测）。

- 调度模式（二期）：取数 → 路径传递 → 分析，由 Agent 串行编排
- 数据传递：**路径/摘要过模型，完整数据走共享目录文件，不过模型上下文**
- 异常中断：取数失败不再调分析；分析失败则诊断终止，已取数据与归档文件保留

### 3.2 会话管理设计
#### 3.2.1 会话复用策略
- **策略**：**一人一会话（one user one session）**，1000 用户对应约 1000 个常驻 session
- **理由**：
  1.  用户主动触发、多轮追问场景多，复用会话保留上下文，提升交互连贯性
  2.  资源（Memory Store、私有 TOS、会话环境变量）一次挂载/注入，全程生效，避免重复创建开销
  3.  沙箱 30 天无活跃自动回收，闲置用户不产生运行成本
  4.  规则热更新不依赖会话重建，会话长期在线不影响规则生效
- **边界**：同一用户多次分析复用同一会话，不同用户会话完全隔离，数据不互通
- **并发限制**：同一 Session 不支持并发发送两条消息（平台约束）。同一用户并发的分析请求需由后端排队或拒绝（返回"上一任务进行中"），避免第二个请求覆盖或报错；如需并行分析，需为该用户创建临时独立会话，代价是上下文不复用

#### 3.2.2 交互模式
- 支持单轮一次性完整分析
- 支持多轮追问：调整分析维度、细化品类、重新计算、补充说明建议
- 上下文保留在平台会话事件流中，无需业务侧存储

#### 3.2.3 中断机制
- 长耗时分析过程中，支持通过 `user.interrupt` 事件中止当前任务
- 中断仅终止当前执行轮次，不销毁沙箱、不删除会话，后续可继续发起新分析

### 3.3 Memory Store 场景化设计
#### 3.3.1 存储内容清单
| 存储项 | 说明 | 更新方 |
|---|---|---|
| 用户分析偏好 | 常用分析维度、默认时间范围、输出格式偏好、默认品类权限 | Java 后端 |
| 历史分析文件索引 | 已迁至 `agent_report_file` 表（见 3.7.4），Memory Store 不再承载文件索引 | Java 后端 |
| 用户权限标识 | 可访问的商品品类、数据范围权限标记 | Java 后端 |

> **不存储**：原始业务明细数据、完整异常清单、规则执行引擎代码、全局业务规则（规则由业务侧配置源承载，见 3.1.2）

#### 3.3.2 读写策略
- **读权限**：沙箱以 `read_only` 模式挂载对应用户的 Memory Store，Skill 运行时仅读取用户配置与权限标识
- **写权限**：统一由 Java 后端通过 Memory Store API 执行写入/更新，Skill 不具备写权限，避免数据篡改
- **更新时机**：用户配置变更、完成新的分析任务时，由后端异步更新对应用户的库

#### 3.3.3 容量与生命周期
- **方案选择**：**每用户一个独立 Memory Store**（1000 用户对应约 1000 个库），会话创建时以 `resources[]` 挂载对应用户库
- **容量规划**：
  - 单用户库条目数：2~3 条（用户偏好、权限标识等），单条 ≤100KB，远低于单库 2000 条上限
  - 文件索引不再占用 Memory Store 空间（由 `agent_report_file` 表承载）
  - 全局规则不占 Memory Store 空间（由业务侧配置源承载）
- **生命周期**：
  - 用户级数据：随用户账号生命周期，离职/失效用户同步清理
  - 文件索引：已迁至 `agent_report_file` 表，与 TOS 归档文件生命周期同步（30 天），到期同步清理（见 3.7.6）
  - 规则数据：生命周期由业务侧配置源管理（保留最近 3 版），与本库解耦

### 3.4 凭据管理设计（统一：会话环境变量注入 token）
#### 3.4.1 统一方案
- **三平台统一**：创建会话时注入用户 token 到会话环境变量，Skill 沙箱内读取环境变量调用业务接口。token 仅在会话创建时注入、运行期不可变，轮换时重建会话注入新 token。
- **火山**：`CreateSessionRequest.environment.config.env`（`EnvironmentConfigOverride.env`）注入，已由 SDK 源码核实。
- **百炼 / 腾讯**：由各自 `AgentPlatform` 适配器实现等价注入；百炼公开 API 的会话级环境变量注入、腾讯 `CustomVariables`/变量管理的确切用法需 POC 复核。

#### 3.4.2 CredentialProvider 抽象
- **注入型**（火山为主）：适配器把 token 写入 env，随 `createSession` 提交。
- **后端持有型**（百炼/腾讯兜底）：token 不注入沙箱，取数走 MCP/回调，由后端持 token 调业务接口。

#### 3.4.3 安全边界
- token 仅注入当前用户会话环境变量，沙箱与会话隔离；不向前端暴露，日志/事件流不打印完整 token。
- 最小权限：仅注入业务接口调用所必需的 token。

#### 3.4.4 资源绑定关系
- `business_user_agent_binding`：`user_id ↔ platform ↔ 平台资源引用（platform_config）`
- `business_agent_session`：`user_id ↔ platform ↔ platform_session_id`，默认会话以 `is_default=1` 标识

### 3.5 文件30天归档存储设计
#### 3.5.1 存储方案选型
采用**私有火山 TOS 桶挂载**方案，替代默认公共 TOS，满足30天法定留存需求。
- 挂载方式：创建会话时通过 `resources` 挂载归档专用 TOS 桶，映射到沙箱内指定目录
- 写入方式：Skill 生成报告文件直接写入 TOS 挂载目录，自动持久化到对象存储
- 优势：文件生命周期自主可控，不受平台 7 天自动删除限制；支持30天保留策略、访问权限管控

> **是否必须挂私有 TOS（待确认，见「待确认项清单」P0-1）**：本方案的唯一刚性理由是「文件需留存 30 天、可历史下载」，而平台默认产物存储 7 天自动删除、沙箱文件随沙箱回收。30 天的原始依据是**分析报告法定留存**，但一期产物是**取数结果文件**而非分析报告。若合规确认取数文件不适用 30 天留存、业务也不要求长期回溯，则一期直接用平台默认文件链路（Skill 写 `/mnt/session/outputs`，`GET /files` 带 `purpose=agent` 获取，见 4.2，存储期 7 天），取消桶挂载、TOS 归档与清理任务，`agent_report_file` 仅登记平台 file_id；若仍需 30 天，则保留本方案，但需补验挂载 TOS 目录是否同样注册到 Files API（若否则 Java 后端直接列举桶对象获取 `oss_path`）。

#### 3.5.2 目录与命名规范
- 按用户分目录：`/archive/{user_id}/year/month/`
- 文件命名：`{分析类型}_{商品范围}_{时间}_{任务ID}.xlsx/md`
- 索引关联：文件生成后，将路径、大小、时间写入 `agent_report_file` 表，支持前端查询与下载

#### 3.5.3 生命周期与成本
- 存储单价：**0.0015 元/GB/小时**（约 1.08 元/GB/月）
- 保留策略：报告文件自生成之日起**标准存储30天**，到期自动删除
- 索引同步：文件到期删除时，同步更新 `agent_report_file.status=1`
- 容量测算：单份报告约 200KB，1000 用户日均 1 份，30天留存总量约 6GB

### 3.6 规则内聚与功能解耦设计
#### 3.6.1 核心设计原则
严守两条设计红线：
1. **不修改 Agent 原始主提示词**：主提示词仅保留角色定位、行为边界与工具调用总原则，不写入具体业务规则、判定标准与映射逻辑，保持长期稳定。
2. **不篡改用户原始输入**：用户自然语言输入原样透传，不在后端强行拼接参数或补充内部信息，保证对话历史一致性。

所有业务规则、执行逻辑、实体映射能力全部下沉至自定义 Skill 层，兼顾保密性与独立迭代能力。

#### 3.6.2 规则分层承载
按规则性质分层落地，兼顾保密、稳定与灵活性：

| 规则层级 | 承载形态 | 更新方式 | 迭代频率 |
|---|---|---|---|
| 框架层（行为边界、输出总规范） | 极简系统主提示词 | Agent 配置变更 | 极低 |
| 执行层（分析流程、判定逻辑、方法论） | 分析引擎自定义 Skill | Skill 包版本发布 | 中 |
| 数据层（阈值、分级标准、商品映射） | Skill 内部配置 / Memory Store 加密存储 | Skill 内更新 / API 热更新 | 高 |

核心业务规则全部内聚于 Skill 内部，控制台仅可见 Skill 名称与功能描述，满足高保密要求。

#### 3.6.3 功能解耦与工具拆分
按单一职责原则拆分，功能边界清晰，独立迭代、可复用：
- **leyosys 取数 Skill（一期）**：业务接口数据拉取，鉴权/接口选择在 Skill 内闭环，按用户隔离
- **报告/结果文件生成（一期）**：结构化结果文件输出、格式转换
- **商品信息标准化工具（二期可拆）**：商品名称/别名转标准编码、属性映射与权限校验，基础能力复用
- **分析引擎 Skill（二期）**：规则加载、异常诊断、决策生成，核心业务逻辑唯一承载点；经会话共享目录 `data_path` 入参接收取数结果（见 3.1.3）

二期工具间采用模型统一编排、串行调度模式，**大数据走共享目录文件、路径过模型**，职责边界清晰。

#### 3.6.4 工具调用管控机制
采用「模型自主调度 + 后端边界约束 + Skill 入口校验」三层机制，既保留 Agent 原生编排能力，又确保分析类任务 100% 触发工具。
1. **后端动态边界约束**：所有工具提前注入 Agent 自定义工具列表，由 Agent 自主识别意图、选择工具。后端仅做粗粒度意图分类，通过 `tool_choice` 参数划定边界：分析类请求设为 `required`（强制调用工具，禁止直接回答）；非分析类请求设为 `auto`（模型自主）。
2. **Skill 入口合法性校验**：所有业务工具入口做参数与权限校验，校验不通过返回标准化错误，禁止跳过执行。
3. **后端事件流观测兜底**：SSE 层观测本轮工具调用事件（平台成对稳定下发，见 3.7.0）；若分析类请求至 idle 仍无工具调用记录，**不自动重发消息**（Java 后端不去重、不替用户重入，重复执行由 Agent 侧承担，见 5.2），仅记录异常并提示用户重试，避免重复取数、重复计费与重复产物。

#### 3.6.5 分阶段落地
1. **一期（快速上线）**：只建取数链路——leyosys 取数 Skill（已就绪）+ 结果对话/文件交付 + 会话/凭据/Memory Store/TOS 对接，最小开发量跑通全链路。
2. **二期（分析能力）**：建设分析引擎 Skill 与规则配置源，按 3.1.3 会话共享目录模式接入取数结果；商品标准化等基础能力按需拆出。
3. **三期（动态优化）**：高频规则抽离至 Memory Store 加密存储，支持热更新。

### 3.7 数据表结构设计（平台无关 · V1.6 修订）
> 设计口径：
> 1. 四张表均带 `platform`（volcano / bailian / tencent_adp）；稳定通用字段做实体列，平台特有字段进 `platform_config JSON`。
> 2. 对外业务主键用 UUID（`conversation_id` / `task_id` / `file_id`），DB 内部保留 `id BIGINT AUTO_INCREMENT` 做 join；平台侧标识存 `platform_*` 列或 JSON。
> 3. `config_snapshot` 为结构化快照（我方配置 hash 为主 + 平台版本辅助），用于会话升级只读判定，见 3.7.2。
> 4. 审计表只存统计维度，不存消息正文、业务明细、规则内容；事件流水逐事件落库。
> 5. 时间统一 `DATETIME(3)`。

#### 3.7.0 字段数据来源核对（火山为首个实现，百炼/腾讯映射见 4.3）
| 字段 | 数据来源 | 火山是否直接提供 | 说明 |
|---|---|---|---|
| platform_session_id | `POST /sessions` 返回的 `id` | ✅ 直接返回 | 4.1 已确认 |
| platform_status / stop_reason | `session.status_*` 事件（idle / running / terminated + stop_reason） | ✅ 直接返回 | 4.2 已确认 |
| config_snapshot | 我方配置 hash 为主 + 平台版本辅助 | ✅（火山 agent_version 已确认） | 会话创建时确定并落 `config_snapshot`；百炼/腾讯的版本字段待 POC 复核，兜底用我方自管 config 版本 |
| tool_call_count | 事件流中的工具调用事件（`agent.tool_use` / `agent.mcp_tool_use` / `agent.custom_tool_use`） | ✅ 直接返回（已确认） | 平台**逐次、稳定、成对下发**，每次工具调用有明确事件与唯一 ID，不丢失、不合并；Java 后端按本轮事件对计数，只落本轮汇总数，不存工具明细 |
| input_tokens / output_tokens / cache_read_tokens / cache_creation_tokens | 火山返回的 usage（事件/接口） | ✅ 直接返回 | 平台字段：`input_tokens`、`output_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens`；落库映射见 3.7.3。注意：usage 随一轮内的**每次模型请求**（`span.model_request_end`，一轮因工具往返可有 N 次）分别返回，**Java 后端需在本轮内累加后只落一行汇总值**；该事件携带的平台 request_id 为单次模型请求粒度，**不落库**，仅在需与火山账单逐笔核对时回查事件流 |
| running_duration_ms | 后端观察 running → idle 自行计时 | ❌ 平台不直接给单次时长 | 由 started_at / ended_at 计算，可靠 |
| cost | 后端按官方单价回算 | ❌ 平台不直接给单次费用 | 由 token / 时长 / 工具次数计算，不得采信模型返回值 |
| model | 业务侧创建 Agent 时指定，或事件返回 | ✅ 业务侧已知 | 若会话可覆写模型，需记录覆写后的值 |
| error_code / error_msg | `error` 事件（后端归一化） | ⚠️ 事件归一化 | 4.2 已注明 error 为归一化事件，非方舟原生事件名 |
| object_path / 文件归属 | 火山 `GET /files?scope_id&purpose=agent`（已确认）；百炼 Files、腾讯按各自能力 | ✅ 火山直接返回 | 火山 Skill 写 `/mnt/session/outputs` 自动注册为 `purpose=agent`；产物发现统一由 `AgentPlatform.listArtifacts` 抽象，归档对象路径落 `object_path` |

#### 3.7.1 business_user_agent_binding（业务用户-平台资源绑定，用户级）
| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| id | BIGINT | 自增主键 | 是 |
| user_id | VARCHAR(64) | 业务用户 ID | 是 |
| platform | VARCHAR(32) | 平台：volcano / bailian / tencent_adp | 是 |
| platform_config | JSON | 平台资源引用（火山 memory_store_id 等；百炼/腾讯按各自能力） | 否 |
| status | TINYINT | 0 正常 / 1 停用 | 是 |
| created_at | DATETIME(3) | 创建时间 | 是 |
| updated_at | DATETIME(3) | 更新时间 | 是 |

约束：`UNIQUE(user_id, platform)`。默认会话不落这张表，由 `business_agent_session.is_default=1` 判定。

#### 3.7.2 business_agent_session（业务会话映射，会话级）
| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| id | BIGINT | 自增主键 | 是 |
| conversation_id | CHAR(36) | 业务会话 UUID（对外主键，唯一） | 是 |
| user_id | VARCHAR(64) | 业务用户 ID | 是 |
| platform | VARCHAR(32) | 平台 | 是 |
| platform_session_id | VARCHAR(128) | 平台会话 ID | 是 |
| is_default | TINYINT | 1 默认会话 / 0 临时会话 | 是 |
| platform_status | VARCHAR(32) | 平台状态归一化：idle / running / terminated | 是 |
| biz_status | TINYINT | 0 活跃 / 1 已结束 / 2 只读（冻结） | 是 |
| frozen_reason | VARCHAR(128) | 只读原因：config_changed / credential_rotated 等 | 否 |
| frozen_at | DATETIME(3) | 置为只读的时间 | 否 |
| config_snapshot | JSON | 结构化配置快照（我方 config hash + 平台版本辅助） | 否 |
| platform_config | JSON | 平台会话差异字段（火山 agent_id/skill 版本等） | 否 |
| title | VARCHAR(255) | 会话标题/摘要 | 否 |
| created_at | DATETIME(3) | 创建时间 | 是 |
| last_active_at | DATETIME(3) | 最后活跃时间 | 是 |
| terminated_at | DATETIME(3) | 终止时间 | 否 |

约束：`UNIQUE(conversation_id)`；`UNIQUE(platform, platform_session_id)`；`INDEX(user_id, is_default)`。

会话升级只读语义：`biz_status=2` 表示该会话快照已过期（agent/skill 升级或凭据轮换），后端**禁止继续发送普通消息**。判定：每次发消息前，用当前配置重算 `config_snapshot` 与会话快照比对，不一致则置 `biz_status=2` 并写 `frozen_reason`/`frozen_at`。

#### 3.7.3 agent_call_log（调用审计，一次分析任务一行）
| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| id | BIGINT | 自增主键（一轮任务一个，作为审计与文件关联的唯一标识） | 是 |
| task_id | CHAR(36) | 业务任务 UUID（对外主键，唯一） | 是 |
| conversation_id | CHAR(36) | 业务会话 UUID | 是 |
| user_id | VARCHAR(64) | 业务用户 ID | 是 |
| platform | VARCHAR(32) | 平台：volcano / bailian / tencent_adp | 是 |
| platform_session_id | VARCHAR(128) | 平台会话 ID | 否 |
| model | VARCHAR(64) | 模型标识（如 doubao-seed-2.1-turbo） | 否 |
| status | TINYINT | 0 成功 / 1 失败 | 是 |
| error_code | VARCHAR(64) | 错误码 | 否 |
| error_msg | VARCHAR(512) | 错误信息 | 否 |
| input_tokens | INT | 未命中缓存的新增输入 Token（计费输入项） | 否 |
| output_tokens | INT | 模型生成的全部输出 Token（计费输出项） | 否 |
| cache_read_tokens | INT | 命中缓存读取 Token（平台 `cache_read_input_tokens`，单价更低） | 否 |
| cache_creation_tokens | INT | 新增创建缓存 Token（平台 `cache_creation_input_tokens`，缓存存储计费，可选） | 否 |
| total_tokens | INT | 总消耗 Token（`input_tokens + output_tokens + cache_read_tokens`） | 否 |
| tool_call_count | INT | 内置工具调用次数 | 否 |
| tool_fee | DECIMAL(12,6) | 工具 / MCP 调用费（平台差异，可空） | 否 |
| running_duration_ms | INT | 运行时长（毫秒） | 否 |
| cost | DECIMAL(12,6) | 折算费用（后算，可空） | 否 |
| platform_usage | JSON | 平台特有用量/计费原始字段 | 否 |
| started_at | DATETIME(3) | 开始时间 | 是 |
| ended_at | DATETIME(3) | 结束时间 | 否 |

约束：`UNIQUE(task_id)`；`INDEX(user_id, started_at)`；`INDEX(platform, platform_session_id)`。Java 后端不做请求去重——用户每发送一条消息均由 Agent 完整执行并落一行记录，重复提交由 3.2.1 的同会话并发限制兜底。三平台统一用量模型：token 五列 + `running_duration_ms` + `tool_call_count` + `tool_fee`；平台计费差异（如百炼 MCP 费、腾讯 PU）进 `platform_usage`，`cost` 由后端按平台单价汇总回算。

#### 3.7.4 agent_report_file（报告文件索引，30 天生命周期）
| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| id | BIGINT | 自增主键 | 是 |
| file_id | CHAR(36) | 业务文件 UUID（对外主键，唯一） | 是 |
| call_log_id | BIGINT | 关联 `agent_call_log.id`（本轮任务） | 是 |
| conversation_id | CHAR(36) | 业务会话 UUID | 是 |
| user_id | VARCHAR(64) | 业务用户 ID | 是 |
| platform | VARCHAR(32) | 平台 | 是 |
| file_type | VARCHAR(16) | 文件类型（md/xlsx） | 否 |
| file_name | VARCHAR(255) | 文件名 | 否 |
| object_path | VARCHAR(512) | 归档对象路径（我方 OSS/TOS） | 是 |
| platform_config | JSON | 平台文件引用（火山 file_id / 百炼 file_id / 腾讯引用） | 否 |
| file_size | INT | 文件字节数 | 否 |
| status | TINYINT | 0 有效 / 1 已过期删除 | 是 |
| expire_at | DATETIME(3) | 到期时间（30 天） | 是 |
| created_at | DATETIME(3) | 创建时间 | 是 |

约束：`UNIQUE(file_id)`；`INDEX(conversation_id, created_at)`；`INDEX(expire_at)`；`INDEX(call_log_id)`。该表作为文件索引真源，支持列表/分页/生命周期清理。文件登记经 `AgentPlatform.listArtifacts` 抽象：火山走 `GET /files?scope_id&purpose=agent`，百炼走 Files API，腾讯按其能力；归档统一到自有对象存储写 `object_path`，平台文件引用进 `platform_config`。

#### 3.7.5 agent_event_log（会话事件流水，评估/审计用）
> 用途：完整保存一轮会话的原始事件（用户消息、助手消息、工具调用与结果、状态变化），供事后评估、质量分析、复现与审计。与 `agent_call_log` 的差异：`agent_call_log` 是**按轮聚合**的统计行（成本/用量），本表是**按事件**的流水（保真时序）。

| 字段 | 类型 | 说明 | 必填 |
|---|---|---|---|
| id | BIGINT | 自增主键 | 是 |
| platform | VARCHAR(32) | 平台 | 是 |
| platform_session_id | VARCHAR(128) | 平台会话 ID | 是 |
| conversation_id | CHAR(36) | 业务会话 UUID | 是 |
| task_id | CHAR(36) | 业务任务 UUID | 否 |
| call_log_id | BIGINT | 关联 `agent_call_log.id`（本轮任务；先到的事件可后回填，可空） | 否 |
| event_id | VARCHAR(128) | SSE 事件 id（断点续传去重用，可空） | 否 |
| seq | BIGINT | 会话内单调递增序号（事件到达顺序） | 是 |
| event_type | VARCHAR(64) | **我方规范事件**：user_message / message / tool_call / tool_result / approval / turn_end / error | 是 |
| role | VARCHAR(16) | user / assistant / tool（可空） | 否 |
| content | JSON | 结构化内容（文本、工具名、参数、结果摘要等） | 否 |
| raw_payload | JSON | 原始事件完整 JSON（保真，评估复现用） | 是 |
| recorded_at | DATETIME(3) | 后端落库时间 | 是 |

约束：`UNIQUE(platform, platform_session_id, event_id)`（event_id 非空时）；`INDEX(conversation_id, seq)`；`INDEX(task_id)`。

**记录时机（关键）**：见 4.2 及官方「流式获取会话事件（SSE）」「Session 事件流总览」。
- **逐事件落库，不等轮次结束**。助手文本会以 delta 流式推送，工具调用是长程调用（先工具开始、很久后才返回结果），只有在每个 SSE 事件到达时立即 append，才能保留真实时序与中间状态。
- 断线重连用 SSE `id`（`Last-Event-ID`）幂等去重，避免重复落库。
- `call_log_id` 关联：Java 后端在发送 `user.message` 前先插入 `agent_call_log` 拿到自增 id，随后本轮所有事件回填该 id，直到 `session.status_idle`（非 `requires_action`）结束本轮。
- 不建议在 `status_idle` 后一次性批量落库：会丢失工具调用中间态、无法还原长程调用时序，也不利于评估“工具调用是否成功/参数是否正确”。

#### 3.7.6 建表 SQL（MySQL 8，参考）
```sql
CREATE TABLE business_user_agent_binding (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  platform VARCHAR(32) NOT NULL,
  platform_config JSON NULL,
  status TINYINT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_user_platform (user_id, platform)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE business_agent_session (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  conversation_id CHAR(36) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  platform VARCHAR(32) NOT NULL,
  platform_session_id VARCHAR(128) NOT NULL,
  is_default TINYINT NOT NULL DEFAULT 0,
  platform_status VARCHAR(32) NOT NULL DEFAULT 'idle',
  biz_status TINYINT NOT NULL DEFAULT 0 COMMENT '0 活跃 / 1 已结束 / 2 只读(冻结)',
  frozen_reason VARCHAR(128) NULL,
  frozen_at DATETIME(3) NULL,
  config_snapshot JSON NULL,
  platform_config JSON NULL,
  title VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_active_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  terminated_at DATETIME(3) NULL,
  UNIQUE KEY uk_conversation (conversation_id),
  UNIQUE KEY uk_platform_session (platform, platform_session_id),
  KEY idx_user (user_id),
  KEY idx_user_default (user_id, is_default)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE agent_call_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  task_id CHAR(36) NOT NULL,
  conversation_id CHAR(36) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  platform VARCHAR(32) NOT NULL,
  platform_session_id VARCHAR(128) NULL,
  model VARCHAR(64) NULL,
  status TINYINT NOT NULL DEFAULT 0,
  error_code VARCHAR(64) NULL,
  error_msg VARCHAR(512) NULL,
  input_tokens INT NULL,
  output_tokens INT NULL,
  cache_read_tokens INT NULL,
  cache_creation_tokens INT NULL,
  total_tokens INT NULL,
  tool_call_count INT NULL,
  tool_fee DECIMAL(12,6) NULL,
  running_duration_ms INT NULL,
  cost DECIMAL(12,6) NULL,
  platform_usage JSON NULL,
  started_at DATETIME(3) NOT NULL,
  ended_at DATETIME(3) NULL,
  UNIQUE KEY uk_task (task_id),
  KEY idx_user_time (user_id, started_at),
  KEY idx_platform_session (platform, platform_session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE agent_report_file (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  file_id CHAR(36) NOT NULL,
  call_log_id BIGINT UNSIGNED NOT NULL,
  conversation_id CHAR(36) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  platform VARCHAR(32) NOT NULL,
  file_type VARCHAR(16) NULL,
  file_name VARCHAR(255) NULL,
  object_path VARCHAR(512) NOT NULL,
  platform_config JSON NULL,
  file_size INT NULL,
  status TINYINT NOT NULL DEFAULT 0,
  expire_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_file (file_id),
  KEY idx_call_log (call_log_id),
  KEY idx_conv_time (conversation_id, created_at),
  KEY idx_expire (expire_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE agent_event_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  platform VARCHAR(32) NOT NULL,
  platform_session_id VARCHAR(128) NOT NULL,
  conversation_id CHAR(36) NOT NULL,
  task_id CHAR(36) NULL,
  call_log_id BIGINT UNSIGNED NULL,
  event_id VARCHAR(128) NULL,
  seq BIGINT NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  role VARCHAR(16) NULL,
  content JSON NULL,
  raw_payload JSON NOT NULL,
  recorded_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_event (platform, platform_session_id, event_id),
  KEY idx_conv_seq (conversation_id, seq),
  KEY idx_task (task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

#### 3.7.7 生命周期与清理
- 会话：`business_agent_session.last_active_at` 超过阈值置 `biz_status=1` 或归档；配置升级置 `biz_status=2`（只读）而非删除，保留历史可查；用户离职同步清理。
- 审计：`agent_call_log` 按月分区/归档，保留周期与财务对账要求一致（建议 ≥90 天，待确认）。
- 事件流水：`agent_event_log` 仅用于评估/审计，保留窗口建议与评估需求一致（≥90 天，待确认）；因含原始事件 payload，需权限管控与脱敏。
- 文件：定时任务按 `agent_report_file.expire_at` 清理对象存储并置 `status=1`，与 30 天生命周期一致。
---

## 四、接口与事件规范

### 4.0 Java SDK（ark-runtime）对接说明
> 接入层采用火山方舟 Managed Agents 官方 Java SDK **`ark-runtime`**（V3 接口体系），替代原 Node.js 手写 HTTP 实现。下述类名/方法名已通过 `ark-runtime 0.6.0`（2026-09-09 Maven Central 最新版）反编译核实；版本升级后以 [Maven Central](https://central.sonatype.com/artifact/com.volcengine/ark-runtime) 及官方 SDK 文档为准。

#### 4.0.1 依赖坐标
**Maven**
```xml
<dependency>
    <groupId>com.volcengine</groupId>
    <artifactId>ark-runtime</artifactId>
    <version>0.6.0</version>
</dependency>
```
**Gradle**
```gradle
implementation "com.volcengine:ark-runtime:0.6.0"
```
> 源码仓库为 [volcengine/ark-runtime-java](https://github.com/volcengine/ark-runtime-java)（`<scm>` 已核实）。旧包名 `volcengine-java-sdk-ark-runtime`（位于 `volcengine/volcengine-java-sdk` 仓库）为旧版，不推荐新项目使用。

#### 4.0.2 核心入口类
- 平台 API（Agent/Environment/Session/Event/File/Memory/Skill/模型）：`com.volcengine.ark.runtime.service.ArkService`（其接口为 `ArkApi`，基于 Retrofit2 + RxJava，多数方法返回 `io.reactivex.Single<T>`，流式为 `retrofit2.Call<ResponseBody>`）。
- 自托管自定义工具 Worker：`com.volcengine.ark.runtime.selfhosted.SelfHostedClient`。

#### 4.0.3 接口方法映射（原 Node 手写 HTTP → Java SDK）
| 能力 | 实际 SDK 方法（ArkService / ArkApi） | 说明 |
|---|---|---|
| 创建会话 | `createSession(CreateSessionRequest, headers)` → `Single<Session>` | `agent` 用 `AgentIdentifier`；`resources` 挂 Memory Store / 私有 TOS；**用户凭据注入在 `environment.config.env`**（`EnvironmentConfigOverride.env` 的 `Map<String,String>`），非顶层字段 |
| 查询 / 更新 / 删除会话 | `getSession(id)` / `updateSession(id, UpdateSessionRequest)` / `deleteSession(id)` | **无 `terminateSession`**，归档/清理用 `deleteSession`（或按平台语义 `updateSession`） |
| 发送用户事件（消息 / 中断 / 工具结果） | `sendSessionEvents(sessionId, SendSessionEventsRequest, headers)` → `Single<SendSessionEventsResponse>` | **无 `sendMessage`**；`SendSessionEventsRequest.events` 为 `List<ManagedAgentsEventParams>`，分别用 `ManagedAgentsUserMessageEventParams` / `ManagedAgentsUserInterruptEventParams` / `ManagedAgentsUserCustomToolResultEventParams` 提交 |
| 订阅会话事件流（SSE） | `streamSessionEvents(sessionId, headers)` → `Call<ResponseBody>` | 返回原始响应体，需自行解析 SSE 帧 |
| 会话事件历史 | `listSessionEvents(sessionId, ...)` | 断线补偿 / 回溯 |
| 会话资源挂载 | `createSessionResource(sessionId, CreateSessionResourceRequest)` / `listSessionResources(sessionId)` | 运行时挂/卸文件 |
| 文件 | `uploadFile(...)` / `retrieveFile(id)` / `listFiles(...)` / `deleteFile(id)` | 产物发现与分发 |
| Agent | `createAgent(...)` / `getAgent(id)` / `updateAgent(...)` / `deleteAgent(id)` / `listAgentVersions(id)` | Agent 生命周期与版本 |
| Environment | `createEnvironment(...)` / `getEnvironment(id)` / `updateEnvironment(...)` / `deleteEnvironment(id)` | 沙箱环境 |
| Memory Store | `createMemoryStore(...)` / `createMemory(...)` / `listMemories(...)` / `updateMemory(...)` / `deleteMemory(...)` | 每用户记忆库 |
| Skill | `createSkill(...)` / `getSkill(id)` / `openSkillContent(id, ...)` | 自定义 Skill 包 |
| 模型推理（通用） | `createResponse(ResponsesRequest, ...)` / `streamResponse(...)` | 与普通在线推理共用 |

> 说明：原初稿中的 `sendMessage`、`postCustomToolResult`、`terminateSession` 均不存在，已按 SDK 实际签名改为上表方法。

#### 4.0.4 SSE 事件监听
SDK 提供 `streamSessionEvents(sessionId)` 返回 Retrofit `Call<ResponseBody>`，但**不负责解析 SSE 帧**；接入层基于 OkHttp（SDK 底层依赖）解析响应体中的 `text/event-stream`：
- 端点由 SDK 封装（等价 `{baseUrl}/sessions/{sessionId}/events/stream`），Header `Authorization: Bearer {apiKey}`；
- 监听并分发 `agent.message`、`agent.custom_tool_use`、`span.model_request_end`、`session.status_idle`、`error` 等事件（见 4.2）；
- 断线重连用 SSE `id` / `Last-Event-ID` 续传；历史补偿用 `listSessionEvents`；事件去重由 `agent_event_log.event_id` 唯一约束兜底。

#### 4.0.5 自定义工具两条路径
1. **一期：沙箱内自定义 Skill**（leyosys 取数，已在 Skill 内闭环鉴权/取数）——不走 `SelfHostedClient`，后端仅经 `ArkService` 管理会话、`sendSessionEvents` 发消息、`streamSessionEvents` 监听事件；Skill 在沙箱内直连 leyosys。
2. **二期/回调链路：自托管 Worker（`SelfHostedClient`）**——当工具需由业务后端执行（如分析 Skill 改为 custom_tool）时启用。其核心接口为 `pollWork` / `ackWork` / `heartbeatWork` / `stopWork`（领取与确认工单）、`sendEvent` / `openEventStream`（收发会话事件）、`Tool.execute(input, ToolContext)`（业务工具实现）；**回传结果走 `sendEvent` / `sendSessionEvents` 的 `user.custom_tool_result` 事件，无 `postCustomToolResult` 方法**。

#### 4.0.6 Token 用量累计
- 一轮任务内每次模型请求由 `span.model_request_end` 事件返回 usage（input / output / cache_read / cache_creation）；
- 后端在轮内累加 N 次 usage，轮次结束（`session.status_idle`，非 `requires_action`）写入 `agent_call_log` 一行汇总（见 3.7.3）。

#### 4.0.7 关键模型字段（已反编译核实，编码时直接对应）
- **凭据注入**：`CreateSessionRequest.environment`（`EnvironmentWithOverrides`）→ `.config`（`EnvironmentConfigOverride`）→ `.env(Map<String,String>)`，对应一期「会话环境变量注入用户凭据」；`EnvironmentConfigOverride` 另含 `packages` / `networking` / `setupScript` / `tos`。
- **资源挂载**：`CreateSessionRequest.resources` 为 `List<SessionResource>`；`SessionResource` 支持 `type`（file / memory_store / tos 等）、`memoryStoreId`、`fileId`、`access`（只读/读写）、`mountPath`、`tosBucket` / `tosKey` / `tosRegion`。据此：Memory Store 用 `type=memory_store + memoryStoreId + access=read_only`；私有 TOS 用 `type=tos + tosBucket/tosKey/tosRegion`。
- **会话事件提交**：`SendSessionEventsRequest.events` 为事件参数列表，一期实际用到 `ManagedAgentsUserMessageEventParams`（发用户消息）、`ManagedAgentsUserInterruptEventParams`（中断）；二期 custom tool 回传用 `ManagedAgentsUserCustomToolResultEventParams`。
- **事件流解析**：`streamSessionEvents` 返回原始 `ResponseBody`，事件对象含 `ManagedAgentsStartEvent` / `ManagedAgentsDeltaEvent` / `ManagedAgentsSessionEvent` 等，接入层按事件 `type` 分发（具体事件枚举以 SDK 当前版本为准，仍需与 4.2 的实测事件名对齐）。

### 4.1 平台侧核心 API 清单（Java 后端调用）
| 类别 | 接口 | 用途 |
|---|---|---|
| 资源管理 | 创建 Memory Store、写入/删除记忆条目 | 用户配置、权限标识管理（每用户一库） |
| 会话管理 | 创建 Session | 挂载用户 Memory Store、私有 TOS，注入用户凭据环境变量 |
| 会话管理 | 发送用户事件 | 提交分析指令、中断任务 |
| 事件流 | SSE Stream 接口 | 监听消息、Skill 调用、状态、文件等事件 |
| 文件管理 | 获取文件下载链接 | 归档报告文件分发 |


### 4.2 SSE 核心事件类型与处理逻辑
> 本节为**火山适配器**视角的平台事件；接入层需把它们归一化为 4.3 的我方规范事件后再对外推送与落库。

| 事件类型 | 触发时机 | 处理逻辑 |
|---|---|---|
| `agent.message` | Agent 生成文字回复 | 增量推送至前端 |
| `session.status_idle`（`requires_action`） | 等待 custom tool 回传结果 | **不算本轮结束**，回传 `user.custom_tool_result` 后继续；一期沙箱 Skill 场景一般不触发 |
| `session.status_idle`（真正空闲） | 本轮分析任务结束 | 标记任务完成、停止计时、异步更新索引 |
| `agent.custom_tool_use` | custom tool 开始执行（二期/回调链路） | 记录日志、前端展示执行状态 |

> 说明：① 事件类型以官方「会话事件类型」文档为准，custom tool 事件带 `agent.` 前缀；② 方舟原生事件中未见 `file` 事件，产物文件在 `session.status_idle` 后通过 Files API 轮询获取：Skill 写入沙箱 `/mnt/session/outputs` 目录的文件会**自动注册到 Files API，用途标记为 `purpose=agent`**；`GET /files` 默认按 `purpose=user_data` 过滤（只返回用户上传文件），**必须显式带 `scope_id={session_id}&purpose=agent`**，否则返回空列表会误判为无产物；取到文件后更新索引并向前端提供下载链接；③ 后端向前端透出的 `error` 为归一化错误事件，非方舟原生事件名。

### 4.3 我方规范事件与三平台映射（平台无关）
| 我方规范事件 | 火山方舟 | 阿里百炼 | 腾讯 ADP（HTTP SSE） |
|---|---|---|---|
| `user_message` | `user.message` | `message`(role=user) | 请求侧 `POST /chat`（`request_ack` 为回执） |
| `message` | `agent.message` | `message`(role=assistant) | `text.delta` / `text.replace` / `message.added`(Type=reply) |
| `tool_call` | `agent.tool_use` / `agent.custom_tool_use` | `tool_call` / `mcp_call` | `message.added`(Type=tool_call, Status=processing) |
| `tool_result` | `agent.tool_result` / `user.custom_tool_result` | `tool_call_output` / `mcp_call_output` | tool_call 消息 Status=success/failed，输出在 Contents |
| `approval` | `session.status_idle`(requires_action) | `tool_approval_request` / `tool_approval_response` | `message.added`(Type=questionnaire)，作答走新请求 |
| `turn_end` | `session.status_idle`(非 requires_action) | `session_status`(null/end_turn/retries_exhausted) | `response.completed` / `done` |
| `error` | `error`（归一化） | `error` | `error` |

> 注意：approval 的裁决回传方式三平台不同（火山同会话续跑、百炼 `tool_approval_response`、腾讯新请求），防腐层需抽象「交互型事件 + 续跑/裁决」，不能只做字段名映射。

---

## 五、可靠性与异常处理
### 5.1 核心异常场景与处理
| 异常场景 | 触发原因 | 处理策略 |
|---|---|---|
| 取数 Skill 鉴权失败 | 用户凭据过期、权限变更 | 返回鉴权失败提示，引导重新认证；触发会话重建加载新凭据 |
| 取数 Skill 执行失败 | 接口超时、参数错误、数据为空 | 返回明确错误话术，提示用户检查查询条件；数据为空时给出空值说明 |
| 规则加载失败 | 业务侧规则接口不可用、版本不兼容 | 按重试策略重试；仍失败则返回明确错误提示，引导稍后重试，避免用错误规则产出结论 |
| 数据量超限 | 单次分析数据超过10MB阈值 | 提示用户缩小查询范围，分批分析；避免沙箱内存溢出 |
| 沙箱执行超时 | 分析任务耗时过长，超出运行阈值 | 中断任务，返回已完成部分结论，支持用户重新发起 |
| SSE 连接断开 | 网络波动、代理超时 | 自动重连 + `Last-Event-ID` 断点续传，不丢失事件，用户无感知 |
| 模型调用失败 | 限流、服务异常 | 重试 1 次，仍失败则返回友好提示，记录告警 |
| 文件归档失败 | TOS 写入异常、权限不足 | 先写入沙箱本地临时目录，后台重试归档；同步记录告警 |

### 5.2 重试与重复提交
- **重试策略**：取数接口指数退避重试 3 次；规则加载重试 2 次；模型调用失败重试 1 次
- **重复提交**：Java 后端不做请求去重，用户每发送一条消息都由 Agent 完整执行；`agent_call_log` 以自增 `id` 按轮记账，不设业务幂等键。同会话并发由 3.2.1 限制（排队或拒绝），避免平台侧并发报错；SSE 断连重连只续传事件，不产生新任务行
- **断点续传**：SSE 事件流支持 `Last-Event-ID`，断连重连后从断点继续，不重复推送

---

## 六、安全与合规
### 6.1 凭据安全
- 一期：用户凭据经会话环境变量按用户隔离注入，仅沙箱内可读，不向前端暴露，日志/事件流不打印完整凭据
- 凭据定期轮换，轮换后重建会话加载新凭据，留存更新审计记录

- 最小权限原则：仅注入业务接口调用所必需的凭据

### 6.2 数据安全
- 业务原始数据仅在沙箱内存中处理，不持久化到本地存储，任务结束即释放
- Memory Store 仅存用户配置与权限标识，不存储原始业务明细数据与规则数据；文件索引由 `agent_report_file` 表承载
- 私有 TOS 归档文件支持服务端加密，访问权限受控，30天自动清理
- 不同用户会话、沙箱、资源完全隔离，数据不互通

### 6.3 审计追溯
- 所有 Skill 调用、文件生成、任务执行均有完整会话事件日志
- 支持按 `session_id`、`user_id` 追溯完整执行链路与操作记录
- 规则更新、凭据更新均留存操作日志，可审计

---

## 七、成本与资源治理
### 7.1 1000 人规模月度成本估算（参考）
| 计费项 | 测算假设 | 月度预估 |
|---|---|---|
| Agent 沙箱运行时 | 人均每日 2 次分析，单次平均 5 分钟 running | 约 2500 元 |
| 模型推理 Token | 单次分析合计 10k token，使用 doubao-seed-2.1-turbo | 约 360 元 |
| 工具调用 | 自定义 Skill 无平台调用费 | 0 元 |
| Memory Store（每用户单库） | 公测阶段免费 | 0 元 |
| 私有 TOS 归档存储 | 30天留存总量约 6GB，1.08 元/GB/月 | 约 7 元 |
| **总计** | - | **约 2870 元/月** |

> 说明：沙箱费用按 0.5 元/小时 × 1000 人 × 2 次/日 × 5 分钟 ≈ 83 元/日 × 30 ≈ 2500 元/月；模型费用按 1000 人 × 2 次/日 × 30 日 × 10k token，单价以官方模型定价为准。以上为粗略估算，实际随使用频率、单次时长、模型选型、归档量波动。

### 7.2 ArkClaw 企业版（包年包月预付费）
按「席位」预付费计费，费用包含对应规格的 CPU、内存、持久存储、网盘等计算与网络资源，适合规模化生产使用。
**平台托管模式本身不额外收取服务费**，属于企业版标准账号管理方式之一。

#### 单席位月费基准（仅 ArkClaw 实例本身）
| 规格 | 单席位月费 | 核心配置 | 适用场景 |
|---|---|---|---|
| 轻量版 Starter | 210 元/月 | 2核 / 4GiB 内存 / 60GiB 存储 / 10GB 网盘 | 入门体验、轻量任务 |
| 标准版 Standard | 430 元/月 | 4核 / 8GiB 内存 / 80GiB 存储 / 20GB 网盘 | 日常生产、中等复杂度工作流 |
| 高级版 Premium | 860 元/月 | 8核 / 16GiB 内存 / 160GiB 存储 / 40GB 网盘 | 复杂任务、多工具并行 |
| 旗舰版 Ultimate | 1720 元/月 | 16核 / 32GiB 内存 / 160GiB 存储 / 80GB 网盘 | 大型项目、高负载全链路编排 |

#### 关键计费规则
1. **购买门槛**：企业版单次购买席位数量不少于 5 个，不足 5 个无法下单；总费用 = 单席位单价 × 席位数量。
2. **模型费用单独计费**：席位费仅包含实例运行资源，Agent Plan Team（大模型调用额度）需搭配购买，不包含在基础席位费中。
3. **购买时长**：支持 1 个月、6 个月、1 年，包年可享折扣，具体以购买页为准。

### 7.3 成本优化策略
1.  **模型分层**：简单查询用 lite，常规分析用 turbo，复杂深度分析用 pro
2.  **闲置回收**：依赖平台 30 天不活跃沙箱自动回收机制，降低无效运行时长
3.  **任务优化**：减少 Skill 执行空转时间，数据预处理与规则计算尽量收敛在 Skill 内
4.  **规则加载优化**：规则接口侧配置缓存/压缩，减少每次执行重复拉取的开销；一期先保持实时拉取以保证热更新即时性
5.  **存储精简**：报告文件控制大小，30天自动清理，避免无效存储堆积

### 7.4 资源生命周期管理
- **用户维度**：用户离职/失效时，同步清理对应 Memory Store、历史会话
- **会话维度**：长期闲置会话保留 session 对象，沙箱自动回收，不产生费用
- **文件维度**：私有 TOS 配置30天生命周期，到期自动删除，同步清理索引
- **规则维度**：业务侧配置源保留最近 3 版规则，历史版本定期清理

---

## 八、运维与可观测性
### 8.1 日志体系
- 会话事件日志：平台原生完整事件流，用于全链路排查
- Skill 执行日志：沙箱内标准输出，用于定位 Skill 报错
- 接入层日志：Java 后端请求、SSE 连接、重连、错误、规则加载日志

### 8.2 核心监控指标
- 业务指标：在线会话数、日任务量、任务成功率、平均响应时长
- 资源指标：沙箱运行时长、Token 消耗量、文件生成量、TOS 存储用量
- 异常指标：错误率、SSE 重连次数、Skill 失败率、鉴权失败率
- 规则指标：规则更新频率、加载成功率、版本分布

### 8.3 排障路径
1.  按 `session_id` 拉取完整会话事件流，定位失败节点
2.  查看对应 Skill 执行日志，定位代码/参数/接口问题
3.  核对 Memory Store、TOS 资源挂载与权限配置，以及会话环境变量注入
4.  核查模型调用与限流情况
5.  规则异常时核对业务侧规则配置源的版本与内容

---

## 九、方案落地实施建议
1.  **一期优先落地核心链路**：用户会话管理 + 每用户 Memory Store + 会话环境变量凭据 + leyosys 取数 Skill（已开发完成，直接接入）+ 取数结果对话/文件交付与 TOS 归档，验证主流程通畅；**不含分析 Skill 与规则配置源**
2.  **二期扩展能力**：分析引擎 Skill（会话共享目录 `data_path` 接入，见 3.1.3）+ 规则热更新（业务侧配置源实时拉取）、精细化权限、历史查询与归档管理
3.  **灰度验证**：先小范围用户试点，验证性能、成本、稳定性后全量推广
4.  **预案准备**：提前准备平台异常降级方案，核心业务场景配置备用调用路径

---

## [参考文档](./managed-agent-docs.md)
