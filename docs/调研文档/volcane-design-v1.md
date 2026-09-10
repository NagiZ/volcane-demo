# 火山引擎 Managed Agents 技术方案设计 - 能力清单 & 接入方式汇总
> 适用架构：Node.js 自研后端 + Web前端
> 用途：技术方案评审、开发设计参考
> 说明：本内容基于本次对话整理，配套独立价格汇总markdown文档

## 一、核心架构总览
Web前端 → 自研Node.js业务服务 → 火山Managed Agents REST API + SSE流式事件
1. Node服务职责：用户鉴权、资源映射管理、事件转发、自定义Tool回调处理、MemoryStore写入、Vault生命周期管理
2. 火山MA侧：Agent调度、大模型推理、沙箱运行、Skill执行、会话管理、MemoryStore、Vault凭据库、文件托管
3. 通信协议说明
    - 管理类接口：REST（创建Session/Vault/MemoryStore/文件上传），可使用火山Node.js通用OpenAPI SDK
    - 会话事件流：SSE `POST /sessions/{id}/stream`，单向推送（服务端→后端），**非WebSocket**
    - 用户消息提交：独立POST接口 `/sessions/{id}/events`，消息不能在SSE流内发送

---

## 二、功能点、接入方式与约束汇总表

### 1. Agent基础管理
|功能点|接入方式|约束/备注|
|---|---|---|
|新建Agent（SystemPrompt、Skill集合、基础模型配置）|火山方舟控制台创建Agent，获取`agent_id`；也支持API创建Agent|Agent绑定推理模型；ArkClaw企业版可配置自定义三方模型；普通版本仅可选用方舟模型广场上架模型|
|自定义三方大模型作为Agent底层推理模型|ArkClaw企业版（Agent Plan/Coding Plan）控制台新建自定义模型池（兼容OpenAI协议），绑定至Agent；创建Session无需修改参数|硬性前提：模型支持OpenAI标准`tool_call`函数调用；BaseURL必须带`/v1`；火山无接入费，模型token费用结算给第三方厂商；火山平台公网可访问模型地址；仅支持1个企业统一API Key的模型池|
|多用户复用同一Agent模板，用户之间隔离|创建Session时传入同一个`agent_id`，不同用户使用独立Session+独立Vault+独立MemoryStore|Agent模板全局复用；用户隔离依靠Session/Vault/MemoryStore资源隔离实现|

### 2. Session会话 & 沙箱（核心模块）
|功能点|接入方式|约束/备注|
|---|---|---|
|创建沙箱会话Session|Node后端调用 `POST /api/v3/sessions`，挂载vault_ids、memory_store、metadata、environment参数|**vault_ids、memory_store资源仅创建Session时挂载，会话运行期间不支持修改**|
|业务用户与会话/凭证/记忆资源绑定|自建业务映射表 `user_agent_bind`：biz_user_id ↔ vault_id ↔ memory_store_id ↔ default_session_id；Vault、MemoryStore创建时，metadata写入业务user_id；Session metadata存入biz_user_id（沙箱不可读，仅后端可读）|推荐同一业务用户复用同一个session_id；session对象永久保存；沙箱会被平台自动回收|
|会话沙箱生命周期管理|Session本身永久保留；沙箱仅`running`状态计费（0.5元/小时），idle空闲不计费；30天无活跃自动销毁沙箱；复用原有session_id会自动重建沙箱，无需新建session|沙箱销毁 ≠ session删除；重建沙箱会自动重新挂载Vault、MemoryStore资源|
|会话流式事件监听（消息、tool调用、状态变更）|Node后端作为SSE客户端，请求`POST /sessions/{session_id}/stream`；标准`text/event-stream`；支持`Last-Event-ID`断点续传|事件类型：`agent.message`、`custom_tool_use`、`session.status_idle`；收到`session.status_idle`代表一轮问答结束；单向流，不可发送用户提问|
|提交用户消息至会话|独立POST接口 `POST /sessions/{session_id}/events` 提交user事件|中断当前问答任务：发送`user.interrupt`事件，中止本轮任务，**不销毁沙箱、不删除session**|
|会话历史存储与读取|平台自动持久化会话事件流，业务侧可不存储；API拉取会话消息，长会话场景需要分页拉取|会话事件存储免费；历史内容过长时，模型侧自动摘要压缩，并非简单截断|

