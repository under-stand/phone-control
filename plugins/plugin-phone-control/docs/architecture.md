# Architecture

## 数据路径

```text
Codex Desktop / IDE / CLI
  ├─ passive lifecycle hooks ───┐
  ├─ sync PermissionRequest ────┤
  ├─ ~/.codex/sessions/*.jsonl ─┤
  └─ managed app-server WS ─────┤
                                ▼
                    Phone Control sidecar
                    ├─ normalized state
                    ├─ bounded event + audit logs
                    ├─ device + approval broker
                    ├─ VAPID Web Push + private image staging
                    ├─ live question + turn control bridge
                    ├─ authenticated REST
                    └─ authenticated SSE
                                ▼
                         Mobile-first PWA
```

被动 Hooks 提供权威的实时生命周期边界；rollout scanner 提供旁路发现、来源判断、对话摘要和
sidecar 离线期间的历史恢复。两条数据路径通过 Codex `session_id` 合并。为兼容尚未支持插件
`async` handler 的 Codex 版本，被动 handler 使用受支持的同步 command，但外层超时限制为 1 秒；
本机 HTTP 投递内部限制为 350 毫秒，失败立即写入有上限的 spool。`PermissionRequest` 使用独立的
同步处理器，以保留手机审批语义。Hook 命令优先从稳定的 `PLUGIN_DATA/hook-runtime` 启动；首次
执行从版本化 `PLUGIN_ROOT` 原子生成该最小运行时，避免插件 cache 更新时打断常驻 App Server。

SessionStore 仍在本机保留内部、测试和诊断状态，供分类、控制边界和服务日志排障使用；正常
`/api/sessions` 快照与 SSE 只下发具有真实用户意图的顶层会话。事件采用短窗口批量落盘，rollout
里由不同记录类型产生的相邻同文消息按语义去重，避免历史日志、网络快照和手机 DOM 同步膨胀。
服务重启时会先开放 HTTP/SSE 和已有的持久化快照，再执行首次 rollout 扫描与现场订阅恢复；手机
因此可以立即加载页面，控制能力则在验证完成后逐步更新。

### 任务语义与检索

会话列表不再用最后一条用户消息充当标题。SessionStore 会保留第一条有实际内容的用户目标；“好的，
去做吧”一类纯确认不会抢占任务身份，后续追加指令也不会改写已经确定的主目标。公共会话摘要派生出稳定
标题、目标、当前进展、最近结果和是否需要用户处理，卡片与目标追踪共用这组字段。

已认证的 `/api/tasks/search` 在本机搜索当前保留窗口中的任务标题、目标、项目、机器、真实用户指令和
Codex 可见回复。每个会话的标准化搜索文档按事件更新失效并懒重建，列表快照会自然预热缓存，连续输入
无需反复清洗整段历史。手机端先用摘要字段即时过滤，再以 180 毫秒防抖请求完整结果；网络暂时不可用时
仍保留卡片级搜索。消息命中会返回 event/turn identity，详情页读取必要历史后定位并高亮精确回复。

顶栏连接状态是一个 44px 可点击控制。用户主动重试时会使旧的前台恢复代次失效，同时发起新的
会话快照请求和 SSE 连接，任一通道成功即可恢复界面；进行中的重复点按被单飞锁合并，失败后继续
沿用有上限的自动退避，不会形成重连风暴。

会话详情与新建表单使用 fixed modal 加动态视口单位 `dvh`，最大高度同时扣除顶部 safe-area。
因此移动浏览器地址栏显示时以当前可见区域为边界，地址栏折叠后再自然扩展，而不是用布局视口的
静态 `vh` 把弹层顶部推到屏幕外。

新建会话的提交栏是表单滚动容器内的 sticky footer，持续展示项目与模型摘要；展开运行配置不会再
把主操作推到屏幕之外。会话内的后续轮次设置使用第二个原生 `dialog`，浏览器负责焦点圈定与背景
不可操作，父详情关闭按钮在该层打开时隐藏，避免两个关闭入口同时争夺注意力。

