# Managed Agents 计费、预付费与订阅包抵扣关系

> 整理日期：2026-09-15
> 范围：阿里云百炼 Managed Agents、字节火山方舟 Managed Agents
> 说明：本文只回答计费和“个人版/企业版是否影响接入”的核心问题，不展开相邻产品的完整功能对比。

## 一、直接结论

| 问题 | 阿里云百炼 | 火山方舟 |
|---|---|---|
| Managed Agents 是否只支持后付费 | 是，官方计费页只定义按量后付费 | 是，官方计费页只定义按量后付费 |
| 是否有 Managed Agents 预付费模式 | 官方未提供运行时预付费/资源包 | 官方未提供运行时预付费/资源包 |
| Token Plan / Agent Plan / Coding Plan 的套餐 Credits 能否直接抵扣 Managed Agents | 不能 | 不能 |
| 企业版/团队版订阅能否抵扣 Managed Agents | 不能直接抵扣；火山侧也没有对应“Token Plan”产品 | 不能 |
| 是否存在“Managed Agents 个人版/企业版” | 不存在 | 不存在 |

## 一之一、TPM / RPM 上限与提额

### 阿里云百炼

官方限流页：<https://help.aliyun.com/zh/model-studio/rate-limit>

- 有 **RPM / TPM** 上限，按“主账号 + 模型”独立计算。
- 主账号下所有 RAM 子账号、业务空间、API Key 的调用量合并计算。
- 服务端可能还会按秒级 `RPS = RPM/60`、`TPS = TPM/60` 执行，短时突发即使未到分钟上限也可能被限流。
- 触发限流后通常 **1 分钟内自动恢复**，返回 `429`。
- 充值不会提升 RPM/TPM 默认阈值；当前官方页面的口径是：**需要更高额度请联系商务经理申请**。

常见触发报错：

| 报错 | 含义 |
|---|---|
| `Requests rate limit exceeded` / `You exceeded your current requests list` | RPM 限流 |
| `Allocated quota exceeded` / `You exceeded your current quota` | TPM 限流 |
| `Request rate increased too quickly` | 短时请求增速过快触发稳定性保护 |

默认值示例（北京地域，非全量，实际以控制台/文档为准）：

| 模型 | RPM | TPM |
|---|---:|---:|
| qwen-plus | 30,000 | 5,000,000 |
| qwen-plus-latest | 15,000 | 1,200,000 |
| qwen3.5-flash | 30,000 | 10,000,000 |
| qwen3.7-plus | 30,000 | 5,000,000 |
| qwen3.8-max / qwen3.8-flash | 动态限流 | 动态限流 |

对 Managed Agents 的影响：会话数量本身不构成硬上限，但会话内实际调用模型时，仍然受所选模型的账号级 RPM/TPM 限制。业务侧需要做排队、削峰、指数退避或备用模型分流。

### 火山方舟

官方突发流量处理页：<https://ark.volcengine.com/region:cn-beijing/docs/82379/1848593?lang=zh>

- 有 **TPM、RPM、TPD、IPM、Inflight Batchsize** 等限流指标。
- 模型级限流：同主账号、同模型（不区分版本）合并限流，**默认值不可手动调整**；需要更高额度通过工单提交提额申请。
- 推理接入点（Endpoint）限流：用户可在控制台自行调整，用于灵活控制某个应用的使用量。
- 触发限流返回 `429: Too Many Requests`。
- 同模型的多 Endpoint、多账号分流无效，因为底层共享同一资源池；跨模型分流有效。

火山主要限流指标：

| 指标 | 含义 |
|---|---|
| TPM | 每分钟可处理 token 量，含输入和输出 |
| RPM | 每分钟可发起请求数 |
| TPD | 每天可处理 token 量，多用于批量推理 |
| IPM | 每分钟可生成图片数量，面向生图模型 |
| Inflight Batchsize | 同账号同模型同时在处理中的请求数上限 |

提额/治理方式：

1. 模型级更高额度：**通过火山工单提交提额申请**。
2. Endpoint 级控制：控制台自行调整推理接入点限流。
3. 高保障业务：购买 **TPM 保障包** 或模型单元，获得确定性并发能力。
4. 突发流量：使用整流、队列、指数退避、`X-Ark-Max-Wait-Timeout-Ms` 排队 header、跨模型分流。

