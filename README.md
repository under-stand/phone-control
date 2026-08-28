# Phone Control

Phone Control 是一个本地优先的 Codex 手机控制面板。它把桌面端、IDE 和 CLI 会话整理成适合
手机查看的任务流，并支持查看进度、回答问题、续聊、发送图片、中止任务和接收完成提醒。

服务与数据保留在自己的电脑上；手机通过 Tailscale、可信局域网或自建 VPS HTTPS Relay 访问。

## 平台支持

追踪任务只需要读取 Hooks 与 rollout；续聊、新建和中止等完整控制还要求 Phone Control 能访问
同一运行环境中的受管 Codex App Server。

| 电脑端运行方式 | 电脑界面 | 追踪与通知 | 完整手机控制 |
| --- | --- | --- | --- |
| Linux 原生 | App、IDE 或 CLI | 支持 | App Server 可用时支持 |
| macOS | App、IDE 或 CLI | 支持 | App Server 可用时支持 |
| Windows 原生 | Windows App 或 CLI | 支持 | 当前不完整 |
| Windows App + WSL2 Agent | 仍然是 Windows App | 目标支持 | 尚未完成一键集成与真机验证 |
| WSL2 中的 Codex CLI | CLI | 支持 | 同一发行版内 App Server 可用时支持 |

WSL2 是 Agent 的执行环境，不等于 CLI。Windows Codex App 可以把 Agent 切换到 WSL2，同时继续
使用桌面 App 界面；只有在 WSL2 终端中直接运行 `codex` 才是 CLI。参见 OpenAI 官方的
[Windows App 说明](https://learn.chatgpt.com/codex/windows/windows-app)和
[WSL2 说明](https://learn.chatgpt.com/codex/windows/wsl)。更完整的能力边界见
[插件使用说明](plugins/plugin-phone-control/README.md#平台与功能边界)。

## Windows 一键安装

在 Windows PowerShell 中粘贴一行：

```powershell
irm https://raw.githubusercontent.com/under-stand/phone-control/main/plugins/plugin-phone-control/install-windows.ps1 | iex
```

安装器会检查 Git、Node.js 22+ 和 Codex，安装插件与依赖，创建当前用户的自恢复后台任务，并在
Tailscale 已登录时尝试生成私有手机入口。也可以下载仓库 ZIP，解压后双击
`plugins\plugin-phone-control\install-windows.cmd`。

当前一键安装器配置的是原生 Windows 追踪模式，支持任务历史、Hooks、通知和仪表盘。需要成熟的
完整控制时，暂时在同一个 WSL2 发行版中运行 Codex CLI 与 Phone Control；Windows App + WSL2
Agent 的专用安装与真机验证仍在计划中。

## Linux、macOS 与 WSL2

需要 Node.js 22+、已登录且支持 `codex plugin` 的 Codex，以及 Git：

```bash
git clone https://github.com/under-stand/phone-control.git
cd phone-control

codex plugin marketplace add .
codex plugin add plugin-phone-control@phone-control

cd plugins/plugin-phone-control
npm ci
npm run verify
node ./bin/phone-control.mjs service install --runtime "$(command -v node)"
node ./bin/phone-control.mjs pair --no-qr
```

服务默认只监听 `127.0.0.1:8787`。不要把普通 HTTP 服务直接暴露到公网。手机接入、Tailscale、
VPS Relay、配对、更新和故障处理见[完整使用说明](plugins/plugin-phone-control/README.md)。

## 仓库结构

- `plugins/plugin-phone-control/`：插件、服务、PWA、CLI、测试和部署示例；
- `.agents/plugins/marketplace.json`：Codex 仓库 marketplace；
- `SECURITY.md`：安全边界与私密漏洞报告方式；
- `ROADMAP.md`：产品方向与后续优先级。

## 验证

```bash
cd plugins/plugin-phone-control
npm ci
npm run verify
npx playwright install chromium
npm run test:mobile
```

项目采用 MIT License。参与开发前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。
