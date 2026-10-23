// 改动追踪：用记录目录里的影子 git 仓库拍快照、生成 diff，不碰项目自己的 .git。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { M, relativePath, pathKey } from './util.mjs';

const LARGE_FILE_BYTES = 5 * 1024 * 1024; // 超过的文件只比较大小和修改时间
const MAX_SNAPSHOT_FILES = 50000;
const SNAPSHOT_BATCH_FILES = 500;
const SNAPSHOT_RETRY_MS = 20000;
const SNAPSHOT_TOTAL_MS = 60000; // 给正常批次留足时间，同时限制首次 add 和重试的总等待。
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
  const git = (args, { input, index, timeout = 180000 } = {}) => {
    // check-ignore 不接受 literal pathspec，路径由 --stdin 原样传入。
    const r = spawnSync('git', [...base.filter((arg) => arg !== '--literal-pathspecs' || args[0] !== 'check-ignore'), ...args], {
      cwd, input, encoding: 'utf8', maxBuffer: 1 << 30, timeout, windowsHide: true,
      env: index ? { ...process.env, GIT_INDEX_FILE: index } : process.env,
    });
    if (r.error || r.status !== 0 && !(args[0] === 'check-ignore' && r.status === 1)) throw new Error(M.gitFailed(args[0], r.error?.message || r.stderr.trim()));
    return r.stdout;
  };

  const roots = track.map((file) => pathKey(relativePath(cwd, file)));
  const tracked = (file) => roots.some((root) => root === '.' || pathKey(file) === root || pathKey(file).startsWith(`${root}/`));
  const records = relativePath(cwd, path.dirname(runDir));
  const recordsInside = records !== '..' && !records.startsWith('../') && !path.isAbsolute(records);
  const inRecords = (file) => recordsInside && (records === '.' || pathKey(file) === pathKey(records) || pathKey(file).startsWith(`${pathKey(records)}/`));
  const unstablePaths = new Set();
  // 被忽略、又不在 --track 里的路径，整个被忽略的目录折叠成一项；折叠的目录里有 --track 的文件时展开它，免得整个算成盲区。
  function ignoredUntracked(pathspec, runGit = git) {
    const list = (args) => runGit(['ls-files', '-z', '-o', '-i', '--exclude-standard', ...args]).split('\0').filter(Boolean);
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
    // 记录目录可能就在项目里，排除整棵目录，免得其他任务的记录也进项目补丁。
    const excludes = [...SNAPSHOT_EXCLUDES, ...(recordsInside ? [`/${records.replace(/[\\*?[\]]/g, '\\$&')}/`] : [])];
    fs.writeFileSync(path.join(gitDir, 'info', 'exclude'), excludes.join('\n') + '\n');
  } catch (e) { cleanup(); throw e; }

  function snap(label) {
    const deadline = Date.now() + SNAPSHOT_TOTAL_MS;
    let timedOut = false;
    const expired = () => {
      if (Date.now() >= deadline) timedOut = true;
      return timedOut;
    };
    const snapGit = (args, options = {}) => {
      const remaining = deadline - Date.now();
      if (timedOut || remaining <= 0) { timedOut = true; throw new Error(M.snapshotDeadline); }
      try { return git(args, { ...options, timeout: Math.min(options.timeout ?? SNAPSHOT_TOTAL_MS, remaining) }); }
      catch (e) { expired(); throw e; }
    };
    const index = path.join(gitDir, `index-${label}`);
    let tree = snapGit(['write-tree'], { index }).trim();
    const files = [...new Set([
      ...snapGit(['ls-files', '-z', '-o', '--exclude-standard']).split('\0').filter(Boolean),
      ...(track.length ? snapGit(['ls-files', '-z', '-o', '--', ...track]).split('\0').filter(Boolean) : []),
    ])].filter((file) => !inRecords(file));
    if (files.length > MAX_SNAPSHOT_FILES) throw new Error(M.tooManyFiles(files.length, MAX_SNAPSHOT_FILES));
    const small = [];
    const large = {};
    const unstable = new Set();
    const confirmed = new Set();
    const stat = (file) => {
      if (expired()) return null;
      try { const st = fs.statSync(path.join(cwd, file)); return st.isDirectory() ? null : st; }
      catch { return null; }
    };
    for (let i = 0; i < files.length; i++) {
      if (expired()) { files.slice(i).forEach((f) => unstable.add(f)); break; }
      const f = files[i];
      let st;
      try { st = fs.statSync(path.join(cwd, f)); } catch { /* 读不到的小文件也要重试，不能静默漏掉 */ }
      if (st?.isDirectory()) continue; // 嵌套仓库
      if (st?.size > LARGE_FILE_BYTES) large[f] = `${st.size}:${Math.round(st.mtimeMs)}`;
      else small.push(f);
    }
    let retryDeadline = null;
    const retry = (batch, attempt) => {
      retryDeadline ??= Date.now() + SNAPSHOT_RETRY_MS;
      if (expired() || attempt > 3 || Date.now() >= retryDeadline) batch.forEach((file) => unstable.add(file));
      else add(batch, attempt, true);
    };
    function add(batch, attempt = 1, retrying = false) {
      if (expired()) { batch.forEach((file) => unstable.add(file)); return; }
      const before = batch.map(stat);
      try {
        snapGit(['add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], {
          input: batch.join('\0'), index,
          timeout: retrying ? Math.max(1, retryDeadline - Date.now()) : SNAPSHOT_RETRY_MS,
        });
      } catch {
        // 超时中止的 git 可能留下索引锁；这个索引只属于本次快照，可以移除后重试。
        fs.rmSync(`${index}.lock`, { force: true });
        if (batch.length === 1) retry(batch, attempt + 1);
        else {
          const half = Math.ceil(batch.length / 2);
          retry(batch.slice(0, half), attempt);
          retry(batch.slice(half), attempt);
        }
        return;
      }
      const changed = batch.filter((file, i) => {
        const a = before[i], b = stat(file);
        return !a || !b || a.size !== b.size || a.mtimeMs !== b.mtimeMs || a.ctimeMs !== b.ctimeMs;
      });
      if (changed.length) retry(changed, attempt + 1);
    }
    try {
      if (label === 'before' && listIgnored) ignoredBefore = ignoredUntracked([], snapGit);
      for (let i = 0; i < small.length && !expired(); i += SNAPSHOT_BATCH_FILES) {
        const batch = small.slice(i, i + SNAPSHOT_BATCH_FILES);
        add(batch);
        // 每批确认后保存树，截止时间到了就直接用它，不再启动 git 收尾或等待下一批。
        if (unstable.size) snapGit(['update-index', '--force-remove', '-z', '--stdin'], { input: [...unstable].join('\0') + '\0', index });
        tree = snapGit(['write-tree'], { index }).trim();
        batch.filter((file) => !unstable.has(file)).forEach((file) => confirmed.add(file));
      }
    } catch (e) { if (!expired()) throw e; }
    for (const file of small) if (!confirmed.has(file)) unstable.add(file);
    for (const file of unstable) unstablePaths.add(pathKey(file));
    return { tree, large, unstable: [...unstable], incomplete: timedOut || unstable.size > 0, timed_out: timedOut };
  }

  function diff(a, b, patchFile, excluded = []) {
    excluded = [...new Set([...excluded, ...a.unstable, ...b.unstable])];
    // 用临时索引删去别人的路径再比较，避免大批路径超过 Windows 命令行长度限制。
    const trees = [a, b].map((snap, i) => {
      if (!excluded.length) return snap.tree;
      const index = path.join(gitDir, `index-patch-${i}`);
      git(['read-tree', snap.tree], { index });
      git(['update-index', '--force-remove', '-z', '--stdin'], { input: excluded.join('\0') + '\0', index });
      return git(['write-tree'], { index }).trim();
    });
    const tokens = git(['diff', '-z', '--name-status', '--no-renames', ...trees]).split('\0').filter(Boolean);
    const files = [];
    for (let i = 0; i + 1 < tokens.length; i += 2) files.push({ status: tokens[i], path: tokens[i + 1] });
    const largeChanged = [];
    for (const f of new Set([...Object.keys(a.large), ...Object.keys(b.large)])) {
      if (a.large[f] === b.large[f] || excluded.includes(f)) continue;
      largeChanged.push({ status: !a.large[f] ? 'A' : !b.large[f] ? 'D' : 'M', path: f });
    }
    const patch = git(['diff', '--no-renames', ...trees]);
    fs.writeFileSync(patchFile, patch);
    const stat = files.length ? git(['diff', '--shortstat', ...trees]).trim() : '';
    return { files, large_files_changed: largeChanged, shortstat: stat, patch_bytes: Buffer.byteLength(patch) };
  }

  function covers(paths, directories = []) {
    const files = paths.map((file) => relativePath(cwd, file));
    const inside = (file) => file !== '.' && file !== '..' && !file.startsWith('../') && !path.isAbsolute(file);
    const candidates = files.filter(inside);
    // --no-index 也能判断已删除或尚未存在的路径，影子仓库的 exclude 与快照一致。
    const ignored = new Set((candidates.length ? git(['check-ignore', '--no-index', '-z', '--stdin'],
      { input: candidates.flatMap((file) => [file, `${file}/`]).join('\0') + '\0' }) : '').split('\0').filter(Boolean).map((file) => pathKey(file.replace(/\/$/, ''))));
    const requestedDirs = directories.map((file) => relativePath(cwd, file));
    const dirs = requestedDirs.filter((file) => inside(file) && !tracked(file));
    // 目录自报可能指向被忽略的后代（开工前有、现在已被删掉的也算），只有 --track 覆盖的部分能排除这种盲区。
    const excluded = dirs.length ? [...ignoredBefore, ...ignoredUntracked(dirs)] : [];
    // 目录看它（包括它自己被忽略时）有没有没被 --track 覆盖的忽略项，文件看它自己是不是被忽略。
    return files.map((file) => {
      if (!inside(file)) return false;
      const key = pathKey(file);
      if (inRecords(file) || [...unstablePaths].some((p) => p === key || requestedDirs.some((dir) => pathKey(dir) === key) && p.startsWith(`${key}/`))) return false;
      if (tracked(file)) return true;
      if (!dirs.some((dir) => pathKey(dir) === key)) return !ignored.has(key);
      return !excluded.some((child) => child === key || child.startsWith(`${key}/`));
    });
  }

  return { snap, diff, covers, cleanup };
}

export { makeTracker };
