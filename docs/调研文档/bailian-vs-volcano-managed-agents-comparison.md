# 阿里云百炼 vs 火山方舟 Managed Agents 对比（功能 + 计费）
> **版本**：V1.0（初稿）
> **用途**：支撑「商品异常分析 Agent」在百炼 / 火山两套 Managed Agents 平台间的选型决策。功能部分以双方官方公开文档为准；计费部分区分「已核实官方单价」与「方案估算/待官方计费页确认」两类，避免把估算当结论。
> **关联文档**：
> - 火山版方案：[managed-agents-goods-analysis-design.md](./managed-agents-goods-analysis-design.md)
> - 百炼版方案：[bailian-managed-agents-goods-analysis-design.md](./bailian-managed-agents-goods-analysis-design.md)

---

## 一、功能差异对比

### 1.1 产品定位与地域
| 维度 | 火山方舟 Managed Agents | 阿里云百炼 Managed Agents |
|---|---|---|
| 厂商 | 火山引擎 / 字节跳动 | 阿里云 |
| 产品形态 | 方舟 MA（标准版） + ArkClaw 企业版 | 百炼 agentstudio（托管运行时） |
| API 基地址 | `https://ark.cn-beijing.volces.com/api/v3/...` | `https://{workspace_id}.cn-beijing.maas.aliyuncs.com/api/v1/agentstudio` |
| 地域 | 支持方舟既有地域（本项目按 cn-beijing） | 当前仅 `cn-beijing` |
| 企业版 | ArkClaw 企业版（席位制，5 席位起） | 未提供对应的独立企业版序列（截至本版） |

### 1.2 资源模型对比（核心差异）
| 资源/能力 | 火山方舟 | 阿里云百炼 | 结论 |
|---|---|---|---|
| Agent | ✅ | ✅ | 一致（模型、system、tools 等） |
| 沙箱 Environment | ✅（沙箱/云环境） | ✅（云端沙箱 Environment） | 一致 |
| Session | ✅ | ✅ | 一致（创建时快照 Agent 配置） |
| 自定义 Skill | ✅ 沙箱内自定义 Skill | ✅ 自定义 Skill（zip ≤10MB + SKILL.md，带版本管理） | 一致，百炼明确限制 zip ≤10MB |
| MCP | ✅ | ✅ | 一致 |
| custom_tool（回调业务侧执行） | ✅ `agent.custom_tool_use` | ❌ 无对等能力（用 MCP 替代） | 火山独有 |
| **Vault / 凭据库** | ✅ 三种凭据：`static_bearer` / `mcp_oauth` / `environment_variable` | ❌ 公开 API 无；控制台有「密钥库」标签但未开放 API | **最大差异** |
| **按会话环境变量注入** | ✅ `environment_with_overrides` | ❌ 无对等能力 | **最大差异** |
| **Memory Store（长期记忆）** | ✅ 每用户一库，可 `read_only` 挂载 | ❌ agentstudio 无；另有独立「记忆库」产品 | **最大差异** |
| 对象存储挂载 | ✅ 私有 TOS 桶挂载 | ⚠️ 仅 Files（≤10MB/文件、100GB/工作空间、30 天） | 火山更灵活 |

### 1.3 凭据与鉴权
| 维度 | 火山方舟 | 阿里云百炼 |
|---|---|---|
| 一期可行方案 | 创建 Session 时经 `environment_with_overrides` 注入用户凭据环境变量，Skill 沙箱内直读 | 公开 API 无会话级环境变量注入，需 Node 后端持有用户凭据、取数走 MCP/回调 |
| 进阶托管 | Vault：一用户一 Vault，`environment_variable` 凭据；支持 `vault_ids` 引用、出站网关替换 | 「密钥库」为控制台能力，API 待官方开放，上线前不可写死 |
| 凭据轮换 | 运行期不可变，轮换需重建 Session；Vault PUT 是否实时生效需 POC | Node 后端自持，轮换在业务侧完成 |

> 对本项目影响：火山可走「会话环境变量直注入」与现有 leyosys Skill 最接近；百炼一期必须把 leyosys 取数改为 MCP/Node 回调，否则沙箱拿不到用户凭据。

