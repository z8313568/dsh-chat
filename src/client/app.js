/**
 * dsh-chat 主面板（规划 §3.1 一级导航）。
 *
 * 布局照规划实现：**左侧主导航 + 中间内容区**，右侧面板按需展开
 * （本版本用对话框承载分享页/直播间，规划 §3 允许"按需展开的右侧面板"，
 *  对话框是它的一个等价形态，且不需要占用宿主的 rightbar 席位、不会和别的插件抢位置）。
 *
 * 导航六项与规划 §3.1 表格一一对应：发现 / 好友 / 消息 / 收藏 / 节点 / 我的。
 */
import {
  Fragment,
  Button, Dot, ErrorLine, Notice, h, useCallback, useEffect, useMemo, useState,
} from './kit.js';
import { DiscoverView, FavoritesView } from './views/discover.js';
import { FriendsView } from './views/friends.js';
import { MessagesView } from './views/messages.js';
import { MeView } from './views/me.js';
import { NodeView } from './views/node.js';

const SECTIONS = [
  { key: 'discover', icon: '◎' },
  { key: 'friends', icon: '☺' },
  { key: 'messages', icon: '✉' },
  { key: 'favorites', icon: '★' },
  { key: 'node', icon: '⬡' },
  { key: 'me', icon: '☰' },
];

/**
 * 主面板组件。
 *
 * @param {object} props
 * @param {object} props.client   Host 通道客户端
 * @param {(key: string, params?: object) => string} props.t 翻译函数
 * @param {(section: string) => void} [props.onSectionChange] 供会话页快捷入口跳转
 * @param {string|null} [props.sessionId] 从会话页跳进来时携带的会话
 */
export function DshChatApp({ client, t, onSectionChange, onOpenRoom = null, jump = null }) {
  const [section, setSection] = useState('discover');
  const [revision, setRevision] = useState(0);
  const [activePeer, setActivePeer] = useState(null);
  const [bootstrapError, setBootstrapError] = useState(null);
  const [sseState, setSseState] = useState('idle');

  // 首次握手：拿 SSE token，并确认 Host 半体真的在。
  useEffect(() => {
    let cancelled = false;
    client.handshake()
      .then(() => { if (!cancelled) setBootstrapError(null); })
      .catch((error) => { if (!cancelled) setBootstrapError(error); });
    return () => { cancelled = true; };
  }, [client]);

  // 实时推送到达时把 revision 加一，所有 useRpc 会自行重取。
  useEffect(() => {
    const stop = client.subscribe(
      ['live', 'peers', 'messages', 'shares', 'directory', 'discovered', 'live-chunk'],
      { onState: setSseState },
    );
    const offs = [
      client.on('peers', () => setRevision((v) => v + 1)),
      client.on('messages', () => setRevision((v) => v + 1)),
      client.on('shares', () => setRevision((v) => v + 1)),
      client.on('directory', () => setRevision((v) => v + 1)),
      client.on('discovered', () => setRevision((v) => v + 1)),
      client.on('live', () => setRevision((v) => v + 1)),
    ];
    return () => {
      stop();
      for (const off of offs) off();
    };
  }, [client]);

  // 主面板只处理**导航**；对话框一律交给常驻的 DialogHost。
  // 这里的 `jump` 只用来把用户带到某个导航页。
  useEffect(() => {
    if (jump?.section) setSection(jump.section);
  }, [jump]);

  const go = useCallback((next) => {
    setSection(next);
    onSectionChange?.(next);
  }, [onSectionChange]);

  const content = useMemo(() => {
    const shared = { client, revision, t };
    switch (section) {
      case 'friends':
        return <FriendsView {...shared} onMessage={(peerKey) => { setActivePeer(peerKey); go('messages'); }} />;
      case 'messages':
        return <MessagesView {...shared} activePeer={activePeer} onSelectPeer={setActivePeer} />;
      case 'favorites':
        return <FavoritesView {...shared} />;
      case 'node':
        return <NodeView {...shared} />;
      case 'me':
        return <MeView {...shared} />;
      case 'discover':
      default:
        return (
          <DiscoverView
            {...shared}
            onOpenRoom={(roomId, role) => onOpenRoom?.(roomId, role)}
            onGoFriends={() => go('friends')}
          />
        );
    }
  }, [section, client, revision, t, activePeer, go, onOpenRoom]);

  const sectionLabel = t(`nav.${section}`);

  return (
    <div className="dshc-root">
      <header className="dshc-header">
        <div>
          <h2 className="dshc-title">dsh-chat · {sectionLabel}</h2>
          <p className="dshc-subtitle">{t(`${section}.subtitle`)}</p>
        </div>
        <div className="dshc-row">
          {sseState === 'open'
            ? <span className="dshc-statusbar"><Dot on /> 实时推送已连接</span>
            : (
              <span className="dshc-statusbar">
                <Dot /> 实时推送{sseState === 'reconnecting' ? '重连中' : '不可用（4 秒轮询兜底）'}
              </span>
            )}
          <Button size="sm" variant="ghost" onClick={() => setRevision((v) => v + 1)}>{t('common.refresh')}</Button>
        </div>
      </header>

      <div className="dshc-body">
        <nav className="dshc-nav" aria-label="dsh-chat">
          {SECTIONS.map((item) => (
            <button
              key={item.key}
              type="button"
              className="dshc-navItem"
              aria-current={section === item.key}
              onClick={() => go(item.key)}
            >
              <span className="dshc-navIcon" aria-hidden="true">{item.icon}</span>
              {t(`nav.${item.key}`)}
            </button>
          ))}
        </nav>
        <div className="dshc-content">
          {bootstrapError ? (
            <Notice tone="error">
              {t('err.generic')}：{bootstrapError.message}
            </Notice>
          ) : null}
          {content}
        </div>
      </div>

    </div>
  );
}

