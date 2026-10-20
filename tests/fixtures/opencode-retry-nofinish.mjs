// 现场 7ce3（2026-10-21）：流超时、重试以后，最后一步写完完整报告就退出，没有 step_finish，opencode 退出码 1。
// 去掉了标识、时间戳和外部绝对路径；最后一段回复保留 time.end，判断"以写完的回复结尾"要用。
export const opencodeRetryNoFinish = [
  {
    "type": "step_start"
  },
  {
    "type": "text",
    "part": {
      "text": "我先读一下 cart.js。",
      "time": {
        "start": 1,
        "end": 2
      }
    }
  },
  {
    "type": "tool_use",
    "part": {
      "tool": "read",
      "state": {
        "status": "completed",
        "input": {
          "path": "cart.js"
        },
        "output": "Read file cart.js, lines 1-5\n1: export function total(items) {\n2:   let sum = 0;\n3:   for (let i = 0; i <= items.length; i++) sum += items[i].price;\n4:   return sum;\n5: }"
      }
    }
  },
  {
    "type": "step_finish",
    "part": {
      "reason": "tool-calls"
    }
  },
  {
    "type": "step_start"
  },
  {
    "type": "tool_use",
    "part": {
      "tool": "glob",
      "state": {
        "status": "completed",
        "input": {
          "pattern": "*"
        },
        "output": "cart.js"
      }
    }
  },
  {
    "type": "step_finish",
    "part": {
      "reason": "tool-calls"
    }
  },
  {
    "type": "step_start"
  },
  {
    "type": "error",
    "error": {
      "type": "provider.transport",
      "message": "Timed out waiting for response data"
    }
  },
  {
    "type": "step_start"
  },
  {
    "type": "text",
    "part": {
      "text": "{\"verdict\":\"issues_found\",\"findings\":[{\"id\":\"F1\",\"location\":\"cart.js:3\",\"issue\":\"循环条件用了 `i <= items.length`，最后一次迭代会读取 items[items.length]（undefined），再访问 .price 时抛出 TypeError。\",\"trigger\":\"任何调用都会触发：空数组（i=0 读到 items[0] 为 undefined）和非空数组（最后一步读到越界下标）都会抛 “Cannot read properties of undefined (reading 'price')”，函数无法正常返回结果。\",\"severity\":\"high\",\"evidence\":\"第3行 `for (let i = 0; i <= items.length; i++) sum += items[i].price;`，`<=` 使 i 取到 length，此时 `items[length]` 恒为 undefined。\",\"suggestion\":\"把条件改为 `i < items.length`，或改用 `for (const item of items)` / `items.reduce(...)` 遍历，并保证不越界。\"},{\"id\":\"F2\",\"location\":\"cart.js:3\",\"issue\":\"对 items[i].price 不做类型校验就直接相加，非数字 price 会被当作字符串拼接或产生 NaN。\",\"trigger\":\"price 为字符串（如 \\\"10\\\"、\\\"9.99\\\"）或缺失/null 时：字符串情况下 sum 变成 \\\"01020\\\" 这类拼接结果；null/undefined 情况下 sum 变为 NaN，最终 total 返回错误值且不报错。\",\"severity\":\"medium\",\"evidence\":\"第3行 `sum += items[i].price` 没有任何 Number 转换或校验，`0 + \\\"10\\\" === \\\"010\\\"`。\",\"suggestion\":\"累加前校验 `typeof item.price === 'number' && Number.isFinite(item.price)`，或显式 `Number(item.price)` 并对 NaN 抛错/跳过，金额建议以最小货币单位（整数分）计算。\"},{\"id\":\"F3\",\"location\":\"cart.js:2-3\",\"issue\":\"用浮点数直接累加金额，存在二进制浮点误差，结果可能带多余小数。\",\"trigger\":\"价格含小数时，如 0.1+0.2 → 0.30000000000000004；多项累加后返回的 total 与预期金额不一致（尤其在等于某个阈值或与支付金额比对时出错）。\",\"severity\":\"low\",\"evidence\":\"第2行初始化为数字 0、第3行 `sum += ...`，全程无取整或四舍五入处理，JS 数字为 IEEE-754 双精度。\",\"suggestion\":\"以整数分累加（先四舍五入到分），返回前再统一换算/保留两位小数。\"}],\"coverage\":{\"checked\":[\"逐行阅读 cart.js 全部 5 行\",\"total 函数的循环边界与越界访问\",\"空数组、非空数组的正常路径\",\"price 字段类型缺失/为字符串/为 null 时的累加行为\",\"金额浮点精度\",\"目录下仅有 cart.js，无调用方或其他上下文文件\"],\"not_checked\":[\"调用方如何构造 items（是否含 quantity 字段、是否已做价格格式化）\",\"项目测试、构建配置与运行时环境（Node/浏览器）\",\"性能、并发、安全相关场景（该函数为纯计算，未见相关逻辑）\"]},\"unverified\":[\"是否应在累加时乘以 quantity（函数只累加 price，无 quantity 字段，无法判断业务预期）\",\"price 的数据来源与契约（是否可能为负数、是否允许折扣价），因此未将负数价格作为问题上报\",\"是否存在外部保证 price 一定为合法数字，从而 F2 可能已有上游校验\"]}",
      "time": {
        "start": 1,
        "end": 2
      }
    }
  }
];
