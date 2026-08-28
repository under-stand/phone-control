# Phone Control

Phone Control 是一个本地优先的 Codex 手机控制面板。它把桌面 App、IDE 和 CLI 会话整理成适合
手机查看的任务流，并支持查看进度、回答问题、续聊、发送图片、中止任务、新建会话和接收完成提醒。

服务与数据保留在自己的电脑上；手机通过 Tailscale、可信局域网或自建 VPS HTTPS Relay 访问。

## 平台支持

| 电脑端运行方式 | 电脑界面 | 追踪与通知 | 安全手机控制 | 控制通道 |
| --- | --- | --- | --- | --- |
| Linux 原生 | App、IDE 或 CLI | 支持 | 支持 | Unix Socket，缺失时回退 stdio |
| macOS | App、IDE 或 CLI | 支持 | 支持 | Unix Socket/stdio + 用户级 launchd |
| Windows 原生 | Windows App 或 CLI | 支持 | 支持 | 受管本机 stdio App Server |
| Windows App + WSL2 Agent | 仍是 Windows App | 支持 | 在会话所属一侧安装时支持 | 自动按 Windows/WSL2 环境选择 |
| WSL2 中的 Codex CLI | CLI | 支持 | 支持 | WSL2 内 Unix Socket 或 stdio |

Windows 原生模式不要求 WSL2。WSL2 只是 Windows App 可选的 Agent 执行环境，不等于 CLI；只有在
WSL2 终端里直接运行 `codex` 才是 CLI。参见 OpenAI 官方的
[Windows App 说明](https://learn.chatgpt.com/codex/windows/windows-app)、
[WSL2 说明](https://learn.chatgpt.com/codex/windows/wsl)和
[App Server 协议](https://learn.chatgpt.com/codex/app-server)。

控制遵循运行时所有权边界：空闲会话可以安全恢复，手机启动的 turn 可以继续或停止；如果一个 turn
正在另一个 App/CLI 进程中执行，而 Phone Control 无法证明自己拥有它，手机端会暂时只读，结束后
即可恢复。这避免两个客户端同时写入同一 turn。

## Windows 一键安装

在普通 Windows PowerShell 中粘贴：

```powershell
irm https://raw.githubusercontent.com/under-stand/phone-control/main/plugins/plugin-phone-control/install-windows.ps1 | iex
```

安装器会检查 Git、Node.js 22+、Codex Plugin 和 App Server，安装插件与依赖，保存实际 Codex
路径，并创建当前用户的自恢复后台任务。Tailscale 已登录时还会尝试生成私有手机入口。也可以下载
仓库 ZIP，解压后双击 `plugins\plugin-phone-control\install-windows.cmd`。

## Linux、macOS 与 WSL2

需要 Node.js 22+、已登录且支持 `codex plugin` 与 `codex app-server` 的 Codex，以及 Git：

```bash
git clone https://github.com/under-stand/phone-control.git
cd phone-control

codex plugin marketplace add .
codex plugin add plugin-phone-control@phone-control

cd plugins/plugin-phone-control
npm ci
npm run verify
node ./bin/phone-control.mjs service install \
  --runtime "$(command -v node)" \
  --codex-command "$(command -v codex)"
node ./bin/phone-control.mjs pair --no-qr
```

Linux 优先使用 user systemd，macOS 使用原生 user launchd，其他 Unix 环境回退到 `tmux + cron`。
服务默认只监听 `127.0.0.1:8787`；不要把普通 HTTP 服务直接暴露到公网。手机接入、配对、更新、
VPS Relay 和故障处理见[完整使用说明](plugins/plugin-phone-control/README.md)。

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