### 1.4 长期记忆
| 维度 | 火山方舟 | 阿里云百炼 |
|---|---|---|
| 能力 | Memory Store（挂载到 Session，`read_only`/读写） | agentstudio 无 Memory Store |
| 替代 | 每用户一库：用户偏好 + 历史文件索引 | 用户级元数据由 Node 后端 Redis/DB 自建 |
| 容量 | 单库 2000 条上限 | 无平台约束（自建存储自行约束） |

> 结论：火山可把「用户偏好/文件索引」放平台侧 Memory Store；百炼需完全下沉到 Node 后端，平台侧不承载长期记忆。

### 1.5 工具扩展
| 维度 | 火山方舟 | 阿里云百炼 |
|---|---|---|
| 内置工具 | Bash、联网等 | Bash、文件读写等 |
| 自定义 Skill | 沙箱内自定义 Skill | zip+SKILL.md 自定义 Skill（版本可回退） |
| MCP | ✅ | ✅ |
| 回调业务侧 | custom_tool（`agent.custom_tool_use` + `user.custom_tool_result`） | 无，用 MCP 替代 |
| 审批 | custom tool 权限策略触发 `requires_action` | 工具 `always_ask` 触发审批 |

### 1.6 会话状态机 / 事件 / 审批
| 维度 | 火山方舟 | 阿里云百炼 |
|---|---|---|
| 事件命名 | `agent.message`、`session.status_idle`、`agent.custom_tool_use`、`user.interrupt` 等（`agent.` 前缀） | `message`、`tool_call/tool_call_output`、`mcp_call/mcp_call_output`、`session_status`、`tool_approval_request/response`、`error` |
| 空闲判断 | `session.status_idle` + `stop_reason`（`requires_action` 表示等待 custom tool） | `session_status` + `stop_reason`（`null`/`end_turn`/`retries_exhausted`/`requires_action`） |
| 审批机制 | custom tool 权限策略 | `always_ask` 工具 → `tool_approval_request` → `requires_action` → `tool_approval_response`（`batch_id`+`call_id`） |
| 中断 | `user.interrupt` | `interrupt` |
| SSE 断点续传 | `Last-Event-ID` | 事件历史分页补偿（`GET /events`，`types`/`order`/`page`） |

> 结论：两平台事件模型语义相似但**字段名不同**，接入层（Node 后端）不可照搬，需分别适配。

### 1.7 文件与归档
| 维度 | 火山方舟 | 阿里云百炼 |
|---|---|---|
| 产物持久化 | 挂载私有 TOS 桶（自主生命周期，30 天） | Files（保留 30 天，超期可能清理）→ 需转存自有 OSS |
| 平台默认清理 | 默认公共 TOS 约 7 天自动删除 | Files 30 天保留，硬删除不可恢复、不支持归档 |
| 挂载路径 | 映射到沙箱指定目录 | 自动加前缀 `/mnt/session/uploads`（`/workspace/x` → `/mnt/session/uploads/workspace/x`） |
| 容量限制 | 私有 TOS 无平台级 10MB/文件限制 | 单文件 ≤10MB、工作空间 100GB |

### 1.8 功能差异对本项目落地的影响（小结）
| 环节 | 火山方舟 | 阿里云百炼 |
|---|---|---|
| leyosys 取数鉴权 | 会话环境变量直注入，Skill 直连（一期） | 改为 MCP/Node 回调，沙箱不接触凭据 |
| 用户级元数据 | Memory Store 每用户一库 | Node 后端 Redis/DB 自建 |
| 规则热更新 | 两平台一致：业务侧规则配置源实时拉取，不依赖平台记忆 |
| 报告归档 | 私有 TOS 直接挂载 | Files → 转存自有 OSS |
| 事件/审批对接 | 适配 `agent.*` 事件 | 适配 `session_status` / `tool_*` 事件 |

### 1.9 并发与资源池扩容（1000 会话在线场景）
先澄清一个口径：**「1000 会话同时在线」≠「1000 会话同时 running」**。两平台都按 running 时长计费、idle 不计费；常驻会话在 idle 时既不占模型并发、也不产生运行成本。真正压到资源的是 running 会话数及其触发的模型 RPM/TPM、沙箱调度。

