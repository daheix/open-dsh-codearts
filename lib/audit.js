/**
 * dsh-codearts — 审计日志（JSONL 追加写）
 *
 * 所有组件（进程托管 / 目标监督 / 安装管家）共享此审计器：
 * - 每条审计一行 JSON：{ts, component, event, ...extra}
 * - 追加写（appendFileSync）保证顺序；目录不存在则显式创建
 * - 审计写失败绝不静默：stderr 告警 + 计数器（errorCount），状态可查
 */
import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export class AuditLogger {
  /**
   * @param {string} filePath JSONL 文件路径
   * @param {{component?: string, now?: () => number}} [opts]
   */
  constructor(filePath, opts = {}) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new Error('审计日志路径不能为空');
    }
    this.filePath = filePath;
    this.component = opts.component ?? 'dsh-codearts';
    this.now = opts.now ?? Date.now;
    this.errorCount = 0;
    this.lastError = undefined;
    this._ensureDir();
  }

  _ensureDir() {
    try {
      statSync(dirname(this.filePath));
    } catch {
      try {
        mkdirSync(dirname(this.filePath), { recursive: true });
      } catch (error) {
        this._reportError('审计目录创建失败', error);
      }
    }
  }

  _reportError(what, error) {
    this.errorCount += 1;
    this.lastError = `${what}: ${error instanceof Error ? error.message : String(error)}`;
    // 显式告警到 stderr（journal 可见），绝不静默吞掉
    console.error(`[dsh-codearts:audit] ${this.lastError}`);
  }

  /**
   * 追加一条审计事件。
   * @param {string} event 事件名（如 tui.start / goal.inject / install.repair）
   * @param {Record<string, unknown>} [extra] 附加字段
   */
  append(event, extra = {}) {
    const line = JSON.stringify({ ts: new Date(this.now()).toISOString(), component: this.component, event, ...extra });
    try {
      appendFileSync(this.filePath, line + '\n', { encoding: 'utf8' });
    } catch (error) {
      this._reportError(`审计写入失败(${event})`, error);
    }
  }

  /** 审计通道自身健康（供 GET /codearts/status 暴露）。 */
  health() {
    return { filePath: this.filePath, errorCount: this.errorCount, lastError: this.lastError };
  }
}

/** 生成目标 ID：goal-<时间戳>-<随机后缀>（可读 + 唯一）。 */
export function newGoalId(now = Date.now) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `goal-${now()}-${rand}`;
}
