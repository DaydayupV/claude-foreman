// Shared CodeBuddy PreToolUse hook for read, edit and shell runs. Project-local reads defer to CodeBuddy.
// Read mode denies writes. Edit approves safe writes and shell defers to CodeBuddy.
// All modes reject unsafe paths, including protected locations and hard links for writes.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const WINDOWS = process.platform === 'win32';
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);
const WRITE_TOOLS = new Set(['Write', 'Edit']);
const PROTECTED_DIRS = new Set(['.git', '.codebuddy', '.claude']);
const OUTSIDE = 'path is outside the project';
const PROTECTED = 'path is in a protected location (.git, .codebuddy, .claude, or foreman or CodeBuddy settings)';
const AMBIGUOUS = 'path has a . or .. segment or a name ending in a dot or space; use a plain path inside the project';
const UNRESOLVED = 'cannot resolve the path safely';
const deny = reason => ({ decision: 'deny', reason: 'foreman guard: ' + reason });
const share = value => WINDOWS && /^(?:\\\\|\/\/)[^\\/]+[\\/]+[^\\/]+/.test(value);
const segments = value => value.split(/[\\/]+/);
const hasProtectedName = value => value.split(path.sep).some(part => PROTECTED_DIRS.has(part.toLowerCase()));

export function codebuddyConfigDir() {
  const configured = process.env.CODEBUDDY_CONFIG_DIR;
  return path.resolve(configured?.trim() ? configured : path.join(os.homedir(), '.codebuddy'));
}

// Whether the user's CodeBuddy settings deny or ask for WebFetch (any rule naming it). An unreadable
// file counts as limiting, so the guard never approves over rules it couldn't read.
function userLimitsWebFetch(configDir = codebuddyConfigDir()) {
  let settings;
  try { settings = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8').replace(/^﻿/, '')); }
  catch (error) { return error.code !== 'ENOENT'; }
  return ['deny', 'ask'].some(key => (Array.isArray(settings?.permissions?.[key]) ? settings.permissions[key] : [])
    .some(rule => /^WebFetch\b/.test(String(rule))));
}

function realPath(target) {
  const suffix = [];
  let current = target, links = 0;
  for (;;) {
    try { return path.join(fs.realpathSync.native(current), ...suffix.reverse()); }
    catch (error) {
      const parent = path.dirname(current);
      if (error.code !== 'ENOENT' || parent === current) throw error;
      // A write can create the target of a dangling link.
      if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
        const link = fs.readlinkSync(current);
        if (++links > 40 || share(link)) throw error;
        current = path.isAbsolute(link) ? link : parent + path.sep + link;
      } else {
        suffix.push(path.basename(current));
        current = parent;
      }
    }
  }
}

const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};

function protectedTargets(root) {
  const targets = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const name = entry.name.toLowerCase();
    if (!PROTECTED_DIRS.has(name)) continue;
    const file = path.join(root, entry.name);
    const linked = entry.isSymbolicLink();
    if (linked && share(fs.readlinkSync(file))) continue;
    const target = linked ? realPath(file) : file;
    if (linked) targets.push(target);
    if (name !== '.git' || !(linked ? fs.statSync(target, { throwIfNoEntry: false })?.isFile() : entry.isFile())) continue;
    const text = fs.readFileSync(target, 'utf8');
    // Git preserves spaces in the directory name and strips only trailing line breaks.
    const dir = text.startsWith('gitdir: ') && text.slice('gitdir: '.length).replace(/[\r\n]+$/, '');
    if (dir && !share(dir)) targets.push(realPath(path.resolve(path.dirname(target), dir)));
  }
  return targets;
}

function targetPaths(root, value) {
  // CodeBuddy normalizes backslashes in relative paths on Unix and expands ~/.
  const plain = !WINDOWS && !path.isAbsolute(value) ? value.replaceAll('\\', '/') : value;
  const targets = value.startsWith('~/') ? [] : [path.resolve(root, plain)];
  // Check both interpretations where foreman expands ~ but CodeBuddy treats it literally.
  if (value === '~' || /^~[\\/]/.test(value)) targets.unshift(path.resolve(os.homedir(), value.slice(2)));
  return targets;
}

