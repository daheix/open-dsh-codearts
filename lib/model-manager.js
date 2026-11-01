/**
 * dsh-codearts — 码道模型管理器
 *
 * 机制事实（2026-10-31 实证）：
 * - 码道模型选择状态：<codeartsHome>/state/model.json，结构
 *   {recent:[{providerID,modelID}...], favorite:[], variant:{}}；recent[0]=TUI 最近选中。
 * - 码道全局配置：<codeartsHome>/codearts_cli.json（JSONC 带注释，wrapper 的
 *   OPENCODE_CONFIG 指向它）。顶层加 "model": "providerID/modelID" 是内核官方的
 *   新会话默认模型配置方式（opencode 同源机制）。provider.*.options.apiKey 为
 *   enc:v3 加密值——本模块【只增改顶层 model 键，绝不触碰 provider 结构】。
 * - 无头 `codearts models` 需 AK/SK（用户未配置）→ 完整内置模型清单拿不到，
 *   如实作为限制记录（见 REPORT）。
 *
 * setModel 零半写纪律：
 *   校验 → 双文件备份(.bak-<ts>) → JSONC 字符串级插入/改写顶层 model 键
 *   （注释/键序/其余内容逐字保留）→ 语义 diff 验证（剥离注释后 JSON.parse，
 *   除 model 键外全部深相等）→ 原子写(tmp+rename) → model.json recent 置顶
 *   （同备份原子纪律）→ 审计。任一步失败显式抛错，目标文件保持原样。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { AuditLogger } from './audit.js';

/**
 * 内置华为 MaaS 模型候选清单（供"完整模型列表"展示与快速添加）。
 *
 * Why 硬编码候选而非动态拉取：无头 `codearts models` 需 AK/SK（用户未配置），
 * 完整清单无法动态获得。本清单覆盖华为 MaaS 常见型号，用户始终可用 addCustom()
 * 自由添加任意 providerID/modelID（清单不代表全部可用，以 TUI 实际可选为准）。
 */
export const HUAWEI_MAAS_CATALOG = [
  { providerID: 'huaweicloud-maas', modelID: 'deepseek-v4.1-flash-1017' },
  { providerID: 'huaweicloud-maas', modelID: 'deepseek-v4.1-flash' },
  { providerID: 'huaweicloud-maas', modelID: 'glm-5.3' },
  { providerID: 'huaweicloud-maas', modelID: 'GLM-5.2' },
  { providerID: 'huaweicloud-maas', modelID: 'kimi-k3' },
  { providerID: 'huaweicloud-maas', modelID: 'deepseek-v3.2' },
  { providerID: 'huaweicloud-maas', modelID: 'qwen3-max' },
  { providerID: 'huaweicloud-maas', modelID: 'qwen3-coder' },
  { providerID: 'huaweicloud-maas', modelID: 'yi-lightning' },
].map((m) => ({ ...m, id: `${m.providerID}/${m.modelID}` }));

/** model.json / 全局配置路径（codeartsHome 可注入做沙箱测试）。 */
export function defaultModelConfig(codeartsHome = process.env.CODEARTS_HOME ?? join(homedir(), '.codeartsdoer')) {
  return {
    codeartsHome,
    modelStatePath: join(codeartsHome, 'state', 'model.json'),
    configPath: join(codeartsHome, 'codearts_cli.json'),
  };
}

/** providerID/modelID 合法性：非空、无空白、无引号、无控制字符（防止注入 JSON 字面量）。 */
export function validateModelId(providerID, modelID) {
  const re = /^[A-Za-z0-9_.-]+$/;
  if (typeof providerID !== 'string' || !re.test(providerID)) {
    throw new Error(`providerID 非法（须匹配 ${re}）：${JSON.stringify(providerID)}`);
  }
  if (typeof modelID !== 'string' || !re.test(modelID)) {
    throw new Error(`modelID 非法（须匹配 ${re}）：${JSON.stringify(modelID)}`);
  }
  return `${providerID}/${modelID}`;
}

/** 跳过空白与两种注释，返回下一个有效字符下标。 */
function skipWsComments(text, i) {
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i += 1; continue; }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1; i += 2; continue; }
    break;
  }
  return i;
}