| 维度 | 火山方舟 | 阿里云百炼 |
|---|---|---|
| 企业版扩容 | ArkClaw 企业版「席位制」，单席位含固定 CPU/内存/存储/网盘，5 席位起，购买更多席位即扩充资源池 | **无 Managed Agents 企业版 / 席位制** |
| 标准版扩容途径 | 按量（方舟 MA），按实际 running 计费，无明显会话数硬上限 | 按量（agentstudio），官方计费页明确「不限会话数」；瓶颈不在会话数，而在模型限流 |
| 限流口径 | 工具按调用次数计费；模型限流以火山方舟为准 | **主账号维度 + 模型独立** 的 RPM/TPM 限流（账号下所有子账号/业务空间/API Key 合并计算） |
| 提额方式 | ArkClaw 席位扩资源；按量额度以火山控制台为准 | ① 控制台「限流提额」自助提升**临时 TPM**（立即生效，30 天有效，支持华北2北京/新加坡）；② 长期大规模需求联系商务经理提额 |
| 业务侧配合 | 同一 Session 不支持并发两消息，后端排队/拒绝 | 同一 Session 同样需排队；客户端建议两级控制（RPM 令牌桶 + 并发信号量）平滑请求 |

> 特别注意：百炼的「Token Plan 团队版」也有「座席」概念（标准/高级/尊享座席），但那是面向 Claude Code / Codex / Qoder / OpenClaw 等 AI 编程工具的 Credits 订阅，**不是 Managed Agents（agentstudio）的席位**，二者不能混用。Managed Agents 的扩容本质是「提限流额度」而非「买席位」。

> 结论：要支撑 1000 会话在线，火山可走 ArkClaw 席位扩容资源池，百炼没有对等席位产品，只能靠**限流提额 + 后端排队**。按本项目「一人一会话、多数时刻 idle、单用户串行」的模型，1000 常驻会话的瞬时并发 running 通常远小于 1000，百炼的主账号 RPM/TPM 提额一般能覆盖；若确有百级并发 running 且模型限流吃紧，需走商务经理提额并做业务侧限流。

---

## 二、计费对比

### 2.1 计费模型（结构）
两平台均采用「**运行时 + 模型 + 工具**」三部分独立计费，但具体口径略有差异：

| 计费项 | 火山方舟（按量） | 阿里云百炼（按量） |
|---|---|---|
| 运行时 | Agent 运行时时长（沙箱） | 会话运行时费（运行中计费，空闲不计费） |
| 模型 | 调用模型的 Token | 调用模型的 Token |
| 工具 | 工具调用次数（内置工具按次计费；自定义 Skill 无平台调用费） | 工具及 MCP 调用费（按所调用工具/MCP 实际标准） |
| 免费额度 | 需查官方「Managed Agents 计费」页 | 商业化后赠送 10 小时运行时额度 |

### 2.2 单位价格对比（已核实项 + 待核实项）
| 计费项 | 火山方舟 | 阿里云百炼 |
|---|---|---|
| 运行时 | 方案文档按 **0.5 元/小时** 估算；确切单价需以火山官方「Managed Agents 计费」页为准 | **0.5 元/小时**（官方计费说明，已核实） |
| 模型（常规档） | `doubao-seed-2.1-turbo`：输入 3 元/百万、输出 15 元/百万；缓存命中输入 0.6 元/百万 | `qwen-plus`：输入 4 元/百万、输出 12 元/百万 |
| 工具调用 | 内置工具按调用次数计费；自定义 Skill 免费 | 工具/MCP 按实际标准单独计费 |
| 记忆/凭据 | Memory Store / Vault 公测阶段免费（方案口径） | 无平台侧 Memory Store/Vault，不产生该项费用 |
| 文件/对象存储 | 私有 TOS 约 0.0015 元/GB/小时（≈1.08 元/GB/月） | Files 平台保留 30 天；长期归档转自有 OSS（按 OSS 定价） |
| 商业化时间 | 待官方公告 | 2026-08-17 起正式商业化，赠 10 小时运行时额度 |

> 说明：模型单价随版本/地域/缓存命中变化，上表为常用档位的公开按量价，落单前以两平台控制台「模型价格」页为准。

### 2.3 1000 人规模月度成本估算对比（参考）
统一假设：1000 名用户、人均日 2 次、单次运行 5 分钟、单次合计 10k token（约 70% 输入 / 30% 输出）。