对话消息保持纯文本存储。PWA 仅对 assistant message 应用无依赖的安全 Markdown 子集，先逐字段
转义再生成段落、标题、列表、引用、代码和语义化表格；仅将验证后的 `http(s)`/`www.` 地址生成
无来源信息的新标签页链接，不接受原始 HTML 或其他 URL 协议。解析结果使用有上限的内存缓存，
长回复仍受现有展开窗口和历史分页约束。展示层按 `turnId` 将用户指令、过程回复、最终回复和运行
事件归组：默认只展开每轮最终回复，工具与生命周期事件保留在轮次内的原生 `details` 中；最近三轮
常驻，较早对话以八轮为一页，不改变底层事件持久化。若 Hook 的用户指令带 turn ID，而五秒内同文
rollout 副本暂时没有 turn ID，展示层会将副本并入前者并按来源去重；同一来源或时间窗口外的重复
指令仍视为用户有意重发。rollout parser 对用户和 assistant
正文使用保留换行的截断函数；短标题、错误和工具摘要继续使用单行压缩。近期 rollout 重放遇到
相同事件 ID 时，SessionStore 会在空白折叠后的正文完全一致且新版本包含更多换行时原位升级事件；
也会在旧正文恰好是 2,000 字符、以省略号结尾且新正文前缀完全吻合时，恢复旧版截断的完整内容。
rollout 中标为 `role=user` 的 `recommended_plugins`、环境/权限/协作模式、仓库指令、guardian 评审、
turn-aborted 和图片路径包装是 Codex 内部上下文，并不代表用户意图；解析器拒绝新记录，SessionStore
恢复时在内存中过滤旧记录，但保留追加式审计日志直到正常 retention 到期。已知旧 Hook 压测会话也
按测试记录分类，不进入最近任务。

## 控制所有权

Phone Control 只主动控制受管 app-server 可以验证的现场 thread，或明确结束/空闲且存在 rollout
的历史 thread。独立 CLI/Desktop 中仍为 `working` 或 `waiting` 的会话只做追踪，因为 app-server
无法证明另一运行时已经释放它。这个边界会牺牲少量“崩溃后立即续聊”的便利，以避免两个客户端
并发写入同一会话。

`thread/loaded/list` 偶尔会包含无法找到 rollout 的进程内 thread。桥接器先为新建 thread 的落盘
竞态保留三次短暂重试；持续失败后在当前加载周期标记为不可用并只警告一次。thread 从加载列表
消失时标记会被清除，之后重新出现会再次验证。

事件日志恢复后，过期或超过现场时效的等待请求会转为不可控制的 `unknown` 状态。实时
`request_user_input` 本身只存在内存，不会从磁盘伪造可回答表单。

## 手机状态快照

已配对设备打开“状态”时，sidecar 通过现有 App Server 连接并行调用 `account/read`、
`account/rateLimits/read` 和 `config/read`。响应先在服务端转换成固定公共结构：遮罩邮箱，仅保留
套餐、模型、推理强度、service tier、审批/沙箱摘要，以及额度百分比、窗口和重置时间。原始配置、
认证令牌和重置凭证不进入 HTTP 响应。普通读取缓存 30 秒，用户显式刷新才绕过缓存。

sidecar 还会执行一次有 2 秒上限的 `codex --version`，并从 App Server `initialize` 的
`userAgent` 提取后台版本。两者不一致时状态页只给出重启建议，不自动终止任何 Codex 进程；
这样可以识别升级前由 Desktop、Remote SSH 或长期终端留下的宿主，而不会误杀仍在工作的 turn。

会话级模型、目录、权限、session ID 和运行态继续来自 SessionStore；页面选择最近的活跃会话，
没有活跃会话时选择最近更新的一条。因此它是 `/status` 的安全移动摘要，而不是逐字复制 TUI。

同步 `PermissionRequest` Hook 默认只上报并立即退出。显式启用手机审批后，sidecar 也只为同一
turn 中已经存在 `phone_input_sent` 所有权标记的事件生成短期、单次 challenge；Desktop/CLI turn
立即退出 Hook，保留 Codex 原有审批通道。手机决定后 Hook 只返回本次 allow/deny，超时或断线时
不返回 decision。

交互回答走另一条严格绑定的路径。sidecar 只连接
`~/.codex/app-server-control/app-server-control.sock` 的本机 Unix WebSocket，完成 JSON-RPC
`initialize`，再通过 `thread/loaded/list` 标记现场 thread。只有 app-server 直接发来的
`item/tool/requestUserInput` 才会生成手机表单；响应使用原 JSON-RPC request id，并在服务端
再次核对 thread 和 turn。rollout 或 Hook 中发现的历史问题不会获得可回答能力。

`thread/loaded/list` 只证明 thread 在内存中，不会自动订阅另一个连接的事件。桥接器因此仅对
该列表中的 thread 调用不带配置覆盖的 `thread/resume` 来建立事件订阅，并设置
`excludeTurns: true`。恢复响应附带一页 `limit: 1`、倒序且 `itemsView: notLoaded` 的 turn 元数据，
用于识别当前 active turn，但不会传输历史 items 或整段 `thread.turns`。若 App Server 忽略
`excludeTurns`，该 thread 立即隔离为只读。该操作本身不启动 turn，也不会更新 rollout 的修改时间。

