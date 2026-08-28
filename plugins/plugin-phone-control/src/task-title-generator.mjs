import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_CACHE_TTL_MS = 30 * 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

function runCodex(command, args, { cwd, timeoutMs, environment }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let settled = false;
    let timer = null;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(Object.assign(new Error("Codex title response was too large"), { statusCode: 502 }));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error) => {
      const message = error.code === "ENOENT" ? "Codex CLI is not available to generate a title" : "Codex title generation could not start";
      finish(Object.assign(new Error(message), { statusCode: error.code === "ENOENT" ? 503 : 502 }));
    });
    child.once("close", (code) => {
      const output = Buffer.concat(stdout).toString("utf8").trim();
      const diagnostics = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        const detail = diagnostics.split("\n").filter(Boolean).at(-1);
        finish(Object.assign(new Error(detail ? `Codex title generation failed: ${detail}` : "Codex title generation failed"), { statusCode: 502 }));
        return;
      }
      finish(null, { stdout: output, stderr: diagnostics });
    });
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(Object.assign(new Error("Codex title generation timed out"), { statusCode: 504 }));
    }, timeoutMs);
    timer.unref?.();
  });
}

function parseResult(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout || "").trim());
  } catch {
    throw Object.assign(new Error("Codex returned an invalid title response"), { statusCode: 502 });
  }
  const title = String(parsed?.title || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/^[#*`'“”"\s]+|[#*`'“”"\s。.!！?？]+$/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (title.length < 2 || title.length > 32 || /^(?:任务|当前任务|继续处理|处理问题|优化一下|未命名)$/u.test(title)) {
    throw Object.assign(new Error("Codex did not return a useful task title"), { statusCode: 502 });
  }
  return title;
}

function namingPrompt(context) {
  const lines = (context.prompts || []).map((prompt) => `${prompt.index}. ${prompt.text}`);
  return `你是移动端 Agent 任务卡片的命名器。只输出符合给定 JSON Schema 的 JSON。\n\n从按时间顺序排列的用户消息中，识别最近一个真正需要 Agent 处理的任务，并把它压缩成清晰的任务名。后面的评价、补充事实或“继续做吧”仍属于前一个任务，不能取代任务名。\n\n标题要求：\n- 优先使用“动作 + 对象”，例如“优化会话标题生成”或“排查 ZK 注册线程 CPU 占用”；\n- 中文通常 8～24 字，最多 32 字；\n- 保留必要的产品名、协议名和技术关键词；\n- 不要使用“我想”“帮我”“这个”“当前任务”“问题是”等聊天口吻；\n- 不要编造消息中不存在的目标。\n\n项目：${context.project || "未知项目"}\n会话主题：${context.topic || "未知"}\n规则生成的候选：${context.automaticTitle || "未知"}\n最近用户消息：\n${lines.join("\n") || "（没有可用消息）"}`;
}

export class TaskTitleGenerator {
  constructor({
    pluginRoot,
    codexBin = process.env.PHONE_CONTROL_CODEX_BIN || "codex",
    model = process.env.PHONE_CONTROL_TITLE_MODEL || null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    commandRunner = runCodex,
    environment = process.env,
  } = {}) {
    this.pluginRoot = path.resolve(pluginRoot || path.resolve(import.meta.dirname, ".."));
    this.codexBin = codexBin;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.cacheTtlMs = cacheTtlMs;
    this.commandRunner = commandRunner;
    this.environment = environment;
    this.cache = new Map();
    this.inflight = new Map();
    this.active = 0;
  }

  async suggest(context = {}) {
    if (!Array.isArray(context.prompts) || !context.prompts.length) {
      throw Object.assign(new Error("This session has no user task to name"), { statusCode: 409 });
    }
    const signature = createHash("sha256").update(JSON.stringify(context)).digest("hex");
    const cached = this.cache.get(signature);
    if (cached && Date.now() - cached.generatedAt < this.cacheTtlMs) return { title: cached.title, cached: true };
    if (this.inflight.has(signature)) return this.inflight.get(signature);
    if (this.active >= 1) throw Object.assign(new Error("Another smart title is being generated; try again shortly"), { statusCode: 429 });
    this.active += 1;
    const operation = this.generate(context).finally(() => {
      this.inflight.delete(signature);
      this.active = Math.max(0, this.active - 1);
    });
    this.inflight.set(signature, operation);
    return operation;
  }

  async generate(context) {
    const args = [
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--sandbox", "read-only",
      "--color", "never",
      "--output-schema", path.join(this.pluginRoot, "assets", "task-title.schema.json"),
    ];
    if (this.model) args.push("--model", this.model);
    args.push(namingPrompt(context));
    const { stdout } = await this.commandRunner(this.codexBin, args, {
      cwd: this.pluginRoot,
      timeoutMs: this.timeoutMs,
      environment: this.environment,
    });
    const title = parseResult(stdout);
    this.cache.set(createHash("sha256").update(JSON.stringify(context)).digest("hex"), { title, generatedAt: Date.now() });
    while (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value);
    return { title, cached: false };
  }
}
