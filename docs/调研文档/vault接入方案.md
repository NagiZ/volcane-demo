# 火山 Managed Agents（方舟MA）Vault凭据接入技术方案
> 背景：原有方案会话创建时明文在环境变量传递 `LEYO_AGENT_KEY`；改造目标：迁移至新版两层Vault API，敏感Token交由Vault托管，避免明文随会话参数传输。
> 业务场景：Skill支持执行代码，当前实现为Python Skill拉起Node子脚本发起外部HTTP请求。

## 一、Vault 核心模型（新版两层资源，必须分两次API创建）
### 资源结构
1. **Vault（保管库，vlt-xxxx）**：容器资源，仅用于分组，本身不存储密钥
    - API：`POST /api/v3/vaults`
    - 请求体仅传 `display_name`，返回 `vault_id`
2. **Credential（凭据，Vault子资源）**：存储真实密钥
    - API：`POST /api/v3/vaults/{vault_id}/credentials`
    - 类型选用：`environment_variable`（环境变量注入型凭据）
    - 关键字段：
        - `secret_name`：`LEYO_AGENT_KEY`（Skill读取的环境变量名，**大小写敏感**）
        - `secret_value`：原始业务Token
        - `networking`：控制出站占位符替换权限
            - MVP调试：`type: unrestricted` 不限制域名
            - 生产环境：`type: limited` + `allowed_hosts` 域名白名单（仅填写host，不带`https://`、url路径）

> 约束：
> - 单个Vault最多支持20条Credential；同Vault内`secret_name`不可重复（创建会返回409冲突）
> - 推荐架构：**1个业务Token对应1个独立Vault，Vault内仅存放1条Credential**
>   - 原因：多个业务需要同名`LEYO_AGENT_KEY`，不能放在同一个Vault；天然资源隔离，销毁时可直接删除整个Vault。

### 凭据生命周期API
| 操作 | API | 说明 |
| ---- | ---- | ---- |
| 创建Vault | `POST /api/v3/vaults` | 创建保管库容器 |
| 创建Credential | `POST /api/v3/vaults/{vaultId}/credentials` | 在Vault内写入密钥凭据 |
| 更新Credential | `PUT /api/v3/vaults/{vaultId}/credentials/{credId}` | 刷新Token；**已存在会话自动读取新密钥，无需重建Session** |
| 删除Vault | `DELETE /api/v3/vaults/{vaultId}` | 一键清理Vault下全部凭据；也可单独删除单条Credential |

## 二、创建会话（CreateSession）接入要点【重点踩坑项】
### ✅ 正确请求体
`vault_ids` 是**根层级数组字段，和environment平级，不能写在 `environment.config` 内部**，写在config内接口会直接忽略，Vault挂载失效。
```json
{
  "agent": "agent-xxxx",
  "environment": {
    "type": "environment_with_overrides",
    "id": "env-xxxx",
    "config": {
      "env": {
        "USER_ID": ""
      }
    }
  },
  "vault_ids": ["vlt-xxxx"],
  "title": "调试会话"
}
```
### 核心规则
1. 时序硬性要求：先创建 Vault + Credential，再新建会话
- 会话一旦创建，不会自动加载会话创建之后新增 / 修改的 Credential；老 Session 不会感知后续新增凭据。
2. 两套环境变量并行注入沙箱
- environment.config.env：明文普通环境变量，用于存放非敏感配置
- vault_ids挂载 Vault：注入environment_variable凭据，沙箱内拿到占位符
- 优先级：明文 env > Vault 注入变量；若两边存在同名 key，明文 env 会覆盖 Vault 占位符，Vault 出站替换机制直接失效。
- 最佳实践：明文 env 中不要定义LEYO_AGENT_KEY。
3. 会话挂载校验方式：调用GET /api/v3/sessions/{sessionId}，查看返回根级vault_ids；控制台 UI 不展示会话挂载的 vault_ids。

