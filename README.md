<p align="center">
  <a href="https://dshfind.com/zh/plugins/huanlinoto/dsh-plugin-komari"><img src="https://dshfind.com/api/card/huanlinoto/dsh-plugin-komari?lang=zh" alt="dsh-plugin-komari card"></a>
</p>

# dsh-plugin-komari

DSH 插件（bundle 形式）：把 [Komari](https://github.com/komari-monitor/komari) 探针面板的能力暴露给模型——**列机器**（节点清单 + 实时状态）、**控制机器**（远程执行命令）与**传输文件**（本机 ↔ 目标机），并在 WebUI 设置页配置面板地址与账号。四个工具经 [dsh-plugin-toolsets](https://github.com/huanlinoto/dsh-plugin-toolsets) 注册为一个**按需加载的工具集**。

DSH plugin (bundle): exposes a Komari monitoring panel to the model — list machines with live status, run shell commands on them, and move files between this machine and them — configured from the WebUI settings page. Tools ship as one lazily-loaded toolset through dsh-plugin-toolsets.

## 工具集（按需加载）

四个工具注册为名为 `komari` 的 toolset：平常只占一行目录（名称 + 「什么时候该用」摘要 + 工具数），模型判断需要时调用全局 `get_tools({"toolset":"komari"})` 把整组工具加载进当前 agent，**下一轮**起可用。

- 依赖 `@huanlin/dsh-plugin-toolsets`（peer，需已安装，否则本插件的 `inject: ['toolsets']` 不满足、不会加载）。
- 目录行内容即 [src/tools.ts](src/tools.ts) 里的 `TOOLSET_DESCRIPTION`。
- 子 agent 不继承：子 agent 需自行调用 `get_tools`。

## 工具

| 工具 | 作用 |
|------|------|
| `komari_list_nodes` | 列出面板上的机器及其实时状态（在线、CPU%、负载、内存/磁盘/Swap、网络总量、运行时长、连接数、温度、系统、备注）。参数：`group`（分组精确过滤）、`include_offline`（默认 true）。 |
| `komari_exec` | 在一台或多台机器上执行 shell 命令，返回每台的输出与 exit code。参数：`command`、`nodes`（uuid / 精确名称 / 唯一名称子串）、`wait_seconds`（默认 30，最大 300）。 |
| `komari_upload_file` | 把**本机**（运行 dsh 的机器）的文件传到一台或多台机器。参数：`local_path`、`remote_path`、`nodes`。走面板分片上传协议，单文件上限 8 GiB。 |
| `komari_download_file` | 把某台机器上的文件取回**本机**（流式写盘）。参数：`remote_path`、`node`、`local_path`（缺省写系统临时目录下的 `komari-downloads/`）。目录不可下载。 |

`komari_upload_file` 会**覆盖目标路径上已存在的文件**，同样需要先确认。

`komari_exec` 是**危险工具**：命令经面板 agent 在目标机上以其自身权限执行（多数 Linux 节点即 root，Windows 节点为 agent 服务账户，走 PowerShell）。工具描述已要求模型在执行重启/删除/改配置/批量命令前先说明计划并取得用户明确同意；面板侧也会记录 `REC, task id: ...` 审计日志。

## 设置页配置

「设置 → 插件」中找到 `@huanlin/dsh-plugin-komari` 这一行，展开其配置卡：

| 字段 | 说明 |
|------|------|
| 面板地址 | 如 `https://status.example.com`；粘贴 `/api` 或 `/api/v1` 后缀会被自动去掉，无协议时默认补 `https://`。 |
| 用户名 / 密码 | 面板账号，**必须是管理员**（远程执行是 admin 权限）。开启 2FA 的账号无法用于本插件（登录接口需要动态 TOTP 码）。 |
| 请求超时 (ms) | 单次面板 HTTP 请求超时，默认 15000。 |

改完点「保存」即时生效（工具每次调用都读取最新配置，无需重启）；点「测试连接」会用当前已保存的配置做一次登录 + 拉取节点，验证地址与账号是否可用。

凭据以明文写入当前 profile 的 `cordis.patch.yml` 中该 entry 的 `config` 下——请自行确认该文件的权限。

## 文件传输备注

- 上传走面板的四步协议：`operation=init`（拿 `upload_id`/分片大小）→ 逐个 `operation=chunk`（原始字节，`Content-Length` 必须等于该分片期望长度）→ `operation=merge`（提交）；任一步失败会自动 `operation=cancel` 清掉半成品。
- 面板限制：单文件 ≤ 8 GiB，分片 1 MiB–128 MiB（默认 25 MiB），上传会话 15 分钟过期，最多 4 个并发上传（因此多机上传是串行执行的）。
- 下载是 `GET .../file/download?path=<绝对路径>` 的二进制流，插件边收边写盘；总时长受「传输超时」约束。
- 路径风格随目标机：Linux 用 `/tmp/...`，Windows agent 用 `C:\Windows\Temp\...`（面板会把它规范化成 `/C/Windows/Temp`）。

## 数据可见性与安全

- 插件以面板**管理员会话**访问 `/api/admin/*`。`GET /api/admin/client/list` 的原始响应里含每台机器的 **Agent Token**，插件在进入模型之前用显式白名单投影（`pickNode`/`pickLive`），只保留状态字段；单元测试 `tests/komari.spec.ts` 钉死了这一行为。
- 会话 Cookie 只保存在宿主进程内存中；遇到 401/403 会清掉旧会话、重新登录并重试一次。
- 密码不写入日志、不回显在工具结果里。

## 开发

```sh
pnpm install
pnpm run build        # tsdown: lib/index.js (host) + lib/client.js (browser half, __ModuleLoader__ 包裹)
```

结构：

| 路径 | 职责 |
|------|------|
| `src/index.ts` | 入口：`name` / `inject` / `Config`（全部字段 `.volatile()`）/ `apply` |
| `src/komari.ts` | `KomariClient`：登录、Cookie 会话、`/api/rpc2`、`/api/admin/*`、字段白名单投影 |
| `src/tools.ts` | 四个 `defineTool` 定义、`buildKomariToolset()` 与 `registerTools()`（注册到 `ctx.toolsets`） |
| `src/transfer.ts` | 本地文件 IO：分片读取上传、流式写盘下载、默认落地路径 |
| `src/summary.ts` | 纯函数：节点摘要、引用解析、文本渲染（无 `@deepseek-ai/*` 依赖，便于单测） |
| `src/rpc.ts` | 宿主 RPC：`komari.probe`（设置卡「测试连接」） |
| `src/client/*` | 浏览器半：`plugins.row.config` 配置卡（row key `@huanlin/dsh-plugin-komari#dsh-komari`） |
| `cordis.patch.yml` | bundle 配置层：insert 一行 `dsh-komari`，`config` 是首次启动的种子值 |

约束：`lib/` 预构建入库（含 `@deepseek-ai/dsh-client-* ` peer，git 安装时无 `prepare`）；不改 DSH 源码。

## 运行

```sh
# 本地开发（改源码后重新 pnpm run build 即可生效，无需重装）
dsh plugin --profile web add "link:D:/Projects/deepseek-harness/dsh-plugin-komari"

# 从远端安装
dsh plugin --profile web add "github:huanlinoto/dsh-plugin-komari"
```

装好后**重启 `dsh web` 进程**，浏览器硬刷新（`Ctrl+Shift+R`），再到「设置 → 插件」填上面四个字段。

## 检查

```sh
pnpm run typecheck                              # tsc --noEmit
pnpm test                                       # 40 个单测（mock fetch；含 token 不泄漏回归、分片协议回归、toolset 契约）
pnpm vitest run tests/e2e.komari.spec.ts         # 真实面板 e2e（未设置环境变量时自跳过）
```

真实面板 e2e 需要：

```powershell
$env:KOMARI_E2E_ENDPOINT='https://status.example.com'
$env:KOMARI_E2E_USERNAME='admin'
$env:KOMARI_E2E_PASSWORD='...'
```

它覆盖四条链路：登录 + 列机器、读实时状态、在**一台在线机器**上执行 `echo dsh-komari-e2e`、以及**文件往返**（上传一个小文本文件到在线机器的临时目录 → stat 校验 → 下载回来比对内容 → 删除远端文件）。只跑无害命令与临时文件。

## 已知限制

- 面板账号开启 2FA 时无法使用：登录与 `admin:exec` 都需要动态 TOTP 码。需要这种场景时应改用面板 API Key 认证（当前未实现）。
- 只覆盖「看机器 + 控制机器 + 传文件」：节点增删改、Ping 任务管理等面板管理写入接口未暴露。
- 强依赖 `@huanlin/dsh-plugin-toolsets`：未安装时本插件因 `inject` 不满足而整体不加载（工具不可见）。
