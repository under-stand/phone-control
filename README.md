# Phone Control

Phone Control 是一个本地优先的 Codex 手机控制面板。它把桌面端、IDE 和 CLI 会话整理成适合
手机查看的任务流，并支持查看进度、回答问题、续聊、发送图片、中止任务和接收完成提醒。

服务与数据保留在自己的电脑上；手机通过 Tailscale、可信局域网或自建 VPS HTTPS Relay 访问。

## Windows 一键安装

在 Windows PowerShell 中粘贴一行：

```powershell
irm https://raw.githubusercontent.com/under-stand/phone-control/main/plugins/plugin-phone-control/install-windows.ps1 | iex
```

安装器会检查 Git、Node.js 22+ 和 Codex，安装插件与依赖，创建当前用户的自恢复后台任务，并在
Tailscale 已登录时尝试生成私有手机入口。也可以下载仓库 ZIP，解压后双击
`plugins\plugin-phone-control\install-windows.cmd`。

原生 Windows 当前支持任务追踪、Hooks、通知和仪表盘。续聊、新建和中止依赖 Codex App Server
控制 socket，暂时需要把 Codex 与 Phone Control 安装在同一个 WSL2 发行版中。详情见
[完整使用说明](plugins/plugin-phone-control/README.md)。

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
