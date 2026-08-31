# Phone Control

Phone Control 是一个本地优先的 Codex 手机控制面板。它把 Codex Desktop、IDE 和 CLI
中的任务汇总到手机浏览器，让你可以离开电脑后继续查看进度、回复问题、追加指令或停止任务。

它不会替代 Codex，也不会修改 rollout 记录。Phone Control 只在本机整理 Codex 已有状态，
再通过你选择的安全网络入口提供给已配对的手机。

```text
Codex Hooks / rollout / App Server ─┐
                                   ↓
手机 ← Tailscale / VPS HTTPS ← Phone Control → Chrome Browser Bridge → 本机网页标签页
```

## 可以做什么

- 实时追踪多个 Codex 会话，查看当前状态、最近轮次、工具活动、模型和推理等级。
- 卡片区分会话主题与当前任务，并过滤“继续做吧”或效果评价一类依赖前文的消息；自动名称不合适时可以手动改名，或按需让 Codex 根据最近几轮生成一个可编辑候选。
- 按当前任务、会话主题、项目、机器、用户指令或 Codex 回复搜索已保留的任务历史。
- 在可验证的会话中继续对话、追加当前 turn、停止任务、新建、在手机与桌面应用之间显式移交控制或永久删除会话；创建会话或开始下一轮时可单独选择权限。
- 在手机上回答 `request_user_input`，并处理与手机所拥有 turn 精确绑定的 App Server 单次审批。
- 发送文字和最多 4 张图片；Codex 回复支持标题、列表、代码、表格和可点击链接。
- 为一个目标会话开启完成提醒，在状态页查看类似 `/status` 的账户与运行摘要。
- 安装可选的 Chrome Browser Bridge 后，从手机查看并操作电脑上已打开的普通网页标签页，包括切换标签、导航、点按、滚动和中文输入。
- 安装为 PWA；数据、设备凭证、审计和事件记录都保留在自己的电脑上。

## 平台与功能边界

Phone Control 的“查看任务”和“控制任务”依赖不同能力。读取 Hooks 与 rollout 就能追踪进度；
续聊、新建、中止、回答问题等完整控制还要求 Phone Control 能访问同一运行环境中的受管 Codex
App Server。可运行 `phone-control doctor` 检查本机是否找到该控制通道。

| 电脑端运行方式 | 电脑界面 | 追踪、通知、仪表盘 | 安全手机控制 | 控制通道 |
| --- | --- | --- | --- | --- |
| Linux 原生 | App、IDE 或 CLI | 支持 | 支持 | 优先复用 Unix Socket，缺失时回退 stdio |
| macOS | App、IDE 或 CLI | 支持 | 支持 | 优先复用 Unix Socket，缺失时回退 stdio |
| Windows 原生 | Windows App 或 CLI | 支持 | 支持 | Phone Control 管理本机 stdio App Server |
| Windows App + WSL2 Agent | 仍然是 Windows App | 支持 | 同一侧安装时支持 | 根据 Phone Control 所在系统自动选择通道 |
| WSL2 中的 Codex CLI | CLI | 支持 | 支持 | WSL2 内的 Unix Socket 或 stdio |