### 3. 会话环境变量 & Skill鉴权
|功能点|接入方式|约束/备注|
|---|---|---|
|静态环境配置（固定环境变量）|控制台创建environment环境，配置基础环境变量|静态环境固定，无法按用户动态修改|
|单次Session覆写环境变量（用户维度动态参数、鉴权token供给Skill读取）|创建Session的API请求传入`environment_with_overrides`，覆写/新增环境变量|可覆盖已有静态环境变量，也可新增变量；**仅当前session生效；控制台手动新建会话无法传入覆写参数，只能API创建session注入**|
|Skill读取环境变量鉴权|沙箱内Skill代码直接读取环境变量；鉴权token通过session环境覆写注入沙箱|适合Skill内部直接发起http请求，不需要转发请求到自研后端；token会随沙箱重建重新注入|

### 4. 凭证管理 Vault
|功能点|接入方式|约束/备注|
|---|---|---|
|创建用户独立Vault凭证库|Node后端API创建Vault，metadata绑定业务user_id；写入用户鉴权凭据（environment_variable / static_basic_auth）；创建session时挂载vault_ids|Vault密钥**只写不可读，API无法获取原始密钥**；单个Vault最多20条凭据；公测阶段免费；删除Vault，内部凭据全部失效|
|Vault凭据自动注入沙箱|Session挂载Vault，沙箱运行时平台自动将凭据注入沙箱环境；Skill内直接读取，原始密钥不会暴露在事件流|沙箱内部密钥无法透出到事件回调层，仅沙箱内skill可以访问|

### 5. MemoryStore（Agent原生轻量持久记忆，跨沙箱）
|功能点|接入方式|约束/备注|
|---|---|---|
|创建用户独立MemoryStore|Node后端API创建MemoryStore，metadata绑定业务user_id；创建session时作为resources挂载，推荐设置read_only|公测免费；配额：单条最大100KB，单个MemoryStore最多2000条UTF8文本，不支持二进制文件|
|Skill读取记忆数据|沙箱内挂载 `/mnt/memory/`，skill读取`user_profile.json`等文件，只读模式|read_only模式下Skill**不能写MemoryStore**；写操作统一由Node后端调用MemoryStore API执行，防止记忆被篡改|
|后端更新/写入记忆（用户偏好、文件索引、个性化参数）|Node后端调用MemoryStore API执行增删改；支持API导出记忆数据，用于离线数据分析|记忆独立生命周期：删除session、销毁沙箱不会删除MemoryStore；删除MemoryStore，该用户记忆清空|

### 6. 文件能力（上传、挂载、生成、下载）
|功能点|接入方式|约束/备注|
|---|---|---|
|文件上传、挂载到会话沙箱|Files API上传文件；创建会话/会话运行阶段挂载文件至沙箱；会话列表接口**不能直接读取会话内文件**，需要调用Files专用接口查询文件信息|文件返回临时签名`download_url`，可提供前端下载使用|
|Agent沙箱内生成输出文件|Skill代码写入`/mnt/session/outputs`目录|方舟公共TOS：文件免费保存7天自动删除；挂载私有火山TOS桶，文件存入自有TOS，按TOS标准计费0.0015元/GB/小时|
|挂载私有火山TOS桶到沙箱|创建Session时在resources配置TOS挂载，映射至沙箱目录|适合大文件、长期存储场景；沙箱读写自有对象存储桶，文件生命周期由TOS桶策略控制|

### 7. Tool / Skill 能力
|功能点|接入方式|约束/备注|
|---|---|---|
|内置Skill（bash、本地文件读写等）|Agent控制台勾选启用，无需额外开发|内置技能仅消耗沙箱运行时长，无单独平台调用费|
|内置联网工具 web_search / web_fetch|Agent开启对应工具，模型自主触发调用，平台执行搜索抓取|业务预估成本1元/次；新账号赠送免费额度500次web_search；调用消耗平台工具费用|
|自定义工具 custom_tool_use（回调自研Node后端）|Agent控制台注册custom tool；模型判定调用工具时，平台通过SSE推送`custom_tool_use`事件到Node服务；Node执行业务逻辑，将结果回传给火山会话事件接口|**平台不收取自定义工具调用费；仅消耗模型token + 沙箱运行时长**|
|MCP协议工具|控制台Agent配置接入MCP工具，平台负责调度；MCP服务自身独立计费，平台不加价|MCP工具在Agent控制台配置|

