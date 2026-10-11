/**
 * 发现页（规划 §8.1 直播广场 / §8.2 会话广场 / §8.3 插件广场 / §8.4 创作者）。
 *
 * 规划 §8.5 有一条必须遵守的诚实要求：**不要宣称本地计算的热门榜代表整个网络的绝对排名**。
 * 所以这一页刻意不做"热门排序"，只做「本机已知」的事实陈列，并在空状态里
 * 直接告诉用户为什么会是空的（没有中心目录）。
 */
import {
  Fragment,
  Badge, Button, Card, Empty, ErrorLine, Mono, Notice, Section, Spinner, formatTime, h, truncate, useRpc, useState,
} from '../kit.js';

export function DiscoverView({ client, revision, t, onOpenRoom, onGoFriends }) {
  const overview = useRpc(client, 'overview', {}, revision);
  const [tab, setTab] = useState('live');

  if (overview.loading && !overview.data) return <Spinner label={t('common.loading')} />;

  const rooms = overview.data?.rooms ?? [];
  const watched = overview.data?.watched ?? [];
  const activeRooms = rooms.filter((room) => room.status !== 'ended');
  const shares = overview.data?.shares ?? [];
  const plugins = overview.data?.directory ?? [];
  const peers = overview.data?.peers ?? [];

  const creators = peers
    .filter((peer) => peer.relation === 'friend' || peer.following)
    .map((peer) => ({
      peerKey: peer.peerKey,
      name: peer.nickname ?? peer.fingerprint ?? peer.peerKey,
      online: peer.online,
      relation: peer.relation,
    }));

  const tabs = [
    ['live', t('discover.live'), activeRooms.length + watched.length],
    ['sessions', t('discover.sessions'), shares.length],
    ['plugins', t('discover.plugins'), plugins.length],
    ['creators', t('discover.creators'), creators.length],
  ];

  return (
    <>
      <ErrorLine error={overview.error} />
      <Notice>{t('discover.whyEmpty')}</Notice>

      <div className="dshc-row" style={{ marginBottom: 14 }}>
        {tabs.map(([key, label, count]) => (
          <Button key={key} variant={tab === key ? 'primary' : 'default'} size="sm" onClick={() => setTab(key)}>
            {label} · {count}
          </Button>
        ))}
        <span className="dshc-spacer" />
        <Button size="sm" variant="ghost" onClick={overview.reload}>{t('common.refresh')}</Button>
      </div>

      {tab === 'live' && (
        <Section>
          {activeRooms.length === 0 && watched.length === 0 ? (
            <Empty>{t('discover.noLive')}</Empty>
          ) : (
            <div className="dshc-grid">
              {activeRooms.map((room) => (
                <Card
                  key={room.id}
                  title={<>{room.title} <Badge tone={room.paused ? 'warn' : 'live'}>{room.paused ? t('live.paused') : 'LIVE'}</Badge></>}
                  meta={`${room.host?.nickname ?? room.host?.fingerprint ?? ''} · ${room.eventCount} ${t('live.events')}`}
                  actions={<Button size="sm" onClick={() => onOpenRoom(room.id, 'host')}>{t('live.chat')}</Button>}
                >
                  {room.tags?.length > 0 && (
                    <div className="dshc-row" style={{ marginTop: 6 }}>
                      {room.tags.map((tag) => <Badge key={tag}>{tag}</Badge>)}
                    </div>
                  )}
                </Card>
              ))}
              {watched.map((room) => (
                <Card
                  key={room.id}
                  title={<>{room.title} <Badge tone="idle">{t('discover.watching')}</Badge></>}
                  meta={`${room.host?.nickname ?? ''} · seq ${room.watchedLatestSeq}${room.pendingGaps > 0 ? ` · ${room.pendingGaps} ${t('live.gaps')}` : ''}`}
                  actions={<Button size="sm" onClick={() => onOpenRoom(room.id, 'viewer')}>{t('discover.watch')}</Button>}
                />
              ))}
            </div>
          )}
        </Section>
      )}

      {tab === 'sessions' && (
        <Section>
          {shares.length === 0 ? <Empty>{t('discover.noShares')}</Empty> : (
            <div className="dshc-list">
              {shares.map((share) => (
                <Card
                  key={share.id}
                  title={share.title}
                  meta={`${share.author?.nickname ?? share.author?.fingerprint} · ${share.itemCount} ${t('share.items')} · ${formatTime(share.createdAt)}`}
                >
                  <div className="dshc-row">
                    <Badge>{share.scope}</Badge>
                    <Badge>{share.mode}</Badge>
                    {share.tags?.map((tag) => <Badge key={tag}>{tag}</Badge>)}
                  </div>
                  <div className="dshc-cardMeta" style={{ marginTop: 6 }}>
                    <Mono>{truncate(share.id, 40)}</Mono>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </Section>
      )}

      {tab === 'plugins' && (
        <Section>
          {plugins.length === 0 ? <Empty>{t('discover.noPlugins')}</Empty> : (
            <div className="dshc-list">
              {plugins.map((plugin) => (
                <Card
                  key={plugin.pluginId}
                  title={
                    <>
                      {plugin.name}
                      <Badge tone={plugin.verified ? 'ok' : 'warn'}>
                        {plugin.verified ? 'signed' : 'unverified'}
                      </Badge>
                      {plugin.installed && <Badge tone="idle">installed</Badge>}
                    </>
                  }
                  meta={plugin.publisher
                    ? `${plugin.publisher.fingerprint} · v${plugin.version}`
                    : `v${plugin.version} · 本机安装（未签名）`}
                >
                  {plugin.description && <div style={{ marginTop: 4 }}>{truncate(plugin.description, 200)}</div>}
                  {plugin.rating?.average !== null && plugin.rating?.average !== undefined && (
                    <div className="dshc-cardMeta" style={{ marginTop: 6 }}>
                      ★ {plugin.rating.average} ({plugin.rating.count})
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )}
        </Section>
      )}

      {tab === 'creators' && (
        <Section>
          {creators.length === 0 ? (
            <Empty>
              {t('friends.none')} <Button size="sm" variant="ghost" onClick={onGoFriends}>{t('nav.friends')}</Button>
            </Empty>
          ) : (
            <div className="dshc-grid">
              {creators.map((creator) => (
                <Card
                  key={creator.peerKey}
                  title={<>{creator.name} {creator.online && <Badge tone="ok">{t('common.online')}</Badge>}</>}
                  meta={<Mono>{truncate(creator.peerKey, 32)}</Mono>}
                />
              ))}
            </div>
          )}
        </Section>
      )}
    </>
  );
}

/**
 * 收藏页（规划 §3.1 一级导航里的「收藏」）。
 *
 * MVP 阶段的收藏就是「已保存的分享」：本地保存一份校验过的分享对象副本。
 * 直播回放与生成内容的收藏需要额外的对象类型，规划把它们放在阶段 2/3，这里如实留空而不是造假数据。
 */
export function FavoritesView({ client, revision, t }) {
  const shares = useRpc(client, 'share.list', {}, revision);
  if (shares.loading && !shares.data) return <Spinner label={t('common.loading')} />;
  const list = shares.data ?? [];
  return (
    <>
      <ErrorLine error={shares.error} />
      {list.length === 0 ? <Empty>{t('favorites.empty')}</Empty> : (
        <div className="dshc-list">
          {list.map((share) => (
            <Card key={share.id} title={share.title} meta={`${formatTime(share.createdAt)} · ${share.itemCount} ${t('share.items')}`}>
              <div className="dshc-row">
                <Badge>{share.scope}</Badge>
                <Badge>{share.mode}</Badge>
              </div>
            </Card>
          ))}
        </div>
      )}
      <Section title={t('favorites.subtitle')}>
        <Notice tone="warn">
          直播回放与生成内容的收藏属于规划的阶段 2/3 范围，本版本未实现——
          这里不显示占位假数据，以免让人以为已经有这些内容。
        </Notice>
      </Section>
    </>
  );
}