export function toolDecision(mode, root, event, options) {
  try {
    const tool = event.tool_name, input = event.tool_input;
    const writing = WRITE_TOOLS.has(tool), searching = tool === 'Glob' || tool === 'Grep';
    // WebFetch could read a local file through a file: URL; only web pages are allowed. CodeBuddy's
    // --allowedTools doesn't pre-approve WebFetch in -p dontAsk runs, so web pages are approved here,
    // unless the user's own settings deny or ask for WebFetch: then CodeBuddy's rules decide.
    if (tool === 'WebFetch' && ['read', 'edit', 'shell'].includes(mode)) {
      if (!/^https?:\/\//i.test(String(input?.url ?? ''))) return deny('only http and https web pages can be fetched');
      return mode !== 'shell' && !userLimitsWebFetch(options?.configDir) ? { decision: 'allow', reason: 'web page' } : { decision: null, reason: null };
    }
    if (!['read', 'edit', 'shell'].includes(mode) || !(writing || READ_TOOLS.has(tool))) return deny('this tool is not allowed in this run');
    if (!path.isAbsolute(root) || !input || typeof input !== 'object' || Array.isArray(input)) return deny(UNRESOLVED);
    const project = path.resolve(root);
    const value = searching ? input.path ?? project : input.file_path;
    // Glob's pattern and Grep's glob filter can name files outside the search folder
    // (CodeBuddy's JavaScript search reads whatever its glob matches), so both are checked like paths.
    const pattern = tool === 'Glob' ? input.pattern ?? '' : tool === 'Grep' ? input.glob ?? '' : '';
    if (typeof value !== 'string' || !value || typeof pattern !== 'string') return deny(UNRESOLVED);
    if (value.startsWith('@') || /^file:/i.test(value) || WINDOWS && /^\/[a-z]\//i.test(value)
      || value.includes('\0') || pattern.includes('\0')) {
      return deny('use a plain path; @ references, file: URLs and /c/-style drive paths are not allowed');
    }
    const candidates = targetPaths(project, value);
    if ([root, value, pattern, ...candidates].some(share)) return deny('path is on a network share');
    // An absolute alternative inside braces ({src/**,C:/x/**}) is as absolute as the whole pattern.
    if (path.isAbsolute(pattern) || /(?:^|[{,])\s*(?:[\\/]|[a-z]:)/i.test(pattern)) return deny(OUTSIDE);
    if (segments(pattern).includes('..') || segments(value).some(part =>
      part === '..' || writing && (part === '.' || WINDOWS && /[. ]$/.test(part)))) return deny(AMBIGUOUS);
    if (mode === 'read' && writing) return deny('this tool is not allowed in this run');

    const realRoot = realPath(project);
    for (const candidate of candidates) {
      const target = realPath(candidate);
      if (!inside(realRoot, target)) return deny(OUTSIDE);
      if (!writing) continue;
      const base = [project, realRoot].find(dir => inside(dir, candidate));
      if (hasProtectedName(base ? path.relative(base, candidate) : candidate) || hasProtectedName(path.relative(realRoot, target))) return deny(PROTECTED);
      if (!path.isAbsolute(options.runsDir)) return deny(UNRESOLVED);
      const owned = [path.join(os.homedir(), '.claude', 'foreman'), codebuddyConfigDir(), options.runsDir].filter(dir => !share(dir));
      if (owned.some(dir => inside(dir, candidate) || inside(realPath(dir), target))
        || protectedTargets(realRoot).some(dir => inside(dir, target))) return deny(PROTECTED);
      const stat = fs.statSync(target, { throwIfNoEntry: false });
      if (stat?.isFile() && stat.nlink > 1) return deny('file has other hard links; it may change a file outside the project');
    }
    return writing && mode === 'edit' ? { decision: 'allow', reason: 'project-local edit' } : { decision: null, reason: null };
  } catch {
    return deny(UNRESOLVED);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , mode, root, runsDir] = process.argv;
  let result;
  try { result = toolDecision(mode, root, JSON.parse(fs.readFileSync(0, 'utf8')), { runsDir }); }
  catch { result = deny(UNRESOLVED); }
  if (result.decision) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse',
    permissionDecision: result.decision, permissionDecisionReason: result.reason } }));
}
