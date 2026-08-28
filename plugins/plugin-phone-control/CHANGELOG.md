# Changelog

本项目遵循语义化版本。这里只记录用户可见变化；开发方向见 [ROADMAP.md](ROADMAP.md)。

## 0.8.0 - 2026-08-29

- 新增跨平台 App Server Transport：Linux 与 macOS 优先使用 Unix Socket，缺失时自动回退到受管 stdio；原生 Windows 直接使用 stdio。
- macOS 后台服务改用当前用户的原生 `launchd`，不再要求另装 `tmux` 才能常驻。
- Windows 一键安装器现在验证 App Server、保存实际 Codex 路径，并启用新建、恢复空闲会话、继续对话和停止手机所拥有 turn 的能力。
- 保留精确运行时所有权边界：正在由另一个 App/CLI 进程执行且无法验证所有权的 turn 继续保持只读。
- `doctor` 现在分别检查 Unix Socket 与 stdio 能力，不再把“没有 Unix Socket”误判为所有平台都无法控制。

## 0.7.1 - 2026-08-29

- 修复当前轮次中同一条用户问题偶尔显示两次的问题。
- 去重时保留手机提交、Hook 与 rollout 的完整事件来源，不影响真正重复发送的问题。

## 0.7.0 - 2026-08-28

- 新增原生 Windows 一键安装器：自动检查 Git、Node.js 与 Codex，安装插件和依赖，并创建当前用户的自恢复计划任务。
- 已登录 Tailscale 时自动配置私有 HTTPS 入口并生成手机配对链接，也可以只安装本机入口。
- 为所有 Hooks 增加 PowerShell 命令，并使用无需管理员权限的 Windows junction 保存稳定 Hook 运行时。
- 明确原生 Windows 与 WSL2 的能力边界：原生模式支持追踪、通知和仪表盘，完整续聊与中止暂时使用 WSL2。

## 0.6.1 - 2026-08-28

- 让 `doctor` 正确认可公开仓库中的稳定插件目录，同时继续拒绝版本化 Codex 缓存目录。
- 修复 GitHub Actions 上智能命名等待与跨平台字体度量造成的移动回归误报。
- 更新 GitHub Actions 到当前 Node 运行时版本。

## 0.6.0 - 2026-08-28

- 提供标准 Codex 仓库 marketplace 安装结构与公开安装说明。
- 完成移动端任务追踪、检索、续聊、图片输入、中止、通知和会话生命周期的首个公开版本。
- 增强会话归并、历史分页、连接恢复、状态一致性和重复通知抑制。
- 将手机布局、Markdown、表格、链接、键盘和详情页关键流程纳入 Playwright 回归测试。
- 通用化 VPS Relay 示例，移除开发机器专用地址与路径。

## 0.5.3

- 建立本地优先的 Codex 手机控制面板、设备配对、SSE 状态流和可选 VPS Relay。