/** 剥离 JSONC 注释（保留字符串字面量内的 // 与slash-star）。 */
export function stripJsoncComments(text) {
  let out = '';
  let i = 0;
  let inString = false;
  let escaped = false;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      i += 1;
      continue;
    }
    if (c === '"') { inString = true; escaped = false; out += c; i += 1; continue; }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** 宽松 JSONC 解析（剥注释 + 剥尾逗号），失败显式抛错。 */
export function parseJsonc(text, label) {
  const stripped = stripJsoncComments(text).replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(stripped);
  } catch (error) {
    throw new Error(`${label} 不是合法 JSONC（剥离注释后 JSON.parse 失败: ${error.message}）`);
  }
}

/**
 * 扫描 JSONC 根对象：定位根 { 与顶层 "model" 键（单遍状态机，注释/字符串内字符不参与结构）。
 * @returns {{rootStart: number, rootEnd: number, isEmptyObject: boolean,
 *            modelKey: {valueStart: number, valueEnd: number, value: string} | null}}
 *   valueStart/valueEnd 为字符串字面量的引号位置（含引号区间 [valueStart, valueEnd]）。
 */
export function scanRootModelKey(text) {
  const rootStart = skipWsComments(text, 0);
  if (rootStart >= text.length || text[rootStart] !== '{') {
    throw new Error('JSONC 顶层不是对象（未找到根 {）');
  }
  let i = rootStart + 1;
  let depth = 1; // 根对象 { 已消费：其直接子成员处于深度 1
  let inString = false;
  let escaped = false;
  let strStart = -1;
  let phase = 'key'; // 深度 1 的读取相位：key → colon → value
  let pendingKey = null;
  /** @type {{valueStart: number, valueEnd: number, value: string} | null} */
  let modelKey = null;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') {
        inString = false;
        const value = text.slice(strStart + 1, i);
        if (depth === 1 && phase === 'key') {
          pendingKey = value;
          phase = 'colon';
        } else if (depth === 1 && phase === 'value' && pendingKey === 'model') {
          modelKey = { valueStart: strStart, valueEnd: i, value };
        }
      }
      i += 1;
      continue;
    }
    if (c === '"') { inString = true; escaped = false; strStart = i; i += 1; continue; }
    if (c === '/' && text[i + 1] === '/') { i = skipWsComments(text, i); continue; }
    if (c === '/' && text[i + 1] === '*') { i = skipWsComments(text, i); continue; }
    if (c === '{' || c === '[') {
      depth += 1;
      if (depth >= 2 && phase === 'value' && pendingKey !== 'model') {
        // 进入嵌套结构：该值不是顶层标量，其字符串成员一律不捕获
        phase = 'nested';
      }
      i += 1;
      continue;
    }
    if (c === '}' ) {
      if (depth === 1) {
        // 根对象收尾
        const isEmptyObject = pendingKey === null && modelKey === null;
        return { rootStart, rootEnd: i, isEmptyObject, modelKey };
      }
      depth -= 1;
      if (depth === 1 && phase === 'nested') phase = 'key';
      i += 1;
      continue;
    }
    if (c === ']') {
      depth -= 1;
      if (depth === 1 && phase === 'nested') phase = 'key';
      i += 1;
      continue;
    }
    if (c === ':' && depth === 1 && phase === 'colon') { phase = 'value'; i += 1; continue; }
    if (c === ',' && depth === 1) {
      if (phase === 'value' && pendingKey === 'model' && modelKey === null) {
        throw new Error('顶层 model 键的值不是字符串字面量，拒绝字符串级改写');
      }
      pendingKey = null;
      phase = 'key';
      i += 1;
      continue;
    }
    i += 1;
  }
  throw new Error('JSONC 根对象未收口（缺少匹配的 }）');
}

/**
 * 在 JSONC 文本上字符串级设置顶层 model 键（其余内容逐字保留）。
 * @returns {string} 修改后的全文
 */
export function setModelKeyInJsonc(text, modelValue) {
  const { rootStart, rootEnd, isEmptyObject, modelKey } = scanRootModelKey(text);
  if (modelKey !== null) {
    // 已有顶层 model 键：原地替换字符串值内容（引号保留）
    return text.slice(0, modelKey.valueStart + 1) + modelValue + text.slice(modelKey.valueEnd);
  }
  if (isEmptyObject) {
    // 空根对象：无尾逗号插入
    return text.slice(0, rootEnd) + `"model": "${modelValue}"` + text.slice(rootEnd);
  }
  // 非空且无 model 键：紧贴根 { 之后插入 `"model": "x",`（后随原有首键/注释，均合法 JSONC）
  return text.slice(0, rootStart + 1) + ` "model": "${modelValue}",` + text.slice(rootStart + 1);
}

