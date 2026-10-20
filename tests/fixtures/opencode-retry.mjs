// 现场 mpxt 的重试事件：保留三段原文，去掉标识、时间和外部绝对路径。
export const opencodeRetry = [
  {
    "type": "step_start"
  },
  {
    "type": "step_start"
  },
  {
    "type": "step_start"
  },
  {
    "type": "step_start"
  },
  {
    "type": "step_start"
  },
  {
    "type": "step_start"
  },
  {
    "type": "tool_use",
    "part": {
      "tool": "read",
      "state": {
        "status": "completed",
        "input": {
          "path": "calc.js"
        },
        "output": "Read file calc.js, lines 1-17\n1: // Small helpers used by the report page.\n2: \n3: // Returns the average of an array of numbers.\n4: function average(nums) {\n5:   let sum = 0;\n6:   for (let i = 0; i <= nums.length; i++) {\n7:     sum += nums[i];\n8:   }\n9:   return sum / nums.length;\n10: }\n11: \n12: // Returns true when the user is an admin.\n13: function isAdmin(user) {\n14:   return user.role = 'admin';\n15: }\n16: \n17: module.exports = { average, isAdmin };"
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
    "type": "text",
    "part": {
      "text": "{\"verdict\":\"issues_found\",\"findings\":[{\"id\":\"F1\",\"location\":\"calc.js:6-9"
    }
  },
  {
    "type": "error",
    "error": {
      "type": "provider.transport",
      "message": "Timed out waiting for response data",
      "status": 200
    }
  },
  {
    "type": "step_start"
  },
  {
    "type": "text",
    "part": {
      "text": "{\"verdict\":\"issues_found\",\"findings\":[{\"id\":\"F1\",\"location\":\"calc.js:6-9\",\"issue\":\"average 的循环条件写成 i <= nums.length，多读了一次 nums[nums.length]（undefined），使 sum 变成 NaN，函数恒定返回 NaN 而不是平均值。\",\"trigger\":\"任何非空数字数组，例如 average([1,2,3])：最后一次迭代 sum += undefined 得到 NaN，返回 NaN/3 = NaN。\",\"severity\":\"high\",\"evidence\":\"第 6 行 for (let i = 0; i <= nums.length; i++)，数组有效下标为 0..length-1，i === nums.length 时 nums[i] 为 undefined；第 7 行 sum += nums[i] 因此为 NaN；第 9 行返回 NaN / nums.length 仍为 NaN。\",\"suggestion\":\"把循环条件改为 i < nums.length（或直接用 reduce/sum）。另外空数组会让 0/0 返回 NaN，如需要可显式处理 nums.length === 0 的情况（返回 0 或抛错）。\"},{\"id\":\"F2\",\"location\":\"calc.js:14\",\"issue\":\"isAdmin 用赋值 = 代替比较 ===，表达式结果是被赋的值 'admin'（真值），所以任何用户都会被判定为 admin，同时还会把 user.role 篡改为 'admin'（副作用）。\",\"trigger\":\"任意非 admin 用户，例如 isAdmin({role:'user'}) 返回 'admin'（被当作 true），且调用后 user.role 变成 'admin'；user 为 null/undefined 时抛 TypeError。返回类型也不是布尔值，与文档描述不符。\",\"severity\":\"high\",\"evidence\":\"第 14 行 return user.role = 'admin'; 这是赋值表达式，返回值恒为 'admin'，为真值；无 === 比较，也没有返回 boolean。\",\"suggestion\":\"改为 return user.role === 'admin';（如需健壮性可写 return !!user && user.role === 'admin';），避免修改传入对象。\"}],\"co"
    }
  },
  {
    "type": "error",
    "error": {
      "type": "provider.transport",
      "message": "Timed out waiting for response data",
      "status": 200
    }
  },
  {
    "type": "step_start"
  },
  {
    "type": "step_start"
  },
  {
    "type": "step_start"
  },
  {
    "type": "step_start"
  },
  {
    "type": "step_start"
  },
  {
    "type": "step_start"
  },
  {
    "type": "text",
    "part": {
      "text": "],\"coverage\":{\"checked\":[\"calc.js 全文 17 行（average 第 4-10 行、isAdmin 第 13-15 行、module.exports 第 17 行）\",\"average 的循环边界与返回值计算路径\",\"isAdmin 的比较/赋值语义与返回值类型\"],\"not_checked\":[\"调用方（report 页面）如何使用这两个函数，以及是否有其他地方依赖 isAdmin 的副作用\",\"项目中的测试文件或其他模块，仅按要求审查 calc.js\"]},\"unverified\":[\"average 对空数组的预期行为（返回 NaN 还是 0/抛错）未在需求中说明，仅作为建议提及\",\"输入可能含非数字、null、稀疏数组时的预期行为未定义\"]}"
    }
  },
  {
    "type": "step_finish",
    "part": {
      "reason": "stop"
    }
  }
];
