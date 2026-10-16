# dsh-plugin-komari — Agent Guide

## 插件概览

bundle 形式的 DSH 插件：向模型暴露 Komari 面板的四个工具——`komari_list_nodes`（列机器 + 实时状态）、`komari_exec`（远程执行命令）、`komari_upload_file`（本机文件 → 目标机）、`komari_download_file`（目标机文件 → 本机）；配置项在「设置 → 插件」的配置卡里。

## 关键约定

- **bundle 形式**：`cordis.patch.yml` insert 一行；`package.json` 声明 `dsh.bundle.patch`。不改 DSH 源码。
- **工具经 toolset 暴露**：`inject = ['toolsets', 'connection']`，`ctx.toolsets.register(buildKomariToolset(...))`——工具不直接进全局工具列表，模型经 `get_tools("komari")` 按需加载。toolset 名 `komari`，描述是 `TOOLSET_DESCRIPTION`（英文，模型可见）。`@huanlin/dsh-plugin-toolsets` 必须是 peerDependency。
- **配置即 entry Config**：`endpoint` / `username` / `password` / `requestTimeoutMs` / `transferTimeoutMs` 全部 `.volatile()`，`apply` 拿到活引用；读值一律 `config.<field>.get()`，禁止注册期快照缓存。配置写入落在 profile 的 `cordis.patch.yml`。
- **entryId 四处一致**：`dsh-komari`（patch 行 id / settings namespace / `configForms.get()` / 卡片 key 后半段），由 `src/client/row-key.ts` 集中定义，`tests/row-key.spec.ts` 钉死。
- **默认空 endpoint 是合法状态**：插件照常加载，工具调用报「未配置」，提示到设置页填。
- **字段白名单**：面板 `/api/admin/client/list` 含 Agent Token，任何情况下都不得把原始响应交给模型；只能用 `pickNode` / `pickLive` 投影。
- **输出不返回 null**：defineTool 的 output schema 不支持 null 字面量，可空语义用空字符串表达。
- **预构建 lib 入库**：含私有 `@deepseek-ai/dsh-client-*` peer，不用 `prepare`。

## 文件职责

| 文件 | 职责 |
|------|------|
| `src/index.ts` | 入口：`name` / `inject = ['toolsets','connection']` / `Config`（Schemastery，全 `.volatile()`）/ `apply` |
| `src/komari.ts` | `KomariClient`：`POST /api/login` 换 session cookie、`/api/rpc2` 取实时状态、`/api/admin/*` 列机器与执行任务；`pickNode`/`pickLive` 白名单投影 |
| `src/tools.ts` | 四个 `defineTool` 定义、`buildKomariToolset()`（toolset 契约）与 `registerTools()` |
| `src/transfer.ts` | 本地文件 IO：分片读取上传、流式写盘下载、`defaultDownloadPath` |
| `src/summary.ts` | 纯函数：`summarizeNode` / `resolveNodeRefs` / `renderListOutput` / `renderExecOutput` / 格式化 |
| `src/rpc.ts` | 宿主 RPC：`komari.probe` 精确 Fetch 路由（`/api` 载体） |
| `src/client/index.ts` | 浏览器半入口：绑定 `configForms`、注册 `plugins.row.config` 卡片 |
| `src/client/SettingsPage.tsx` | 配置卡（summary + page 两种 view、保存、测试连接） |
| `src/client/settings-form.ts` | `KomariSettingsController`：草稿 → `form.set` 提交 |
| `tests/toolset.spec.ts` | toolset 注册契约（名字/描述/工具集合/peer 声明） |
| `tests/e2e.komari.spec.ts` | 真实面板 e2e（无 `KOMARI_E2E_*` 环境变量时自跳过） |

## 命令

```sh
pnpm run typecheck   # tsc --noEmit
pnpm test            # vitest（mock fetch）
pnpm run build       # tsdown → lib/index.js + lib/client.js
```

## Komari 接口备忘（实测于面板 1.5.11）

- `POST /api/login` `{username,password,2fa_code}` → `{status:'success',data:{'set-cookie':{session_token}}}` + `Set-Cookie`。
- `GET /api/admin/client/list` → **裸数组**（`jsonRpc.WithRaw`），字段见 `models.Client`，含 `token`。
- `POST /api/rpc2` → `{jsonrpc,id,method:'common:getNodesLatestStatus',params:{}}` → `{jsonrpc,id,result:{uuid: record}}`；该 RPC 无独立 REST 路由。
- `POST /api/admin/task/exec` `{command,clients:[uuid]}` → `data:{task_id,clients,queued_clients}`；离线节点会直接写入 `result:"Client offline!"`、`exit_code:-1`。
- `GET /api/admin/task/{task_id}` → `data:{task_id,command,clients,results:[{client,result,exit_code,finished_at}]}`。
- 文件元数据/控制走 JSON-RPC（`/api/rpc2`）：`admin:fileStat`、`admin:fileList`、`admin:fileListRoots`、`admin:fileDelete`、`admin:fileMkdir`、`admin:fileMove`、`admin:fileCopy`、`admin:fileChmod`、`admin:fileChown`、`admin:fileSearch`。注意 `/api/rpc2` 返回的是 **JSON-RPC 信封** `{jsonrpc,id,result|error}`，与 REST 桥的 `{status,message,data}` 不同——客户端里 `rpcCall()` 与 `callData()` 分别处理这两种。
- 文件内容走二进制流：上传 `POST /api/admin/client/{uuid}/file/upload?operation=init|chunk|merge|cancel`（chunk 的 `Content-Length` 必须**精确等于** `min(chunk_size, size-offset)`）；下载 `GET /api/admin/client/{uuid}/file/download?path=<绝对路径>`（支持 Range，目录返回 400）。限制：8 GiB/文件、分片 1–128 MiB（默认 25 MiB）、会话 15 分钟、并发上传 4。
- 其余管理接口经 `jsonRpc.Bind` 桥接：成功 `{status:'success',message,data}`；失败为非 2xx + `{status:'error',message}`。
- Windows 节点的 agent 用 PowerShell 执行命令，`&&` 在旧版 PowerShell 不可用。

## 发布

按仓库根 `AGENTS.md` 的 SOP：仓库名 `dsh-plugin-komari`、npm 包 `@huanlin/dsh-plugin-komari`，README 顶部加 dshfind card，GitHub 描述双语 + topic `dsh-plugin`。
