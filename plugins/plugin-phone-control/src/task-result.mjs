import { clampMessageText, clampText } from "./utils.mjs";

const COMMAND_TOOLS = /(?:exec|shell|bash|terminal|command|powershell|cmd)/i;
const FILE_TOOLS = /(?:apply_patch|write_file|edit_file|create_file|delete_file|move_file)/i;
const TEST_SIGNAL = /(?:^|[\s/:_-])(?:test|tests|pytest|vitest|jest|playwright|verify|check|lint|cargo test|go test)(?:$|[\s/:_-])/i;
const TERMINAL_KINDS = new Set(["turn_complete", "session_end", "error", "aborted"]);
const MAX_TASK_RESULTS = 256;

function unique(values, limit) {
  return [...new Set(values.filter(Boolean))].slice(0, limit);
}

function resultWindow(events, completionIndex = events.length - 1) {
  if (completionIndex < 0 || !events[completionIndex]) return [];
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

function completionIndexes(events) {
  const latestByTurn = new Map();
  events.forEach((event, index) => {
    if (!TERMINAL_KINDS.has(event.kind)) return;
    // A turn can emit both turn_complete and session_end. Keep the last
    // terminal event for that turn so the phone shows one metadata card.
    const key = event.turnId ? `turn:${event.turnId}` : `event:${index}`;
    latestByTurn.set(key, index);
  });
  return [...latestByTurn.values()].sort((left, right) => left - right);
}

function resultIdentity(result) {
  if (result?.turnId) return `turn:${result.turnId}`;
  if (result?.completionEventId) return `event:${result.completionEventId}`;
  if (result?.completedAt) return `at:${result.completedAt}`;
  return null;
}

function resultTime(result) {
  const value = Date.parse(result?.completedAt);
  return Number.isFinite(value) ? value : 0;
}

function mergeResult(previous, current) {
  if (!previous) return current;
  if (!current) return previous;
  const files = unique([...(previous.files || []), ...(current.files || [])], 8);
  const commands = [];
  for (const command of [...(previous.commands || []), ...(current.commands || [])]) {
    if (!command || commands.some((item) => item.tool === command.tool && item.summary === command.summary)) continue;
    commands.push(command);
  }
  const previousTests = previous.tests || { status: "not_observed", items: [] };
  const currentTests = current.tests || { status: "not_observed", items: [] };
  const tests = unique([...(previousTests.items || []), ...(currentTests.items || [])], 5);
  const warnings = unique([...(previous.warnings || []), ...(current.warnings || [])], 4);
  return {
    ...previous,
    ...current,
    completionEventId: current.completionEventId || previous.completionEventId || null,
    conclusion: current.conclusion || previous.conclusion || null,
    files,
    commands: commands.slice(-6),
    tests: {
      status: currentTests.status !== "not_observed" ? currentTests.status : previousTests.status,
      items: tests,
    },
    warnings,
    hasContent: Boolean(current.hasContent || previous.hasContent || files.length || commands.length || tests.length || warnings.length),
  };
}

// Keep completed-turn snapshots separate from the rolling event window. A
// busy session can evict its older timeline events while its result cards
// should remain available in the detail view. The snapshots are rebuilt from
// the append-only event log during restore, so they do not need a second
// persistence format.
export function mergeTaskResults(previous = [], current = []) {
  const merged = new Map();
  for (const result of [...(Array.isArray(previous) ? previous : []), ...(Array.isArray(current) ? current : [])]) {
    if (!result || typeof result !== "object") continue;
    const key = resultIdentity(result);
    if (!key) continue;
    merged.set(key, mergeResult(merged.get(key), result));
  }
  return [...merged.values()]
    .sort((left, right) => resultTime(left) - resultTime(right))
    .slice(-MAX_TASK_RESULTS);
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

function deriveTaskResultAt(session, events, completionIndex, { fallbackTurnId = null } = {}) {
  const window = resultWindow(events, completionIndex);
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
    turnId: completion.turnId || fallbackTurnId || null,
    completionEventId: completion.eventId || null,
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

export function deriveTaskResults(session) {
  const events = Array.isArray(session?.events) ? session.events : [];
  const derived = completionIndexes(events)
    .map((completionIndex) => deriveTaskResultAt(session, events, completionIndex))
    .filter(Boolean);
  return mergeTaskResults(session?.taskResults, derived);
}

export function deriveTaskResult(session) {
  const results = deriveTaskResults(session);
  const result = results.at(-1) || null;
  if (result && !result.turnId && session?.lastCompletedTurnId) {
    return { ...result, turnId: session.lastCompletedTurnId };
  }
  return result;
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

// Detail pages need the metadata for each finished turn, but not another copy
// of the assistant's final answer. Keep this payload bounded and deliberately
// omit `conclusion`; the conversation timeline owns that text.
export function detailTaskResult(result) {
  if (!result) return null;
  return {
    status: result.status,
    turnId: result.turnId,
    completionEventId: result.completionEventId,
    completedAt: result.completedAt,
    files: result.files.slice(0, 8),
    commands: result.commands.slice(0, 6),
    tests: { status: result.tests.status, items: result.tests.items.slice(0, 5) },
    warnings: result.warnings.slice(0, 4),
    hasContent: result.hasContent,
  };
}
