const GENERIC_TASK_FRAGMENT = /^(?:好(?:的)?|行(?:吧)?|可以|没问题|知道了|收到|允许|确认|开始吧|去做吧|继续(?:吧)?|ok(?:ay)?|yes|go\s+ahead|do\s+it)$/iu;
const CONTEXT_ONLY_PROMPT = [
  /^(?:好(?:的)?[，,\s]*)?(?:(?:按(?:照)?)(?:你|你的想法|这个|上面|刚才).{0,10})?(?:去|来)?(?:做|继续|执行|实现|优化|修复|更新|尝试|试|推|提交|部署|发布)(?:一下|一版)?(?:吧|看看|试试|就行|即可)?(?:这个|它|当前)?$/iu,
  /^(?:好(?:的)?[，,\s]*)?继续(?:去)?(?:做|搞|处理|优化|修复|实现|执行)?(?:一下)?(?:吧|就行)?$/u,
  /^(?:可以|那就|就|先)?(?:这样|这么|按这个)(?:尝试|试|做|改|实现|执行)?(?:一下)?(?:看看(?:效果)?|效果|吧|就行)?$/u,
  /^(?:这|这个|那|那个|它)(?:不是|是|可以|行|对|能)(?:吗|么|吧|呢)?$/u,
  /^(?:好(?:的)?[，,\s]*)?(?:去)?(?:修复|解决|优化|处理).{0,6}(?:这|这个|该)(?:问题|东西|功能)(?:吧)?$/u,
  /^再(?:做|优化|修复|改|调整|补充|检查)(?:一下)?[^，。,.!！?？]{0,18}(?:吧)?$/u,
  /^(?:好(?:的)?|行|嗯)?[，,\s]*(?:分支)?推(?:一下|吧|到远端|远端)?(?:吧)?(?:[，,].*)?$/u,
  /^(?:好(?:的)?|行|嗯)[，,\s]*(?:修改|修复|优化|调整|更新)(?:一下)?(?:吧)?(?:[，,].*(?:提交|推|部署).*)?$/u,
  /^没有就(?:安装|装|加|创建|新建|做)(?:一个|一下)?(?:吧|呗)?$/u,
  /^(?:这|这个|那|那个)是.{2,160}(?<![吗呢么?？])$/u,
  /^我.*(?:拷贝|复制|上传|下载|放到).*(?:了|这儿了|这里了)$/u,
];
const TASK_ACTION = /(?:实现|增加|新增|添加|支持|调整|改进|优化|修复|解决|排查|检查|审计|分析|调研|定位|测试|验证|设计|规划|整理|梳理|重构|升级|更新|回滚|还原|删除|移除|停止|打断|取消|提交|推送|部署|安装|构建|开发|总结|记录|保存|复制|迁移|对比|确认|查找|搜索|选择|切换|开启|关闭|显示|隐藏|合并|过滤|忽略|加载|连接|恢复|降低|减少|提升|避免|保证|处理)/u;
const TASK_QUESTION = /(?:如何|怎么|为什么|为何|能不能|可不可以|是否|需不需要|有没有|有无|什么方案|怎么办|哪里|哪个模型|哪种方案)/u;
const TASK_PROBLEM = /(?:问题|错误|报错|异常|失败|断开|重连|卡顿|很卡|太慢|很慢|不稳定|不准确|不太准|不正确|截断|重复|错乱|覆盖|刷新不出|连接不上|不能|无法|缺少|缺失|遗漏)/u;
const CONTEXTUAL_FEEDBACK = [
  /^(?:有点|有些|稍微)?(?:长进|进步|改善|改进)(?:了|，|,|\s)*(?:但是|但)?(?:还是)?(?:感觉|觉得)?(?:还)?(?:不够|差点意思|一般|不太行)(?:啊|呀|吧|。)?$/u,
  /^(?:现在|目前)?(?:看起来|看着|感觉|觉得|效果)?(?:已经|确实|还是|还)?(?:不错|可以|还行|好多了|有改善|有进步)(?:了)?(?:啊|呀|吧|。)?$/u,
  /^(?:但是|不过|只是|就是)(?:这|这个|它|那|那个).{2,100}(?<![吗么呢?？])$/u,
];
const STATUS_LABELS = {
  working: "工作中",
  waiting: "等待处理",
  idle: "本轮完成",
  completed: "已结束",
  error: "出错",
  aborted: "已中止",
  unknown: "状态未知",
};