初始化还通过 `optOutNotificationMethods` 关闭 Phone Control 不消费的 item 内容、reasoning、命令
输出、diff、plan 和 token usage 增量。后台订阅串行进行，使 transport 级超大消息可以归因到唯一
thread；该 thread 会在当前进程内熔断，其他 thread 在重连后继续订阅。WebSocket 与 JSON 行均有
128 MiB 上限，解析器使用分块队列避免每个网络分片都复制已有缓冲区。重连退避从 1 秒指数增长到
30 秒，只在 initialize 与完整订阅轮次都健康后复位。新 `thread/started` 通知会触发同样的订阅
流程；桥接器也会每两秒刷新 loaded 列表。断线会清空现场绑定，但保留本进程内的超大 thread 隔离。

## 会话控制状态

桥接器从 `thread/resume` 返回值和 `thread/status/changed`、`turn/started`、`turn/completed`
通知维护每个 thread 的权威运行态。手机页面只消费服务端派生出的控制能力：

- 未加载、存在 rollout 且状态明确结束或空闲：显示 `resume`，提交后先恢复；
- 已订阅且 idle：显示 `start`，调用 `turn/start`；
- 已订阅且 active：只有已知当前 turn id 且没有等待审批/回答时才显示 `steer` 与 `interrupt`；
- 等待审批或回答：关闭通用输入，显示绑定请求的专用表单；
- 仍可能被独立 CLI/Desktop 占用、无 rollout、临时 thread、断线或状态不明：只读。

因此交互能力必须满足以下条件后才能启用：

1. 找到明确的 app-server 或 Codex App control endpoint；
2. 完成 JSON-RPC `initialize`；
3. 用 metadata-only `thread/resume` 建立订阅并读取 runtime status 与最新 turn identity；
4. 记录 endpoint、thread、活动 turn 和 active flags 的绑定关系；
5. `turn/steer` 与 `turn/interrupt` 都携带页面看到的精确 turn identity，由 sidecar 和 app-server
   逐层做最终前置条件校验；
6. 断线、绑定漂移、元数据模式不受支持或单 thread 超限时立刻降级为只读。

`turn/start` 默认沿用 thread 的 sticky configuration；用户显式选择时只覆盖服务端从 `model/list`
验证过的 `model`、`effort` 与 `serviceTier`。这些字段按 App Server 协议作用于本轮及后续轮次；
`turn/steer` 不接受覆盖，因此 active turn 的追加输入不显示运行配置。权限与沙箱不开放覆盖。每次手机输入使用独立 client message id；
文本和受控 `localImage` 可以组成同一组 App Server `UserInput`，
审计不含正文或图片路径。图片只来自设备/session/turn 绑定的短期私有 staging 文件，Codex 接收
路径后进入不可复用租约，最长保留 15 分钟供异步读取；租约跨 sidecar 重启恢复，过期后删除。
中止操作只结束当前 turn，不删除 thread。请求送达后桥接器为该 turn 保留
`interruptRequested` 状态并拒绝重复请求，直到收到 `turn/completed` 的 `interrupted` 结果；如果
传输中断导致送达状态未知，不自动重试。

## 会话创建与销毁

`POST /api/sessions` 只接受首条文本、当前机器上存在的绝对 cwd、可选的白名单模型/推理等级/
service tier 和幂等 client message id。`GET /api/models` 读取并缓存 App Server `model/list`，只输出
渲染选择器所需字段，同时从可见用户会话聚合当前机器最近使用的目录；提交时桥接器重新验证模型 ID、
effort、service tier 与目录。桥接器调用 `thread/start` 创建独立 thread，再把首条文本交给
`turn/start`；HTTP 响应携带实际 thread/turn
绑定，SessionStore 仍通过同一事件归一化路径展示它。若创建 thread 后首轮明确被 App Server 拒绝，
桥接器会尝试删除未使用的 thread；传输结果不明确时则不做可能误删的补偿操作。

`DELETE /api/sessions/:id` 要求同源已配对写请求、顶层用户会话、无等待问题/审批，并且状态不是
`working`/`waiting`。桥接器再次核对现场状态后调用 `thread/delete`。成功通知会删除 SessionStore
快照、详情缓存、草稿/附件引用和设备目标，并向 SSE 广播 `session_removed`。事件日志追加
`session_deleted` tombstone；服务重启或 rollout 扫描遇到同一 ID 的迟到事件时不会把会话复活。

## 通知通道

SSE 负责页面打开时的实时视图；标准 Web Push 负责 PWA 关闭后的系统通知。`CompletionPolicy` 是
唯一通知判定点：服务启动完成扫描和 App Server 初始同步后先建立状态基线，要求 thread + turn 的
稳定完成标识。等待、错误、子会话、历史会话、连续 `idle`/`completed` 和同一 turn 的延迟事件都不会
生成完成事件。符合条件的顶层用户会话再按设备保存的目标 session 筛选 SSE 与 Web Push 接收者；
没有目标的设备只接收最近活跃主会话。页面可见时 service worker 把 Push
转交给页面并由本地完成 key 去重；页面隐藏时才显示系统通知，避免双重弹窗和声音。点击通知后打开
或聚焦 `/?session=<id>`，页面在鉴权和会话快照完成后再打开详情。

