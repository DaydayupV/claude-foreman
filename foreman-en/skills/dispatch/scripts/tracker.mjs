// 改动追踪：用记录目录里的影子 git 仓库拍快照、生成 diff，不碰项目自己的 .git。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { M } from './util.mjs';

const LARGE_FILE_BYTES = 5 * 1024 * 1024; // 超过的文件只比较大小和修改时间
const MAX_SNAPSHOT_FILES = 50000;
const SNAPSHOT_EXCLUDES = [
  '.git/', 'node_modules/', '.venv/', 'venv/', '__pycache__/', '.mypy_cache/', '.pytest_cache/',
  '.ruff_cache/', '.tox/', '.next/', '.nuxt/', '.gradle/', '.idea/', '.vs/', 'target/', '*.pyc',
];

function makeTracker(runDir, cwd, track) {
  const gitDir = path.join(runDir, '.shadow');
  const base = [
    '--git-dir', gitDir, '--work-tree', cwd, '--literal-pathspecs',
    '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.quotepath=false',
    '-c', 'safe.directory=*', '-c', 'core.longpaths=true',
  ];
  const git = (args, { input, index } = {}) => {
    const r = spawnSync('git', [...base, ...args], {
      cwd, input, encoding: 'utf8', maxBuffer: 1 << 30, timeout: 180000, windowsHide: true,
      env: index ? { ...process.env, GIT_INDEX_FILE: index } : process.env,
    });
    if (r.error || r.status !== 0) throw new Error(M.gitFailed(args[0], r.error?.message || r.stderr.trim()));
    return r.stdout;
  };

  const cleanup = () => { try { fs.rmSync(gitDir, { recursive: true, force: true }); } catch { /* 留着也无害 */ } };
  try {
    git(['init', '--quiet']);
    fs.mkdirSync(path.join(gitDir, 'info'), { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'info', 'exclude'), SNAPSHOT_EXCLUDES.join('\n') + '\n');
  } catch (e) { cleanup(); throw e; }

  function snap(label) {
    const index = path.join(gitDir, `index-${label}`);
    const files = [...new Set([
      ...git(['ls-files', '-z', '-o', '--exclude-standard']).split('\0').filter(Boolean),
      ...(track.length ? git(['ls-files', '-z', '-o', '--', ...track]).split('\0').filter(Boolean) : []),
    ])];
    if (files.length > MAX_SNAPSHOT_FILES) throw new Error(M.tooManyFiles(files.length, MAX_SNAPSHOT_FILES));
    const small = [];
    const large = {};
    for (const f of files) {
      let st;
      try { st = fs.statSync(path.join(cwd, f)); } catch { continue; }
      if (st.isDirectory()) continue; // 嵌套仓库
      if (st.size > LARGE_FILE_BYTES) large[f] = `${st.size}:${Math.round(st.mtimeMs)}`;
      else small.push(f);
    }
    if (small.length) git(['add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: small.join('\0'), index });
    return { tree: git(['write-tree'], { index }).trim(), large };
  }

  function diff(a, b, patchFile) {
    const tokens = git(['diff', '-z', '--name-status', '--no-renames', a.tree, b.tree]).split('\0').filter(Boolean);
    const files = [];
    for (let i = 0; i + 1 < tokens.length; i += 2) files.push({ status: tokens[i], path: tokens[i + 1] });
    const largeChanged = [];
    for (const f of new Set([...Object.keys(a.large), ...Object.keys(b.large)])) {
      if (a.large[f] === b.large[f]) continue;
      largeChanged.push({ status: !a.large[f] ? 'A' : !b.large[f] ? 'D' : 'M', path: f });
    }
    const patch = git(['diff', '--no-renames', a.tree, b.tree]);
    fs.writeFileSync(patchFile, patch);
    const stat = files.length ? git(['diff', '--shortstat', a.tree, b.tree]).trim() : '';
    return { files, large_files_changed: largeChanged, shortstat: stat, patch_bytes: Buffer.byteLength(patch) };
  }

  return { snap, diff, cleanup };
}

export { makeTracker };
