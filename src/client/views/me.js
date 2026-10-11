/**
 * 我的页（规划 §3.1「个人主页、我的插件、我的分享、直播管理、隐私设置」）。
 *
 * 这里承载了产品规划里最敏感的两块：**身份备份**与**授权可见性**。
 *
 * - 身份备份：规划 §5.1 要求「私钥只由用户掌控，并提供安全的备份与恢复说明」。
 *   所以导出按钮不会"点一下就下载"，而是先把风险讲清楚，导出后也只显示在本地。
 * - 授权可见性：规划 §12.2 要求用户能控制"谁能看到什么"。
 *   这一页把**当前所有生效中的外发授权**列出来，并允许逐条撤销——
 *   用户不需要回忆自己开过什么，这是"隐私优先"能不能落地的关键。
 */
import {
  Fragment,
  Badge, Button, Card, CopyButton, Empty, ErrorLine, Field, Input,
  KV, Mono, Notice, Section, Spinner, Textarea, formatTime, h,
  truncate, useAction, useRpc, useState,
} from '../kit.js';

export function MeView({ client, revision, t }) {
  const profile = useRpc(client, 'profile.get', {}, revision);
  const shares = useRpc(client, 'share.list', {}, revision);
  const overview = useRpc(client, 'overview', {}, revision);
  const action = useAction();
  const [draft, setDraft] = useState(null);
  const [exported, setExported] = useState(null);
  const [confirmExport, setConfirmExport] = useState(false);

  if (profile.loading && !profile.data) return <Spinner label={t('common.loading')} />;

  const current = profile.data?.profile ?? {};
  const editing = draft ?? { nickname: current.nickname ?? '', bio: current.bio ?? '' };
  const node = overview.data?.node;
  const grants = node?.consent?.sessions ?? [];
  const rooms = overview.data?.rooms ?? [];

  return (
    <>
      <ErrorLine error={profile.error ?? action.error} />

      <Section title={t('me.profile')}>
        <Card>
          <Field label={t('me.nickname')} hint={t('me.nicknameHint')}>
            <Input
              value={editing.nickname}
              onChange={(e) => setDraft({ ...editing, nickname: e.target.value })}
            />
          </Field>
          <Field label={t('me.bio')}>
            <Textarea
              value={editing.bio}
              onChange={(e) => setDraft({ ...editing, bio: e.target.value })}
            />
          </Field>
          <div className="dshc-row">
            <Button
              variant="primary"
              disabled={action.busy || !draft}
              onClick={() => action.run(async () => {
                await client.call('profile.update', editing);
                setDraft(null);
                profile.reload();
              })}
            >
              {action.busy ? t('common.saving') : t('common.save')}
            </Button>
            {draft && <Button variant="ghost" onClick={() => setDraft(null)}>{t('common.cancel')}</Button>}
          </div>
        </Card>
      </Section>

      <Section title={t('me.identity')}>
        <Card meta={<Mono>{profile.data?.identity?.publicKeyId}</Mono>}>
          <KV rows={[
            [t('node.fingerprint'), <Mono key="fp">{profile.data?.identity?.fingerprint}</Mono>],
            ['算法', profile.data?.identity?.algorithm ?? 'ed25519'],
          ]} />
          <div className="dshc-row" style={{ marginTop: 10 }}>
            <Button variant="danger" onClick={() => setConfirmExport(true)}>{t('me.exportKey')}</Button>
            <span className="dshc-cardMeta">私钥保存在本机 0600 权限的文件里，不会上传到任何节点。</span>
          </div>
          {confirmExport && !exported && (
            <div style={{ marginTop: 10 }}>
              <Notice tone="error">{t('me.exportWarning')}</Notice>
              <div className="dshc-row">
                <Button
                  variant="danger"
                  onClick={() => action.run(async () => {
                    const result = await client.call('identity.export', {});
                    setExported(result);
                  })}
                >
                  我已了解风险，导出
                </Button>
                <Button variant="ghost" onClick={() => setConfirmExport(false)}>{t('common.cancel')}</Button>
              </div>
            </div>
          )}
          {exported && (
            <div style={{ marginTop: 10 }}>
              <Notice tone="error">{exported.warning}</Notice>
              <pre className="dshc-pre" style={{ maxHeight: 200, overflow: 'auto' }}>
                {JSON.stringify(exported.record, null, 2)}
              </pre>
              <div className="dshc-row">
                <CopyButton
                  text={JSON.stringify(exported.record)}
                  label={t('common.copy')}
                  copiedLabel={t('common.copied')}
                />
                <Button variant="ghost" size="sm" onClick={() => { setExported(null); setConfirmExport(false); }}>
                  {t('common.close')}
                </Button>
              </div>
            </div>
          )}
        </Card>
      </Section>

      <Section title={t('me.privacy')} actions={<Button size="sm" variant="ghost" onClick={overview.reload}>{t('common.refresh')}</Button>}>
        {grants.length === 0 ? <Empty>{t('me.noGrants')}</Empty> : (
          <div className="dshc-list">
            {grants.map((grant) => (
              <Card
                key={grant.sessionId}
                title={<>{truncate(grant.sessionId, 28)} <Badge tone="warn">{grant.mode}</Badge> <Badge>{grant.scope}</Badge></>}
                meta={`授权于 ${formatTime(grant.authorizedAt)}${grant.expiresAt ? ` · 到期 ${formatTime(grant.expiresAt)}` : ''}`}
                actions={
                  <Button size="sm" variant="danger" onClick={() => action.run(async () => {
                    await client.call('consent.revoke', { sessionId: grant.sessionId });
                    overview.reload();
                  })}>{t('me.revoke')}</Button>
                }
              >
                <div className="dshc-row">
                  {grant.contentKinds.map((kind) => <Badge key={kind}>{kind}</Badge>)}
                </div>
              </Card>
            ))}
          </div>
        )}
      </Section>

      <Section title={t('me.myRooms')}>
        {rooms.length === 0 ? <Empty>{t('live.noRoom')}</Empty> : (
          <div className="dshc-list">
            {rooms.map((room) => (
              <Card
                key={room.id}
                title={<>{room.title} {room.status === 'ended' ? <Badge tone="idle">{t('live.ended')}</Badge> : <Badge tone="live">LIVE</Badge>}</>}
                meta={`${room.eventCount} ${t('live.events')} · seq ${room.seq}${room.droppedEvents ? ` · 已裁剪 ${room.droppedEvents}` : ''}`}
              >
                {room.status === 'ended' && (
                  <div className="dshc-row">
                    <Badge tone={room.replayPublished ? 'ok' : 'idle'}>
                      回放：{room.replayPublished ? '已发布' : '未发布'}
                    </Badge>
                    {!room.replayPublished && (
                      <Button size="sm" onClick={() => action.run(async () => {
                        await client.call('live.publishReplay', { roomId: room.id });
                        overview.reload();
                      })}>{t('live.publishReplay')}</Button>
                    )}
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </Section>

      <Section title={t('me.myShares')}>
        {(shares.data ?? []).length === 0 ? <Empty>{t('common.empty')}</Empty> : (
          <div className="dshc-list">
            {(shares.data ?? []).map((share) => (
              <Card
                key={share.id}
                title={share.title}
                meta={`${share.itemCount} ${t('share.items')} · ${formatTime(share.createdAt)}`}
                actions={
                  <Button size="sm" variant="danger" onClick={() => action.run(async () => {
                    await client.call('share.revoke', { id: share.id });
                    shares.reload();
                  })}>{t('share.revoke')}</Button>
                }
              >
                <div className="dshc-cardMeta"><Mono>{truncate(share.id, 52)}</Mono></div>
              </Card>
            ))}
          </div>
        )}
      </Section>

      <Section title="插件目录（本机）">
        <Notice>
          「插件广场」里的签名清单需要发布者用密钥签名后广播；本机已安装的插件来自文件系统，
          <strong>没有签名可验</strong>，所以一律标为未验证来源。
        </Notice>
      </Section>
    </>
  );
}