### 8. 知识库RAG（独立产品，与MemoryStore区分）
|功能点|接入方式|约束/备注|
|---|---|---|
|火山方舟知识库RAG能力|两种接入方式：①Agent自定义工具调用知识库API；②Agent官方知识库插件集成|知识库独立计费（计算资源+存储+向量+重排模型），和MA费用叠加；**仅删除文档不会停止计费，删除整个知识库才停止计费**；和MemoryStore是两套独立存储，不可混淆|

### 9. SDK选型（Node后端）
|SDK/API类型|用途|说明|
|---|---|---|
|火山通用OpenAPI Node.js SDK|Vault、MemoryStore、Files、知识库等资源管理API|✅可用；内置火山签名逻辑|
|ArkRuntime MA专用SDK|封装SSE事件消费、事件解析；支持Python / Java / Go|❌无官方Node.js版本，Node项目不可直接使用|
|裸REST + SSE手写（Node）|创建session、提交事件、SSE事件流监听、custom_tool回调处理|Node项目必须手写SSE客户端、断点续传、事件分发逻辑|

## 三、计费摘要（完整明细见独立price.md）
1. 模型推理：按输入/输出token计费；自定义三方模型火山不收通道费，token费用结算给第三方厂商
2. Agent沙箱运行：0.5元/小时，仅running状态计费
3. web_search/web_fetch：业务预估1元/次
4. MemoryStore、Vault：公测阶段免费
5. 文件存储：公共TOS免费7天；私有TOS：0.0015元/GB/小时
6. 知识库：独立按量计费（计算、存储、向量、重排模型）
7. 新账号赠送额度：30小时Agent运行时长、500次web_search，有效期2年

## 四、风险与限制汇总（方案评审重点）
1. Session挂载资源不可动态变更：vault_ids、memory_store一旦创建session后无法修改，变更资源必须新建session
2. SSE长连接容易被Nginx/代理超时断开，必须实现`Last-Event-ID`断点续传、自动重连逻辑
3. 自定义三方模型强依赖`tool_call`输出质量，JSON格式错误会直接中断Agent工具调度循环
4. MemoryStore配额限制，适合小体量结构化用户偏好存储；大容量文档检索场景使用独立知识库
5. 单个Vault最多20条凭据；大量用户场景不建议单vault存放多用户凭据，推荐**一用户一Vault**
6. 沙箱销毁不会删除session、vault、memory_store，业务层需要实现资源生命周期清理逻辑（过期用户资源删除）
7. session内metadata沙箱内不可读，仅后端可读取，适合存放业务用户映射信息

## 五、业务主流程时序图文字版
1. Web前端携带业务token请求Node后端，Node解析得到`biz_user_id`
2. Node查询业务映射表 `user_agent_bind`
    - 无记录：调用API创建Vault、写入用户鉴权凭据；创建MemoryStore；资源信息写入业务数据库
    - 已有记录：取出`vault_id`、`memory_store_id`、`default_session_id`
3. 判断session
    - session为空：调用MA创建session API，挂载vault、memory_store、session metadata、环境变量覆写，保存session_id入库
    - session存在：直接复用已有session_id
4. Node提交用户消息事件（POST `/events`）
5. Node持续维持SSE长连接，监听事件流
    - `agent.message`：转发消息给前端
    - `custom_tool_use`：Node执行业务逻辑，结果回写火山事件接口
    - `session.status_idle`：标记本轮对话结束
    - 网络断开：使用Last-Event-ID断点续连
6. 如需更新用户记忆：Node后端调用MemoryStore API写入，沙箱设置只读，禁止Skill直接写记忆
7. 用户发起中断：Node发送`user.interrupt`事件终止当前轮次任务，沙箱保留