Android/iOS 可以冻结或丢弃后台页面，因此 Phone Control 不把 SSE 永久在线当作可靠性前提。
页面隐藏或收到 `freeze` 时保存草稿并主动关闭实时流；回到前台后，会并行执行 `/api/sessions`
快照和新的 SSE 握手，任一成功即可恢复可用界面。同一次唤醒产生的 `visibilitychange`、`resume`、
`pageshow` 和 `online` 共享一个恢复事务；若现有 SSE 仍健康则直接复用，不重复关闭连接或读取完整
会话列表。浏览器的 `navigator.onLine` 只表示一个不可靠的系统提示，不直接改变连接状态。

连接指示采用 12 秒瞬时抖动宽限：最近实时事件仍新鲜时保持当前现场，HTTP 快照可用但实时流持续
未恢复时显示“已同步”，两条通道都不可用才进入“恢复中/重试”。SSE 每 12 秒发送命名 `ping`，
可见页面超过 36 秒未收到任何流事件时主动替换半开连接。后台完成提醒继续由 Web Push/Service
Worker 承担，不要求页面常驻执行。

## 状态模型

| 状态 | 主要来源 |
| --- | --- |
| `working` | prompt、turn start、tool start/end、subagent 活动 |
| `waiting` | `PermissionRequest`、`request_user_input` |
| `idle` | `Stop`、`task_complete` |
| `completed` | `SessionEnd` |
| `aborted` | `turn_aborted` |
| `error` | rollout error event |
| `unknown` | 仅发现 thread，尚无足够活动证据 |

状态之外还有 `liveness`：`recent` 表示十分钟内看到活动，`historical` 表示已结束/空闲，
`unverified` 表示仍显示运行或等待，但无法从持久化日志证明原 runtime 仍然在线。

## 本地文件

默认位于 `~/.phone-control/`：

- `config.json`：版本化监听、安全和保留配置，权限 `0600`；
- `devices.json`：设备 ID 和凭证哈希，不保存设备明文凭证；
- `push.json`：VAPID 密钥与按设备绑定的 PushSubscription，权限 `0600`，不会经状态 API 返回；
- `uploads/`：图片发送的随机短期 staging 目录，目录 `0700`、文件 `0600`；成功交付的路径进入
  不可复用、可跨服务重启恢复的 15 分钟读取租约；
- `events.jsonl`：自动压缩的归一化事件日志，用于 sidecar 重启恢复；
- `audit.jsonl`：审批 challenge 与交互问题的绑定、过期、设备和送达审计，不含回答正文；
- `hook-spool.jsonl`：有大小上限的短期 Hook 队列；
- `run-service.sh` / `service.log`：非 systemd 环境的 tmux 守护入口与日志。

rollout transcript 只读，不被 Phone Control 修改。

## 运行与发布

### 可选 VPS Relay

VPS Relay 是现有 HTTP/SSE 边界之外的透明传输层。sidecar 继续只监听 `127.0.0.1`，FRP client
从电脑主动建立 TLS 隧道；VPS HTTPS edge 只把已过滤的公网请求转发到 VPS 回环上的 FRP proxy。
公网 edge 明确拒绝 `/api/internal/`，替换而不是继承 forwarded headers，并关闭会记录配对码、
session ID 或 URL 的访问日志。FRP token 与客户端配置使用独立 `0600` 文件，relay 元数据不含
secret。

Relay service 使用独立的 systemd unit 或 `phone-control-relay` tmux session，不重启主 sidecar。
配置默认 standby；`relay activate` 只有在 client config、后台服务、本机健康与公网 HTTPS 四项
诊断都通过后才保存新的 `publicUrl`，`relay deactivate` 恢复配置时记录的旧入口。

后台服务定义记录明确的 Node 与插件 entry 元数据。`service install` 先用当前 Node 执行目标入口的
`--help` 预检，再原子替换 systemd unit 或 tmux launcher，并主动重启现有服务；因此 Node 或插件
安装根升级后不会继续静默运行旧工作区。`doctor` 将 Node 22+、稳定个人插件根、服务定义、App
Server socket 与设备记录作为分层检查输出。

设备凭证只对 active 记录执行 50 台上限。撤销记录按时间最多保留 20 条，超过上限时自动删除最旧
记录；手机端默认只展开 active 设备，用户也可以清理全部撤销历史。生产源代码的格式化工具已从
单体页面脚本拆为可独立测试的 ES module；服务诊断与服务定义生成也拆为纯模块。GitHub Actions 在
Node 22 上运行语法检查、实现测试和生产依赖审计，作为发布前的基础门禁。
