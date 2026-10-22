'use strict';
// Display names of the coding agents tokentaby can log. Pure data: the
// offline snapshot bundles it for the dashboard.

const TOOLS = {
  'claude-code': 'Claude Code',
  'codex-app': 'Codex App',
  'codex-cli': 'Codex CLI',
  opencode: 'OpenCode',
  'gemini-cli': 'Gemini CLI',
  'qwen-code': 'Qwen Code',
  'copilot-cli': 'GitHub Copilot CLI',
  'kimi-code': 'Kimi Code',
  'hermes-agent': 'Hermes Agent',
  antigravity: 'Antigravity',
  cursor: 'Cursor',
};

const toolName = (id) => TOOLS[id] || id;

module.exports = { TOOLS, toolName };
