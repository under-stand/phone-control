# Security

Phone Control 可以展示本机 Codex 会话、工作目录、工具名称和消息摘要，应按开发机远程
访问能力保护。

## 支持版本与漏洞报告

当前仅维护最新的 `0.9.x` 版本。旧版本收到安全修复时应升级到最新发布版。

Windows 的“移交电脑 / 手机接管”只对来源为 Desktop 的用户会话开放；CLI 会话既不显示按钮，
服务端也拒绝所有权移交接口。“移交电脑”只在 Phone Control 自己管理的 stdio App Server 上开放，
并要求共享进程内所有已订阅 thread 都处于空闲且没有待处理问题或审批。用户确认后，服务关闭该
受管进程以释放 `active writer`，只把用户选择的 Desktop thread 标记为手机只读，再启动一个不加载
该 thread 的新进程；共享进程中其他被短暂释放的会话仍可按原流程恢复。

“手机接管”先以 `thread/read` 只读检查目标状态，再调用 `thread/resume` 并验证恢复结果为空闲；
只有全部成功才清除只读标记。电脑端仍在运行或持有 active writer 时，服务保留已移交状态且不会
自动重试；若状态在检查与恢复之间变为 active，或恢复结果异常，服务会重启自己管理的 App Server，
立即回滚可能刚取得的写入权。共享 Unix Socket 不会被手机端关闭，也不宣称支持立即移交。