| 计费项 | 火山方舟（估算） | 阿里云百炼（估算） |
|---|---|---|
| 运行时 | 1000×2×30×5min = 5000 小时 → 约 2500 元 | 同左 → 约 2500 元 |
| 模型 | 60 万次 × 10k = 6 亿 token；输入 4.2 亿、输出 1.8 亿：约 1260 + 2700 = **约 3960 元** | 同量：约 1680 + 2160 = **约 3840 元** |
| 工具 | 自定义 Skill 免费（暂不计内置工具） | 工具/MCP 调用费待实测 |
| 归档存储 | 30 天约 6GB：约 7 元 | 自有 OSS 约 6GB：约数元 |
| **量级** | **约 6500 元/月（不含工具）** | **约 6400 元/月（不含工具/MCP）** |

> 对比结论：
> 1. **运行时费用两平台一致**（均按运行时长计费，本项目约 2500 元/月是大头）。
> 2. **模型费用量级接近**：`doubao-turbo` 输入更便宜、`qwen-plus` 输出更便宜；若火山侧命中上下文缓存，doubao 输入可低至 0.6 元/百万，模型成本可显著下降。
> 3. 真正拉开差距的是**工具/MCP 调用费**：百炼明确对工具/MCP 单独计费，火山自定义 Skill 免费但内置工具按次计费，具体取决于最终取数/规则能力的落地形态，需 POC 实测后才有可比结论。
> 4. 上述「模型约 3900 元」为按 70/30 输入输出的粗算，与两份方案文档里更保守的「数百元/约 360 元」存在差异；原因是方案文档按较低 token 单价口径估的，正式立项建议用 2.2 的单价比对重新核算。

### 2.4 企业版 / 预付费（可选）
| 维度 | 火山方舟 ArkClaw 企业版 | 阿里云百炼 |
|---|---|---|
| 计费方式 | 席位制预付费，5 席位起 | 无对应席位制 |
| 单席位月费 | Starter 210 / Standard 430 / Premium 860 / Ultimate 1720 元/月 | - |
| 模型费 | 席位费不含模型，需另购 Agent Plan | - |

> ArkClaw 适合规模化、包年包月的长期生产；本项目 1000 人按量（方舟 MA 标准版）在测算口径下更灵活，是否切企业版需按实际席位复用率另行评估。

### 2.5 计费侧选型小结
1. **运行时费无差异**：两平台均为 0.5 元/小时口径，本项目约 2500 元/月，是主要成本项，优化手段相同（及时回到 idle、减少空转）。
2. **模型费因选型而异**：火山 doubao 缓存命中更便宜，百炼 qwen-plus 输出更便宜，需按真实 token 分布测算。
3. **工具/MCP 费是百炼的相对不确定项**：若 leyosys 取数改为 MCP，会新增 MCP 调用费；火山自定义 Skill 则无该项。这是百炼方案相对火山的潜在成本增量，需 POC 实测。
4. **长期记忆与归档**：火山 Memory Store/私有 TOS 与百炼 Node 自建 + 自有 OSS 成本量级都较低（元/月），不构成选型决定性因素。

---

## 参考文档
- 火山方舟：[Managed Agents 概述](https://console.volcengine.com/ark/region:cn-beijing/docs/82379/2553713?lang=zh)、[Tools](https://ark.volcengine.com/region:cn-beijing/docs/82379/2553719?lang=zh)、[启动 Session](https://ark.volcengine.com/region:cn-beijing/docs/82379/2553723?lang=zh)、[使用 Vaults 认证](https://ark.volcengine.com/region:cn-beijing/docs/82379/2553726?lang=zh)、[查询凭证列表](https://console.volcengine.com/ark/region:cn-beijing/docs/82379/2555963?lang=zh)
- 阿里云百炼：[Managed Agents API 总览与认证](https://help.aliyun.com/zh/model-studio/managed-agents-api-overview)、[会话事件流（SSE）](https://help.aliyun.com/zh/model-studio/managed-agents-event-stream)、[管理会话](https://help.aliyun.com/zh/model-studio/managed-agents-session-operations)、[文件上传与挂载](https://help.aliyun.com/zh/model-studio/managed-agents-file)、[文件 API](https://help.aliyun.com/zh/model-studio/files-api/)、[Managed Agents 计费说明](https://help.aliyun.com/zh/model-studio/managed-agents-billing)
