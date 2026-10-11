/**
 * 好友页（规划 §5.2）。
 *
 * 界面上刻意区分三种"未完成"状态，因为它们对用户意味着完全不同的下一步：
 *   - `已发出，等待对方上线`（DRAFT）——对方根本没收到，需要等或换通道；
 *   - `对方已收到，等待确认`（SENT）——球在对方那边；
 *   - `待处理申请`（INCOMING）——球在我这边。
 * 把三者合并成一个"待确认"，看起来更整洁，但会让用户不知道该做什么。
 */
import {
  Fragment,
  Badge, Button, Card, CopyButton, Dot, Empty, ErrorLine, Field, Input, Mono, Notice,
  Section, Spinner, formatTime, h, truncate, useAction, useRpc, useState,
} from '../kit.js';

const RELATION_LABEL_KEY = {
  friend: 'friends.list',
  incoming: 'friends.incoming',
  outgoing: 'friends.outgoing',
  following: 'friends.following',
  blocked: 'friends.blocked',
};

export function FriendsView({ client, revision, t, onMessage }) {
  const peers = useRpc(client, 'peers.list', {}, revision);
  const discovered = useRpc(client, 'peers.discovered', {}, revision);
  const connected = useRpc(client, 'peers.connected', {}, revision);
  const invite = useRpc(client, 'peers.invite', {}, 0);

  const [address, setAddress] = useState('');
  const action = useAction();

  const reloadAll = () => {
    peers.reload();
    discovered.reload();
    connected.reload();
  };

  const list = peers.data ?? [];
  const incoming = list.filter((p) => p.relation === 'incoming');
  const outgoing = list.filter((p) => p.relation === 'outgoing');
  const friends = list.filter((p) => p.relation === 'friend');
  const following = list.filter((p) => p.following && p.relation !== 'friend');
  const blocked = list.filter((p) => p.relation === 'blocked');

  const connect = () => action.run(async () => {
    if (!address.trim()) return;
    await client.call('peers.connect', { address: address.trim() });
    setAddress('');
    reloadAll();
  });

  return (
    <>
      <ErrorLine error={peers.error ?? discovered.error} />
      <ErrorLine error={action.error} />

      <Section title={t('friends.add')}>
        <div className="dshc-row">
          <Input
            style={{ flex: '1 1 320px' }}
            placeholder={t('friends.addressPlaceholder')}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') connect(); }}
          />
          <Button variant="primary" disabled={action.busy || !address.trim()} onClick={connect}>
            {t('friends.connect')}
          </Button>
        </div>
        {invite.data?.invite && (
          <div style={{ marginTop: 10 }}>
            <div className="dshc-label">{t('friends.invite')}</div>
            <div className="dshc-cardMeta dshc-mono">{invite.data.invite}</div>
            <div className="dshc-row" style={{ marginTop: 6 }}>
              <CopyButton text={invite.data.invite} label={t('common.copy')} copiedLabel={t('common.copied')} />
              <span className="dshc-cardMeta">监听：<Mono>{invite.data.address ?? '—'}</Mono></span>
            </div>
            <div className="dshc-hint">
              邀请码里只有你的公钥标识和地址，没有私钥。对方用它就能直连你。
            </div>
          </div>
        )}
      </Section>

      {(discovered.data ?? []).length > 0 && (
        <Section title={t('friends.discovered')}>
          <div className="dshc-list">
            {(discovered.data ?? []).map((entry) => (
              <Card
                key={entry.publicKeyId}
                title={<>{entry.nickname ?? entry.fingerprint} <Badge>UDP 信标</Badge></>}
                meta={`${entry.address} · ${formatTime(entry.seenAt)}`}
                actions={
                  <Button size="sm" onClick={() => action.run(async () => {
                    await client.call('peers.connect', { address: entry.address });
                    reloadAll();
                  })}>
                    {t('friends.connect')}
                  </Button>
                }
              />
            ))}
          </div>
        </Section>
      )}

      <Section title={t('friends.connected')}>
        {(connected.data ?? []).length === 0 ? <Empty>{t('common.empty')}</Empty> : (
          <div className="dshc-list">
            {(connected.data ?? []).map((peer) => (
              <Card
                key={peer.peerKey}
                title={<><Dot on /> {peer.nickname ?? peer.fingerprint}</>}
                meta={<Mono>{truncate(peer.peerKey, 40)}</Mono>}
              />
            ))}
          </div>
        )}
      </Section>

      {incoming.length > 0 && (
        <Section title={t('friends.incoming')}>
          <div className="dshc-list">
            {incoming.map((peer) => (
              <Card
                key={peer.peerKey}
                title={peer.nickname ?? peer.fingerprint ?? truncate(peer.peerKey, 24)}
                meta={peer.note ? `“${peer.note}”` : null}
                actions={
                  <>
                    <Button size="sm" variant="primary" onClick={() => action.run(async () => {
                      await client.call('peers.respond', { peerKey: peer.peerKey, accepted: true });
                      reloadAll();
                    })}>{t('friends.accept')}</Button>
                    <Button size="sm" onClick={() => action.run(async () => {
                      await client.call('peers.respond', { peerKey: peer.peerKey, accepted: false });
                      reloadAll();
                    })}>{t('friends.reject')}</Button>
                  </>
                }
              />
            ))}
          </div>
        </Section>
      )}

      {outgoing.length > 0 && (
        <Section title={t('friends.outgoing')}>
          <div className="dshc-list">
            {outgoing.map((peer) => (
              <Card
                key={peer.peerKey}
                title={peer.nickname ?? truncate(peer.peerKey, 24)}
                meta={peer.delivery === 'sent' ? t('friends.waitingConfirm') : t('friends.waitingPeer')}
              />
            ))}
          </div>
        </Section>
      )}

      <Section title={t('friends.list')}>
        {friends.length === 0 && following.length === 0 ? <Empty>{t('friends.none')}</Empty> : (
          <div className="dshc-list">
            {[...friends, ...following].map((peer) => (
              <Card
                key={peer.peerKey}
                title={<><Dot on={peer.online} /> {peer.nickname ?? peer.fingerprint ?? truncate(peer.peerKey, 24)}
                  {peer.relation === 'friend' ? <Badge tone="ok">好友</Badge> : <Badge>关注</Badge>}</>}
                meta={<Mono>{truncate(peer.peerKey, 44)}</Mono>}
                actions={
                  <>
                    {peer.relation === 'friend' && (
                      <Button size="sm" onClick={() => onMessage(peer.peerKey)}>{t('nav.messages')}</Button>
                    )}
                    {peer.following
                      ? <Button size="sm" variant="ghost" onClick={() => action.run(async () => {
                        await client.call('peers.unfollow', { peerKey: peer.peerKey }); reloadAll();
                      })}>{t('friends.unfollow')}</Button>
                      : <Button size="sm" variant="ghost" onClick={() => action.run(async () => {
                        await client.call('peers.follow', { peerKey: peer.peerKey }); reloadAll();
                      })}>{t('friends.follow')}</Button>}
                    {peer.relation === 'friend' && (
                      <Button size="sm" variant="ghost" onClick={() => action.run(async () => {
                        await client.call('peers.remove', { peerKey: peer.peerKey }); reloadAll();
                      })}>{t('friends.remove')}</Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => action.run(async () => {
                      await client.call('peers.block', { peerKey: peer.peerKey, reason: 'user' }); reloadAll();
                    })}>{t('friends.block')}</Button>
                  </>
                }
              />
            ))}
          </div>
        )}
      </Section>

      {blocked.length > 0 && (
        <Section title={t('friends.blocked')}>
          <div className="dshc-list">
            {blocked.map((peer) => (
              <Card
                key={peer.peerKey}
                title={peer.nickname ?? truncate(peer.peerKey, 24)}
                meta={peer.blockReason || null}
                actions={
                  <Button size="sm" onClick={() => action.run(async () => {
                    await client.call('peers.unblock', { peerKey: peer.peerKey }); reloadAll();
                  })}>{t('friends.unblock')}</Button>
                }
              />
            ))}
          </div>
        </Section>
      )}
    </>
  );
}
