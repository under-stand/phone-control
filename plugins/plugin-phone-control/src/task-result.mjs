import { clampMessageText, clampText } from "./utils.mjs";

const COMMAND_TOOLS = /(?:exec|shell|bash|terminal|command|powershell|cmd)/i;
const FILE_TOOLS = /(?:apply_patch|write_file|edit_file|create_file|delete_file|move_file)/i;
const TEST_SIGNAL = /(?:^|[\s/:_-])(?:test|tests|pytest|vitest|jest|playwright|verify|check|lint|cargo test|go test)(?:$|[\s/:_-])/i;

function unique(values, limit) {
  return [...new Set(values.filter(Boolean))].slice(0, limit);
}

function resultWindow(events) {
  const completionIndex = events.reduce((found, event, index) => ["turn_complete", "session_end", "error", "aborted"].includes(event.kind) ? index : found, -1);
  if (completionIndex < 0) return [];
  const completion = events[completionIndex];
  let start = 0;
  for (let index = completionIndex; index >= 0; index -= 1) {
    const event = events[index];
    if (completion.turnId && event.turnId && event.turnId !== completion.turnId) continue;
    if (["user_prompt", "phone_input_sent", "turn_start"].includes(event.kind)) {
      start = index;
      break;
    }
  }
  return events.slice(start, completionIndex + 1);
}

function fileCandidates(summary) {
  if (!summary) return [];
  const source = String(summary).replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, " ");
  const matches = source.match(/(?:[A-Za-z]:\\[^\s"'<>|]+|\.?\.?\/[\w@%+.,=~()\/-]+|[\w@%+.,=~()-]+\/[\w@%+.,=~()\/-]+\.[A-Za-z0-9]{1,12})/g) || [];
  return matches.map((value) => value.replace(/[),.;:]+$/, ""));
}

function conclusionFrom(events, fallback, completion) {
  const assistants = events.filter((event) => event.kind === "assistant_message" && event.message?.text);
  const final = assistants.findLast?.((event) => event.phase === "final_answer")
    || [...assistants].reverse().find((event) => event.phase === "final_answer")
    || assistants.at(-1);
  const windowStart = Date.parse(events[0]?.at);
  const fallbackAt = Date.parse(fallback?.at);
  const completionAt = Date.parse(completion?.at);
  const fallbackMatches = Boolean(fallback?.text)
    && (!completion?.turnId || fallback.turnId === completion.turnId)
    && (!Number.isFinite(windowStart) || !Number.isFinite(fallbackAt) || fallbackAt >= windowStart)
    && (!Number.isFinite(completionAt) || !Number.isFinite(fallbackAt) || fallbackAt <= completionAt);
  return clampMessageText(final?.message?.text || (fallbackMatches ? fallback.text : null), 1_600) || null;
}

export function deriveTaskResult(session) {
  const events = Array.isArray(session?.events) ? session.events : [];
  const window = resultWindow(events);
  const completion = window.at(-1);
  if (!completion) return null;
  const tools = window.filter((event) => event.kind === "tool_start" && event.tool?.name);
  const commands = tools
    .filter((event) => COMMAND_TOOLS.test(event.tool.name) && event.tool.summary)
    .map((event) => ({ tool: event.tool.name, summary: clampText(event.tool.summary, 300) }))
    .slice(-6);
  const fileSummaries = tools
    .filter((event) => FILE_TOOLS.test(event.tool.name) || fileCandidates(event.tool.summary).length)
    .flatMap((event) => fileCandidates(event.tool.summary));
  const testItems = tools
    .filter((event) => TEST_SIGNAL.test(`${event.tool.name} ${event.tool.summary || ""}`))
    .map((event) => clampText(event.tool.summary || event.tool.name, 240));
  const warnings = unique(window
    .filter((event) => event.kind === "error" && event.message?.text)
    .map((event) => clampText(event.message.text, 300)), 4);
  if (completion.kind === "aborted") warnings.unshift("本轮由用户或 Codex 中止");
  const status = completion.kind === "error" ? "failed"
    : completion.kind === "aborted" ? "stopped"
      : "completed";
  const conclusion = conclusionFrom(window, session.lastAssistantMessage, completion);
  const files = unique(fileSummaries, 8);
  const observedTests = unique(testItems, 5);
  return {
    status,
    turnId: completion.turnId || session.lastCompletedTurnId || null,
    completedAt: completion.at || session.lastCompletionAt || session.completedAt || null,
    conclusion,
    files,
    commands,
    tests: {
      status: status === "failed" && observedTests.length ? "failed" : observedTests.length ? "observed" : "not_observed",
      items: observedTests,
    },
    warnings,
    hasContent: Boolean(conclusion || files.length || commands.length || observedTests.length || warnings.length),
  };
}

export function summarizeTaskResult(result) {
  if (!result) return null;
  return {
    status: result.status,
    turnId: result.turnId,
    completedAt: result.completedAt,
    conclusion: clampText(result.conclusion, 240) || null,
    files: result.files.slice(0, 3),
    tests: { status: result.tests.status, count: result.tests.items.length },
    warningCount: result.warnings.length,
    hasContent: result.hasContent,
  };
}