/** 语义 diff 验证：除 model 键外，其余内容解析后必须深相等，且 model 值正确。 */
export function verifyOnlyModelChanged(beforeText, afterText, expectModel) {
  const before = parseJsonc(beforeText, '改写前配置');
  const after = parseJsonc(afterText, '改写后配置');
  const { model: _beforeModel, ...restBefore } = before;
  const { model: _afterModel, ...restAfter } = after;
  if (JSON.stringify(restBefore) !== JSON.stringify(restAfter)) {
    throw new Error('语义 diff 验证失败：model 键之外的内容发生了变化，拒绝写入（防止破坏 provider/apiKey/注释结构）');
  }
  if (after.model !== expectModel) {
    throw new Error(`语义 diff 验证失败：model 键值 ${JSON.stringify(after.model)} ≠ 期望 ${JSON.stringify(expectModel)}`);
  }
}

/** 原子写文本（同目录 tmp + rename，零半写）。 */
function atomicWriteText(filePath, text) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, filePath);
}

/** 带时间戳备份（copy 语义）。 */
function backupFile(filePath, nowMs) {
  if (!existsSync(filePath)) return undefined;
  const bak = `${filePath}.bak-${nowMs}`;
  copyFileSync(filePath, bak);
  return bak;
}

/**
 * 模型管理器（单例由 index.js 持有；路径可注入做沙箱测试）。
 */
export class ModelManager {
  /** @param {Partial<ReturnType<typeof defaultModelConfig>>} config
   *  @param {{audit?: AuditLogger, now?: () => number, stateDir?: string}} [opts] */
  constructor(config = {}, opts = {}) {
    const merged = { ...defaultModelConfig(), ...config };
    // 沙箱隔离铁律：注入 codeartsHome 而未显式注入派生路径时，路径必须随注入的 home 重派生。
    // （否则测试/多环境会把 model 键写进真实 ~/.codeartsdoer —— 2026-10-31 事故根因，已修复并回滚现场）
    if (config.codeartsHome !== undefined && config.modelStatePath === undefined) {
      merged.modelStatePath = join(config.codeartsHome, 'state', 'model.json');
    }
    if (config.codeartsHome !== undefined && config.configPath === undefined) {
      merged.configPath = join(config.codeartsHome, 'codearts_cli.json');
    }
    this.cfg = merged;
    this.now = opts.now ?? Date.now;
    const stateDir = opts.stateDir ?? process.env.DSH_CODEARTS_STATE_DIR ?? join(homedir(), '.dsh-codearts');
    this.audit = opts.audit ?? new AuditLogger(join(stateDir, 'audit', 'model.jsonl'), { component: 'model-manager', now: this.now });
  }

  /** 读 model.json（不存在/损坏显式报错——选择状态是切换链路的依据，不能猜）。 */
  _readModelState() {
    if (!existsSync(this.cfg.modelStatePath)) {
      throw new Error(`model.json 不存在: ${this.cfg.modelStatePath}（先在 TUI 里选择过一次模型才会生成）`);
    }
    const obj = parseJsonc(readFileSync(this.cfg.modelStatePath, 'utf8'), 'model.json');
    if (!Array.isArray(obj.recent)) throw new Error('model.json 结构非法：缺少 recent 数组');
    return obj;
  }

  /** 读全局配置（不存在视为空对象——首次配置允许只有 model 键）。 */
  _readConfig() {
    if (!existsSync(this.cfg.configPath)) {
      return { text: '{}', obj: {} };
    }
    const text = readFileSync(this.cfg.configPath, 'utf8');
    return { text, obj: parseJsonc(text, '全局配置') };
  }

  /**
   * 模型清单：{recent, favorite, configured}（model.json 与全局配置合并视角）。
   * 完整内置清单需 AK/SK 的 `codearts models`（未配置），如实不含。
   */
  listModels() {
    const state = this._readModelState();
    const { obj: config } = this._readConfig();
    return {
      recent: state.recent.map((r) => ({ providerID: r.providerID, modelID: r.modelID, id: `${r.providerID}/${r.modelID}` })),
      favorite: (state.favorite ?? []).map((r) => ({ providerID: r.providerID, modelID: r.modelID, id: `${r.providerID}/${r.modelID}` })),
      configured: typeof config.model === 'string' ? config.model : null,
      note: '完整内置模型清单需 AK/SK（codearts models），未配置故不含；huaweicloud-maas/* 即华为 MaaS 模型',
      builtin: HUAWEI_MAAS_CATALOG,
      custom: this.listCustom(),
    };
  }

