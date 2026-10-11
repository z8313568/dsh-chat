/**
 * 节点页（规划 §9.2 用户贡献设置、§9.1 节点角色、§16.2 资源可见性）。
 *
 * 规划 §16.2 有一条验证要求：「是否能够清晰呈现节点贡献所消耗的带宽、空间和运行时间」。
 * 所以这一页显示的是**真实计数**（连接数、握手次数、收发信封数、采集事件数、队列丢弃数），
 * 而不是"健康度"之类的合成指标。
 *
 * 同时把「已生效」和「仅声明」两组设置分开列出来。
 * 这是整份规划里最容易骗人的地方——界面上摆一个"最大上传带宽：1 MB/s"的滑块，
 * 用户会以为限速真的在跑。实际没有。所以必须逐项标注而不是笼统地写一句"部分未实现"。
 */
import {
  Fragment,
  Badge, Button, Card, Dot, Empty, ErrorLine, KV, Mono, Notice, Section, Spinner, formatTime, h,
  useAction, useRpc, useState,
} from '../kit.js';

const ROLE_LABEL_KEY = {
  ordinary: 'node.roleOrdinary',
  storage: 'node.roleStorage',
  forwarder: 'node.roleForwarder',
  relay: 'node.roleRelay',
  bootstrap: 'node.roleBootstrap',
};