function clamp(value, limit) {
  const text = String(value || "");
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

export function cleanTaskText(value = "") {
  return String(value ?? "")
    .replace(/```[\s\S]*?```/g, " 代码片段 ")
    .replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/gm, " ")
    .replace(/^\s*\|.*\|\s*$/gm, " ")
    .replace(/\[([^\]\n]+)\]\((?:https?:\/\/|www\.)[^)\s]+\)/gi, "$1")
    .replace(/<https?:\/\/[^>\s]+>/gi, " 网页链接 ")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s*(?:#{1,6}|[-+*>]|\d+[.)])\s+/gm, "")
    .replace(/(^|\s):?-{3,}:?(?=\s|$)/g, " ")
    .replace(/[#*_`~\[\]|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeTaskSearch(value = "") {
  return cleanTaskText(value)
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isMeaningfulTaskPrompt(value = "") {
  const text = cleanTaskText(value);
  const comparable = text.replace(/[。.!！?？]+$/u, "").trim();
  const fragments = text.split(/[\s，。,.!！?？]+/u).filter(Boolean);
  const generic = fragments.length > 0 && fragments.every((fragment) => GENERIC_TASK_FRAGMENT.test(fragment));
  return text.length >= 4 && !generic && !CONTEXT_ONLY_PROMPT.some((pattern) => pattern.test(comparable));
}

export function isTaskAnchorPrompt(value = "") {
  const text = cleanTaskText(value);
  if (!isMeaningfulTaskPrompt(text)) return false;
  const comparable = text.replace(/[。.!！?？]+$/u, "").trim();
  if (CONTEXTUAL_FEEDBACK.some((pattern) => pattern.test(comparable))
    && !TASK_ACTION.test(comparable) && !TASK_PROBLEM.test(comparable)) return false;
  if (/^(?:停|停止|别|不要)(?:了|再|继续|修|改|做|执行)/u.test(comparable)) return true;
  if (TASK_ACTION.test(comparable) || TASK_QUESTION.test(comparable) || TASK_PROBLEM.test(comparable)) {
    if (/^(?:这|这个|那|那个|它|容器)?(?:外面|里面|上面|下面)?(?:没有|不是|可以|能|行)(?:吗|么|呢)?$/u.test(comparable)) return false;
    return true;
  }
  // English prompts and longer standalone statements tend to carry their own
  // object and action. Keep them eligible instead of requiring Chinese verbs.
  if (!/[\p{Script=Han}]/u.test(comparable)) return true;
  return comparable.length >= 18 && !/^(?:但是|不过|只是|就是|然后|所以|而且)/u.test(comparable);
}

function projectName(session = {}) {
  if (!session.cwd) return "未知项目";
  const parts = String(session.cwd).replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.at(-1) || String(session.cwd);
}

function preview(value, limit = 140) {
  const text = cleanTaskText(value);
  if (!text) return "";
  const sentence = text.match(/^(.{8,}?[。！？.!?])(?:\s|$)/u)?.[1] || text;
  return clamp(sentence, limit);
}

function titleFromPrompt(value, fallback) {
  let text = cleanTaskText(value)
    .replace(/^(?:(?:好(?:的)?|行|嗯+|可以|另外|对了|然后|还有(?:一点)?)[，,。.!！\s]+)+(?=.{6})/u, "")
    .replace(/^我(?:现在|目前)?(?:还)?(?:发现|觉得|感觉|希望|需要)(?:的是|有)?[，,。.!！\s]*/u, "")
    .replace(/\/(?:mnt|home|Users|workspace|tmp|root)\/.*?(?=\s+(?:这个|那个|该|是否|是不是|和我们|与我们)|[，。,.!！?？:：]|$)/gu, "指定路径")
    .trim();
  if (!text) return fallback;
  const generationIssue = text.match(/^(.{2,28}?)(?:是)?怎么(?:得到|生成|来的).{0,36}?(?:不太准|不准确|不准|有问题)/u);
  if (generationIssue) {
    const subject = generationIssue[1].replace(/的(?=标题|名称|名字)/gu, "").replace(/的$/u, "").trim();
    if (subject) return clamp(`改进${subject}生成`, 32);
  }
  const slowIssue = text.match(/^(.{2,30}?)(?:有点|比较|还是|依然|一直)?(?:太慢|很慢|慢|卡顿)(?:了|啊|呀|吧)?[。.!！?？]*$/u);
  if (slowIssue) return clamp(`优化${slowIssue[1].trim()}速度`, 32);
  const modelComparison = text.match(/^这是报错的那台(.{1,10}?)执行加载的模型[:：].*(?:当前测试的模型).*(?:不一样|不同|区别|相同)/u);
  if (modelComparison) return clamp(`对比${modelComparison[1].trim()}报错模型与当前测试模型`, 32);
  const zkCpuIssue = text.match(/(?:代码)?(?:有)?(.{1,18}?ZK\s*注册线程).{0,24}?(?:CPU|cpu).{0,8}?(?:占用|使用)/u);
  if (zkCpuIssue) return "排查 ZK 注册线程 CPU 占用";
  const vectorMd5 = text.match(/(?:另外)?(?:有没有|是否(?:有)?|能否|能不能)?(.{0,18}?向量查询.{0,16}?相似图片\s*MD5)\s*(?:的)?功能/u);
  if (vectorMd5) {
    const target = vectorMd5[1].trim();
    return clamp(`检查${target}${/[A-Z0-9]$/u.test(target) ? " " : ""}功能`, 32);
  }
  const driftIssue = text.match(/(?:去)?定位(?:一下)?(.{0,20}?漂移)(?:的)?原因/u);
  if (driftIssue) return clamp(`定位${driftIssue[1].replace(/^(?:这个|该|这)/u, "").trim()}原因`, 32);
  const requestClause = text.match(/(?:我(?:还)?(?:希望|需要)|需要|请|能不能|是否可以|可不可以)(?:实现|增加|新增|添加|支持|调整|优化|修复|解决|检查|分析|设计|做|搞)?(?:的(?:是|功能是)?|一下)?[：:，,\s]*(.{6,}?)(?:[。.!！?？]|$)/u)?.[1];
  if (requestClause && requestClause.length + 2 < text.length) text = requestClause.trim();
  const sentence = text.match(/^(.{6,}?[。！？.!?])/u)?.[1] || text;
  return clamp(sentence.replace(/[。.!！?？]+$/u, ""), 32);
}

function asRecord(value) {
  if (!value?.text || !cleanTaskText(value.text)) return null;
  return {
    eventId: value.eventId || null,
    turnId: value.turnId || null,
    at: value.at || null,
    text: value.text,
  };
}

function userRecords(session) {
  const records = [];
  const add = (value) => {
    const record = asRecord(value);
    if (!record) return;
    const duplicate = records.some((candidate) => (
      record.eventId && candidate.eventId === record.eventId
    ) || (
      cleanTaskText(candidate.text) === cleanTaskText(record.text) && candidate.at === record.at
    ));
    if (!duplicate) records.push(record);
  };
  add(session.taskGoalMessage);
  add(session.firstUserMessage);
  for (const event of session.events || []) {
    if (event.message?.role !== "user") continue;
    add({ eventId: event.eventId, turnId: event.turnId, at: event.at, text: event.message.text });
  }
  add(session.lastUserMessage);
  return records.sort((left, right) => {
    const leftAt = Date.parse(left.at) || 0;
    const rightAt = Date.parse(right.at) || 0;
    return leftAt - rightAt;
  });
}

function messageRecord(session, role, direction = "first") {
  const events = Array.isArray(session.events) ? session.events : [];
  const source = direction === "last" ? [...events].reverse() : events;
  const event = source.find((candidate) => candidate.message?.role === role && cleanTaskText(candidate.message.text));
  if (event) return { eventId: event.eventId || null, turnId: event.turnId || null, at: event.at, text: event.message.text };
  if (role === "user") return session.taskGoalMessage || session.firstUserMessage || session.lastUserMessage || null;
  return session.lastAssistantMessage || (session.lastMessage?.role === "assistant" ? session.lastMessage : null);
}

function taskRecords(session) {
  const records = userRecords(session).filter((record) => isMeaningfulTaskPrompt(record.text));
  const anchors = records.filter((record) => isTaskAnchorPrompt(record.text));
  return {
    topic: records[0] || null,
    current: anchors.at(-1) || records[0] || null,
  };
}

export function buildTaskTitleContext(session = {}, { promptLimit = 10 } = {}) {
  const { topic, current } = taskRecords(session);
  const prompts = userRecords(session)
    .filter((record) => isMeaningfulTaskPrompt(record.text))
    .slice(-Math.min(16, Math.max(3, Number(promptLimit) || 10)))
    .map((record, index) => ({
      index: index + 1,
      text: clamp(cleanTaskText(record.text), 420),
      taskAnchor: isTaskAnchorPrompt(record.text),
    }));
  const fallback = projectName(session);
  return {
    sessionId: session.id || null,
    project: fallback,
    topic: titleFromPrompt(topic?.text, fallback),
    automaticTitle: titleFromPrompt(current?.text, fallback),
    prompts,
  };
}

function progressRecord(session, latestAssistant) {
  if (session.status === "waiting") {
    const action = session.pendingApproval?.kind === "question" ? "需要你回答" : "需要你处理";
    return { text: preview(session.pendingApproval?.reason || session.statusReason || action, 116) || action, source: null };
  }
  if (session.status === "working") {
    const tool = session.currentTool;
    if (tool?.summary && !/^agent activity$/i.test(String(tool.summary).trim())) return { text: preview(tool.summary, 116), source: null };
    if (tool?.name) return { text: `正在运行 ${clamp(cleanTaskText(tool.name), 72)}`, source: null };
    const reason = /^(?:agent activity|agent responded|processing a new prompt)$/i.test(String(session.statusReason || "").trim())
      ? ""
      : preview(session.statusReason, 116);
    if (reason) return { text: reason, source: null };
    if (latestAssistant?.text) return { text: preview(latestAssistant.text, 116), source: latestAssistant };
    return { text: "Codex 正在执行", source: null };
  }
  if (["idle", "completed"].includes(session.status)) {
    if (latestAssistant?.text) return { text: preview(latestAssistant.text, 132), source: latestAssistant };
    return { text: session.status === "completed" ? "会话已结束" : "本轮已经完成", source: null };
  }
  if (session.status === "error") return { text: preview(session.statusReason, 116) || "执行遇到错误", source: null };
  if (session.status === "aborted") return { text: "本轮已停止", source: null };
  return { text: preview(session.statusReason, 116) || "等待状态同步", source: null };
}

export function deriveTaskSemantics(session = {}) {
  const { topic, current } = taskRecords(session);
  const latestAssistant = messageRecord(session, "assistant", "last");
  const fallback = projectName(session);
  const currentTitle = titleFromPrompt(current?.text, fallback);
  const topicReliable = !session.eventsDiscarded;
  const topicTitle = topicReliable ? titleFromPrompt(topic?.text, fallback) : fallback;
  const customTitle = cleanTaskText(session.customTaskTitle).slice(0, 80) || null;
  const title = customTitle || currentTitle;
  const goalPreview = preview(current?.text, 156) || `处理 ${fallback} 中的 Codex 任务`;
  const result = preview(latestAssistant?.text, 180) || null;
  const progress = progressRecord(session, latestAssistant);
  return {
    title,
    autoTitle: currentTitle,
    currentTitle,
    topic: topicTitle,
    customTitle,
    titleSource: customTitle ? "manual" : current?.text ? "current_task" : "workspace",
    goal: goalPreview,
    progress: progress.text,
    progressEventId: progress.source?.eventId || null,
    progressTurnId: progress.source?.turnId || null,
    progressAt: progress.source?.at || null,
    result,
    needsAttention: session.status === "waiting" || session.status === "error",
    source: current?.text ? "user_prompt" : "workspace",
    sourceAt: current?.at || session.startedAt || session.updatedAt || null,
    sourceEventId: current?.eventId || null,
    sourceTurnId: current?.turnId || null,
    topicSource: topicReliable && topic?.text ? "user_prompt" : "workspace",
    topicAt: topicReliable ? topic?.at || session.startedAt || session.updatedAt || null : session.startedAt || session.updatedAt || null,
    topicEventId: topicReliable ? topic?.eventId || null : null,
    topicTurnId: topicReliable ? topic?.turnId || null : null,
  };
}

function messageSearchRows(session) {
  const rows = [];
  for (const event of session.events || []) {
    if (!event.message?.text || !["user", "assistant"].includes(event.message.role)) continue;
    const text = cleanTaskText(event.message.text);
    if (!text) continue;
    rows.push({
      field: event.message.role === "user" ? "user_prompt" : "assistant_reply",
      eventId: event.eventId || null,
      turnId: event.turnId || null,
      at: event.at || null,
      text,
      normalized: normalizeTaskSearch(text),
    });
  }
  return rows;
}

function fieldMatches(normalized, tokens) {
  return Boolean(normalized) && tokens.every((token) => normalized.includes(token));
}

function matchSnippet(text, tokens, limit = 180) {
  const source = cleanTaskText(text);
  if (source.length <= limit) return source;
  const lower = source.toLocaleLowerCase("zh-CN");
  const indexes = tokens.map((token) => lower.indexOf(token)).filter((index) => index >= 0);
  const first = indexes.length ? Math.min(...indexes) : 0;
  const start = Math.max(0, first - Math.floor(limit / 3));
  const end = Math.min(source.length, start + limit);
  return `${start ? "…" : ""}${source.slice(start, end)}${end < source.length ? "…" : ""}`;
}

export function buildTaskSearchDocument(session = {}) {
  const task = deriveTaskSemantics(session);
  const metadataRows = [
    { field: "title", text: task.title, normalized: normalizeTaskSearch(task.title), weight: 120, eventId: task.titleSource === "manual" ? null : task.sourceEventId, turnId: task.titleSource === "manual" ? null : task.sourceTurnId, at: task.titleSource === "manual" ? null : task.sourceAt },
    { field: "current_task", text: task.currentTitle, normalized: normalizeTaskSearch(task.currentTitle), weight: 110, eventId: task.sourceEventId, turnId: task.sourceTurnId, at: task.sourceAt },
    { field: "session_topic", text: task.topic, normalized: normalizeTaskSearch(task.topic), weight: 100, eventId: task.topicEventId, turnId: task.topicTurnId, at: task.topicAt },
    { field: "goal", text: task.goal, normalized: normalizeTaskSearch(task.goal), weight: 90, eventId: task.sourceEventId, turnId: task.sourceTurnId, at: task.sourceAt },
    { field: "progress", text: task.progress, normalized: normalizeTaskSearch(task.progress), weight: 65, eventId: task.progressEventId, turnId: task.progressTurnId, at: task.progressAt },
    { field: "project", text: `${projectName(session)} ${session.cwd || ""}`, normalized: normalizeTaskSearch(`${projectName(session)} ${session.cwd || ""}`), weight: 55 },
    { field: "machine", text: session.machineName || "", normalized: normalizeTaskSearch(session.machineName), weight: 40 },
    { field: "runtime", text: `${session.surface || ""} ${session.model || ""} ${STATUS_LABELS[session.status] || session.status || ""}`, normalized: normalizeTaskSearch(`${session.surface || ""} ${session.model || ""} ${STATUS_LABELS[session.status] || session.status || ""}`), weight: 30 },
  ];
  const messageRows = messageSearchRows(session);
  return {
    id: session.id,
    updatedAt: session.updatedAt || null,
    task,
    metadataRows,
    messageRows,
    searchable: [...metadataRows, ...messageRows].map((row) => row.normalized).join(" "),
  };
}

export function searchTaskDocuments(documents = [], { query, limit = 60 } = {}) {
  const normalizedQuery = normalizeTaskSearch(query).slice(0, 160);
  if (!normalizedQuery) return [];
  const tokens = normalizedQuery.split(" ").filter(Boolean).slice(0, 12);
  const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 60));
  const matches = [];

  for (const document of documents) {
    const { metadataRows, messageRows, searchable } = document;
    if (!tokens.every((token) => searchable.includes(token))) continue;

    let best = null;
    for (const row of metadataRows) {
      if (!fieldMatches(row.normalized, tokens)) continue;
      const phraseBonus = row.normalized.includes(normalizedQuery) ? 30 : 0;
      const candidate = { ...row, score: row.weight + phraseBonus };
      if (!best || candidate.score > best.score) best = candidate;
    }
    for (let index = messageRows.length - 1; index >= 0; index -= 1) {
      const row = messageRows[index];
      if (!fieldMatches(row.normalized, tokens)) continue;
      const base = row.field === "user_prompt" ? 72 : 48;
      const phraseBonus = row.normalized.includes(normalizedQuery) ? 20 : 0;
      const recencyBonus = Math.min(12, Math.floor(index / Math.max(1, messageRows.length) * 12));
      const candidate = { ...row, score: base + phraseBonus + recencyBonus };
      if (!best || candidate.score > best.score) best = candidate;
    }
    if (!best) {
      const row = messageRows.find((candidate) => tokens.some((token) => candidate.normalized.includes(token)));
      best = row ? { ...row, score: 20 } : { ...metadataRows[0], score: 10 };
    }
    const updated = Date.parse(document.updatedAt) || 0;
    matches.push({
      id: document.id,
      score: best.score,
      updatedAt: document.updatedAt,
      match: {
        field: best.field,
        eventId: best.eventId || null,
        turnId: best.turnId || null,
        at: best.at || null,
        snippet: matchSnippet(best.text, tokens),
      },
      _updated: updated,
    });
  }

  return matches
    .sort((left, right) => right.score - left.score || right._updated - left._updated)
    .slice(0, boundedLimit)
    .map(({ _updated, ...match }) => match);
}

export function searchTaskSessions(sessions = [], options = {}) {
  return searchTaskDocuments(sessions.map(buildTaskSearchDocument), options);
}
