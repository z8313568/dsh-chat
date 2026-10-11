/**
 * dsh-chat Client 半体入口。
 *
 * 注册点（全部用 `ctx.slots.inject(ownerKey, () => ctx.slots.register(...))` 的官方姿势，
 * 这样 slot 声明收起时注册会被自动撤销、恢复时会自动重装）：
 *
 *   1. `main`（keyed，key = 'dsh-chat'）—— 整个 dsh-chat 主面板；
 *   2. `sidebar.panellist` —— 左侧全局面板图标，点一下切到主面板；
 *   3. `conversation.session.header.actions` —— 会话标题旁的「分享会话」「开启直播」
 *      （规划 §3.2 要求的两个快捷入口）；
 *   4. `conversation.input.dock` —— 会话内直播状态条，开播时在输入框上方提示状态；
 *   5. `shell.overlay` —— 三个对话框的**唯一**宿主（常驻，见 dialog-host.js）。
 *
 * 关于 3 和 5 的分工，这里踩过一次坑：会话页的按钮**不自己渲染对话框**，
 * 因为它所在的 conversation 子树会被"切主面板"这个动作卸载，
 * 对话框会跟着一起消失（用户看到"跳到面板了但什么都没发生"）。
 * 所以按钮只写意图，对话框由 shell.overlay 上的常驻宿主渲染。
 */
import { DshChatApp, SessionEntry } from './app.js';
import { NS, createLocalTranslator, en, zh } from './i18n.js';
import { Badge, h, useEffect, useState } from './kit.js';
import { createHostClient } from './rpc.js';
import { DialogHost } from './dialog-host.js';
import { intentStore } from './intent.js';
import { STYLES } from './styles.js';

export const name = 'dsh-chat';
export const inject = ['slots', 'connection'];

const PANEL_ID = 'dsh-chat';
const STYLE_ID = 'dsh-chat';

