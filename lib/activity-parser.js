/**
 * dsh-codearts — 码道内核日志 → 结构化交互流时间线解析器（纯函数，零 IO）。
 *
 * 数据源：cli-data/log/kernel-*.log（bus-publish 事件流 + tool-timing + ERROR 等）。
 * 输出：[{time, kind, text}]，kind ∈ user | assistant | tool | error | system。
 *
 * 解析规则（2026-11-01 实机日志实证，样本见 test fixture）：
 *   - 行形如 `LEVEL [trace] ISO +Δms service=NAME "payload" k=v ...`
 *   - user/assistant：bus-publish message.part.updated 的 type=text 部件；角色由
 *     同日志内 message.updated 的 info{id,role} 建 msgRoles 映射；无 messageID 的
 *     部件按注入标记启发式归 user（【/goal、[GOAL-、synthetic 等），其余自然语言
 *     归 assistant。<system-reminder>+synthetic 属经验/语言 hook 前缀 → 剔除。
 *   - tool：tool-timing-plugin 的 tool_request（取 function_name）、file-write-
 *     metadata-hook 的实际写入行、bus-publish 的 type=tool 部件。
 *   - error：level=ERROR 行；含「错误码 5xx」等失败模式的行（llm stream error）。
 *   - system：session.status、retry、toast 等运行态事件；其余启动 INFO 噪声跳过。
 */
/** 单条时间线条目。 */
/**
 * @typedef {'user'|'assistant'|'tool'|'error'|'system'} ActivityKind
 */
/**
 * @typedef {Object} ActivityItem
 * @property {string} time ISO 时间（取自行首；缺省 ''）
 * @property {ActivityKind} kind
 * @property {string} text 已剔除前缀/截断的展示文本
 */

/** 条目文本上限（防止超长 prompt/回复撑爆前端）。 */
const MAX_TEXT = 600

/** 日志行头：LEVEL [trace] ISO +Δms service=NAME */
const LINE_HEAD_RE = /^(INFO|WARN|ERROR|DEBUG|TRACE)\s+(?:\[[^\]]+\]\s+)?(\d{4}-\d{2}-\d{2}T[\d:.]+)\s+\+\d+ms\s+service=([A-Za-z0-9-]+)\s*/i

/** 注入/hook 标记（这类文本部件归 user：监督器契约/系统提醒/hook 任务书）。 */
const USER_MARKERS = ['【/goal', '[GOAL-', '<system-reminder>', '请以 `', '请以 ', '【经验采集', '当前本地时间：']
/** 需要整体剔除的 hook 噪声（语言/经验提醒，非用户可读对话）。 */
const NOISE_MARKERS = ['<system-reminder>']

/** JSON 字符串内容反转义（"...\n..." → 实际换行）；非法输入原样返回。 */
function unescapeJsonString(raw) {
  try {
    return JSON.parse(`"${raw}"`)
  } catch {
    return raw
  }
}

/** 截断到 MAX_TEXT 并加省略号。 */
function clamp(text) {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text
}

/**
 * 从 bus-publish 行提取内嵌 JSON 对象（行尾被引号包裹：`"{...}"`）。
 * 解析失败返回 null（该行按启发式降级处理）。
 */
function extractBusJson(line) {
  const start = line.indexOf('{"type":')
  if (start < 0) return null
  let raw = line.slice(start).trim()
  if (raw.endsWith('"')) raw = raw.slice(0, -1)
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** text 部件正则（"type":"text","text":"..."；messageID 可能在 type 之前）。 */
const TEXT_PART_RE = /"type":"text","text":"((?:[^"\\]|\\.)*)"/
const MESSAGE_ID_RE = /"messageID":"(msg_[A-Za-z0-9]+)"/
const MSG_ROLE_RE = /"info":\s*\{"id":"(msg_[A-Za-z0-9]+)"[^{}]*?"role":"(user|assistant)"/
const TOOL_REQUEST_RE = /tool_request \{[\s\S]*?"function_name":"([^"]+)"/
const ERROR_MSG_RE = /error(?:Message|Type)?=\{?[^]*?"message":"([^"]{4,300})"/
const RETAIL_FAIL_RE = /错误码 \d{3}|后端服务不可用|stream error/

/** 目标契约文本 → 实际目标段（剔除契约骨架，取「目标：」行起的内容）。 */
function stripGoalContract(text) {
  const idx = text.indexOf('目标：')
  if (idx < 0) return text
  return text.slice(idx)
}

/** user 注入标记命中（按 USER_MARKERS 前缀/包含判定）。 */
function looksLikeUserInjection(text) {
  return USER_MARKERS.some((m) => text.startsWith(m) || text.includes(m))
}

