# 项目需求：Node.js 后端服务，对接火山方舟 Managed‑Agents（火山引擎 Ark）
技术栈：Node.js + Express + ioredis，使用 axios 调用方舟 Open‑API，不引入第三方方舟SDK。

## 官方参考文档（遇到API参数、字段定义疑问时，以官方文档为准）
- Managed Agents 总览：https://docs.volcengine.com/docs/82379/2553713
- 快速入门（代码接入）：https://docs.volcengine.com/docs/82379/2553715
- 创建会话 API 文档：https://docs.volcengine.com/docs/82379/2555932
- Session 事件流 / 发送消息接口：https://docs.volcengine.com/docs/82379/2555933
- 环境覆写（environment_with_overrides）相关说明以官方文档为准。
- 服务地域：华北（北京），Base URL：https://ark.cn-beijing.volces.com/api/v3

## 业务架构目标
1、前端Web端发起请求，请求携带前端用户鉴权token。
2、本阶段不接入真实 auth-service，也不解析 userId。前端传入的 webUserToken 作为 MVP 阶段的用户身份标识。
3、维护 Redis 映射关系：tokenHash <-> ark sessionId，实现：
   - 对同一个 webUserToken，优先复用上一次创建出来的 Ark Session；
   - 不存在会话时，调用方舟 API 新建 Session；
   - tokenHash 使用 SHA-256(webUserToken) 生成，Redis 中不保存原始 Token。
4、创建 Session 时，使用 environment_with_overrides 覆写模式，基于一份固定的基础 environment_id，会话级别注入：
   - USER_ID：MVP 阶段使用 tokenHash 作为临时用户标识；
   - USER_BEARER_TOKEN：当前 webUserToken；
   给沙箱 Skill 读取。
5、沙箱内Skill代码通过 os.getenv() 读取该会话独有的鉴权变量，自行发起外部接口请求，不需要后端中转代理；
6、多人会话天然隔离：每个userId对应独立session、独立沙箱Sandbox；
7、Session一旦创建成功，中途不能修改沙箱环境变量；鉴权token刷新时后端主动重建新Session。

## 火山方舟Managed‑Agents 关键API约束（必须严格遵守）
1、Agent 和 Environment 已经提前在火山方舟控制台创建完成，得到固定常量 agentId、baseEnvironmentId。
2、创建Session接口地址：POST https://ark.cn-beijing.volces.com/api/v3/sessions
3、认证头 Authorization: Bearer ${ARK_API_KEY}
4、禁止顶层字段 environment_id；必须使用复合字段 environment (type="environment_with_overrides")
5、environment_with_overrides.config.env 是**全量替换，不是增量合并**。基座环境我们控制台env为空；所有环境变量全部由后端在创建会话时传入，无需拉取基座环境合并。
6、创建会话支持可选自定义id字段指定sessionId，不指定则由方舟自动生成session‑id。
7、发送消息/事件接口：POST /api/v3/sessions/{session_id}/events，流式返回Agent回答。
8、沙箱空闲超时后容器回收：内存变量丢失；/workspace 文件快照可保留30天。

## Redis 设计
- Key命名规则：ark:session:map:{tokenHash}
- tokenHash：SHA-256(webUserToken)
- Value：方舟 sessionId 字符串
- Redis 中不保存原始 webUserToken
- Redis 缓存过期时间：25天（小于沙箱快照最大30天生命周期，到期后需要重新创建 Session）

## 需要开发的接口
1. POST /api/agent/chat
入参Body：
{
  "webUserToken": "前端传来用户token",
  "userMessage": "用户发送给Agent的对话文本"
}
输出：流式返回Agent响应内容。

业务处理流程：
①校验 webUserToken 是否存在，并计算 tokenHash = SHA-256(webUserToken)；
②查询 Redis：ark:session:map:{tokenHash}
    Case1：查到sessionId
        -> 调用events接口复用该会话发送消息；
    Case2：Redis无会话
        -> 请求方舟创建Session，传入environment_with_overrides，注入环境变量 USER_ID(USER_ID = tokenHash)、USER_BEARER_TOKEN（USER_BEARER_TOKEN=webUserToken）
        -> 将返回sessionId写入Redis映射
        -> 使用新建sessionId发送events消息，流式返回对话
③返回流式结果给前端。

2. POST /api/agent/rebuild-session
手动强制为某个 webUserToken 对应的用户重建全新会话。

请求传入 webUserToken，后端计算 tokenHash 后删除对应的 Redis Session 映射，再创建新的 Ark Session，并使用新的 webUserToken 注入 USER_BEARER_TOKEN。

该接口主要用于 MVP 阶段验证 Session 重建流程，后续接入 auth-service 后可继续复用。

## 配置文件
使用 .env 文件保存常量：
ARK_API_KEY=
ARK_AGENT_ID=
ARK_BASE_ENVIRONMENT_ID=
REDIS_URL=
PORT=

## 代码要求
1、使用 Express，ioredis；axios调用方舟API；
2、支持Server‑Send‑Events(SSE)流式输出回答；
3、代码加上详尽注释；区分生产代码和调试代码；
4、单独抽离方舟请求工具函数：createArkSession、sendSessionEvent；
5、错误处理：方舟API调用失败捕获异常；Redis异常捕获；
6、不要把ARK_API_KEY暴露给前端；鉴权全部在后端完成；
7、提供启动示例、Postman测试curl、项目readme文档；
8、不要引入火山方舟官方SDK，纯HTTP接口调用实现。

## 额外注意事项
- 同一个session不能并发发送两条消息；后端不需要实现排队锁，代码中注释提醒该风险；
- 环境变量仅创建session那一刻注入，运行期间无法修改沙箱操作系统环境变量。

## MVP 边界

当前版本只验证：

webUserToken
    ↓
tokenHash
    ↓
Redis Session 映射
    ↓
Ark Managed Agent Session
    ↓
environment_with_overrides
    ↓
USER_BEARER_TOKEN
    ↓
Sandbox Skill
    ↓
业务 API

暂不实现 Token → userId 的真实鉴权逻辑。

后续接入独立 auth-service 后，将：

webUserToken
    ↓
auth-service
    ↓
userId
    ↓
Session 映射

当前 Session 管理逻辑应尽量与“如何获取用户身份标识”解耦，方便后续替换。