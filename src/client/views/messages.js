/**
 * 消息页（规划 §5.3 一对一私聊）。
 *
 * 页面上最显眼的东西是一条**关于加密状态的警告**，这是刻意的。
 * 规划 §5.3 要求「私聊内容应使用成熟的端到端加密方案，不自行设计密码算法」，
 * 而 MVP 阶段（规划 §15 阶段 1）只做到「一对一文字消息」。
 * 当前实现的真实状态是：**信封有 Ed25519 签名（能证来源、能防篡改），但没有加密（不防偷看）**。
 *
 * 把这件事写在界面顶部而不是藏进文档，是因为用户会把"能加好友"直接理解成"聊天是私密的"，
 * 这个误解的代价由用户承担，所以不能默认。
 */
import {
  Fragment,
  Badge, Button, Dot, Empty, ErrorLine, Mono, Notice, Spinner, formatTime, h,
  truncate, useAction, usePolling, useRpc, useState,
} from '../kit.js';

export function MessagesView({ client, revision, t, activePeer, onSelectPeer }) {
  const peers = useRpc(client, 'peers.list', {}, revision);
  const threads = useRpc(client, 'messages.list', {}, revision);
  const [draft, setDraft] = useState('');
  const action = useAction();

  const friends = (peers.data ?? []).filter((peer) => peer.relation === 'friend');
  const selected = activePeer ?? friends[0]?.peerKey ?? null;
  const messages = (threads.data ?? []).filter((m) => !selected || m.peerKey === selected);

  // 消息没有 SSE 之外的兜底时会显得"卡住"，这里补一个低频轮询。
  usePolling(() => threads.reload(), 4000, true);

  const send = () => action.run(async () => {
    const text = draft.trim();
    if (!text || !selected) return;
    await client.call('messages.send', { peerKey: selected, text });
    setDraft('');
    threads.reload();
  });

  if (peers.loading && !peers.data) return <Spinner label={t('common.loading')} />;

  return (
    <>
      <Notice tone="warn">{t('messages.plainWarning')}</Notice>
      <ErrorLine error={peers.error ?? threads.error ?? action.error} />

      <div className="dshc-split" style={{ minHeight: 380 }}>
        <div className="dshc-splitSide">
          {friends.length === 0 ? <Empty>{t('friends.none')}</Empty> : friends.map((peer) => (
            <button
              key={peer.peerKey}
              type="button"
              className="dshc-sideItem"
              aria-current={peer.peerKey === selected}
              onClick={() => onSelectPeer(peer.peerKey)}
            >
              <div className="dshc-row">
                <Dot on={peer.online} />
                <span>{peer.nickname ?? truncate(peer.peerKey, 16)}</span>
              </div>
              <div className="dshc-cardMeta"><Mono>{truncate(peer.peerKey, 22)}</Mono></div>
            </button>
          ))}
        </div>

        <div className="dshc-splitMain">
          {!selected ? <Empty>{t('messages.pick')}</Empty> : (
            <>
              <div className="dshc-thread">
                {messages.length === 0 ? <Empty>{t('common.empty')}</Empty> : messages.slice().reverse().map((message) => (
                  <div
                    key={message.id}
                    className={`dshc-bubble ${message.direction === 'out' ? 'dshc-bubbleOut' : ''}`}
                  >
                    {message.text}
                    <div className="dshc-bubbleMeta">
                      {formatTime(message.at)}
                      {message.direction === 'out' && !message.delivered ? ' · 未送达（对端不在线）' : ''}
                      {message.encrypted === false ? ' · 未加密' : ''}
                    </div>
                  </div>
                ))}
              </div>
              <div className="dshc-row">
                <input
                  className="dshc-input"
                  style={{ flex: 1 }}
                  placeholder={t('messages.placeholder')}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                />
                <Button variant="primary" disabled={action.busy || !draft.trim()} onClick={send}>
                  {t('messages.send')}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
