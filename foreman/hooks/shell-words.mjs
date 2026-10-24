// 钩子共用的命令行解析：按分隔符拆段、去掉 heredoc 和 PowerShell here-string 的正文、取出命令替换。
// 只做字面上的拆分，用来看每段命令开头真正被执行的是什么程序。

export const base = (p) => p.replace(/^["']|["']$/g, '').split(/[\\/]/).pop().toLowerCase();

// 按 ; | && || 和换行把命令拆成几段，引号里的分隔符不算。
export function splitSegments(command) {
  const segments = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      current += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      current += c;
    } else if (c === ';' || c === '|' || c === '\n' || (c === '&' && command[i + 1] === '&')) {
      segments.push(current);
      current = '';
      if ((c === '&' || c === '|') && command[i + 1] === c) i++;
    } else {
      current += c;
    }
  }
  segments.push(current);
  return segments;
}

// 命令替换 $( … ) 和 ` … ` 里的命令会执行：从会展开的正文里取出来，另起一行检查
export function substitutions(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '`') {
      const j = text.indexOf('`', i + 1);
      if (j < 0) break;
      out.push(text.slice(i + 1, j)); i = j;
    } else if (text[i] === '$' && text[i + 1] === '(') {
      let depth = 0, j = i + 1;
      for (; j < text.length; j++) { if (text[j] === '(') depth++; else if (text[j] === ')' && --depth === 0) break; }
      out.push(text.slice(i + 2, j)); i = j;
    }
  }
  return out;
}

// 一行里写在引号外、注释前的 heredoc 开头：<<WORD、<<-WORD（结束行可以带制表符缩进）、<<'WORD'、<<"WORD"、<<\WORD。
// 分隔符加了引号或反斜杠的正文原样是文字（literal）；<<< 是 here-string，不算
export function heredocsOf(line) {
  const found = [];
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === quote) quote = null; else if (c === '\\' && quote === '"') i++; continue; }
    if (c === '\\') { i++; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;
    if (c !== '<' || line[i + 1] !== '<' || line[i + 2] === '<' || line[i - 1] === '<') continue;
    const m = /^<<(-?)\s*(?:(['"])([^'"]+)\2|\\([A-Za-z_][\w.-]*)|([A-Za-z_][\w.-]*))/.exec(line.slice(i));
    if (!m) { i++; continue; }
    found.push({ tabs: m[1] === '-', end: m[3] ?? m[4] ?? m[5], literal: m[3] != null || m[4] != null });
    i += m[0].length - 1;
  }
  return found;
}

// heredoc 和 PowerShell 的 here-string（@' … '@、@" … "@）里是写进文件的文字，不是要执行的命令：先去掉正文再拆段，
// 免得正文里的"| pi · …"这类表格被当成调用。会展开的正文（分隔符没加引号的 heredoc、@" … "@）里的命令替换照样检查
export function stripHeredocs(command) {
  const text = command.replace(/@(['"])\r?\n([\s\S]*?)\r?\n\1@/g, (_, quote, body) => (quote === '"' ? ['""', ...substitutions(body)].join('\n') : "''"));
  const lines = text.split('\n'), out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    for (const { tabs, end, literal } of heredocsOf(lines[i])) {
      const body = [];
      while (i + 1 < lines.length) {
        const line = lines[++i].replace(/\r$/, '');
        if ((tabs ? line.replace(/^\t+/, '') : line) === end) break;
        body.push(line);
      }
      if (!literal) out.push(...substitutions(body.join('\n')));
    }
  }
  return out.join('\n');
}

// 一段命令拆成词：去掉开头的括号、反引号、$、& 和 .（PowerShell 的调用运算符），引号可以出现在一个参数中间（--call="codex exec"），整段算一个参数
export const tokensOf = (segment) => segment.replace(/^[\s(`$&.]+/, '').match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
