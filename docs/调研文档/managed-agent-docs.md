# 火山引擎 Managed Agents 官方文档索引
> 按本技术方案模块分类，可直接复制使用；均为火山引擎官方文档中心链接

## 一、核心总览 & API 总入口
| 文档名称 | 官方链接 | 说明 |
|---|---|---|
| 火山方舟 Managed Agents 产品总览 | [https://www.volcengine.com/product/ark](https://www.volcengine.com/product/ark) | 产品能力、模型定价、场景介绍总入口 |
| API 总文档 & 鉴权说明 | [https://docs.volcengine.com/docs/82379/1099475](https://docs.volcengine.com/docs/82379/1099475) | Base URL、鉴权方式、通用接口规范 |

## 二、Agent 与会话管理（核心流程）
| 文档名称 | 官方链接 | 说明 |
|---|---|---|
| 创建智能体 Agent | [https://docs.volcengine.com/docs/82379/2555910](https://docs.volcengine.com/docs/82379/2555910) | Agent 创建API、模型配置、Skill/工具参数定义 |
| 创建会话 Session | [https://docs.volcengine.com/docs/82379/2555932](https://docs.volcengine.com/docs/82379/2555932) | 会话创建API、资源挂载、环境变量覆写、模型参数覆写 |
| 流式获取会话事件（SSE） | [https://docs.volcengine.com/docs/82379/2555946](https://docs.volcengine.com/docs/82379/2555946) | SSE 协议说明、事件列表、断点续传、心跳机制 |
| Session 事件流总览 | [https://docs.volcengine.com/docs/82379/2553725](https://docs.volcengine.com/docs/82379/2553725) | 事件类型说明、重连机制、发送用户事件规范 |
| 发送会话事件 | [https://docs.volcengine.com/docs/82379/2555937](https://docs.volcengine.com/docs/82379/2555937) | 用户消息、中断指令等事件的发送格式 |

## 三、Memory Store 持久化记忆
| 文档名称 | 官方链接 | 说明 |
|---|---|---|
| 持久化记忆 Memory Store 总览 | [https://docs.volcengine.com/docs/82379/2553728](https://docs.volcengine.com/docs/82379/2553728) | 基本概念、挂载方式、读写权限、配额限制 |
| 创建/更新记忆库 API | [https://docs.volcengine.com/docs/82379/2555971](https://docs.volcengine.com/docs/82379/2555971) | Memory Store 管理API、metadata配置 |
| 查询记忆条目 API | [https://docs.volcengine.com/docs/82379/2555975](https://docs.volcengine.com/docs/82379/2555975) | 记忆条目列表查询、目录浏览、分页参数 |
| Memory Store 最佳实践教程 | [https://docs.volcengine.com/docs/82379/2604771](https://docs.volcengine.com/docs/82379/2604771) | 用户级记忆构建、读写流程、场景化示例 |

## 四、Vault 凭据管理
| 文档名称 | 官方链接 | 说明 |
|---|---|---|
| 使用 Vaults 认证 | [https://ark.volcengine.com/docs/82379/2553726](https://ark.volcengine.com/docs/82379/2553726) | Vault 核心机制、凭据类型、与Session/MCP的配合方式 |
| Vault 进阶集成教程 | [https://docs.volcengine.com/docs/82379/2604773](https://docs.volcengine.com/docs/82379/2604773) | Vault + Memory 完整投研Agent示例，包含创建、挂载、调用全流程 |

## 五、自定义模型 & ArkClaw 企业版
| 文档名称 | 官方链接 | 说明 |
|---|---|---|
| 调整/配置推理模型（自定义模型） | [https://www.volcengine.com/docs/87732/2270242](https://www.volcengine.com/docs/87732/2270242) | ArkClaw企业版自定义三方模型配置步骤、协议要求、备选模型 |
| 模型管理（自定义模型池） | [https://www.volcengine.com/docs/87732/2425279](https://www.volcengine.com/docs/87732/2425279) | 企业级模型池管理、自定义模型池配置、限流配置 |

## 六、Skill / 工具 / MCP
| 文档名称 | 官方链接 | 说明 |
|---|---|---|
| MCP 接入说明 | [https://ark.volcengine.com/docs/82379/2553718](https://ark.volcengine.com/docs/82379/2553718) | MCP协议工具接入、与Vault凭据配合、Agent层配置 |
| 内置工具 web_search / web_fetch | [https://docs.volcengine.com/docs/82379/2553720](https://docs.volcengine.com/docs/82379/2553720) | 内置联网工具能力、调用方式、配额说明 |

## 七、知识库 RAG（独立产品）
| 文档名称 | 官方链接 | 说明 |
|---|---|---|
| 知识库计费说明 | [https://www.volcengine.cn/docs/82379/1263336](https://www.volcengine.cn/docs/82379/1263336) | 标准版/旗舰版计费项、单价、计费触发条件 |
| 知识库插件功能说明 | [https://docs.volcengine.com/docs/82379/1528458](https://docs.volcengine.com/docs/82379/1528458) | 与Managed Agents集成方式、文档处理能力、配额限制 |
| 知识库常见问题 | [https://docs.volcengine.com/docs/84313/1606319](https://docs.volcengine.com/docs/84313/1606319) | 计费边界、资源清理、配额限制等常见问题 |

## 八、计费与价格
| 文档名称 | 官方链接 | 说明 |
|---|---|---|
| 模型价格总览 | [https://www.volcengine.com/product/ark](https://www.volcengine.com/product/ark) | 各模型输入输出单价、上下文缓存价格 |
| 知识库计费 | [https://www.volcengine.cn/docs/82379/1263336](https://www.volcengine.cn/docs/82379/1263336) | 知识库计算、存储、向量模型详细单价 |

## 九、快速入门与最佳实践
| 文档名称 | 官方链接 | 说明 |
|---|---|---|
| 快速入门（代码） | [https://docs.volcengine.com/docs/82379/2553714](https://docs.volcengine.com/docs/82379/2553714) | Python SDK 快速上手、Session创建、事件流监听示例 |
| 连续对话工单分诊助手教程 | [https://docs.volcengine.com/docs/82379/2598398](https://docs.volcengine.com/docs/82379/2598398) | 会话管理、SSE事件处理、多轮对话最佳实践 |
| 数据分析Agent教程 | [https://docs.volcengine.com/docs/82379/2604769](https://docs.volcengine.com/docs/82379/2604769) | 文件处理、报告生成、SSE观测完整流程示例 |