WSL2 是 **Agent 的执行环境**，不是另一种界面。在 Windows Codex App 的设置中把 Agent
切换到 WSL2 后，用户仍然使用桌面 App，只是命令、工具和 Linux 沙箱在 WSL2 内运行；只有在
WSL2 终端中直接执行 `codex` 时才是 CLI。参见 OpenAI 官方的
[Windows App 说明](https://learn.chatgpt.com/codex/windows/windows-app)与
[WSL2 说明](https://learn.chatgpt.com/codex/windows/wsl)。Phone Control 不要求 Windows 必须使用
WSL2：原生安装会启动自己管理的本机 stdio App Server。官方 App Server 支持 stdio、Unix Socket
和实验性的 WebSocket；Phone Control 默认使用前两种稳定本机通道，参见
[App Server 协议](https://learn.chatgpt.com/docs/app-server)。

控制仍遵循精确所有权边界：手机新建或成功恢复的 thread 由 Phone Control 的 App Server 持有，
其 turn 可以追加或停止。如果 thread 已被另一个 Codex App/CLI 进程打开，该进程可能在 turn 结束后
仍保留 `active writer`；Phone Control 不会强行抢占，因此该 thread 仍可能只读。要把已有 Desktop
thread 交给手机，先完全退出占用它的 Codex App/CLI，再从手机恢复；控制期间不要在另一客户端重新
打开它。也可以直接在手机点“新建”，从一开始建立由 Phone Control 持有的 thread。这是会话安全
约束，不是 Windows 或 macOS 功能缺失。

反过来，如果 Desktop thread 已由 Phone Control 接管，Windows 电脑端可能显示“已在另外一个应用中
打开”。等当前 turn 完成后，在手机会话标题旁点“移交电脑”即可主动释放占用；历史不会删除，手机
会切为只读，随后可在 Codex Desktop 继续。电脑端任务结束并完全关闭该会话后，可点“手机接管”：
服务先用 `thread/read` 只读确认状态，再调用 `thread/resume`，只有确认恢复为空闲状态才重新开放手机
输入；如果电脑端仍有 active writer，则保持只读并提示继续关闭电脑端会话。

这两个所有权按钮只对来源为 Desktop 的用户会话开放，CLI 会话不显示按钮，也不能绕过页面调用
移交接口；CLI 仍使用原来的安全恢复、继续和追加流程。当前 Windows 实现使用一个受管 stdio App
Server 承载手机会话，因此移交会短暂释放它持有的其他空闲会话；页面会先明确确认，并在任何手机
任务仍在执行、等待问题或等待审批时拒绝操作。只有被选择的 Desktop thread 会标记为“已移交”，
其他 CLI/会话可按原流程恢复。协议本身的 `thread/unsubscribe` 在最后一个订阅者离开后仍可能保留
thread 30 分钟，不能用于立即移交，所以 Phone Control 会关闭并重建自己管理的 App Server 进程。
Unix Socket 是共享进程，当前不提供这个立即移交按钮。

## 快速开始

### Windows 一键安装（推荐）

如果仓库是公开的，Windows PowerShell 中可以直接粘贴下面一行：

```powershell
irm https://raw.githubusercontent.com/under-stand/phone-control/main/plugins/plugin-phone-control/install-windows.ps1 | iex
```

安装器会自动检查或安装 Git、Node.js 22+ 和支持插件的 Codex CLI，然后下载 Phone Control、注册
公开 monorepo marketplace、安装后台计划任务并检查服务。若电脑已经登录 Tailscale，它还会尝试配置 `tailscale serve`
并直接打印十分钟有效的一次性手机配对链接。安装依赖时 Windows 可能显示系统确认窗口；Phone
Control 后台任务本身以当前用户权限运行，不要求管理员权限。

安装器把稳定源码放在 `%USERPROFILE%\.phone-control\source`，避免 Microsoft Store/AppX 应用中的
`LOCALAPPDATA` 重定向导致计划任务找不到源码。后台启动器会在没有显式 `HTTP_PROXY`、
`HTTPS_PROXY` 或 `ALL_PROXY` 时读取当前用户的 Windows 系统代理；Clash、Mihomo 等只写入系统
代理设置的工具因此也能供后台 Codex App Server 使用。显式环境变量始终优先。

只在电脑本机安装、不配置 Tailscale（公开仓库）：

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/under-stand/phone-control/main/plugins/plugin-phone-control/install-windows.ps1))) -Access Local
```

如果仓库保持私有，匿名 `raw.githubusercontent.com` 无法读取脚本；请先用已登录 GitHub 的
SSH/HTTPS 克隆，或下载 ZIP 后解压，再双击 `plugins\plugin-phone-control\install-windows.cmd`（也可以在插件目录执行
`powershell -ExecutionPolicy Bypass -File .\install-windows.ps1 -Access Local`）。

安装完成后完全退出并重新打开 Codex，新建一个 thread，在 `/hooks` 中检查并信任当前 Hooks。

原生 Windows 除了追踪 App/CLI 历史、显示实时 Hook 状态、通知和手机仪表盘，还会通过受管 stdio
App Server 提供新建、恢复未被其他进程占用的会话、继续对话和停止手机所拥有 turn 的能力。被另一个
Windows App/CLI 持有 `active writer` 的 thread 保持只读；完全退出占用方后再从手机恢复。

### Linux、macOS 与 WSL2 手动安装

#### 1. 准备环境

需要：

- Node.js 22 或更高版本；
- 已安装并登录、且支持 `codex plugin` 的 Codex；
- Tailscale、可信局域网或一台带 HTTPS 的 VPS；
- 若要续聊、回答和停止任务，需要本机 Codex App Server 正常运行。

先确认本机能力：

```bash
node --version
codex --version
codex plugin --help
```

Linux 优先使用 systemd user service；macOS 使用当前用户的原生 `launchd`；没有 systemd 的 Linux
和 WSL 回退到 tmux + `@reboot` crontab。原生 Windows 使用当前用户的计划任务，并在进程退出后自动恢复。

#### 2. 安装项目与插件

公开仓库采用 Codex 标准 monorepo 结构，marketplace 清单已经在仓库根目录维护。从仓库根目录
执行以下命令即可注册并安装插件：

```bash
git clone https://github.com/under-stand/phone-control.git
cd phone-control

