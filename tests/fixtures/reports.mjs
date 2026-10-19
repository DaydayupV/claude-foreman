export const report = {
  status: 'completed', summary: '合成任务已完成', files_changed: [], commands_run: [],
  verification: '合成验证通过', open_issues: [], decision_requests: [],
};
export const discussion = {
  position: '先建立回归测试，再拆模块',
  options: [{ name: '保留入口', idea: '按职责拆分', pros: ['行为可验证'], cons: ['需要基线'], recommended: true }],
  critiques: [], risks: ['遗漏边界行为'], open_questions: ['模块边界待确认'], confidence: 'high',
};
export const usage = { input_tokens: 120, cached_input_tokens: 30, output_tokens: 40, reasoning_output_tokens: 10 };
export const review = { verdict: 'no_issues', findings: [], coverage: { checked: ['source.txt'], not_checked: [] }, unverified: [] };
export const sessionStats = {
  info: { total_token_usage: usage, last_token_usage: { total_tokens: 60 }, model_context_window: 1000 },
  rate_limits: { primary: { used_percent: 25, window_minutes: 300, resets_at: 2000000000 } },
};
export const command = (type = 'item.completed') => ({
  type, item: { id: 'cmd-1', type: 'command_execution', command: 'node -e "0"', exit_code: 0, aggregated_output: 'synthetic ok\n' },
});