/** hook 噪声命中（整体剔除，不进时间线）。 */
function isHookNoise(text) {
  return NOISE_MARKERS.some((m) => text.startsWith(m))
}

/**
 * 解析内核日志行数组为交互流时间线。
 * @param {string[]} lines 原始日志行（通常为尾部采样）
 * @returns {ActivityItem[]}
 */
export function parseActivityLines(lines) {
  if (!Array.isArray(lines)) return []
  /** @type {Record<string, string>} messageID → role（user|assistant） */
  const msgRoles = {}
  /** @type {ActivityItem[]} */
  const items = []
  for (const line of lines) {
    if (typeof line !== 'string' || line.length === 0) continue
    const head = LINE_HEAD_RE.exec(line)
    const level = head ? head[1].toUpperCase() : ''
    const time = head ? head[2] : ''
    const service = head ? head[3] : ''
    const rest = head ? line.slice(head[0].length) : line

    // ---- error：ERROR 级 / 失败模式（含 message 尽量取人话） ----
    if (level === 'ERROR') {
      const em = ERROR_MSG_RE.exec(rest)
      items.push({ time, kind: 'error', text: clamp(em ? `${service}: ${em[1]}` : `${service}: ${rest.slice(0, 200)}`) })
      continue
    }
    if (RETAIL_FAIL_RE.test(rest)) {
      const em = ERROR_MSG_RE.exec(rest)
      items.push({ time, kind: 'error', text: clamp(em ? `${service}: ${em[1]}` : `${service}: ${rest.slice(0, 200)}`) })
      continue
    }

    // ---- bus-publish：角色映射 / 文本部件 / tool 部件 ----
    if (service === 'bus-publish') {
      const roleMatch = MSG_ROLE_RE.exec(rest)
      if (roleMatch) msgRoles[roleMatch[1]] = roleMatch[2]
      const typeMatch = /"type":"(message\.part\.updated|message\.updated|session\.[a-z.]+)"/.exec(rest)
      const busType = typeMatch ? typeMatch[1] : ''
      if (busType === 'message.part.updated') {
        const textMatch = TEXT_PART_RE.exec(rest)
        if (textMatch) {
          const text = unescapeJsonString(textMatch[1]).trim()
          if (text.length === 0) continue
          if (isHookNoise(text)) continue // 经验/语言 hook 前缀：剔除
          const mid = MESSAGE_ID_RE.exec(rest)
          const mapped = mid ? msgRoles[mid[1]] : undefined
          let kind
          if (mapped === 'user' || mapped === 'assistant') {
            kind = mapped
          } else {
            // 无映射：注入标记 → user；其余自然语言 → assistant
            kind = looksLikeUserInjection(text) ? 'user' : 'assistant'
          }
          const display = kind === 'user' && text.startsWith('【/goal') ? stripGoalContract(text) : text
          items.push({ time, kind, text: clamp(display) })
          continue
        }
        if (/"type":"tool"/.test(rest)) {
          const toolName = /"tool":"([^"]+)"/.exec(rest)
          items.push({ time, kind: 'tool', text: `工具部件更新${toolName ? `: ${toolName[1]}` : ''}` })
          continue
        }
      }
      // session.status 等运行态 → system（给短标签，不倒原始 JSON）
      if (busType.startsWith('session.')) {
        const short = busType.replace('session.', '会话')
        if (busType === 'session.diff' || busType === 'session.updated') {
          items.push({ time, kind: 'system', text: `${short}（内部状态同步）` })
        } else {
          items.push({ time, kind: 'system', text: clamp(`${short}: ${rest.slice(0, 120)}`) })
        }
      }
      continue
    }

    // ---- tool：tool_request / 文件写入 hook ----
    if (service === 'tool-timing-plugin') {
      const tm = TOOL_REQUEST_RE.exec(rest)
      if (tm) {
        items.push({ time, kind: 'tool', text: `工具执行: ${tm[1]}` })
      }
      continue
    }
    if (service === 'file-write-metadata-hook' && !rest.includes('Hook created')) {
      items.push({ time, kind: 'tool', text: `文件写入: ${rest.slice(0, 160)}` })
      continue
    }

    // ---- system：会话状态/重试/toast 等运行态事件（其余 INFO 噪声跳过） ----
    if (/session\.status|"state":"(busy|idle|retry)"|tui\.toast/.test(rest)) {
      items.push({ time, kind: 'system', text: clamp(`${service}: ${rest.slice(0, 140)}`) })
    }
    // 其余行（启动 INFO、server request 等）不入时间线——只保留可读对话信号
  }
  return items
}

/** 五类 kind 常量（routes 校验/测试用）。 */
export const ACTIVITY_KINDS = ['user', 'assistant', 'tool', 'error', 'system']