  /** 自定义模型清单文件路径（与 model.json 同域：codeartsHome 下，沙箱注入随 home 重派生）。 */
  get customFile() {
    return join(this.cfg.codeartsHome, 'custom-models.json');
  }

  /** 读取自定义模型清单（文件不存在返回空数组）。 */
  listCustom() {
    try {
      const arr = JSON.parse(readFileSync(this.customFile, 'utf8'));
      if (!Array.isArray(arr)) throw new Error('custom-models.json 结构非法');
      return arr;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  /** 添加自定义模型（非空校验 + 去重 + 原子写 0600）。 */
  addCustom(providerID, modelID) {
    if (typeof providerID !== 'string' || providerID.length === 0) throw new Error('providerID 不能为空');
    if (typeof modelID !== 'string' || modelID.length === 0) throw new Error('modelID 不能为空');
    const list = this.listCustom();
    const entry = { providerID, modelID, id: `${providerID}/${modelID}` };
    if (list.some((m) => m.id === entry.id)) return { added: false, list };
    list.push(entry);
    const tmp = `${this.customFile}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.customFile);
    this.audit.append('model.custom.add', { id: entry.id });
    return { added: true, list };
  }

  /** 移除自定义模型。 */
  removeCustom(providerID, modelID) {
    const list = this.listCustom();
    const id = `${providerID}/${modelID}`;
    const next = list.filter((m) => m.id !== id);
    const tmp = `${this.customFile}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.customFile);
    this.audit.append('model.custom.remove', { id, removed: next.length < list.length });
    return { removed: next.length < list.length, list: next };
  }

  /** 当前模型：recent[0]（TUI 最近选中）优先，其次全局配置 model 键；都无则显式报错。 */
  getCurrentModel() {
    const state = this._readModelState();
    if (state.recent.length > 0) {
      const top = state.recent[0];
      return { id: `${top.providerID}/${top.modelID}`, providerID: top.providerID, modelID: top.modelID, source: 'recent[0]' };
    }
    const { obj: config } = this._readConfig();
    if (typeof config.model === 'string') {
      const slash = config.model.indexOf('/');
      return { id: config.model, providerID: config.model.slice(0, slash), modelID: config.model.slice(slash + 1), source: 'config.model' };
    }
    throw new Error('当前没有任何已选模型（model.json.recent 为空且全局配置无 model 键）');
  }

  /**
   * 切换默认模型：
   * ① 校验 → ② 备份两文件(.bak-<ts>) → ③ JSONC 字符串级改写 config 顶层 model 键
   * → ④ 语义 diff 验证 → ⑤ 原子写 config → ⑥ model.json recent 置顶（去重，原子写）
   * → ⑦ 审计。任一步失败显式抛错，不留半写状态。
   * @returns {{model: string, configBackup?: string, stateBackup?: string}}
   */
  setModel(providerID, modelID) {
    const modelValue = validateModelId(providerID, modelID);
    const ts = this.now();
    // ② 备份（先于任何改写）
    const configBackup = backupFile(this.cfg.configPath, ts);
    const stateBackup = backupFile(this.cfg.modelStatePath, ts);
    // ③④ 字符串级改写 + 验证（失败即抛，不落盘）
    const { text: beforeText } = this._readConfig();
    const afterText = setModelKeyInJsonc(beforeText, modelValue);
    verifyOnlyModelChanged(beforeText, afterText, modelValue);
    // ⑤ 原子写 config
    atomicWriteText(this.cfg.configPath, afterText);
    // ⑥ model.json recent 置顶（去重；重序列化自检后原子写）
    const state = this._readModelState();
    state.recent = [{ providerID, modelID }, ...state.recent.filter((r) => !(r.providerID === providerID && r.modelID === modelID))];
    const stateText = JSON.stringify(state, null, 2);
    parseJsonc(stateText, '重序列化 model.json 自检');
    atomicWriteText(this.cfg.modelStatePath, stateText);
    // ⑦ 审计
    this.audit.append('model.set', { model: modelValue, configBackup, stateBackup });
    return { model: modelValue, configBackup, stateBackup };
  }
}
