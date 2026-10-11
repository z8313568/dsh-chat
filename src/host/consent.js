/**
 * 授权门（规划 §2.4、§6.1、§7.2、§12.2）。
 *
 * 这是整个插件里最重要的一个模块。规划把「分享必须明确授权」列为四大设计原则之一，
 * 而现实约束是：**会话内容外发没有任何产品级 gate**（插件一旦订阅 session/event
 * 就拿到了全部内容）。所以同意机制必须由插件自己实现，而且要 fail-closed。
 *
 * 三条不可协商的规则：
 *   1. 默认拒绝。没有一条由用户显式创建的授权记录，就什么都不外发。
 *   2. 授权不跨进程继承。重启后所有会话回到未授权状态——宁可让用户再点一次，
 *      也不要在用户不知情时恢复上一轮的广播。
 *   3. 授权是「会话 × 内容类型 × 范围 × 有效期」四元组，不是全局开关。
 *      关掉直播不会顺手关掉分享，反之亦然，因为它们是不同的用户意图。
 */
import { randomUUID } from 'node:crypto';

import {
  ACCESS_SCOPE,
  CONTENT_KINDS,
  SHARING_MODE,
  SHARING_MODE_CONTENT,
  isAccessScope,
  isSharingMode,
} from '../shared/protocol.js';

/** 授权不存在、已过期、粒度不够、内容类型未勾选——都归到这里。 */
export class ConsentError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'ConsentError';
    this.code = 'dsh-chat/not-authorized';
    this.detail = detail;
  }
}

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000; // 12 小时：够一场长直播，又不至于忘到明天

/** 范围从最严到最松，用于「不能比授权更宽」的比较。 */
const ACCESS_SCOPE_ORDER = [
  ACCESS_SCOPE.SELF,
  ACCESS_SCOPE.FRIENDS,
  ACCESS_SCOPE.GROUP,
  ACCESS_SCOPE.LINK,
  ACCESS_SCOPE.PUBLIC,
];

/**
 * 授权登记表。
 *
 * 注意：这里**不读盘恢复**。见类注释规则 2。审计日志会落盘，但授权本身只在内存里。
 */
export class ConsentGate {
  #config;
  #logger;
  #grants = new Map(); // sessionId -> grant
  #listeners = new Set();
  #audit;
  #denials = new Map(); // sessionId -> 计数，用于节流审计噪音

  constructor({ config, logger = null, auditLog = null } = {}) {
    this.#config = config;
    this.#logger = logger;
    this.#audit = auditLog;
  }

  /** 订阅授权变化，界面据此刷新。 */
  onChange(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit() {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (error) {
        this.#logger?.warn?.('授权变化监听器抛错', { message: error?.message });
      }
    }
  }

