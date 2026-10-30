export function formatConfigText(obj) {
  const render = (value, depth, modules = false) => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    const array = Array.isArray(value), entries = Object.entries(value);
    if (!entries.length) return array ? '[]' : '{}';
    // 只在顶层 modules 里把原始值对象收成一行，数组仍让每个元素各占一行。
    if (modules && !array && entries.every(([, item]) => item === null || typeof item !== 'object')) {
      return `{ ${entries.map(([key, item]) => `${JSON.stringify(key)}: ${JSON.stringify(item)}`).join(', ')} }`;
    }
    const indent = '  '.repeat(depth);
    const rows = array ? value.map((item) => render(item, depth + 1, modules))
      : entries.map(([key, item]) => `${JSON.stringify(key)}: ${render(item, depth + 1, modules || depth === 0 && key === 'modules')}`);
    return `${array ? '[' : '{'}\n${rows.map((row) => `${indent}  ${row}`).join(',\n')}\n${indent}${array ? ']' : '}'}`;
  };
  return render(JSON.parse(JSON.stringify(obj)), 0) + '\n';
}

export function isOneLine(text) {
  const clean = text.replace(/^\uFEFF/, '');
  try { return formatConfigText(JSON.parse(clean)) === clean.replace(/\r\n?/g, '\n'); }
  catch { return null; }
}