codex plugin marketplace add .
codex plugin add plugin-phone-control@phone-control

cd plugins/plugin-phone-control
npm ci
npm run verify
```

本项目目前通过 GitHub 仓库分发，不发布 npm 包。`npm ci` 只安装运行与验证所需的 Node 依赖。

安装或更新插件后，新建一个 Codex thread，并在 `/hooks` 中检查、信任当前 Hook 哈希。
已经长期运行的 Codex Desktop、IDE 或 App Server 也应重启一次，避免继续加载旧缓存目录。

#### 3. 安装后台服务

```bash
node ./bin/phone-control.mjs doctor
node ./bin/phone-control.mjs service install \
  --runtime "$(command -v node)" \
  --codex-command "$(command -v codex)"
node ./bin/phone-control.mjs service status
```

服务默认只监听 `127.0.0.1:8787`。Linux 会优先使用 systemd user service，macOS 使用
原生 `launchd`，其他不支持 systemd 的 Unix 环境自动使用独立的 tmux 会话和 `@reboot` crontab。

`service install` 会固定当前 Node 和插件路径。升级 Node 或移动项目后，需要重新执行一次该命令。
Windows 一键安装器创建当前用户的计划任务。

#### 4. 让手机访问

选择一种接入方式即可。

##### VPS Relay：无需手机 VPN

已经配置过 Relay 的机器只需检查状态并生成配对链接：

```bash
node ./bin/phone-control.mjs relay status
node ./bin/phone-control.mjs relay doctor
node ./bin/phone-control.mjs pair --no-qr
```

从零部署 VPS、配置 FRP、HTTPS 证书和回滚入口，见
[VPS Relay 指南](docs/vps-relay.md)。Relay 默认先进入 standby，只有所有诊断通过后才能激活。

##### Tailscale：仅 tailnet 可见

```bash
tailscale serve --bg 8787

node ./bin/phone-control.mjs doctor \
  --public-url https://your-machine.your-tailnet.ts.net \
  --secure-cookies
