# Phone Control 维护约定

## 源码与发布

- 唯一 canonical 源码是 `under-stand/phone-control` monorepo 的
  `plugins/plugin-phone-control/`。
- `~/.agents/plugins/marketplace.json` 中的 personal 插件源只是可重建的安装镜像；不要在
  personal 源或 Codex 版本化 cache 中手工开发。
- 旧的独立 `plugin-phone-control` 仓库只作为回退副本；在确认 monorepo 已包含全部历史前不要删除。
- 发布前使用 Node.js 22+ 执行 `npm run verify:release`。它必须同时通过源码检查、实现测试和当前
  Codex App Server JSON Schema 契约检查；再执行生产依赖审计和敏感信息扫描。
- 更新现有插件时先用 `scripts/read_marketplace_name.py` 确认 marketplace，再用
  `scripts/update_plugin_cachebuster.py` 更新唯一 cachebuster；通过 `validate_plugin.py` 后执行
  `codex plugin add plugin-phone-control@personal`，不要手改 marketplace 配置。
- 正式发布应同步 monorepo 插件目录到 personal 安装镜像，确认服务从稳定安装路径启动，并推送提交和
  annotated version tag；已发布 tag 不得移动或覆盖，并应创建对应 GitHub Release。服务数据、设备记录、
  配对凭证、Relay token 和 Codex rollout 绝不进入 Git。

当前已发布版本：`0.12.2`，公开提交和标签以 GitHub `under-stand/phone-control` 为准。

## 协议与所有权边界

- Phone Control 的 Codex 出站枚举只能在协议边界统一构造；内部旧拼写可以归一化，但发给 App Server
  的审批值必须是当前 schema 接受的 wire enum（例如 `on-request`）。
- CLI、Desktop App 和 Phone Control 的写入所有权必须保持可验证；不能为了让手机可操作而抢占其他客户端
  的活动 turn。无法证明所有权时保持只读或排队，并显示可解释原因。
- CLI 追踪、Hooks、rollout 历史、SSE 和手机控制是不同能力；App Server 控制通道重连时不应冻结历史
  追踪，也不要把 CLI 误称为临时 App Server 会话。
- Codex 控制与 Chrome 浏览器控制保持独立生命周期、租约、幂等和安全边界；不要抽象成虚假的统一控制器。

## 架构与产品优先级

- 不继续把功能堆进 `public/app.js`、`src/server.mjs`、`src/app-server-bridge.mjs` 或
  `src/session-store.mjs`；按职责渐进拆出 Codex、HTTP、Session、Browser、Service 和前端 feature 模块。
- 不引入一次性大规模框架重写、通用 DI 容器或自制全局 EventBus；优先小而显式、可测试的边界。
- 产品优先级：统一任务状态 → 有语义的任务卡片与检索 → “待我处理”收件箱 → 离开期间增量摘要 →
  结构化结果审阅 → 多机器入口与任务编排。
- 每次修复都要考虑手机断线、后台恢复、重复事件、陈旧审批、任务串线、只读降级、连接重试和小屏键盘
  等边界；用户可见状态必须来自同一份派生 Session/Task 投影。

## 协作默认动作

- 用户说“去做吧”时，先检查 canonical monorepo、当前远端和正在运行的 personal 服务版本，再决定同步、
  测试、提交或回滚；不要默认在旧独立仓库继续开发。
- 完成代码变化后报告：改动范围、测试结果、服务健康状态、提交/标签和仍未完成的验证项。
- 不输出或提交真实主机名、IP、用户名、工作目录、访问令牌、密码、证书、设备凭证、会话记录或个人日志。