对 Managed Agents 的影响：Managed Agents 的模型调用费按所选模型的后付费 token 结算，因此同样受方舟模型服务限流约束；运行时按 `running` 时长计费，工具调用按次数计费。实际项目里除平台限流外，还要注意 **同一 Session 不支持并发发两条消息**，所以单用户会话通常串行执行。

## 口径澄清：豆包说的“Agent Plan 可抵扣 managed agent”怎么理解

这里要区分两种“managed agent”：

1. 如果指“运行在 Agent Plan / Token Plan 工具链里的智能体”，那订阅套餐确实按 AFP / Credits 抵扣模型、多模态、Harness 等用量。
2. 如果指平台产品名 `Managed Agents`，则不是一回事。火山的 Agent Plan 官方 AFP 抵扣清单里没有 `Managed Agents`，不能抵扣它的运行时、模型 token、工具调用；百炼的 Token Plan Credits 也不能直接抵扣 `Managed Agents`，只有个人版 Standard/Pro 的 Harness 权益能给 Managed Agent 按量账单打 88 折。

## 二、阿里云百炼

### 2.1 Managed Agents 计费

官方计费页：<https://help.aliyun.com/zh/model-studio/managed-agents-billing>

| 计费项 | 标准 |
|---|---|
| 会话运行时费 | 0.5 元/小时，仅在会话 `running` 时计费，空闲不计费 |
| 模型调用费 | 按实际调用模型的公开按量价格，单独计费 |
| 工具及 MCP 调用费 | 按实际调用工具/MCP 的标准，单独计费 |

赠送额度：

- 总计 10 小时运行时，不限会话数。
- 仅抵扣运行时费，不抵扣模型费和工具/MCP 费。
- 有效期 30 天。

结论：**当前官方没有 Managed Agents 的预付费模式或运行时资源包。**

### 2.2 Token Plan 与 Managed Agents 的关系

Token Plan 是阿里云百炼的订阅服务，分：

- 个人版：Lite / Standard / Pro。
- 团队版：标准座席 / 高级座席 / 尊享座席。

Token Plan 使用 `sk-sp-` 开头的专属 API Key 和 Token Plan Base URL，通过 Credits 抵扣模型调用。

关键关系：

- **Token Plan Credits 不能直接抵扣 Managed Agents 的运行时费、模型费、工具/MCP 费。**
- Managed Agents 必须使用百炼标准 API Key（`sk-` 开头）和标准 Base URL 接入。
- Token Plan 个人版 **Standard / Pro** 附赠 Harness 权益，其中“百炼全托管智能体 / Managed Agent”没有每月免费额度，但享受按量后付费 **88 折**；这个折扣只作用于 Managed Agents 的按量账单，不占用 Credits。
- Token Plan **团队版不支持 Harness 权益**，因此团队版订阅不能给 Managed Agents 带来免费额度或 88 折，也不能直接抵扣。

所以：

- “开企业版/团队版 Token Plan 直接用于 Managed Agent 消耗”：**不支持**。
- “开个人版 Standard/Pro Token Plan”：不能抵扣 Managed Agent，但可让 Managed Agent 的按量账单享受 88 折。

百炼文档还明确区分了两类 API Key：

- `sk-sp-`：Token Plan 专属 Key，仅用于模型 Credits 抵扣。
- `sk-`：百炼标准 Key，Managed Agents、Harness 服务等按量服务使用；系统会自动识别账号下的 Token Plan 订阅并应用附赠权益。

参考：

- Token Plan 概述：<https://help.aliyun.com/zh/model-studio/token-plan-overview>
- Harness 权益：<https://help.aliyun.com/zh/model-studio/token-plan-harness-benefits>
- Token Plan 团队版快速开始：<https://help.aliyun.com/zh/model-studio/token-plan-team-quickstart>

### 2.3 个人版/企业版接入差异

百炼 Managed Agents 本身没有个人版/企业版之分。

- 个人账号和企业账号都使用同一套控制台、REST API、CLI。
- 差异只来自工作空间权限，不来自产品版本。

## 三、火山方舟

### 3.1 Managed Agents 计费

官方价格页：<https://ark.volcengine.com/region:cn-beijing/docs/82379/1544106?lang=zh>

| 计费项 | 标准 |
|---|---|
| 模型调用费 | 按实际调用模型的常规在线推理 token 价格 |
| Agent 运行时费 | 0.5 元/小时，仅 `running` 状态计费 |
| 工具调用费 | `web_search` 0.02 元/次；`web_fetch` 限时免费 |

赠送额度：