node ./bin/phone-control.mjs service restart
node ./bin/phone-control.mjs pair --no-qr
```

##### 可信局域网：临时调试

```bash
node ./bin/phone-control.mjs start --host 0.0.0.0
```

只应在可信局域网使用这种方式。不要把普通 HTTP 端口直接暴露到公网；Web Push 等能力也需要
HTTPS 安全上下文。

| 方式 | 手机是否需要 VPN | 适合场景 |
| --- | --- | --- |
| 可信局域网 | 否 | 同一 Wi-Fi 下快速调试 |
| Tailscale | 是 | 私有访问、无需自建服务器 |
| VPS Relay | 否 | 与其他 VPN 共存、普通 HTTPS 访问 |

#### 5. 完成手机配对

`pair` 会生成一个十分钟有效、只能使用一次的 URL。用手机打开后，服务端会签发该设备独有的
HttpOnly Cookie，并立即从地址栏移除配对码。

这里的 `code=...` 是一次性配对码，必须随完整 `/pair?code=...` URL 打开；它不是首页“访问口令”
输入框使用的长期主令牌。一次性配对 URL 用过或过期后应重新运行 `phone-control pair --no-qr`，
不要把旧 `code` 单独粘贴到访问口令输入框。

配对完成后建议：

1. 将页面添加到手机主屏幕；
2. 点击顶栏连接状态，确认机器可达；
3. 选择一个会话作为当前目标；
4. 按需开启提醒，并确认测试通知能够收到。

### 可选：从手机控制电脑 Chrome

浏览器控制是 `0.9.x` 的可选能力，当前要求 Phone Control 使用默认的本机地址
`http://127.0.0.1:8787`，并在电脑 Chrome 中手工加载一次随项目提供的扩展。

Windows 可以在插件目录中双击 `install-browser-extension.cmd`。一键安装后的稳定目录通常是：

```text
%USERPROFILE%\.phone-control\source\plugins\plugin-phone-control\install-browser-extension.cmd
```

也可以手工完成：

1. 在 Chrome 打开 `chrome://extensions/`；
2. 打开右上角“开发者模式”；
3. 点“加载已解压的扩展程序”，选择 `plugins/plugin-phone-control/extensions/chrome`；
4. 打开一个普通 `http://` 或 `https://` 网页，点扩展图标确认显示“已连接 Phone Control”；
5. 在手机 Phone Control 顶栏点“浏览器”。

Chrome 会显示调试器正在控制标签页，这是扩展使用 Chrome DevTools Protocol 实现截图、点按和
输入时的正常安全提示。`chrome://`、扩展页和本地 `file://` 页面不会开放给手机。一个时刻只有一台
已配对设备能取得浏览器控制权；离开页面、退出、撤销设备或租约超时后会自动释放。

## 日常使用

打开任务后，页面会根据 Codex 的真实现场自动显示可用操作：

- **查看进度**：最近轮次默认展开，过程回复和工具活动按需展开；每条 Codex 回复可一键复制完整原文。
- **继续会话**：空闲或已完成的 thread 会开始新 turn。
- **追加指令**：运行中的受管 turn 会使用精确 turn ID 发送 steer。
- **回答问题**：只对当前仍有效的 `request_user_input` 显示回答表单。
- **停止任务**：只中断当前 turn，不删除 thread 或历史记录。
- **新建会话**：选择当前机器上的项目目录、模型、推理等级、Fast 和权限模式。
- **下一轮设置**：空闲会话开始下一轮前，可单独覆盖模型、推理、Fast 和权限；运行中的 steer 不允许中途改权限。
- **删除会话**：永久删除 Codex 原始 thread；运行中或等待处理的会话不能删除。
- **目标追踪**：每台已配对设备可以独立选择要提醒和置顶的会话。
- **任务检索**：输入关键词会自动切换到全部任务，支持“待处理/当前/历史”等范围筛选；命中历史消息时直接展开并定位到对应轮次。
- **浏览器控制**：选择电脑 Chrome 标签页，刷新画面后直接点按或滑动；先点网页输入框，再用下方输入栏发送中文或回车。