/**
 * 会话页标题旁的入口按钮（规划 §3.2「DSH 会话页快捷入口」）。
 *
 * 规划要求这两个入口「尽量集成到 DSH 原有会话操作中，避免用户重复创建会话」——
 * 所以它们是会话头部的两个小按钮，而不是另开一个页面。
 *
 * 本组件只负责"按钮长什么样 + 把点击意图交给上层"，自己不做任何跳转。
 */
export function SessionActions({ client, t, sessionId, onJump }) {
  const [error, setError] = useState(null);
  const [state, setState] = useState(null);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    try {
      const summary = await client.call('consent.summary', {});
      const grant = summary.sessions.find((item) => item.sessionId === sessionId) ?? null;
      const rooms = await client.call('live.list', {});
      const room = rooms.find((item) => item.sessionId === sessionId && item.status !== 'ended') ?? null;
      setState({ grant, room });
      setError(null);
    } catch (cause) {
      setError(cause);
    }
  }, [client, sessionId]);

  useEffect(() => { refresh(); }, [refresh]);

  if (!sessionId) return null;

  return (
    <span className="dshc-row" style={{ gap: 6 }}>
      <button
        type="button"
        className="dshc-btn dshc-btnSm"
        onClick={() => onJump?.({ kind: 'share', sessionId })}
        title={t('share.action')}
      >
        {t('session.share')}
      </button>
      {state?.room ? (
        <button
          type="button"
          className="dshc-btn dshc-btnSm"
          onClick={() => onJump?.({ kind: 'room', roomId: state.room.id, role: 'host', sessionId })}
        >
          {state.room.paused ? t('session.paused') : t('session.liveNow')}
        </button>
      ) : (
        <button
          type="button"
          className="dshc-btn dshc-btnSm"
          onClick={() => onJump?.({ kind: 'live', sessionId })}
          title={t('live.action')}
        >
          {t('session.live')}
        </button>
      )}
      {error && (
        <span
          className="dshc-cardMeta"
          style={{ color: 'var(--dsw-alias-state-error-primary)' }}
          title={error?.message ?? String(error)}
        >
          ⚠
        </span>
      )}
    </span>
  );
}

/**
 * 会话页入口。
 *
 * 它的职责被刻意压到最小：**只把用户的点击变成一个意图**，别的什么都不做。
 *
 * 这里连着踩过两个坑，合起来说明了一件事——"谁负责弹窗"这个问题必须一次想清楚：
 *
 *   坑 1：第一版让按钮调 `ctx.layout.selectPanel('dsh-chat')` 切主面板，
 *         再由主面板弹对话框。而 `layout` 是用 `ctx.get()` 在 apply 那一刻取的
 *         **一次性快照**，服务没就绪就永远是 undefined，点击成了静默空操作。
 *   坑 2：改成"自己就地弹对话框 + 顺便切面板"之后，切面板会把 conversation
 *         子树整个卸载，而这个组件正住在里面——对话框刚创建就跟着组件一起消失。
 *         用户看到的是「跳到面板了，但什么都没发生」。
 *
 * 结论：**负责弹窗的组件不能住在任何会被导航卸载的子树里。**
 * 所以现在对话框住在常驻的 `shell.overlay`（见 dialog-host.js），
 * 这里只写意图，不切面板、不持状态。切面板与弹窗彻底解耦。
 */
export function SessionEntry({ client, t, sessionId, onIntent }) {
  if (!sessionId) return null;
  return (
    <SessionActions
      client={client}
      t={t}
      sessionId={sessionId}
      onJump={(intent) => onIntent?.({ ...intent, sessionId })}
    />
  );
}
