// 改动追踪：用记录目录里的影子 git 仓库拍快照、生成 diff，不碰项目自己的 .git。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { M, relativePath, pathKey } from './util.mjs';

const LARGE_FILE_BYTES = 5 * 1024 * 1024; // 超过的文件只比较大小和修改时间
const MAX_SNAPSHOT_FILES = 50000;
const SNAPSHOT_EXCLUDES = [
  '.git/', 'node_modules/', '.venv/', 'venv/', '__pycache__/', '.mypy_cache/', '.pytest_cache/',
  '.ruff_cache/', '.tox/', '.next/', '.nuxt/', '.gradle/', '.idea/', '.vs/', 'target/', '*.pyc',
];

// ignored 为 true 时，开工前的快照还记下被忽略的路径（讨论和审查判断自报的目录用）。
function makeTracker(runDir, cwd, track, { ignored: listIgnored = false } = {}) {
  const gitDir = path.join(runDir, '.shadow');
  const base = [
    '--git-dir', gitDir, '--work-tree', cwd, '--literal-pathspecs',
    '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.quotepath=false',
    '-c', 'safe.directory=*', '-c', 'core.longpaths=true',
  ];
  const git = (args, { input, index } = {}) => {
    // check-ignore 不接受 literal pathspec，路径由 --stdin 原样传入。
    const r = spawnSync('git', [...base.filter((arg) => arg !== '--literal-pathspecs' || args[0] !== 'check-ignore'), ...args], {
      cwd, input, encoding: 'utf8', maxBuffer: 1 << 30, timeout: 180000, windowsHide: true,
      env: index ? { ...process.env, GIT_INDEX_FILE: index } : process.env,
    });
    if (r.error || r.status !== 0 && !(args[0] === 'check-ignore' && r.status === 1)) throw new Error(M.gitFailed(args[0], r.error?.message || r.stderr.trim()));
    return r.stdout;
  };

  const roots = track.map((file) => pathKey(relativePath(cwd, file)));
  const tracked = (file) => roots.some((root) => root === '.' || pathKey(file) === root || pathKey(file).startsWith(`${root}/`));
  // 被忽略、又不在 --track 里的路径，整个被忽略的目录折叠成一项；折叠的目录里有 --track 的文件时展开它，免得整个算成盲区。
  function ignoredUntracked(pathspec) {
    const list = (args) => git(['ls-files', '-z', '-o', '-i', '--exclude-standard', ...args]).split('\0').filter(Boolean);
    return list(['--directory', '--', ...pathspec]).flatMap((entry) => {
      const key = pathKey(entry.replace(/\/$/, ''));
      return entry.endsWith('/') && roots.some((root) => root.startsWith(`${key}/`)) ? list(['--', entry]) : [entry];
    }).map((file) => pathKey(file.replace(/\/$/, ''))).filter((file) => !tracked(file));
  }
  let ignoredBefore = [];

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
    if (label === 'before' && listIgnored) ignoredBefore = ignoredUntracked([]);
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

  function covers(paths, directories = []) {
    const files = paths.map((file) => relativePath(cwd, file));
    const inside = (file) => file !== '.' && file !== '..' && !file.startsWith('../') && !path.isAbsolute(file);
    const candidates = files.filter(inside);
    // --no-index 也能判断已删除或尚未存在的路径，影子仓库的 exclude 与快照一致。
    const ignored = new Set((candidates.length ? git(['check-ignore', '--no-index', '-z', '--stdin'],
      { input: candidates.flatMap((file) => [file, `${file}/`]).join('\0') + '\0' }) : '').split('\0').filter(Boolean).map((file) => pathKey(file.replace(/\/$/, ''))));
    const dirs = directories.map((file) => relativePath(cwd, file)).filter((file) => inside(file) && !tracked(file));
    // 目录自报可能指向被忽略的后代（开工前有、现在已被删掉的也算），只有 --track 覆盖的部分能排除这种盲区。
    const excluded = dirs.length ? [...ignoredBefore, ...ignoredUntracked(dirs)] : [];
    // 目录看它（包括它自己被忽略时）有没有没被 --track 覆盖的忽略项，文件看它自己是不是被忽略。
    return files.map((file) => {
      if (!inside(file)) return false;
      if (tracked(file)) return true;
      const key = pathKey(file);
      if (!dirs.some((dir) => pathKey(dir) === key)) return !ignored.has(key);
      return !excluded.some((child) => child === key || child.startsWith(`${key}/`));
    });
  }

  return { snap, diff, covers, cleanup };
}

export { makeTracker };
