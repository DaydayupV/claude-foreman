// 审查范围与材料指纹只读计算，不修改工作区或索引。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { M, die, isGitRepo, readAttachments, readImages, relativePath } from './util.mjs';

export const MAX_REVIEW_CHARS = 200000;
export const REVIEW_TARGETS = ['diff', 'files', 'claims', 'visual'];
const MAX_UNTRACKED_BYTES = 1024 * 1024;
const DIFF_OPTIONS = ['--no-ext-diff', '--no-textconv', '--no-color', '--find-renames', '--full-index',
  '--no-relative', '--src-prefix=a/', '--dst-prefix=b/', '--submodule=short', '--ignore-submodules=none'];
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function validateReviewMaterial(options, plan = null) {
  const { cwd, target = 'diff', file = [], uncommitted, base, commit } = options;
  if (!REVIEW_TARGETS.includes(target)) die(M.reviewTargetChoices(M.list(REVIEW_TARGETS)));
  if (target !== 'diff' && !file.length) die(M.reviewTargetNeedsFile(target));
  if (target !== 'diff' && (uncommitted || base != null || commit != null)) die(M.reviewScopeDiffOnly);
  if (!plan?.review) {
    if (target === 'visual') readImages(file, cwd);
    else readAttachments(file, cwd, false);
  }
  let material;
  try { material = computeReviewMaterial(options); }
  catch (e) { die(plan?.review ? M.planMaterialChanged(plan.plan_id) : e.message); }
  if (plan?.review && (material?.fingerprint ?? null) !== plan.review.fingerprint) die(M.planMaterialChanged(plan.plan_id));
  if (target === 'diff' && material && !material.files.length) die(M.reviewEmpty(material.description));
  return material;
}

export function computeReviewMaterial({ cwd, target = 'diff', file = [], uncommitted, base, commit }) {
  if (target === 'diff') return isGitRepo(cwd) ? { ...computeReviewScope({ cwd, uncommitted, base, commit }), target } : null;
  const entries = file.map((spec) => {
    const match = /:(\d+)-(\d+)$/.exec(spec);
    const range = match ? [Number(match[1]), Number(match[2])] : null;
    const full = path.resolve(cwd, match ? spec.slice(0, match.index) : spec), rel = relativePath(cwd, full);
    const shown = rel.startsWith('../') || rel === '..' || path.isAbsolute(rel) ? full : rel;
    return [shown, range, createHash('sha256').update(fs.readFileSync(full)).digest('hex')];
  });
  const fingerprint = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  return { target, kind: target, description: M.reviewScopeTarget[target](entries.length), base: null, merge_base: null,
    commit: null, files: entries.map(([path, range]) => ({ path, range })), patch: '', fingerprint };
}

export function computeReviewScope({ cwd, uncommitted, base, commit }) {
  const git = (args, allowed = [0]) => {
    const r = spawnSync('git', ['-c', 'core.quotepath=false', '--literal-pathspecs', ...args], {
      cwd, input: '', maxBuffer: 1 << 30, windowsHide: true,
    });
    if (!allowed.includes(r.status)) throw new Error(r.error?.message || r.stderr.toString('utf8').trim());
    return r.stdout;
  };
  cwd = git(['rev-parse', '--show-toplevel']).toString('utf8').trim();
  const resolve = (ref) => git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).toString('utf8').trim();
  const emptyTree = () => git(['hash-object', '-t', 'tree', '--stdin']).toString('utf8').trim();
  let kind = 'uncommitted', description = M.reviewScopeUncommitted, baseSha = null, mergeBase = null, commitSha = null, revisions;
  if (base) {
    kind = 'base';
    try {
      baseSha = resolve(base);
      mergeBase = git(['merge-base', baseSha, 'HEAD']).toString('utf8').trim();
    } catch { throw new Error(M.baseNotFound(base)); }
    description = M.reviewScopeBase(base, mergeBase);
    revisions = [mergeBase];
  } else if (commit) {
    kind = 'commit';
    commitSha = resolve(commit);
    const parent = git(['rev-list', '--parents', '-n', '1', commitSha]).toString('utf8').trim().split(' ')[1];
    revisions = [parent || emptyTree(), commitSha];
    description = M.reviewScopeCommit(commitSha);
  } else {
    const head = git(['rev-parse', '--verify', '--quiet', 'HEAD'], [0, 1]).toString('utf8').trim();
    revisions = [head || emptyTree()];
  }
  const diff = ['diff', ...DIFF_OPTIONS, ...revisions];
  const names = git([...diff, '--name-status', '-z', '--']).toString('utf8').split('\0');
  const entries = [];
  for (let i = 0; names[i];) {
    const status = names[i++][0], first = names[i++];
    const renamed = status === 'R' || status === 'C';
    entries.push({ path: renamed ? names[i++] : first, status, binary: false, too_large: false, old_path: renamed ? first : null });
  }
  const untracked = new Set(kind === 'uncommitted'
    ? git(['ls-files', '--others', '--exclude-standard', '-z']).toString('utf8').split('\0').filter(Boolean) : []);
  for (const file of untracked) entries.push({ path: file, status: 'A', binary: false, too_large: false, old_path: null });
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  let patch = '';
  for (const file of entries) {
    if (untracked.has(file.path) && fs.lstatSync(path.join(cwd, file.path)).size > MAX_UNTRACKED_BYTES) {
      file.too_large = true;
      continue;
    }
    const bytes = untracked.has(file.path)
      ? git(['diff', '--no-index', ...DIFF_OPTIONS, '--', '/dev/null', file.path], [0, 1])
      : git([...diff, '--', ...(file.old_path ? [file.old_path] : []), file.path]);
    let text;
    try { text = utf8.decode(bytes); } catch { file.binary = true; }
    if (bytes.includes(0)) file.binary = true;
    if (file.binary) {
      // 非 UTF-8 或强制文本 diff 的二进制只保留头部，完整哈希仍能反映内容变化。
      const headerEnd = bytes.indexOf('\n--- ');
      text = headerEnd < 0 ? '' : bytes.subarray(0, headerEnd + 1).toString('utf8');
    } else file.binary = /^Binary files /m.test(text);
    patch += text;
  }
  const fingerprint = createHash('sha256').update(patch).update(JSON.stringify(entries)).digest('hex');
  return { kind, description, base: baseSha, merge_base: mergeBase, commit: commitSha, files: entries, patch, fingerprint };
}
