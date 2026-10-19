#!/usr/bin/env node
// 记下图像路线弹窗的提问和回答；只记带路线标记的题目，避免保存其他回答。
// 钩子不能输出任何东西，也不能因记录失败而影响 AskUserQuestion。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 和 scripts/plan.mjs 的标记保持一致。
const ROUTE_MARKER = /图像路线|image route/i;

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (input.tool_name === 'AskUserQuestion' && /^[A-Za-z0-9._-]{1,128}$/.test(input.session_id || '')
    && ['PreToolUse', 'PostToolUse'].includes(input.hook_event_name)) {
    const questions = (input.tool_input?.questions || []).filter((q) => ROUTE_MARKER.test(q.question || '') || ROUTE_MARKER.test(q.header || ''))
      .map((q) => ({ question: q.question, header: q.header, multiSelect: q.multiSelect, options: (q.options || []).map((o) => o.label) }));
    if (questions.length) {
      const custom = process.env.FOREMAN_CONFIG || process.env.CODEX_BRIDGE_CONFIG;
      const dir = path.join(custom ? path.dirname(custom) : path.join(os.homedir(), '.claude', 'foreman'), 'answers');
      fs.mkdirSync(dir, { recursive: true });
      const answered = input.hook_event_name === 'PostToolUse';
      const answers = input.tool_response?.answers ?? input.tool_input?.answers ?? {};
      const record = { event: answered ? 'answered' : 'asked', at: new Date().toISOString(), tool_use_id: input.tool_use_id, questions,
        ...(answered ? { answers: Object.fromEntries(questions.filter((q) => Object.hasOwn(answers, q.question)).map((q) => [q.question, answers[q.question]])) } : {}) };
      fs.appendFileSync(path.join(dir, `${input.session_id}.jsonl`), JSON.stringify(record) + '\n');
      // 先记录再清理；目录读失败或某个旧条目删不掉都不能挡住这次回答。
      try {
        for (const name of fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'))) {
          try {
            const file = path.join(dir, name);
            if (Date.now() - fs.statSync(file).mtimeMs > 30 * 86400000) fs.unlinkSync(file);
          } catch { /* 下次再清 */ }
        }
      } catch { /* 下次再清 */ }
    }
  }
} catch { /* 记录失败不能影响工具 */ }
