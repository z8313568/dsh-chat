/**
 * 本地存储层（规划 §11.1「个人私密会话默认保存在用户本地」）。
 *
 * 全部落在 <数据目录>/ 下，默认 `~/.dsh/dsh-chat/`（与 dsh-pocket 用 `~/.dsh/dsh-pocket/`、
 * dsh-im 用 `~/.dsh/im/` 的既有约定一致）。可以用环境变量 DSH_CHAT_DATA_DIR 覆盖，
 * 测试就是靠它把两个节点塞进不同的临时目录。
 *
 * 写盘策略：先写同目录临时文件再 rename。rename 在同一文件系统内是原子的，
 * 因此进程被杀死也不会留下被截断的半个 JSON——这对身份密钥尤其重要。
 */
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** 解析数据目录。优先级：显式参数 > 环境变量 > ~/.dsh/dsh-chat。 */
export function resolveDataDir(explicit) {
  const candidate = explicit
    ?? process.env.DSH_CHAT_DATA_DIR
    ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-chat');
  return resolve(candidate);
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * 原子写一个文件。
 * @param {string} file 目标路径
 * @param {string} contents 内容
 * @param {{mode?: number}} [options] mode 默认 0600——里面可能存私钥。
 */
export function atomicWrite(file, contents, options = {}) {
  const mode = options.mode ?? 0o600;
  ensureDir(dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, contents, { mode });
  try {
    renameSync(tmp, file);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* 清理失败不掩盖原始错误 */ }
    throw error;
  }
  try { chmodSync(file, mode); } catch { /* 某些文件系统不支持，忽略 */ }
  return file;
}

export function readJsonFile(file, fallback = undefined) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`无法解析 ${file}: ${error.message}`, { cause: error });
  }
}

export function writeJsonFile(file, value, options = {}) {
  return atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`, options);
}

/**
 * 一个「读一次、之后常驻内存、写回原子」的小型 JSON 文档。
 * 适合身份、资料、设置这类低频写入的小对象。
 */
export class JsonDocument {
  #file;
  #mode;
  #value;
  #loaded = false;

  constructor(file, { fallback = null, mode = 0o600 } = {}) {
    this.#file = file;
    this.#mode = mode;
    this.fallback = fallback;
  }

  get path() {
    return this.#file;
  }

  get exists() {
    return existsSync(this.#file);
  }

  read() {
    if (!this.#loaded) {
      this.#value = readJsonFile(this.#file, this.fallback);
      this.#loaded = true;
    }
    return this.#value;
  }

  write(value) {
    this.#value = value;
    this.#loaded = true;
    writeJsonFile(this.#file, value, { mode: this.#mode });
    return value;
  }

  /** 读—改—写；mutator 返回 undefined 时保留原值。 */
  update(mutator) {
    const next = mutator(this.read());
    return next === undefined ? this.read() : this.write(next);
  }
}

/**
 * 只追加的 JSONL 日志。
 *
 * 为什么不用 JSON 数组：分享对象、直播事件、收到的消息都是只增长的，
 * 每次重写整个数组在长会话下会变成 O(n²) 的写放大。
 * JSONL 追加是 O(1)，且进程崩溃最多丢掉最后一行（读取时按行解析并跳过坏行）。
 */
export class JsonlLog {
  #file;
  #maxBytes;

  constructor(file, { maxBytes = 8 * 1024 * 1024 } = {}) {
    this.#file = file;
    this.#maxBytes = maxBytes;
  }

  get path() {
    return this.#file;
  }

  append(record) {
    ensureDir(dirname(this.#file));
    appendFileSync(this.#file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return record;
  }

  /** 读取全部记录；坏行跳过并计数，不因为一行损坏丢掉整个文件。 */
  readAll({ limit = Infinity } = {}) {
    if (!existsSync(this.#file)) return [];
    const text = readFileSync(this.#file, 'utf8');
    const out = [];
    let skipped = 0;
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        skipped += 1;
      }
    }
    const sliced = Number.isFinite(limit) && out.length > limit ? out.slice(-limit) : out;
    return sliced;
  }

  get maxBytes() {
    return this.#maxBytes;
  }

  get bytes() {
    return existsSync(this.#file) ? readFileSync(this.#file).length : 0;
  }

  /** 超过上限时把文件重写为后一半记录。返回是否发生了裁剪。 */
  compactIfNeeded() {
    if (this.bytes <= this.#maxBytes) return false;
    const all = this.readAll();
    const keep = all.slice(Math.floor(all.length / 2));
    atomicWrite(this.#file, keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''));
    return true;
  }
}