如果页面处于只读状态，通常表示 Phone Control 可以读取历史，但无法证明该 thread 当前由受管
App Server 控制。此时不会冒险从手机驱动一个可能仍被 Desktop 或独立 CLI 占用的会话。即使卡片
已经显示“本轮完成”，另一进程仍可能持有 `active writer`；完全退出该客户端后再恢复，或在手机新建
一个 thread。手机创建的任务在控制期间不要同时从 Desktop 打开。

## 审批与交互

手机交互默认开启。新建会话或开始下一轮时，权限菜单提供四种显式模式：

| 权限模式 | 行为 |
| --- | --- |
| 只读 | 不允许写文件，也不为写入自动提权 |
| 工作区内自动执行 | 可写当前项目；工作区外与网络访问由沙箱阻止 |
| 超出工作区时询问 | 工作区内正常执行；额外命令、文件或 `request_permissions` 请求回到手机单次审批 |
| 完全访问电脑 | 关闭沙箱并自动执行；每次发送前都要求再次确认，且仍受管理员策略限制 |

不选择时沿用当前 thread 或本机 Codex 默认。所选配置只在 `thread/start` / `turn/start` 生效并延续到后续轮次，不能通过 `turn/steer` 修改。原生审批请求同时绑定 JSON-RPC request、thread 和 turn；Phone Control 只响应由手机开始或追加的 turn，Desktop/CLI 仍使用自己的审批通道。十分钟未处理的手机审批会自动拒绝，轮次结束时遗留审批也会立即失效。

下面的旧 Hook 审批开关用于兼容会产生同步 `PermissionRequest` Hook 的流程，默认关闭：

```bash
node ./bin/phone-control.mjs interactions status
node ./bin/phone-control.mjs approvals status
```

需要兼容 Hook 审批时：

```bash
node ./bin/phone-control.mjs approvals enable
node ./bin/phone-control.mjs service restart
```

Hook 审批同样只接管由手机开始或追加的精确 turn。Desktop/CLI 发起的 turn 继续使用 Codex 原本的
审批通道，不会同时在手机制造一个重复挑战。使用 App Server 原生“超出工作区时询问”不要求开启该兼容开关。

## 常用命令

下面的 `phone-control` 等价于 `node ./bin/phone-control.mjs`。

| 命令 | 用途 |
| --- | --- |
| `phone-control doctor` | 检查 Node、服务、插件路径和 App Server |
| `phone-control pair --no-qr` | 生成新的单次手机配对链接 |
| `phone-control service status` | 查看主服务状态 |
| `phone-control service restart` | 重启主服务并应用配置 |
| `phone-control relay status` | 查看 VPS Relay 是否安装、运行和激活 |
| `phone-control relay doctor` | 检查 FRP、本机服务和公网 HTTPS |
| `phone-control relay deactivate` | 恢复 Relay 配置前的公网入口 |
| `phone-control interactions status` | 检查续聊、回答与控制能力 |
| `phone-control approvals enable` | 开启手机发起 turn 的单次审批 |

完整 CLI：

```text
phone-control start [--host HOST] [--port PORT] [--public-url URL]
phone-control pair [--url URL] [--no-qr]
phone-control approvals <enable|disable|status>
phone-control interactions <enable|disable|status>
phone-control service <install|uninstall|status|start|stop|restart> [--runtime NODE]
phone-control marketplace install [--plugin-root PATH] [--marketplace-root PATH]  # 独立插件目录兼容用法
phone-control relay <configure|install|uninstall|status|doctor|start|stop|restart|activate|deactivate>
phone-control doctor [--data-dir PATH] [--codex-home PATH]
```

## 更新

```bash
cd phone-control
git pull

codex plugin marketplace add .
codex plugin add plugin-phone-control@phone-control

cd plugins/plugin-phone-control
npm ci

npm run verify
node ./bin/phone-control.mjs service install \
  --runtime "$(command -v node)" \
  --codex-command "$(command -v codex)"
```

更新后新建 Codex thread，以加载新的插件、Hooks 和工具定义。Phone Control 的设备、配置和历史
保存在 `~/.phone-control`，重新安装服务或插件不会删除它们。

