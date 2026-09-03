# Repository architecture audit — 2026-09-03

## Outcome

Phone Control 已经从单机辅助脚本成长为包含 Codex 会话聚合、实时控制、审批、通知、图片、浏览器桥接、
VPS Relay 和跨平台安装的产品。当前实现仍可维护，也有 155 项实现测试保护，但新增功能继续集中进入
三个大文件，发布源又存在多份副本。下一阶段应先稳定边界和发布链路，再继续扩展产品能力。

本次审计同时修复了一个真实协议回归：手机开始下一轮时发送了旧式 `onRequest`，当前 Codex App
Server 只接受 `on-request`。权限映射现已移入 `src/codex-permissions.mjs`，并增加
`npm run check:protocol`，直接用已安装 Codex 生成的 JSON Schema 校验出站枚举。

## 快照

| 区域 | 规模 | 主要职责 |
| --- | ---: | --- |
| `public/app.js` | 4,054 行 / 77 个事件监听 | 列表、搜索、连接、详情、输入、通知、设备和渲染 |
| `src/app-server-bridge.mjs` | 2,179 行 | 协议、连接、订阅、状态、命令、审批、移交和审计 |
| `src/server.mjs` | 1,852 行 / 54 条路由 | 组合根、HTTP、鉴权、API、SSE、队列和静态资源 |
| `src/session-store.mjs` | 1,034 行 | 事件归并、任务投影、控制状态、搜索、保留和持久化 |
| 测试 | 155 项实现测试 | 核心边界覆盖良好，真实 Codex 协议契约此前未进入门禁 |

## 最高优先级问题

### P0：源码和运行版本没有单一事实来源

当前机器同时存在旧独立仓库、公开 monorepo 的嵌套插件、personal 插件源、Codex 版本缓存和常驻服务
固定路径。公开修复、开发工作区和实际运行服务可以分别处于不同版本；本次“远端已经修复但手机仍是
旧界面”就是直接后果。

目标状态：

1. `under-stand/phone-control` monorepo 是唯一可提交源码；
2. `plugins/plugin-phone-control` 是唯一开发目录；
3. personal source 只作为可重建的安装镜像，不做手工开发；
4. 服务定义固定稳定安装源，并在健康接口报告源码版本、资源版本和启动根；
5. 发布脚本一次完成版本、前端缓存、插件 cachebuster、验证、安装和服务重启，任何一步失败即停止。

旧独立仓库暂时保留为可回退副本，确认 monorepo 已包含全部提交后再归档；不要直接删除。

### P0：mock 测试与真实 Codex 协议之间存在空隙

桥接器测试验证了自己构造的请求，却没有验证这些值仍被当前 Codex 接受。因此 mock 接受了
`onRequest`，而真实 App Server 拒绝。所有出站 DTO 应只在一个协议边界构造，并在发布前对 Codex
生成的 schema 做契约检查。不要让 UI、SessionStore 或 HTTP 路由直接拼 App Server 枚举。

### P1：三个编排文件已经超过合适尺寸

- `server.mjs` 应保留为组合根和生命周期管理；路由按 `system/auth`、`sessions/control`、
  `devices/push`、`browser` 四组渐进迁出。使用小型显式路由函数即可，不引入通用 Web 框架。
- `app-server-bridge.mjs` 应保留连接状态机；协议 DTO、订阅恢复、thread/turn 命令、审批交互和桌面移交
  分成可独立测试的协作者。先拆纯函数和无状态映射，再拆有状态流程。
- `public/app.js` 应先迁出纯渲染与 selector，然后按任务列表、会话详情/输入、连接恢复、通知/设备拆分。
  保留一个小型 `state` 与启动入口；不要建立自制前端框架或全局 EventBus。

### P1：会话领域状态与存储耦合

`SessionStore` 的归并规则非常重要且复杂，不适合大改。先把纯事件 reducer/投影与 JSONL repository
分离，保持现有公开快照不变；搜索索引继续消费同一投影。迁移必须使用现有重复轮次、幽灵会话、延迟
最终回复和旧记录恢复测试作为 golden tests。

### P2：持久化和测试夹具重复

多个模块重复实现 `tmp + writeFile + rename` 的原子写入。可以抽出一个很小的 `atomic-file.mjs`，明确
模式、换行和失败清理；不要抽成通用 repository 框架。`server.test.mjs` 与
`app-server-bridge.test.mjs` 也应先提取共享 harness，再按行为拆文件，避免测试文件本身成为单体。

## 不应抽象的部分

- Codex 控制与浏览器控制的所有权、幂等和生命周期不同，不建立虚假的统一“远程控制器”接口。
- Tailscale/VPS Relay 是传输入口，App Server 是 Codex 控制协议，不放进同一连接状态机。
- 当前 `Task` 仍主要是 Session 的语义投影；在真正支持跨会话任务前，不新增独立数据库实体。
- 不为 54 条路由引入装饰器、依赖注入容器或复杂 router；显式函数和精确依赖对象更容易审计。
- 小而稳定的模块（认证、回放防重、租约、图片、推送）已经边界清楚，暂不合并或重写。

## 推荐实施顺序

1. **发布与协议可靠性**：统一 monorepo，增加协议 schema 门禁、运行版本证明和一键发布/回滚。
2. **输入控制可靠性**：把直发、排队、恢复、审批、失败和重试收敛为一套可观察命令状态机。
3. **行动收件箱**：默认展示需要回答、审批、失败和刚完成的任务，减少在“最近”中寻找。
4. **离开期间摘要**：按设备上次查看游标生成增量变化，不重新总结整段历史。
5. **结构化结果卡**：文件、diff、测试、产物、风险和下一步成为可快速审阅的交付对象。
6. **多机器统一入口**：在单机身份和状态可靠后，再加入机器注册、在线状态和统一任务检索。

## 渐进式目标结构

```text
src/
  codex/             transport、wire DTO、subscription、commands
  http/              HTTP primitives 与四组显式 routes
  session/           reducer、projection、repository、search
  browser/           保持独立的浏览器控制域
  service/           后台服务、Relay 与诊断
  server.mjs         仅组合依赖与管理生命周期
public/
  app.js             启动入口
  app/               api/state、connection、tasks、session-detail、notifications
```

目录迁移应随职责拆分逐步进行，不做一次性搬家。短期目标不是追求更多层，而是让每个故障只需要进入一个
清楚的边界定位。
