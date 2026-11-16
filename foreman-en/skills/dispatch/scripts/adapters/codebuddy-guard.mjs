// CodeBuddy PreToolUse guard for edit runs. Scoped allow rules are a second gate;
// the hook explicitly authorizes only resolved project paths (including new files).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

function realPath(target) {
  const suffix = [];
  for (let current = target; ; current = path.dirname(current)) {
    try { return path.join(fs.realpathSync.native(current), ...suffix.reverse()); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code) || path.dirname(current) === current) throw error;
      // A dangling symlink must not be treated as a new ordinary file.
      try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('unresolved symbolic link'); }
      catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
      suffix.push(path.basename(current));
    }
  }
}

export function editDecision(root, event) {
  if (!root || !['Write', 'Edit'].includes(event.tool_name)) return { allow: false, reason: 'invalid edit policy' };
  const value = event.tool_input?.file_path;
  if (typeof value !== 'string' || !value || value.includes('\0')) return { allow: false, reason: 'missing file_path' };
  try {
    let target = value;
    if (target === '~') target = os.homedir();
    else if (/^~[\\/]/.test(target)) target = path.join(os.homedir(), target.slice(2));
    else if (target.startsWith('file://')) target = fileURLToPath(target);
    const resolvedRoot = realPath(path.resolve(root));
    const lexical = path.relative(path.resolve(root), path.resolve(root, target));
    const relative = path.relative(resolvedRoot, realPath(path.resolve(root, target)));
    const inside = rel => rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
    // .git and .codebuddy can alter later permission decisions; do not authorize them.
    const protectedPath = [lexical, relative].some(rel => rel.split(path.sep).some(part => ['.git', '.codebuddy'].includes(part.toLowerCase())));
    return inside(lexical) && inside(relative) && !protectedPath
      ? { allow: true, reason: 'project-local edit' }
      : { allow: false, reason: 'path is outside the project or changes protected settings' };
  } catch { return { allow: false, reason: 'cannot resolve file_path safely' }; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    let result;
    try { result = editDecision(process.argv[2], JSON.parse(input)); }
    catch { result = { allow: false, reason: 'invalid hook input' }; }
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse',
      permissionDecision: result.allow ? 'allow' : 'deny', permissionDecisionReason: `foreman guard: ${result.reason}` } }));
  });
}