## 三、Vault environment_variable 运行机制
1. 沙箱 Python 主进程读取：os.getenv("LEYO_AGENT_KEY") → 获取占位符字符串 {{vault:xxxx}}
2. 安全机制：沙箱内永远无法获取原始 Token；仅当 HTTP 出站请求经过平台网关时，网关识别占位符并替换为真实 secret_value
3. 替换生效前提（两层网络策略必须同时放行目标域名，缺一不可）
- Credential 维度 networking 配置放行目标域名
- 会话绑定的 Environment（cloud 沙箱）networking 策略放行目标域名
4. 不同子进程行为差异
- ✅ Python 主进程直接requests、Python 拉起 curl 子进程：占位符{{vault:xxx}}原样保留，网关正常识别替换
- ⚠️ Python 拉起Node 子进程，Node 读取环境变量：沙箱自动把{{vault:xxxx}}改写为固定字符串SECRET_PLACEHOLDER，网关无法识别，密钥替换失效，鉴权失败

## 四、Node 子进程场景的可行实现方案（当前业务重点）
当前实现：Python Skill 拉起 Node 脚本发起 HTTP 请求
限制：Node 读取环境变量会自动脱敏为SECRET_PLACEHOLDER，破坏 Vault 占位符

1. 方案 A（推荐，生产首选）：Python Skill 内部直接发起 HTTP 请求
- 移除 Node 脚本调用逻辑，Python 使用 requests 完成外部接口调用
- Python 进程持有原始{{vault:xxx}}占位符，网关正常替换，不存在 Node 脱敏问题
2. 方案 B（仅临时调试可用，生产存在安全风险）：占位符通过命令行参数传递给 Node，不走环境变量
- Python 拿到{{vault:xxx}}，作为 subprocess 的 argv 参数传入 node 脚本
- Node 通过process.argv拿到原始占位符，组装 HTTP 请求头，不会被替换成 SECRET_PLACEHOLDER
- ⚠️ 风险：命令行参数会出现在系统进程列表，同机进程可查看占位符，生产环境不推荐。
❌ 不可行方案：将 Vault 占位符通过环境变量传递给 Node 子进程。

## 五、替换失效常见风险点
1. Shell 转义：shell=True执行 bash 命令，shell 会解析{}，破坏{{vault:xxx}}占位符；解决：参数列表调用 subprocess，关闭 shell。
2. 占位符被额外转义：json 序列化等操作将{}转义为\{ \}，网关识别失败。占位符必须保持原样{{vault:xxx}}。
3. 网络白名单域名格式错误：allowed_hosts 只填写 host（api.example.com），不能填写完整 URL https://api.example.com/xxx。
4. 环境类型：Vault environment_variable 注入仅支持 cloud 类型沙箱 Environment，自托管环境不支持。
5. ID 混淆：vault_ids填写 Vault 保管库 ID，不能填写 Credential 凭据 ID，平台无法识别 cred_id。

## 六、验证 & 验收用例
1. 基础注入验证（Python Skill）
``` python
运行
import os
print("LEYO_AGENT_KEY" in os.environ)
print(repr(os.getenv("LEYO_AGENT_KEY")))
```
预期：输出True，值为{{vault:xxxx}}

2. Node 环境变量脱敏验证
```python
运行
import subprocess
# Node读取环境变量
res = subprocess.run(["node", "-e", "console.log(process.env.LEYO_AGENT_KEY)"], capture_output=True, text=True)
print(repr(res.stdout.strip()))
# Node读取命令行参数
token = os.getenv("LEYO_AGENT_KEY")
res2 = subprocess.run(["node", "-e", "console.log(process.argv[2])", token], capture_output=True, text=True)
print(repr(res2.stdout.strip()))
```
预期：环境变量输出SECRET_PLACEHOLDER；命令行参数输出{{vault:xxxx}}

3. 端到端接口调用验证：成功调用目标业务接口，鉴权通过
4. 凭据变更验证：调用更新 Credential 接口修改 secret_value，原有会话直接使用新 Token，无需重建 session
5. 销毁验证：删除 Vault，后续会话发起的接口请求鉴权 401 失效

## 七、资源清理与异常说明
1. 删除 Skill 前置约束：删除 Skill 时，必须先删除 Skill 下所有版本，否则返回报错：
skill xxx still has 1 version(s); delete all versions first
2. 调试资源清理：直接删除 Vault，一次性销毁内部全部凭据。

## 八、架构选型总结
- MVP 调试：一 Token 一独立 Vault；cred networking 使用unrestricted；优先 Python requests 发起 http，规避 Node 环境变量脱敏问题
- 生产环境：
1. networking 改为limited，配置 cred 和 Environment 两层域名白名单
2. 优先方案 A（Python 直接发请求），规避命令行参数泄露风险
3. 权限隔离：用户 Token 撤销直接删除对应 Vault，不影响其他用户凭据