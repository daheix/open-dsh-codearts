/**
 * dsh-codearts — codearts CLI 安装管家
 *
 * 背景（实证缺陷）：厂商自动升级"先改名（bin/codearts→codearts.delete）后部署"，
 * 部署跨 ZFS 数据集 rename 抛 EXDEV 被静默吞 → CLI 丢失。已做防护：
 * autoupdate=false + 备份 codearts.bak-<版本> + 本管家的自愈/受控升级。
 *
 * 零损坏纪律：
 * - 部署一律 copy（禁跨数据集 rename）；升级走 下载→哈希→同数据集暂存→copy 部署→复验→旧版转 bak；
 * - 任何一步失败：清理暂存、现有安装原样保留、显式报错 + 审计。
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { AuditLogger } from './audit.js';

/** 安装管家默认路径。 */
export function defaultInstallConfig() {
  const home = process.env.CODEARTS_HOME ?? join(homedir(), '.codeartsdoer');
  return {
    installRoot: join(home, 'installers'),
    wrapperPath: join(home, 'installers', 'codearts'),
    /** 厂商配置（读 autoupdate 开关） */
    configDir: home,
  };
}

/** sha256 摘要。 */
export function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/**
 * 安装状态探测。
 * 返回 {healthy, binExists, version, backupFiles, autoupdateDisabled, binSha256, drift, detail}
 */
export function probeInstall(cfg = {}) {
  const c = { ...defaultInstallConfig(), ...cfg };
  const binPath = join(c.installRoot, 'bin', 'codearts');
  const binExists = existsSync(binPath);
  let version;
  let binSha256;
  if (binExists) {
    // 版本由二进制自报（--version），失败即显式报错——版本是健康判据不能猜
    const probe = spawnSync(binPath, ['--version'], { encoding: 'utf8', timeout: 30_000 });
    if (probe.status !== 0 || !probe.stdout || probe.stdout.trim().length === 0) {
      throw new Error(`bin/codearts --version 探测失败（exit=${probe.status}）stderr: ${(probe.stderr ?? '').slice(-300)}`);
    }
    version = probe.stdout.trim().split('\n')[0];
    binSha256 = sha256File(binPath);
  }
  // 备份清单：bin/codearts.bak-* 与 installers/codearts.bak-*
  const backupFiles = [];
  const binDir = join(c.installRoot, 'bin');
  if (existsSync(binDir)) {
    for (const f of readdirSync(binDir)) if (f.startsWith('codearts.bak-')) backupFiles.push(join(binDir, f));
  }
  if (existsSync(c.installRoot)) {
    for (const f of readdirSync(c.installRoot)) if (f.startsWith('codearts.bak-')) backupFiles.push(join(c.installRoot, f));
  }
  // autoupdate 开关：wrapper 内 OPENCODE_DISABLE_AUTOUPDATE 实证
  let autoupdateDisabled = null;
  let autoupdateEvidence = null;
  if (existsSync(c.wrapperPath)) {
    const wrapper = readFileSync(c.wrapperPath, 'utf8');
    const m = /^export OPENCODE_DISABLE_AUTOUPDATE="?(true|false)"?$/m.exec(wrapper);
    if (m) {
      autoupdateDisabled = m[1] === 'true';
      autoupdateEvidence = 'wrapper:OPENCODE_DISABLE_AUTOUPDATE';
    }
  }
  // 漂移：bin 与最新备份哈希不一致 → 疑似被厂商升级改写
  let drift = null;
  if (binExists && backupFiles.length > 0) {
    const latest = backupFiles.map((p) => ({ p, m: statSync(p).mtimeMs })).sort((a, b) => b.m - a.m)[0].p;
    const bakSha = sha256File(latest);
    drift = bakSha === binSha256 ? null : { backupFile: latest, backupSha256: bakSha, note: 'bin 与最新备份哈希不一致（可能被自动升级改写或备份过期）' };
  }
  // 残留 .delete（厂商升级失败遗留）
  const deleteLeftovers = [];
  if (existsSync(binDir)) {
    for (const f of readdirSync(binDir)) if (f.startsWith('codearts.delete')) deleteLeftovers.push(join(binDir, f));
  }
  const healthy = binExists && autoupdateDisabled === true && deleteLeftovers.length === 0;
  return {
    healthy,
    binExists,
    binPath,
    version,
    binSha256,
    backupFiles,
    autoupdateDisabled,
    autoupdateEvidence,
    deleteLeftovers,
    drift,
    detail: !binExists
      ? 'bin/codearts 缺失（可能命中厂商升级 EXDEV 缺陷）'
      : autoupdateDisabled === false
        ? 'autoupdate 未禁用（EXDEV 丢 CLI 风险敞口）'
        : deleteLeftovers.length > 0
          ? '存在 .delete 升级残留'
          : '正常',
  };
}