## 常见问题

| 现象 | 处理方式 |
| --- | --- |
| 手机打不开页面 | 运行 `relay doctor` 或检查 `tailscale serve status` |
| `/api/health` 返回正常但手机仍显示正在恢复 | `ok` 只表示 HTTP 进程存活；等待 `ready: true`，或运行 `doctor` 检查 App Server。安装器也会等待这一就绪状态 |
| 页面一直只读 | 运行 `doctor`，确认 Unix Socket 或受管 stdio App Server 可用；若日志出现 `active writer`，完全退出占用该 thread 的 Desktop/CLI 后再恢复，或直接从手机新建任务 |
| Codex Desktop 显示“已在另外一个应用中打开” | 如果该 Desktop 会话正由手机接管，先等当前任务完成，再在手机会话标题旁点“移交电脑”；手机会保留历史并切成只读。按钮不可用表示它是 CLI 会话、仍有手机任务/问题/审批，或当前使用共享 Unix Socket，不能保证立即释放 |
| 已移交电脑后怎样由手机拿回来 | 先等电脑端任务完成并完全关闭该会话，再在手机标题旁点“手机接管”。服务会先只读检查再恢复；如果仍提示电脑占用，请完全退出该会话或 Codex Desktop 后重试，失败期间手机保持只读。CLI 会话没有这个按钮，也不需要所有权移交 |
| 会话历史把同一条 Codex 回复显示两次 | 更新到 0.8.2 并重新执行 `service install`；新版会合并 rollout 中 `response_item` 与延迟 `task_complete` 携带的同轮最终回复，同时保留跨轮次的真实重复内容。若手机仍显示旧页面，完全关闭后重新打开以更新 Service Worker 缓存 |
| 某轮最终回答出现在“过程回复”里 | 更新到最新 `0.9.x` 并重新执行 `service install`；新版保留 Codex rollout 中的 `commentary` / `final_answer` 阶段，最终回答不再靠“最后一条消息”猜测。旧历史会在下一次 rollout 扫描时自动补齐阶段 |
| 服务或网络中断后，旧会话一直显示“工作中” | 更新到 0.8.3；缺少结束事件的旧 turn 超过 10 分钟未再活动后会显示“连接已中断”，但保留原始事件并维持只读，避免误续写。请在电脑端确认旧 turn 是否已停止，再新建或恢复会话 |
| Hook 显示失败 | 更新插件后重启 Codex，并在 `/hooks` 重新检查当前哈希 |
| Windows 安装后只能查看 | 更新到支持 stdio 的 Codex，重新运行一键安装器；再用 `doctor` 检查保存的 Codex 路径与 App Server |
| 手机任务创建后一直停在 `working` | 查看 `~/.phone-control/service.log`；若出现 `request timed out`，确认 Windows 系统代理正在监听并重新执行 `service install`。新版 Windows 启动器会自动导入当前用户代理，日志写入 `Imported the current Windows user proxy`，但不会记录代理地址或凭据 |
| `service restart` 后出现 `EADDRINUSE` | 更新并重新安装服务；新版会精确结束旧 Phone Control Node 进程及其 Codex 子进程，再启动新实例 |
| 从手机控制的会话执行 `service install/restart` 后手机断线 | 这类命令会停止承载当前会话的受管 App Server；新版会在停服务前拒绝。请改在独立 PowerShell 窗口执行，或使用未由 Phone Control 持有的 Desktop/CLI 会话 |
| 一次性配对码提示口令错误 | 不要把 `code` 填进“访问口令”；用同一浏览器打开完整的 `/pair?code=...` URL，且不要在 `localhost`、`127.0.0.1` 与 Tailscale 域名之间混用 Cookie |
| 可以发指令但没有审批按钮 | 在新建会话或空闲会话的下一轮设置中选择“超出工作区时询问”；只有 Codex 实际申请额外权限时才显示按钮，且只接管手机发起或追加的精确 turn。旧 Hook 流程另按“审批与交互”章节开启兼容开关 |
| 后台回来后显示断线 | 点击顶栏连接状态立即探测；页面会同时重建 SSE |
| 收不到系统通知 | 确认使用 HTTPS，并以“开启提醒”时的测试通知为准 |
| 新版本没有生效 | 重新执行 `codex plugin add`、`service install`，然后新建 thread |
| 手机“浏览器”页显示扩展离线 | 确认最新 Phone Control `0.9.x` 正在默认端口 8787 运行；在 Chrome 扩展页重新加载 Browser Bridge，再点扩展里的“重新连接”。普通网页不能代替扩展调用本机内部接口 |
| 浏览器页提示另一台设备正在控制 | 关闭另一台手机上的浏览器控制页，或等待最多 60 秒租约过期；撤销那台设备也会立即释放租约 |