/** 插入样式表。官方第三方插件的既有做法：带 data-plugin 标记的 <style>。 */
function installStyles() {
  if (typeof document === 'undefined') return () => {};
  const existing = document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`);
  if (existing) return () => {};
  const style = document.createElement('style');
  style.dataset.plugin = 'dsh-chat';
  style.dataset.pluginCss = STYLE_ID;
  style.textContent = STYLES;
  document.head.appendChild(style);
  return () => style.remove();
}

export function apply(ctx) {
  // --- 文案 ---
  let t = createLocalTranslator();
  ctx.inject(['locale'], (localeCtx) => {
    ctx.effect(() => localeCtx.locale.register(NS, { zh, en }), 'dsh-chat: 注册中英文案');
    t = localeCtx.locale.bind(NS);
  });

  // --- 样式 ---
  ctx.effect(() => installStyles(), 'dsh-chat: 安装样式表');

  // --- Host 通道 ---
  const client = createHostClient(ctx);

  // --- 主面板 ---
  //
  // `layout` 必须用 `ctx.inject` 等它真正就绪，**不能**用 `ctx.get('layout')` 取一次快照。
  //
  // 第一版就是一次性快照：apply 执行的那一刻 layout 服务如果还没注册，取到的就是
  // undefined，而且永远不会再变——于是"点按钮切面板"变成静默空操作，
  // 用户看到的就是「按钮无法点击」。`ctx.inject` 会在服务出现时重新执行回调。
  // 参考实现的写法见 @xmanrui/dsh-im 的 plugin-src/client/plugin-page.js。
  let layoutService = null;
  if (typeof ctx.inject === 'function') {
    ctx.inject(['layout'], (injected) => {
      layoutService = injected.layout ?? null;
    });
  } else {
    layoutService = ctx.get?.('layout') ?? null;
  }

  /**
   * 尝试把主面板切出来。
   * @returns {boolean} 是否真的切了。调用方据此决定要不要给用户一句说明，
   *   而不是让"什么都没发生"成为唯一的结果。
   */
  const openPanel = () => {
    if (!layoutService || typeof layoutService.selectPanel !== 'function') return false;
    try {
      layoutService.selectPanel(PANEL_ID);
      return true;
    } catch (error) {
      console.warn('[dsh-chat] 切换主面板失败', error);
      return false;
    }
  };

  function PanelHost() {
    const [jump, setJump] = useState(intentStore.value);
    useEffect(() => {
      // 挂载时消费一次遗留意图，保证「先切面板、后面板才挂载」也能生效。
      if (intentStore.value) setJump(intentStore.value);
      return intentStore.subscribe(setJump);
    }, []);
    // 主面板只做导航，不再渲染任何对话框——对话框统一由 DialogHost 负责。
    return (
      <DshChatApp
        client={client}
        t={t}
        jump={jump}
        // 发现页点「观看」也只是写意图，同样不切面板。
        onOpenRoom={(roomId, role) => intentStore.set({ kind: 'room', roomId, role })}
      />
    );
  }

  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({}),
  }, PanelHost)), 'dsh-chat: 主面板');

  // --- 左侧全局面板图标 ---
  function PanelIcon() {
    return (
      <button
        type="button"
        className="dshc-btn dshc-btnGhost dshc-btnSm"
        title={t('nav.discover')}
        aria-label={t('nav.discover')}
        onClick={openPanel}
      >
        <span aria-hidden="true">◎</span> dsh-chat
      </button>
    );
  }

  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 40,
    label: () => 'dsh-chat',
    locale: NS,
    inject: () => ({}),
  }, PanelIcon)), 'dsh-chat: 侧栏入口');

  // --- 对话框宿主（常驻）---
  //
  // `shell.overlay` 的定义是「Frame-wide floating layer, above every column and
  // outside their scroll containers」——它挂在 root 上，不随主面板或会话切换而卸载。
  // 这正是对话框需要的位置：谁被导航卸载都不影响它。
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: PANEL_ID,
    order: 50,
    label: () => 'dsh-chat dialogs',
    locale: NS,
    inject: () => ({}),
  }, (props) => <DialogHost client={client} t={t} {...props} />)), 'dsh-chat: 对话框宿主');

  // --- 会话页快捷入口（规划 §3.2）---
  function SessionActionsEntry(props) {
    // `sessionId` 是该 slot 的 standardProps 之一（已由 Slots.listSubTree 实测确认）。
    const sessionId = props?.sessionId ?? null;
    return (
      <SessionEntry
        client={client}
        t={t}
        sessionId={sessionId}
        /**
         * 点「分享会话 / 开启直播」时**只写意图**，绝不切主面板。
         *
         * 切面板会卸载 conversation 子树，而本组件正在那棵树里——
         * 之前"顺便切过去"的写法会把刚弹出的对话框一起带走。
         * 现在按钮和对话框分居两处，谁被卸载都不影响对方。
         */
        onIntent={(intent) => intentStore.set(intent)}
      />
    );
  }

  ctx.effect(() => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: PANEL_ID,
    order: 10,
    label: () => t('share.action'),
    locale: NS,
    inject: () => ({}),
  }, SessionActionsEntry)), 'dsh-chat: 会话页分享/直播入口');

  // --- 会话内直播状态条 ---
  function LiveStatusBar(props) {
    const sessionId = props?.sessionId ?? null;
    const [room, setRoom] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
      let cancelled = false;
      const load = async () => {
        if (!sessionId) return;
        try {
          const rooms = await client.call('live.list', {});
          if (!cancelled) {
            setRoom(rooms.find((item) => item.sessionId === sessionId && item.status !== 'ended') ?? null);
            setError(null);
          }
        } catch (cause) {
          if (!cancelled) setError(cause);
        }
      };
      load();
      const timer = setInterval(load, 5000);
      return () => { cancelled = true; clearInterval(timer); };
    }, [sessionId]);

    if (!sessionId || error || !room) return null;
    return (
      <div className="dshc-statusbar">
        <Badge tone={room.paused ? 'warn' : 'live'}>{room.paused ? t('session.paused') : t('session.liveNow')}</Badge>
        <span>{room.title}</span>
        <span>· {room.eventCount} {t('live.events')}</span>
        <span className="dshc-spacer" />
        <button
          type="button"
          className="dshc-btn dshc-btnSm"
          onClick={() => intentStore.set({ kind: 'room', roomId: room.id, role: 'host' })}
        >
          {t('live.chat')}
        </button>
      </div>
    );
  }

  ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: PANEL_ID,
    order: 30,
    locale: NS,
    inject: () => ({}),
  }, LiveStatusBar)), 'dsh-chat: 会话内直播状态条');

  // --- 对外暴露一个只读客户端服务，方便其它插件/命令打开面板 ---
  if (typeof ctx.provide === 'function') {
    ctx.provide('dshChatClient', Object.freeze({
      version: 1,
      openPanel,
      // 这三个只负责弹出对话框，不切面板——对话框在常驻的 shell.overlay 上，
      // 切不切面板都不影响它。需要浏览界面时调用 openPanel()。
      openShare: (sessionId) => intentStore.set({ kind: 'share', sessionId }),
      openLive: (sessionId) => intentStore.set({ kind: 'live', sessionId }),
      openRoom: (roomId, role = 'host') => intentStore.set({ kind: 'room', roomId, role }),
      closeDialog: () => intentStore.clear(),
      call: (method, payload) => client.call(method, payload),
    }));
  }
}

export { PANEL_ID };