- 首次开通赠送 30 小时运行时 + 500 次 `web_search`。
- 每账号仅一次，有效期 2 年。

结论：**当前官方没有 Managed Agents 的预付费模式或运行时资源包。**

### 3.2 火山订阅包与 Managed Agents 的关系

火山没有“Token Plan”，相关产品是：

| 产品 | 是否等于 Managed Agents | 能否抵扣 Managed Agents |
|---|---|---|
| Agent Plan 个人版 | 否 | 不能 |
| Coding Plan 个人版 | 否 | 不能 |
| ArkClaw 企业版 | 否，是预付费云端 OpenClaw Agent 服务 | 不能 |

说明：

- Agent Plan / Coding Plan 个人版是给 Claude Code、OpenClaw、Cursor 等 AI 工具使用的订阅包，不适用于 Managed Agents API。
- ArkClaw 企业版是独立的预付费云端智能体，和 Managed Agents 不是同一个产品，也不抵扣 Managed Agents 的后付费账单。
- Managed Agents 只能走火山方舟 API / 控制台，按量后付费。

火山 Agent Plan 的 AFP 抵扣范围包括文本生成、向量化、图片生成、视频生成、语音、豆包搜索、Agent 记忆、AI Native 应用开发底座、Agent 进化、Computer Use Agent 等；**该清单中没有 `Managed Agents`**。

### 3.3 个人版/企业版接入差异

火山 Managed Agents 本身没有个人版/企业版之分。

- 个人账号和企业账号使用同一套 `https://ark.cn-beijing.volces.com/api/v3` API 和控制台。
- 火山生态中的“个人版 Agent Plan / Coding Plan”和“ArkClaw 企业版”不是 Managed Agents，不能作为 Managed Agents 的个人/企业版本理解。

## 五、无历史业务时的选型建议

如果只是做“长时运行、多步工具调用、有状态会话”这类通用 Managed Agent，两平台功能确实接近；但如果结合本项目实际约束，推荐 **火山方舟**，优先级更高。

推荐火山的理由：

1. 会话级凭据注入更贴合一期架构：`environment_with_overrides` / Vault 能按用户隔离凭据；百炼公开 API 没有会话级环境变量注入，需要改走 MCP/后端回调。
2. Memory Store 是原生能力，可按用户挂载长期记忆；百炼 Managed Agents 没有对应原生 Memory Store，需要自建 Redis/DB。
3. 产物归档链路更短：火山可挂载私有 TOS；百炼 Files 有 10MB/文件、30 天保留等限制，通常还要转自有 OSS。
4. 两平台运行时单价相同，都是 0.5 元/小时；主要成本差异在模型选型和工具/MCP，需要 POC 后才知道最终账单。

适合选百炼的情况：

1. 业务本来就在阿里云体系内，或模型选择明显偏向 Qwen。
2. 不需要按用户注入凭据、不需要平台侧长期记忆，且文件归档可接受 Files + OSS 转存。
3. 对 Token Plan 个人版 Standard/Pro 的 Managed Agent 88 折后付费优惠有明确成本收益。

因此：无历史业务时，**默认选火山方舟做 POC**；如果 POC 阶段发现百炼在模型效果、提额体验或商务折扣上明显更优，再切换。

## 四、主要参考链接

- 阿里云百炼 Managed Agents 计费：<https://help.aliyun.com/zh/model-studio/managed-agents-billing>
- 阿里云百炼 Token Plan 概述：<https://help.aliyun.com/zh/model-studio/token-plan-overview>
- 阿里云百炼 Token Plan Harness 权益：<https://help.aliyun.com/zh/model-studio/token-plan-harness-benefits>
- 阿里云百炼 Token Plan 团队版快速开始：<https://help.aliyun.com/zh/model-studio/token-plan-team-quickstart>
- 火山方舟 Managed Agents 概述：<https://ark.volcengine.com/region:cn-beijing/docs/82379/2553713?lang=zh>
- 火山方舟模型价格页（含 Managed Agents 计费）：<https://ark.volcengine.com/region:cn-beijing/docs/82379/1544106?lang=zh>
- 火山方舟 Agent Plan 个人版：<https://ark.volcengine.com/region:cn-beijing/docs/82379/2366394?lang=zh>
- 火山方舟 Coding Plan 个人版：<https://ark.volcengine.com/region:cn-beijing/docs/82379/1925114?lang=zh>
- ArkClaw 企业版规格与计费：<https://docs.volcengine.com/docs/87732/2254730?lang=zh>