中国大陆网络下，浏览器系统推送可能依赖 Google/Firebase 等厂商通道。Tailscale 或 VPS 只负责
访问面板，不能保证这些推送服务可达；页面保持打开时的 SSE、小弹窗和提示音不受此限制。

## 安全边界

- 默认只监听回环地址；公网访问必须经过可信网络或 HTTPS 入口。
- 配对码单次、短期有效；每台设备使用独立凭证，可在设备页单独撤销。
- rollout 文件只读；归一化事件、设备和审计数据保存在 `~/.phone-control`。
- 回答、追加、停止和审批都必须匹配服务端验证的 thread、turn 和单次请求。
- “移交电脑 / 手机接管”只对 Desktop 来源的用户会话开放；移交要求受管 stdio 中所有 thread 空闲且无待处理问题/审批，接管则先只读检查，再恢复并验证为空闲。共享进程中的其他会话会被短暂释放，但不会标记为已移交；CLI 不进入该流程。
- 图片会在浏览器端缩放并移除元数据，服务端只保留不可复用的短期临时文件。
- Chrome Bridge 只连接 `127.0.0.1:8787`，服务端校验并绑定扩展来源；手机仍必须先配对。网页截图只保存在内存，不写入事件日志，输入正文也不会进入 Phone Control 审计。
- 删除会话会删除 Codex 原始记录且不可恢复，页面会在执行前明确确认风险。

更完整的边界说明见 [SECURITY.md](SECURITY.md)，实现设计见
[架构说明](docs/architecture.md)。

## 开发与测试

```bash
npm ci
npm run verify
npx playwright install chromium
npm run test:mobile
npm run test:browser
```

`npm run verify` 会执行源码检查和全部实现测试。真实状态、问题、续聊、审批、SSE 和性能联调脚本
位于 `scripts/`，部分脚本会创建短暂的真实 Codex thread 并消耗少量额度，运行前请先阅读对应源码。
`npm run test:mobile` 会启动隔离的本地服务并用 Chromium 验证主要手机流程；可通过
`PHONE_CONTROL_BROWSER` 指定已有浏览器可执行文件。
`npm run test:browser` 会用伪造的本机扩展代理验证手机浏览器页面、标签列表与截图显示，不操作真实网页。

提交改动前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。版本变化见
[CHANGELOG.md](CHANGELOG.md)。

项目主要目录：

- `bin/`：CLI 入口；
- `src/`：服务、会话、App Server 与 Relay 实现；
- `public/`：手机 PWA；
- `hooks/`、`scripts/`：Codex Hooks 与诊断脚本；
- `deploy/vps-relay/`：隔离 VPS 部署模板；
- `test/`：实现测试。

## 后续方向

下一阶段会优先建设统一任务状态、有语义的任务卡片、任务检索、“待我处理”收件箱和结构化结果审阅，
随后扩展多机器管理、任务编排、项目工作区与自动化。完整目标和实施顺序见
[产品路线图](ROADMAP.md)。

## License

MIT