请不要通过公开 Issue 报告漏洞。使用 GitHub 的
[私密安全公告](https://github.com/under-stand/phone-control/security/advisories/new)，说明受影响版本、
复现条件、影响和建议修复；不要附带真实令牌、Cookie、Codex 会话或工作目录。如私密报告入口
暂不可用，请只提交一个不含漏洞细节的普通 Issue，请求维护者开启私密联系渠道。

## 支持的部署方式

- 默认回环监听，仅本机访问；
- 可信局域网；
- Tailscale、WireGuard 或 SSH 端口转发；
- 自行配置的 HTTPS/WSS 反向代理和身份认证。

不要把 `--host 0.0.0.0` 的普通 HTTP 端口直接暴露到公网。

## 鉴权与设备

- 首次运行生成 256-bit 随机令牌；
- 配置文件权限为 `0600`；
- 主访问令牌只用于本地 Hook 鉴权和手工恢复配对，不再作为日常浏览器凭证；
- 一次性配对 URL 十分钟过期、消费一次后立即失效；
- 每台浏览器获得独立随机凭证，服务端只保存 SHA-256 哈希，可在手机端单独撤销；
- 撤销记录不再参与设备上限，最多保留最近 20 条供用户识别历史设备；设备页默认折叠这些记录并
  允许显式清理。清理不会恢复访问，也不会删除任何仍有效的设备凭证；
- 每台设备可以保存一个目标 session ID，用于筛选该设备的完成通知；设备列表不会向其他设备公开
  这一偏好，目标设置不能指向手机任务 API 之外的内部或诊断会话；
- 浏览器后续使用 `HttpOnly; SameSite=Strict` Cookie；HTTPS 部署应启用 `Secure`；
- API 不启用 CORS，写操作同时检查自定义客户端头、Fetch Site 和同源 Origin；
- Hook ingestion 同时要求 bearer token 和 loopback 来源。

## Chrome Browser Bridge

浏览器控制是可选功能，能力等同于远程查看和操作已经登录的普通网页，应只授权给自己完全信任的
配对设备。扩展使用 Chrome `debugger` API，因此 Chrome 会明确显示标签页正在被调试。扩展只把
`http:`、`https:` 和空白新标签视为可控目标；`chrome://`、扩展页和 `file://` 不允许截图或操作。

扩展的服务权限固定为 `http://127.0.0.1:8787/*`。内部浏览器 API 不接受网络请求：服务端同时验证
TCP 回环来源、专用请求头和合法的 `chrome-extension://` Origin，并把当前服务进程首次连接的扩展
Origin 固定下来。扩展重装导致 ID 改变时，需要重启 Phone Control 后重新连接。普通网页、手机网络
和反向代理不能访问这些内部端点。与其他本机回环服务一样，同一用户权限下的恶意本地进程仍属于
主机信任边界，可能伪造 HTTP 请求；Phone Control 不把 Chrome Bridge 当作本机恶意软件隔离层。

手机侧浏览器 API 继续要求独立的已配对设备 Cookie和同源写确认。一个时刻只有一台设备持有 60 秒
可续期控制租约；页面离开、设备退出或撤销会释放租约。点按、滚动和输入同时绑定截图 ID 与页面代数，
页面变化后的旧截图操作会返回冲突。每次操作还携带 client action ID；五分钟内的网络重试共享同一
执行结果，相同 ID 携带不同内容会被拒绝。防重放缓存只保存动作摘要，不保存输入正文，过大的结果不缓存。

网页截图只保存在 Phone Control 进程内存和当前手机页面，不写入事件、审计或上传目录；新截图会
替换旧截图，服务停止时清空。标签标题、URL、网页可见像素以及从手机输入的文字仍会经过本机服务和
浏览器扩展，因此不要把浏览器控制权交给不可信设备，也不要在控制期间打开不希望手机看到的敏感页面。

## 数据最小化

Hook 原始载荷不会整体写入磁盘。sidecar 只保留 session/thread 标识、cwd、model、状态、
工具名、截断摘要和有限长度的最近事件。普通任务卡摘要保持短小；rollout 对话正文单条最多
保留 64,000 个字符，避免旧的 2,000 字符限制丢失常规长回复。审批模式会额外保存完成决定所需的截断命令、路径
和权限摘要。事件日志默认保留 14 天且不超过 8 MiB；完整 rollout 文件仍由 Codex 管理。

手机端的 Codex 回复只通过内置的 Markdown 子集渲染器生成固定标签；所有单元格、代码、段落和
行内内容都会先做 HTML 转义，不执行 transcript 中的 HTML、脚本或事件属性。只有经过 URL 解析
且不含用户名/密码的 `http:`、`https:` 和规范化后的 `www.` 地址会成为用户主动点击的外部链接；
链接在新标签页打开，并设置 `noopener noreferrer` 与 `no-referrer`。代码中的地址保持纯文本，
`javascript:`、`data:`、`file:` 等其他协议不会生成链接。表格仅在消息容器内部滚动。

手机状态页通过本机 App Server 读取账户、额度和生效配置，但服务端只返回白名单字段。邮箱会
在 `@` 前遮罩；不会返回 access token、refresh token、完整配置、配置来源、额度重置凭证 ID
或账户 workspace ID。状态接口仍要求已配对设备凭证，并使用 30 秒缓存限制重复读取。
运行时兼容性诊断只公开 CLI 与 App Server 的语义版本以及是否建议重启；不会返回 PID、完整命令行
或环境变量，也不会从手机端自动终止进程。后台服务安装会先用所选 Node 对稳定插件入口执行启动
预检，再原子写入 systemd/tmux 定义；预检失败时保留现有常驻服务。

运行配置也由服务端约束。`/api/models` 只返回 App Server `model/list` 中的 ID、显示名、描述、
默认/支持的推理等级、service tier、输入模态和默认标记，并附带最小化本机默认配置、机器名和从
可见用户会话聚合的最近目录；不扫描文件系统，也不透传隐藏字段或完整配置。创建 thread 或开始新
turn 时，服务端再次验证模型、effort、service tier、权限配置，并要求工作目录是当前机器上存在的绝对目录。
权限只能从固定的 `read-only`、`workspace-write`、`on-request`、`danger-full-access` 档位选择；服务端
把它们映射为 App Server 的审批与沙箱协议，不能注入任意 sandbox JSON。完全访问必须由前端二次确认并
在请求中携带确认位，仍可能被 Codex 管理员策略拒绝。运行中的 `turn/steer` 不能改变这些配置。

## 手机审批

权限模式选择“超出工作区时询问”后，Phone Control 可以响应受管 App Server 发出的
`item/commandExecution/requestApproval`、`item/fileChange/requestApproval` 和
`item/permissions/requestApproval`。请求只在 thread/turn 与 Phone Control 已送达的手机命令精确匹配
时才会显示；Desktop/CLI 所拥有 turn 的 server request 保持不响应，避免抢走原客户端的审批。HTTP
决定再次携带并校验 session 与 turn，允许只映射为 `accept` 或完整请求权限的 turn 级授权，拒绝映射为
`decline` 或空权限集。挑战只能决定一次；十分钟未处理时自动向 App Server 发送拒绝，轮次提前结束时
遗留挑战立即失效。传输结果未知时不自动重试，决定设备与送达状态写入不含正文的本地审计。

旧的同步 `PermissionRequest` Hook 审批仍默认关闭，可单独开启用于兼容旧流程；它同样只接管手机所
拥有的精确 turn。挑战绑定事件、session 和 turn，短期过期且只能决定一次；重复响应返回冲突。
App Server 原生审批不依赖这个兼容开关。

## 手机回答

手机回答只处理本机受管 app-server 直接发送的 `item/tool/requestUserInput`。每个表单绑定
app-server 连接、JSON-RPC request id、thread、turn 和 item；HTTP 提交还必须重复携带并
匹配 session/thread 与 turn。断线、过期、错误 turn 和重复提交都会失败。底层写入结果不
明确时标记为 `delivery_unknown`，不自动重试。

秘密输入与普通回答正文只存在于浏览器表单、内存和发往 app-server 的单次响应中，不写入
Phone Control 的事件或审计日志。审计只记录问题 ID、绑定标识、决定设备和送达状态。

## 手机新建、续聊、追加指令、中止与删除

已配对设备可以提交当前机器的工作目录、第一条任务，以及实时 `model/list` 白名单内的可选模型、推理等级、service tier 和固定权限档位，
服务端验证后调用 `thread/start` 和 `turn/start`。未选择时新 thread 沿用当前 App Server 默认配置；
浏览器不能指定权限档位以外的沙箱 JSON 或其他 App Server 参数。已配对设备也可以在会话详情中发送文本和图片。服务端
根据受管 app-server 的实时状态选择操作：空闲
thread 使用 `turn/start`，明确为 `idle`、`completed`、`error` 或 `aborted` 且存在 rollout 的
历史 thread 先 `thread/resume`，运行中 turn 使用带 `expectedTurnId` 的 `turn/steer`。浏览器不能
自行指定动作；错误或已经变化的 turn 会返回冲突。只有即将开始的新 turn 可以选择模型、推理等级、Fast 与权限，
运行中的 `turn/steer` 明确拒绝这些覆盖。

所有恢复请求都设置 `excludeTurns: true`，仅附带最新一个 turn 的身份和状态且不加载 items。
若 App Server 返回了非空历史 turns，Phone Control 会拒绝开放控制；transport 级超大消息可归因
到唯一恢复请求时会隔离该 thread，其他会话在重连后继续工作。WebSocket/JSON 消息有 128 MiB
硬上限，重连退避只有在完整订阅轮次成功后才复位，避免异常长会话形成快速重连循环。

仍为 `working` 或 `waiting`、但没有受管 app-server 现场绑定的会话可能正在独立 CLI/Desktop
中运行，因此一律只读。服务重启恢复事件日志时，已过期或超过现场时效的等待操作会被清除并
标记为待重新验证，不会重新开放审批、回答或续聊。

等待问题或审批时不允许发送通用指令。每次提交携带独立 client message id，重复提交被拒绝；
送达结果不明确时不会自动重试。Phone Control 审计只记录消息长度、图片数量、thread/turn 绑定、
动作、设备和送达结果，不写入消息正文或临时图片路径。消息正文与图片会作为正常用户输入进入
Codex 自己的 rollout。

只有受管 app-server 已订阅、状态为 active、当前 turn ID 已知且没有等待回答/审批时，页面才显示
“停止当前任务”。提交必须再次携带页面看到的 turn ID；sidecar 与实时状态不匹配时返回冲突，
不会把请求转发给 Codex。送达后同一 turn 的重复中止被锁定，直到 `turn/completed` 确认结束；
传输结果未知时不自动重试。该操作调用 `turn/interrupt`，只中止当前 turn，不删除 thread、历史
或已完成的文件变化。审计仅记录操作 ID、thread/turn 绑定、设备与送达状态。

永久删除调用 App Server `thread/delete`，不是界面隐藏。只允许删除正常用户会话；`working` 或
`waiting` 状态、仍有问题/审批或 App Server 断线时都会拒绝。浏览器必须先显示风险确认，说明
Codex 原始记录、关联元数据以及派生子会话会一并移除且不可恢复。成功后 Phone Control 写入持久化
tombstone，忽略迟到 Hook/rollout 事件，清除所有设备对该 session 的目标追踪。生命周期审计只记录
thread ID、操作、设备与结果，不记录新建任务正文；被删除的 Codex 内容无法由 Phone Control 恢复。

手机端只接受 JPEG、PNG 和 WebP；选择后先在浏览器重新编码和缩放，这会移除常见 EXIF/GPS
元数据，但不会遮挡图片像素中本来可见的敏感内容。服务端独立校验魔数与 6 MiB 上限，不信任
文件名、扩展名或浏览器 MIME。上传记录最多 4 张，绑定当前设备、session 和 expected turn，保存
为 `0700` 目录中的随机 `0600` 文件。路径交给 Codex 后记录立即变为不可复用租约，但文件会继续
保留最多 15 分钟，给 App Server 后续异步读取；服务重启会恢复未过期租约而不是提前删除。未发送
文件同样在 15 分钟内过期，发送失败时立即清理。HTTP 客户端不能传入 `localImage` 路径，也不能
重新使用或主动删除已经租出的文件。

当前仍不允许手机编辑历史内容、提交自定义沙箱配置或绕过 Codex 审批；模型、推理等级、Fast、固定权限档位与 cwd
只允许在创建会话或开始下一 turn 时从服务端白名单/当前机器路径中选择，不会中途修改 active turn；
唯一允许的历史破坏操作是上述显式确认的永久整会话删除。
Hook 审批与 App Server 原生命令、文件、权限审批都有独立协议测试；原生审批测试同时验证未知
Desktop/CLI turn 不会被 Phone Control 响应。

## 离线通知

离线通知必须由已配对设备主动开启。VAPID 私钥、浏览器 PushSubscription endpoint 和加密密钥
仅写入本机 `push.json`（`0600`）；HTTP 状态接口只返回 VAPID 公钥和当前设备是否订阅，不返回
endpoint 或私钥。撤销设备会同时删除其订阅，推送服务返回 404/410 时也会清理失效订阅。

Web Push 载荷按协议使用订阅公钥加密，正文只包含通用的完成或测试提示及用于打开会话的 session
路由，不包含消息、工作目录、项目名或命令。完成提示只对每台设备选择的目标会话按 thread + turn
唯一标识发送一次；没有目标的设备回退到最近活动的顶层用户会话。等待、错误、子会话和历史状态
变化不触发通知。推送服务仍能观察发送时间、目标
endpoint 和流量元数据。系统通知的显示位置、声音和锁屏可见性由手机操作系统控制；不应把通用
通知提示理解为额外身份验证。中国大陆网络下浏览器推送服务可能不可达，Tailscale 本身不会转发
厂商 Push 通道。

## 令牌泄漏

优先在“设备与配对”中撤销单台设备。若主令牌泄漏，停止服务，删除
`~/.phone-control/config.json` 后重新启动以生成新令牌，并重新配对可信设备；若使用自定义
`PHONE_CONTROL_TOKEN`，请在其来源处轮换。