export function NodeView({ client, revision, t }) {
  const snapshot = useRpc(client, 'node.snapshot', {}, revision);
  const relay = useRpc(client, 'relay.status', {}, revision);
  const reputation = useRpc(client, 'relay.reputation', {}, revision);
  const reach = useRpc(client, 'reachability', {}, revision);
  const connected = useRpc(client, 'peers.connected', {}, revision);
  const discovered = useRpc(client, 'peers.discovered', {}, revision);
  const action = useAction();
  const [paused, setPaused] = useState(false);

  if (snapshot.loading && !snapshot.data) return <Spinner label={t('common.loading')} />;
  const node = snapshot.data;
  if (!node) return <ErrorLine error={snapshot.error} />;

  const transport = node.transport ?? {};
  const capture = node.capture ?? {};
  const rpcMetrics = node.rpc ?? {};
  const contribution = node.contribution ?? {};

  return (
    <>
      <ErrorLine error={snapshot.error ?? action.error} />

      <Section title={t('node.identity')}>
        <Card>
          <KV rows={[
            ['昵称', node.identity?.nickname ?? '—'],
            [t('node.fingerprint'), <Mono key="fp">{node.identity?.fingerprint}</Mono>],
            ['公钥标识', <Mono key="pk">{node.identity?.publicKeyId}</Mono>],
            [t('node.transport'), `${transport.name ?? '—'} ${transport.running ? '· running' : '· stopped'}`],
            [t('node.address'), <Mono key="addr">{transport.address ?? '—'}</Mono>],
            ['数据目录', <Mono key="dir">{node.dataDir}</Mono>],
          ]} />
        </Card>
      </Section>

      <Section title="网络计数">
        <div className="dshc-grid">
          <Card title="传输" meta={`${transport.metrics?.connections ?? 0} 次连接 · ${transport.metrics?.handshakes ?? 0} 次握手`}>
            <KV rows={[
              ['打开连接', transport.metrics?.openConnections ?? 0],
              ['已知节点', transport.metrics?.knownPeers ?? 0],
              ['发现候选', transport.metrics?.discovered ?? 0],
              ['收到信封', transport.metrics?.envelopesIn ?? 0],
              ['发出信封', transport.metrics?.envelopesOut ?? 0],
              ['握手失败', transport.metrics?.failedHandshakes ?? 0],
            ]} />
          </Card>
          <Card title="信封校验" meta={`${node.codec?.opened ?? 0} 条通过 · ${node.codec?.rejected ?? 0} 条被拒`}>
            <KV rows={Object.entries(node.codec?.byReason ?? {}).map(([reason, count]) => [reason, count])} />
            {Object.keys(node.codec?.byReason ?? {}).length === 0 ? <div className="dshc-cardMeta">尚无被拒记录</div> : null}
          </Card>
          <Card title={t('node.capture')} meta={`${capture.eventsCaptured ?? 0} 条已采集`}>
            <KV rows={[
              ['看到的事件', capture.eventsSeen ?? 0],
              ['因未授权跳过', capture.eventsFiltered ?? 0],
              ['已采集', capture.eventsCaptured ?? 0],
              ['入队失败', capture.eventsDropped ?? 0],
              ['handler 抛错', capture.handlerErrors ?? 0],
              ['token 帧', capture.chunksSeen ?? 0],
              ['最后事件', capture.lastEventAt ? formatTime(capture.lastEventAt) : '—'],
            ]} />
          </Card>
          <Card title={t('node.rpc')} meta={`${rpcMetrics.rpcCalls ?? 0} 次调用 · ${rpcMetrics.sseClients ?? 0} 个推送连接`}>
            <KV rows={[
              ['调用失败', rpcMetrics.rpcErrors ?? 0],
              ['SSE 建立次数', rpcMetrics.sseConnections ?? 0],
              ['SSE 事件投递', rpcMetrics.sseEvents ?? 0],
              ['脱敏规则数', node.redaction?.ruleCount ?? 0],
            ]} />
          </Card>
        </div>
      </Section>

      <Section title={t('node.peers')}>
        {(connected.data ?? []).length === 0 ? <Empty>{t('common.empty')}</Empty> : (
          <div className="dshc-list">
            {(connected.data ?? []).map((peer) => (
              <Card
                key={peer.peerKey}
                title={peer.nickname ?? peer.fingerprint ?? peer.peerKey}
                meta={<><Mono>{peer.peerKey}</Mono> · {peer.direction} · {peer.address}</>}
              />
            ))}
          </div>
        )}
      </Section>

      <Section title={t('node.discovered')}>
        {(discovered.data ?? []).length === 0 ? <Empty>{t('common.empty')}</Empty> : (
          <div className="dshc-list">
            {(discovered.data ?? []).map((entry) => (
              <Card key={entry.publicKeyId} title={entry.nickname ?? entry.fingerprint} meta={`${entry.address} · ${formatTime(entry.seenAt)}`} />
            ))}
          </div>
        )}
      </Section>

      <Section title="中继（公网节点）">
        {(() => {
          const status = relay.data;
          if (!status) return <Spinner label={t('common.loading')} />;
          const reach = status.reachability ?? {};
          const tone = reach.verdict === 'reachable' ? 'ok'
            : reach.verdict === 'unproven' ? 'warn' : 'idle';
          return (
            <>
              <ErrorLine error={relay.error} />
              <Card
                title={<>本机角色 <Badge tone={tone}>{
                  reach.verdict === 'reachable' ? '公网可达 · 可当中继'
                    : reach.verdict === 'unproven' ? '已配置中继但未被验证'
                      : '仅使用别人的中继'
                }</Badge></>}
                meta={reach.note}
              >
                <KV rows={[
                  ['被连入次数', reach.inboundPeers ?? 0],
                  ['主动连出次数', reach.outboundPeers ?? 0],
                  ['最近一次被连入', reach.lastInboundAt ? formatTime(reach.lastInboundAt) : '—'],
                  ['是否对外提供中继', status.serving ? t('common.yes') : t('common.no')],
                ]} />
              </Card>

              <Card
                title={`已接入的中继（${(status.servers ?? []).length}）`}
                meta="NAT 后面的节点只能主动出站。所以能不能被找到，取决于有没有挂到一台公网中继上。"
              >
                {(status.servers ?? []).length === 0
                  ? <Empty>还没有接入任何中继。可以在下方手动加入一台公网节点的地址。</Empty>
                  : (
                    <div className="dshc-list">
                      {(status.servers ?? []).map((server) => (
                        <div key={server.peerKey} className="dshc-rowBetween">
                          <span className="dshc-row" style={{ gap: 6 }}>
                            <Dot on={server.registered} />
                            <Mono>{server.address}</Mono>
                          </span>
                          <span className="dshc-row" style={{ gap: 6 }}>
                            {server.registered
                              ? <Badge tone="ok">已登记</Badge>
                              : <Badge tone="warn">未登记</Badge>}
                            {server.load && <Badge>{server.load.peers}/{server.load.capacity} 对端</Badge>}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
              </Card>

              {(status.relayedPeers ?? []).length > 0 && (
                <Card
                  title={`经中继可达的节点（${status.relayedPeers.length}）`}
                  meta="这些节点与本机之间没有直连，消息经公网中继转发。内容全程加密，中继解不开。"
                >
                  <div className="dshc-list">
                    {status.relayedPeers.map((peer) => (
                      <div key={peer.peerKey} className="dshc-rowBetween">
                        <Mono>{peer.nickname ?? `${peer.peerKey.slice(0, 24)}…`}</Mono>
                        <span className="dshc-cardMeta">{peer.lastSeen ? formatTime(peer.lastSeen) : ''}</span>
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {status.client?.metrics?.forwardedIn !== undefined && (
                <Card title="中继流量（本机）" meta="只统计经中继转发的部分；直连流量不在这里。">
                  <KV rows={[
                    ['转发出去', status.client.metrics.forwardedOut ?? 0],
                    ['接收进来', status.client.metrics.forwardedIn ?? 0],
                    ['目标不可达', status.client.metrics.unreachable ?? 0],
                    ['忽略的非中继控制消息', status.client.metrics.refused ?? 0],
                  ]} />
                </Card>
              )}

              {status.server && (
                <Card title="作为中继提供服务" meta="本机对外提供转发；只转发密文与公开内容。">
                  <KV rows={[
                    ['已登记对端', status.server.peers ?? 0],
                    ['容量', status.server.capacity ?? 0],
                    ['已转发', status.server.forwarded ?? 0],
                    ['拒绝明文', status.server.refusedPlaintext ?? 0],
                    ['目标不可达', status.server.unreachable ?? 0],
                    ['转发字节', status.server.bytesForwarded ?? 0],
                  ]} />
                  <div className="dshc-hint">
                    本中继**只能看到**谁在和谁通信、消息大小与时间（元数据）；
                    正文是端到端加密的，它解不开。它也可以拒绝服务 —— 这条限制没有被消除。
                  </div>
                </Card>
              )}

              {reputation.data && (
                <Card
                  title="打洞"
                  meta="打通了就省下中继带宽，也不让第三方看到元数据。打不通完全正常，中继永远是兜底。"
                >
                  <KV rows={[
                    ['NAT 类型', natLabel(reputation.data.punch?.natType?.type)],
                    ['尝试次数', reputation.data.punch?.attempts ?? 0],
                    ['成功', reputation.data.punch?.succeeded ?? 0],
                    ['失败', reputation.data.punch?.failed ?? 0],
                    ['跳过（对称 NAT 不值得试）', reputation.data.punch?.skipped ?? 0],
                  ]} />
                  {reputation.data.punch?.natType?.reason && (
                    <div className="dshc-hint">
                      判定依据：{reputation.data.punch.natType.reason}
                      {reputation.data.punch.natType.type === 'unknown'
                        && '（只有一个观察点时无法区分锥形与对称，此时仍然值得一试）'}
                      {reputation.data.punch.natType.type === 'symmetric'
                        && '（对称 NAT 下打洞必然失败，会直接跳过并走中继）'}
                    </div>
                  )}
                </Card>
              )}

              {reputation.data && (
                <Card
                  title="中继信誉与贡献"
                  meta="全部是本机实测。他人证明只作参考 —— 否则批量伪造的好评就能把坏中继刷到榜首。"
                >
                  <KV rows={[
                    ['转发出去（本机做中继）', formatBytes(reputation.data.contribution?.servedBytes ?? 0)],
                    ['经中继消耗', formatBytes(reputation.data.contribution?.consumedBytes ?? 0)],
                    ['净贡献', `${(reputation.data.contribution?.balance ?? 0) >= 0 ? '+' : ''}${formatBytes(reputation.data.contribution?.balance ?? 0)}`],
                  ]} />
                  {(reputation.data.relays ?? []).length > 0 && (
                    <div className="dshc-list">
                      {reputation.data.relays.map((entry) => (
                        <div key={entry.peerKey} className="dshc-rowBetween">
                          <Mono>{entry.peerKey.slice(0, 28)}…</Mono>
                          <span className="dshc-row" style={{ gap: 6 }}>
                            <Badge tone={entry.blacklisted ? 'warn' : entry.score > 0 ? 'ok' : 'idle'}>
                              {entry.score > 0 ? '+' : ''}{entry.score}
                            </Badge>
                            <span className="dshc-cardMeta">{entry.observations} 次观察</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="dshc-hint">{reputation.data.note}</div>
                </Card>
              )}

              {reach.data && (
                <Card
                  title="我能不能被别人连上"
                  meta="判断依据是实测，不是「我的 IP 看起来是公网」。这两件事经常不一致。"
                >
                  <KV rows={[
                    ['结论', reachLabel(reach.data.state)],
                    ['本机地址', reach.data.local?.reason ?? '—'],
                    ['中继观察到的来源地址', `${reach.data.observations ?? 0} 个观察点`],
                    ['有人主动连入过', `${reach.data.inbound?.count ?? 0} 次`],
                    ['对外提供中继', reach.data.serving ? t('common.yes') : t('common.no')],
                  ]} />
                  <div className="dshc-hint">{reach.data.reason}</div>
                  {reach.data.suggestion?.note && (
                    <div className="dshc-hint">{reach.data.suggestion.note}</div>
                  )}
                  {reach.data.suggestion?.suggest && (
                    <div className="dshc-hint">
                      已实测可达 —— 如果愿意贡献带宽，可以把配置里的 relay.serve 设为 true 或 auto。
                    </div>
                  )}
                  {reach.data.serving && reach.data.inbound?.count === 0 && (
                    <Notice tone="warn">
                      已经配置为提供中继服务，但**从来没有人成功连入过**。
                      如果你在 NAT 后面，别人是连不进来的 —— 对外宣称可达会让他们白发消息。
                    </Notice>
                  )}
                </Card>
              )}

              <AddRelayForm client={client} t={t} onAdded={relay.reload} />
            </>
          );
        })()}
      </Section>

      <Section title={t('node.contribution')}>
        <Notice>{t('node.contributionNote')}</Notice>
        <Card>
          <div className="dshc-row" style={{ marginBottom: 8 }}>
            {(contribution.roles ?? []).map((role) => (
              <Badge key={role} tone={role === 'ordinary' ? 'idle' : 'warn'}>{t(ROLE_LABEL_KEY[role] ?? role)}</Badge>
            ))}
          </div>
          <KV rows={[
            ['最大缓存空间', contribution.maxCacheBytes ? `${contribution.maxCacheBytes} B` : '0（不缓存他人内容）'],
            ['最大上传带宽', contribution.maxUploadBps ? `${contribution.maxUploadBps} B/s` : '0（不限）'],
            ['最大下载带宽', contribution.maxDownloadBps ? `${contribution.maxDownloadBps} B/s` : '0（不限）'],
            ['仅接电源时运行', contribution.onlyOnPower ? t('common.yes') : t('common.no')],
            ['自动停止', contribution.autoStopMinutes ? `${contribution.autoStopMinutes} 分钟` : '不自动停止'],
            [t('node.sharingDefault'), node.consent?.defaultSharingMode ?? '—'],
          ]} />
        </Card>

        <div className="dshc-grid" style={{ marginTop: 10 }}>
          <Card title={t('node.enforced')} meta="当前进程内真正生效">
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {(contribution.enforced ?? []).map((item) => <li key={item}><Mono>{item}</Mono></li>)}
            </ul>
          </Card>
          <Card title={t('node.declaredOnly')} meta="只是配置值，尚未执行">
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {(contribution.declaredOnly ?? []).map((item) => <li key={item}><Mono>{item}</Mono></li>)}
            </ul>
            <div className="dshc-hint">
              限速与「仅接电源」需要在网络层加入令牌桶与系统电源查询才会真正生效；
              本版本没有实现，所以不把它显示成已经生效的开关。
            </div>
          </Card>
        </div>

        <div className="dshc-row" style={{ marginTop: 12 }}>
          <Button
            variant="danger"
            disabled={action.busy}
            onClick={() => action.run(async () => {
              const result = await client.call('node.pauseAll', {});
              setPaused(result);
              snapshot.reload();
            })}
          >
            {t('node.pauseAll')}
          </Button>
          {paused && <span className="dshc-cardMeta">{t('node.paused')}（撤销 {paused.revokedGrants} 条授权）</span>}
        </div>
      </Section>
    </>
  );
}

/** 手动接入一台中继。跨网段时靠它 —— 广播发现到不了别的网络。 */
function AddRelayForm({ client, t, onAdded }) {
  const [address, setAddress] = useState('');
  const action = useAction();
  return (
    <Card title="手动接入中继" meta="填入一台公网节点的地址（host:port 或 [v6]:port）。跨网段时这是唯一可行的入口。">
      <div className="dshc-row">
        <input
          className="dshc-input"
          style={{ flex: '1 1 260px' }}
          placeholder="203.0.113.7:47800"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && address.trim() && !action.busy) {
              action.run(async () => { await client.call('relay.add', { address: address.trim() }); setAddress(''); onAdded?.(); });
            }
          }}
        />
        <Button
          variant="primary"
          disabled={action.busy || !address.trim()}
          onClick={() => action.run(async () => {
            await client.call('relay.add', { address: address.trim() });
            setAddress('');
            onAdded?.();
          })}
        >
          {action.busy ? t('common.saving') : '接入'}
        </Button>
      </div>
      <ErrorLine error={action.error} />
    </Card>
  );
}

/** NAT 类型的中文说明。界面上只显示术语，用户看不懂就等于没说。 */
function natLabel(type) {
  switch (type) {
    case 'cone': return '全锥形（打洞可行）';
    case 'restricted': return '受限锥形（打洞可行）';
    case 'symmetric': return '对称型（打洞不可行，需中继）';
    case 'open': return '无 NAT（直连即可）';
    default: return '未知（观察点不足）';
  }
}

function formatBytes(value) {
  const n = Number(value) || 0;
  if (Math.abs(n) < 1024) return `${n} B`;
  if (Math.abs(n) < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 可达性结论的中文说明。
 * 只显示四个字的状态名，用户没法据此做任何决定 —— 所以每个状态都要说清"这意味着什么"。
 */
function reachLabel(state) {
  switch (state) {
    case 'proven': return '实测可达（有人连进来过）';
    case 'likely': return '看起来在公网上，但还没被验证';
    case 'behind-nat': return '在 NAT 后面';
    case 'private-only': return '只有内网地址';
    case 'client-only': return '只使用别人的中继';
    default: return '还判断不出来';
  }
}
