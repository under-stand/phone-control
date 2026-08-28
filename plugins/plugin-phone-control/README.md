# Phone Control

Phone Control 是一个本地优先的 Codex 手机控制面板。它把 Codex Desktop、IDE 和 CLI
中的任务汇总到手机浏览器，让你可以离开电脑后继续查看进度、回复问题、追加指令或停止任务。

它不会替代 Codex，也不会修改 rollout 记录。Phone Control 只在本机整理 Codex 已有状态，
再通过你选择的安全网络入口提供给已配对的手机。

```text
Codex Hooks / rollout / App Server
                ↓
Phone Control · 127.0.0.1:8787
                ↓
      Tailscale 或 VPS HTTPS
                ↓
              手机
```

## 可以做什么

- 实时追踪多个 Codex 会话，查看当前状态、最近轮次、工具活动、模型和推理等级。
- 卡片区分会话主题与当前任务，并过滤“继续做吧”或效果评价一类依赖前文的消息；自动名称不合适时可以手动改名，或按需让 Codex 根据最近几轮生成一个可编辑候选。
- 按当前任务、会话主题、项目、机器、用户指令或 Codex 回复搜索已保留的任务历史。
- 在可验证的会话中继续对话、追加当前 turn、停止任务、新建或永久删除会话。
- 在手机上回答 `request_user_input`，并按需启用精确绑定的单次审批。
- 发送文字和最多 4 张图片；Codex 回复支持标题、列表、代码、表格和可点击链接。
- 为一个目标会话开启完成提醒，在状态页查看类似 `/status` 的账户与运行摘要。
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
[App Server 协议](https://learn.chatgpt.com/codex/app-server)。

控制仍遵循精确所有权边界：空闲会话可以安全恢复，手机启动的 turn 可以追加或停止；如果某个
turn 已经在另一个 Codex App/CLI 进程中运行，而当前 App Server 无法证明自己拥有它，手机端保持
只读，等它结束后再恢复。这是会话安全约束，不是 Windows 或 macOS 功能缺失。

## 快速开始

### Windows 一键安装（推荐）

在 Windows PowerShell 中粘贴下面一行：

```powershell
irm https://raw.githubusercontent.com/under-stand/phone-control/main/plugins/plugin-phone-control/install-windows.ps1 | iex
```

安装器会自动检查或安装 Git、Node.js 22+ 和支持插件的 Codex CLI，然后下载 Phone Control、注册
插件、安装后台计划任务并检查服务。若电脑已经登录 Tailscale，它还会尝试配置 `tailscale serve`
并直接打印十分钟有效的一次性手机配对链接。安装依赖时 Windows 可能显示系统确认窗口；Phone
Control 后台任务本身以当前用户权限运行，不要求管理员权限。

如果不想粘贴命令，也可以下载仓库 ZIP，解压后双击
`plugins\plugin-phone-control\install-windows.cmd`。只在电脑本机安装、不配置 Tailscale：

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/under-stand/phone-control/main/plugins/plugin-phone-control/install-windows.ps1))) -Access Local
```

安装完成后完全退出并重新打开 Codex，新建一个 thread，在 `/hooks` 中检查并信任当前 Hooks。

原生 Windows 除了追踪 App/CLI 历史、显示实时 Hook 状态、通知和手机仪表盘，还会通过受管 stdio
App Server 提供新建、恢复空闲会话、继续对话和停止手机所拥有 turn 的能力。正在由另一个
Windows App 进程执行的 turn 保持只读，结束后即可从手机安全恢复。

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

Linux 可使用 systemd user service；没有 systemd 的 Linux、macOS 和 WSL 会回退到 tmux +
`@reboot` crontab。原生 Windows 使用当前用户的计划任务，并在进程退出后自动恢复。

#### 2. 安装项目与插件

从公开仓库注册 `phone-control` marketplace，再安装插件：

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

服务默认只监听 `127.0.0.1:8787`。它会优先使用 systemd user service；系统不支持时，
自动使用独立的 tmux 会话和 `@reboot` crontab。

`service install` 会固定当前 Node 和插件路径。升级 Node 或移动项目后，需要重新执行一次该命令。
Linux 优先使用当前用户的 systemd，macOS 使用当前用户的原生 `launchd`，其他 Unix 环境回退到
`tmux + cron`；Windows 一键安装器创建当前用户的计划任务。

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

配对完成后建议：

1. 将页面添加到手机主屏幕；
2. 点击顶栏连接状态，确认机器可达；
3. 选择一个会话作为当前目标；
4. 按需开启提醒，并确认测试通知能够收到。

## 日常使用

打开任务后，页面会根据 Codex 的真实现场自动显示可用操作：

- **查看进度**：最近轮次默认展开，过程回复和工具活动按需展开；每条 Codex 回复可一键复制完整原文。
- **继续会话**：空闲或已完成的 thread 会开始新 turn。
- **追加指令**：运行中的受管 turn 会使用精确 turn ID 发送 steer。
- **回答问题**：只对当前仍有效的 `request_user_input` 显示回答表单。
- **停止任务**：只中断当前 turn，不删除 thread 或历史记录。
- **新建会话**：选择当前机器上的项目目录、模型、推理等级和 Fast。
- **删除会话**：永久删除 Codex 原始 thread；运行中或等待处理的会话不能删除。
- **目标追踪**：每台已配对设备可以独立选择要提醒和置顶的会话。
- **任务检索**：输入关键词会自动切换到全部任务，支持“待处理/当前/历史”等范围筛选；命中历史消息时直接展开并定位到对应轮次。

如果页面处于只读状态，通常表示 Phone Control 可以读取历史，但无法证明该 thread 当前由受管
App Server 控制。此时不会冒险从手机驱动一个可能仍被 Desktop 或独立 CLI 占用的会话。

## 审批与交互

手机交互默认开启，手机审批默认关闭：

```bash
node ./bin/phone-control.mjs interactions status
node ./bin/phone-control.mjs approvals status
```

需要手机审批时：

```bash
node ./bin/phone-control.mjs approvals enable
node ./bin/phone-control.mjs service restart
```

手机审批只接管由手机开始或追加的精确 turn。Desktop/CLI 发起的 turn 继续使用 Codex 原本的
审批通道，不会同时在手机制造一个重复挑战。验证完成后可用 `approvals disable` 关闭。

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
| 页面一直只读 | 运行 `doctor`，确认 Unix Socket 或受管 stdio App Server 可用；另一个客户端正在运行的 turn 会保持只读 |
| Hook 显示失败 | 更新插件后重启 Codex，并在 `/hooks` 重新检查当前哈希 |
| Windows 安装后只能查看 | 更新到支持 stdio 的 Codex，重新运行一键安装器；再用 `doctor` 检查保存的 Codex 路径与 App Server |
| 后台回来后显示断线 | 点击顶栏连接状态立即探测；页面会同时重建 SSE |
| 收不到系统通知 | 确认使用 HTTPS，并以“开启提醒”时的测试通知为准 |
| 新版本没有生效 | 重新执行 `codex plugin add`、`service install`，然后新建 thread |

中国大陆网络下，浏览器系统推送可能依赖 Google/Firebase 等厂商通道。Tailscale 或 VPS 只负责
访问面板，不能保证这些推送服务可达；页面保持打开时的 SSE、小弹窗和提示音不受此限制。

## 安全边界

- 默认只监听回环地址；公网访问必须经过可信网络或 HTTPS 入口。
- 配对码单次、短期有效；每台设备使用独立凭证，可在设备页单独撤销。
- rollout 文件只读；归一化事件、设备和审计数据保存在 `~/.phone-control`。
- 回答、追加、停止和审批都必须匹配服务端验证的 thread、turn 和单次请求。
- 图片会在浏览器端缩放并移除元数据，服务端只保留不可复用的短期临时文件。
- 删除会话会删除 Codex 原始记录且不可恢复，页面会在执行前明确确认风险。

更完整的边界说明见 [SECURITY.md](SECURITY.md)，实现设计见
[架构说明](docs/architecture.md)。

## 开发与测试

```bash
npm ci
npm run verify
npx playwright install chromium
npm run test:mobile
```

`npm run verify` 会执行源码检查和全部实现测试。真实状态、问题、续聊、审批、SSE 和性能联调脚本
位于 `scripts/`，部分脚本会创建短暂的真实 Codex thread 并消耗少量额度，运行前请先阅读对应源码。
`npm run test:mobile` 会启动隔离的本地服务并用 Chromium 验证主要手机流程；可通过
`PHONE_CONTROL_BROWSER` 指定已有浏览器可执行文件。

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