/**
 * 安装管家（实例持有 stateDir 审计）。
 * 文件操作全部可注入 rootOverride（测试 fixture 目录）。
 */
export class InstallManager {
  /** @param {Partial<ReturnType<typeof defaultInstallConfig>>} config
   *  @param {{stateDir: string, now?: () => number, audit?: AuditLogger, fetchFn?: (url: string) => Promise<Buffer>}} opts */
  constructor(config = {}, opts) {
    this.cfg = { ...defaultInstallConfig(), ...config };
    this.stateDir = opts.stateDir;
    this.now = opts.now ?? Date.now;
    this.audit = opts.audit ?? new AuditLogger(join(this.stateDir, 'audit', 'install.jsonl'), { component: 'install-manager', now: this.now });
    // fetchFn 注入（测试）；生产用全局 fetch
    this.fetchFn = opts.fetchFn ?? ((url) => fetch(url).then((r) => {
      if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}: ${url}`);
      return r.arrayBuffer().then((b) => Buffer.from(b));
    }));
  }

  /** 启动自愈：检测"仅剩 .delete / bin 缺失但有备份"自动还原（防 EXDEV 复发）。 */
  autoHeal() {
    const probe = probeInstall(this.cfg);
    if (probe.binExists && probe.deleteLeftovers.length === 0) {
      return { healed: false, reason: '安装完好，无需自愈' };
    }
    if (probe.backupFiles.length === 0) {
      const detail = `自动自愈无法进行：bin ${probe.binExists ? '存在但残留 .delete' : '缺失'} 且没有任何 codearts.bak-* 备份。需人工重新安装。`;
      this.audit.append('install.autoheal.blocked', { detail });
      throw new Error(detail);
    }
    const latest = probe.backupFiles.map((p) => ({ p, m: statSync(p).mtimeMs })).sort((a, b) => b.m - a.m)[0].p;
    const result = this.repairInstall({ fromBackup: latest });
    this.audit.append('install.autoheal', { restoredFrom: latest, removedLeftovers: result.removedLeftovers });
    return { healed: true, restoredFrom: latest, deleteLeftoversRemoved: result.removedLeftovers, result };
  }

  /**
   * 备份自愈：从指定备份 copy 还原 bin/codearts（copyFile，同/跨数据集皆安全）。
   * 还原后复验 --version；失败显式报错（现有状态最多是"缺 CLI"，copy 不会使其更坏）。
   */
  repairInstall(opts = {}) {
    const binPath = join(this.cfg.installRoot, 'bin', 'codearts');
    const from = opts.fromBackup ?? this._latestBackupOrThrow();
    if (!existsSync(from)) throw new Error(`备份文件不存在: ${from}`);
    mkdirSync(join(this.cfg.installRoot, 'bin'), { recursive: true });
    copyFileSync(from, binPath);
    // 复验
    const verify = spawnSync(binPath, ['--version'], { encoding: 'utf8', timeout: 30_000 });
    if (verify.status !== 0 || !verify.stdout?.trim()) {
      const detail = `还原后复验失败（exit=${verify.status}）stderr: ${(verify.stderr ?? '').slice(-300)}`;
      this.audit.append('install.repair.failed', { from, detail });
      throw new Error(detail);
    }
    // 清理 .delete 残留
    const removed = this._removeDeleteLeftovers();
    this.audit.append('install.repair', { from, version: verify.stdout.trim().split('\n')[0], removedLeftovers: removed });
    return { restored: binPath, from, version: verify.stdout.trim().split('\n')[0], removedLeftovers: removed };
  }

  /**
   * 受控升级：下载 → 哈希校验 → 旧版快照转 bak → 同数据集暂存 → copy 部署 → 复验 → 审计。
   * 任何一步失败：从升级前快照回滚 bin、清理暂存、现有安装保持可用、显式抛错。
   * @param {{url: string, expectSha256: string, expectVersion: string}} step
   */
  async guardUpgrade(step) {
    if (typeof step.url !== 'string' || step.url.length === 0) throw new Error('升级需要 url');
    if (!/^[a-f0-9]{64}$/.test(step.expectSha256 ?? '')) throw new Error('升级需要 64 位十六进制 expectSha256（预知哈希，禁信任下载源自述）');
    if (typeof step.expectVersion !== 'string' || step.expectVersion.length === 0) throw new Error('升级需要 expectVersion');
    const binDir = join(this.cfg.installRoot, 'bin');
    const binPath = join(binDir, 'codearts');
    if (!existsSync(binPath)) throw new Error('当前 bin/codearts 缺失，拒绝升级（先 repairInstall/autoHeal）');
    const oldVersion = this._binVersionOrThrow(binPath);
    const oldSha = sha256File(binPath);

    // ① 下载
    const payload = await this.fetchFn(step.url);
    // ② 哈希校验（预知哈希，不信任下载源自述）
    const actualSha = createHash('sha256').update(payload).digest('hex');
    if (actualSha !== step.expectSha256) {
      this.audit.append('install.upgrade.aborted', { stage: 'hash', expect: step.expectSha256, actual: actualSha });
      throw new Error(`下载哈希不匹配，已中止（expect=${step.expectSha256} actual=${actualSha}），现有安装未动`);
    }

    // ③ 旧版快照转 bak（必须在覆盖前 copy——覆盖后旧内容就不在了）
    const bakPath = join(binDir, `codearts.bak-${oldVersion}`);
    copyFileSync(binPath, bakPath);

    // ④ 同数据集暂存（binDir 内 .staging-*，与部署目标同一文件系统 → 从根上规避 EXDEV）
    mkdirSync(binDir, { recursive: true });
    const staging = join(binDir, `codearts.staging-${this.now()}`);
    writeFileSync(staging, payload, { mode: 0o755 });

    try {
      // ⑤ copy 部署（copy 语义，禁跨数据集 rename）
      copyFileSync(staging, binPath);
      // ⑥ 复验：版本自报一致 + 部署后哈希一致
      const verifyVersion = this._binVersionOrThrow(binPath);
      if (verifyVersion !== step.expectVersion) {
        throw new Error(`升级复验失败：版本 ${verifyVersion} ≠ 期望 ${step.expectVersion}`);
      }
      if (sha256File(binPath) !== actualSha) throw new Error('升级复验失败：部署后哈希漂移');
    } catch (error) {
      // ⑤/⑥ 任一失败 → 回滚到升级前快照，保证零损坏
      try {
        copyFileSync(bakPath, binPath);
        const rollbackSha = sha256File(binPath);
        if (rollbackSha !== oldSha) throw new Error(`回滚后哈希仍不一致（${rollbackSha} ≠ ${oldSha}）`);
        this.audit.append('install.upgrade.rolled_back', { reason: String(error), oldVersion });
      } catch (rollbackError) {
        this.audit.append('install.upgrade.rollback_failed', { error: String(rollbackError) });
      }
      try { rmSync(staging, { force: true }); } catch (cleanupError) {
        this.audit.append('install.upgrade.staging_cleanup_failed', { staging, error: String(cleanupError) });
      }
      this.audit.append('install.upgrade.failed', { error: String(error) });
      throw error;
    }
    // ⑦ 成功收尾：清暂存 + 审计
    try { rmSync(staging, { force: true }); } catch (cleanupError) {
      this.audit.append('install.upgrade.staging_cleanup_failed', { staging, error: String(cleanupError) });
    }
    this._removeDeleteLeftovers();
    this.audit.append('install.upgrade', { from: oldVersion, to: step.expectVersion, sha256: actualSha, backup: bakPath });
    return { from: oldVersion, to: step.expectVersion, sha256: actualSha, backup: bakPath };
  }

  _binVersionOrThrow(binPath) {
    const probe = spawnSync(binPath, ['--version'], { encoding: 'utf8', timeout: 30_000 });
    if (probe.status !== 0 || !probe.stdout?.trim()) {
      throw new Error(`bin --version 探测失败（exit=${probe.status}）stderr: ${(probe.stderr ?? '').slice(-300)}`);
    }
    return probe.stdout.trim().split('\n')[0];
  }

  _latestBackupOrThrow() {
    const binDir = join(this.cfg.installRoot, 'bin');
    const candidates = [];
    if (existsSync(binDir)) {
      for (const f of readdirSync(binDir)) if (f.startsWith('codearts.bak-')) candidates.push(join(binDir, f));
    }
    if (candidates.length === 0) throw new Error('没有任何 codearts.bak-* 备份，拒绝操作（零损坏纪律：无备份不动 bin）');
    return candidates.map((p) => ({ p, m: statSync(p).mtimeMs })).sort((a, b) => b.m - a.m)[0].p;
  }

  _removeDeleteLeftovers() {
    const binDir = join(this.cfg.installRoot, 'bin');
    const removed = [];
    if (existsSync(binDir)) {
      for (const f of readdirSync(binDir)) {
        if (f.startsWith('codearts.delete')) {
          rmSync(join(binDir, f), { force: true });
          removed.push(f);
        }
      }
    }
    return removed;
  }
}