  #record(action, detail) {
    this.#audit?.append?.({
      at: new Date().toISOString(),
      action,
      ...detail,
    });
  }

  /** 用户显式授权一个会话可以按某个粒度外发。 */
  authorize(sessionId, {
    mode = null,
    contentKinds = null,
    scope = ACCESS_SCOPE.PUBLIC,
    ttlMs = DEFAULT_TTL_MS,
    previewed = false,
    reason = 'user-action',
  } = {}) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new TypeError('authorize 需要 sessionId');
    }
    const effectiveMode = mode ?? this.#config.privacy.defaultSharingMode;
    if (!isSharingMode(effectiveMode)) throw new TypeError(`未知外发粒度: ${effectiveMode}`);
    if (!isAccessScope(scope)) throw new TypeError(`未知访问范围: ${scope}`);

    // 规划 §7.2：开播前提供预览。预览不是 UI 建议，是硬前置。
    if (this.#config.live.requirePreview && previewed !== true) {
      throw new ConsentError('开播/分享前必须先过内容预览', { sessionId, reason: 'preview-required' });
    }
    if (effectiveMode === SHARING_MODE.DISABLED) {
      throw new ConsentError('外发粒度为「关闭」时无法授权', { sessionId, reason: 'mode-disabled' });
    }

    const allowedByMode = SHARING_MODE_CONTENT[effectiveMode];
    const requested = contentKinds === null
      ? allowedByMode
      : contentKinds.filter((kind) => CONTENT_KINDS.includes(kind));

    // 粒度上限永远压在用户勾选之上：用户不可能通过勾选绕过粒度。
    const effectiveKinds = requested.filter((kind) => allowedByMode.includes(kind));
    if (effectiveKinds.length === 0) {
      throw new ConsentError('授权的内容类型为空；该粒度下没有任何可外发内容', {
        sessionId, mode: effectiveMode, requested,
      });
    }

    const now = Date.now();
    const grant = Object.freeze({
      id: randomUUID(),
      sessionId,
      mode: effectiveMode,
      contentKinds: Object.freeze([...effectiveKinds]),
      scope,
      authorizedAt: now,
      expiresAt: ttlMs > 0 ? now + ttlMs : null,
      previewed: true,
      reason,
    });
    this.#grants.set(sessionId, grant);
    this.#denials.delete(sessionId);
    this.#record('authorize', {
      sessionId, mode: grant.mode, scope: grant.scope, contentKinds: grant.contentKinds,
      expiresAt: grant.expiresAt ? new Date(grant.expiresAt).toISOString() : null,
    });
    this.#logger?.info?.('会话已授权外发', {
      sessionId, mode: grant.mode, scope: grant.scope, kinds: grant.contentKinds.join(','),
    });
    this.#emit();
    return grant;
  }

  /** 撤销授权。规划 §7.7：一键暂停广播必须真的立刻停。 */
  revoke(sessionId, reason = 'user-action') {
    const existing = this.#grants.get(sessionId);
    if (!existing) return false;
    this.#grants.delete(sessionId);
    this.#record('revoke', { sessionId, reason, grantedAt: new Date(existing.authorizedAt).toISOString() });
    this.#logger?.info?.('会话授权已撤销', { sessionId, reason });
    this.#emit();
    return true;
  }

  /** 撤销全部授权（规划 §9.2「一键暂停所有节点贡献」）。 */
  revokeAll(reason = 'user-action') {
    const ids = [...this.#grants.keys()];
    for (const sessionId of ids) this.revoke(sessionId, reason);
    return ids.length;
  }

  /** 取当前生效的授权；过期即视为不存在（并顺手清掉）。 */
  grantFor(sessionId) {
    const grant = this.#grants.get(sessionId);
    if (!grant) return null;
    if (grant.expiresAt !== null && grant.expiresAt <= Date.now()) {
      this.revoke(sessionId, 'expired');
      return null;
    }
    return grant;
  }

  isAuthorized(sessionId) {
    return this.grantFor(sessionId) !== null;
  }

  /** 所有生效中的授权（界面「直播管理」「我的分享」用它渲染）。 */
  listGrants() {
    const out = [];
    for (const sessionId of [...this.#grants.keys()]) {
      const grant = this.grantFor(sessionId);
      if (grant) out.push(grant);
    }
    return out;
  }

  /**
   * 判断某条内容能不能出去。这是唯一的判定入口。
   * @returns {{allowed: boolean, reason?: string, grant?: object}}
   */
  check(sessionId, contentKind, { scope = null } = {}) {
    if (!CONTENT_KINDS.includes(contentKind)) {
      return { allowed: false, reason: 'unknown-content-kind' };
    }
    const grant = this.grantFor(sessionId);
    if (!grant) return { allowed: false, reason: 'no-grant' };

    if (!grant.contentKinds.includes(contentKind)) {
      this.#noteDenial(sessionId, 'content-kind-not-selected');
      return { allowed: false, reason: 'content-kind-not-selected', grant };
    }
    // 调用方想用更宽的范围发送时，取两者中更严的那个。
    if (scope !== null && ACCESS_SCOPE_ORDER.indexOf(scope) > ACCESS_SCOPE_ORDER.indexOf(grant.scope)) {
      this.#noteDenial(sessionId, 'scope-exceeds-grant');
      return { allowed: false, reason: 'scope-exceeds-grant', grant };
    }
    return { allowed: true, grant };
  }

  /** check 的抛错版本，供外发路径使用。 */
  assert(sessionId, contentKind, options = {}) {
    const verdict = this.check(sessionId, contentKind, options);
    if (verdict.allowed) return verdict.grant;
    throw new ConsentError('该内容未获授权外发', {
      sessionId, contentKind, reason: verdict.reason,
      hint: '请在 dsh-chat 界面中对该会话显式开启分享或直播',
    });
  }

  /** 该粒度允许的全部内容类型，界面用它决定勾选框的可选项。 */
  allowedKindsFor(sessionId) {
    const grant = this.grantFor(sessionId);
    if (grant) return grant.contentKinds;
    return SHARING_MODE_CONTENT[this.#config.privacy.defaultSharingMode] ?? [];
  }

  /**
   * 拒绝是有信息量的，但刷屏的拒绝日志没有用。
   * 每个会话每种原因只记一次，之后只累加计数。
   */
  #noteDenial(sessionId, reason) {
    const key = `${sessionId}:${reason}`;
    const seen = this.#denials.get(key) ?? 0;
    this.#denials.set(key, seen + 1);
    if (seen === 0) this.#record('deny', { sessionId, reason });
  }

  /** 供界面展示的摘要。 */
  summary() {
    const grants = this.listGrants();
    return {
      activeGrants: grants.length,
      defaultSharingMode: this.#config.privacy.defaultSharingMode,
      sessions: grants.map((grant) => ({
        sessionId: grant.sessionId,
        mode: grant.mode,
        scope: grant.scope,
        contentKinds: [...grant.contentKinds],
        authorizedAt: new Date(grant.authorizedAt).toISOString(),
        expiresAt: grant.expiresAt ? new Date(grant.expiresAt).toISOString() : null,
      })),
    };
  }
}

/** 范围从最严到最松，用于「不能比授权更宽」的比较。 */
export { ACCESS_SCOPE_ORDER, DEFAULT_TTL_MS };
