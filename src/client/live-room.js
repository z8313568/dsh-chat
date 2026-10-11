/**
 * 直播间（规划 §7.3 三段式布局、§7.5 交互、§7.6 权限边界）。
 *
 * 布局按规划实现：顶部（标题/主播/LIVE 状态/事件数）+ 中间（实时会话流）+ 右侧（聊天室）。
 * 中间会话区**只读**——规划 §7.3 明确要求「观众不能直接操作主播的 DSH」，
 * 所以这里没有任何"帮主播发消息"的入口，观众提问走聊天室并由主播自行决定是否采纳。
 *
 * 主播与观众的控件完全分开（规划 §7.6 表格）：暂停/恢复/结束只对主播出现；
 * 观众看到的是"已暂停"提示与补洞信息。
 */
import {
  Fragment,
  Badge, Button, CopyButton, Empty, ErrorLine, KV, Mono, Notice, Spinner,
  formatTime, h, truncate, useAction, useCallback, useEffect, useRpc, useStableAction, useState,
} from './kit.js';

export function LiveRoomDialog({ client, roomId, role = 'host', t, onClose, revision }) {
  const snapshot = useRpc(client, 'live.snapshot', { roomId }, revision);
  const [chatDraft, setChatDraft] = useState('');
  const action = useAction();

  const room = snapshot.data?.room;
  const events = snapshot.data?.events ?? [];
  const chat = snapshot.data?.chat ?? [];

  const sendChat = () => action.run(async () => {
    const text = chatDraft.trim();
    if (!text) return;
    await client.call('live.chat', { roomId, text });
    setChatDraft('');
    snapshot.reload();
  });

  const isHost = role === 'host';

  return (
    <div className="dshc-overlay" role="presentation">
      <div className="dshc-modal" style={{ width: 'min(1040px, 100%)' }} role="dialog" aria-modal="true">
        <div className="dshc-modalHead">
          <strong style={{ flex: 1 }}>
            {room?.title ?? t('common.loading')}{' '}
            {room?.status === 'ended'
              ? <Badge tone="idle">{t('live.ended')}</Badge>
              : room?.paused
                ? <Badge tone="warn">{t('live.paused')}</Badge>
                : <Badge tone="live">LIVE</Badge>}
          </strong>
          {isHost ? (
            <>
              {room?.status !== 'ended' && (room?.paused
                ? <Button size="sm" variant="primary" onClick={() => action.run(async () => {
                  await client.call('live.resume', { roomId }); snapshot.reload();
                })}>{t('live.resume')}</Button>
                : <Button size="sm" onClick={() => action.run(async () => {
                  await client.call('live.pause', { roomId }); snapshot.reload();
                })}>{t('live.pause')}</Button>)}
              {room?.status !== 'ended' && (
                <Button size="sm" variant="danger" onClick={() => action.run(async () => {
                  await client.call('live.close', { roomId, keepReplay: true }); snapshot.reload();
                })}>{t('live.end')}</Button>
              )}
            </>
          ) : (
            <Badge tone="idle">{t('live.hostOnly')}</Badge>
          )}
          <Button size="sm" variant="ghost" onClick={onClose}>{t('common.close')}</Button>
        </div>

        <div className="dshc-modalBody" style={{ display: 'flex', gap: 16, padding: 16 }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <ErrorLine error={snapshot.error ?? action.error} />

            {room?.paused && <Notice tone="warn">{t('live.pausedNotice')}</Notice>}
            {snapshot.data?.droppedEvents > 0 && (
              <Notice tone="warn">
                部分直播事件已被环形裁剪（{snapshot.data.droppedEvents} 条），回放不完整。
              </Notice>
            )}

            <div className="dshc-scroll" style={{ maxHeight: '46vh', flex: 1 }}>
              {snapshot.loading && events.length === 0 ? <Spinner label={t('common.loading')} /> : null}
              {events.length === 0 && !snapshot.loading ? <Empty>{t('common.empty')}</Empty> : null}
              {events.map((event) => (
                <div key={`${event.seq}`} className="dshc-previewItem" data-role={event.payload?.role === 'user' ? 'user' : 'assistant'}>
                  <div className="dshc-rowBetween">
                    <span className="dshc-cardMeta">#{event.seq} · {event.type}</span>
                    <span className="dshc-cardMeta">{formatTime(event.at)}</span>
                  </div>
                  {event.type === 'message_added' || event.type === 'artifact_published' ? (
                    <pre className="dshc-pre">{truncate(event.payload?.text, 2000)}</pre>
                  ) : (
                    <div className="dshc-cardMeta">
                      {event.type === 'session_started' && `开播 · ${event.payload?.title ?? ''} · 粒度 ${event.payload?.mode ?? ''}`}
                      {event.type === 'stream_paused' && `暂停 · ${event.payload?.reason ?? ''}`}
                      {event.type === 'stream_resumed' && '恢复广播'}
                      {event.type === 'session_ended' && `结束 · 时长 ${Math.round((event.payload?.durationMs ?? 0) / 1000)}s`}
                      {event.type === 'message_updated' && '内容更新'}
                    </div>
                  )}
                  {event.sig && (
                    <div className="dshc-cardMeta" style={{ marginTop: 4 }}>
                      签名 <Mono>{truncate(event.sig, 24)}</Mono>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div style={{ width: 280, flex: '0 0 auto', display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--dsw-alias-border-l1)', paddingLeft: 14 }}>
            <h3 className="dshc-sectionTitle">{t('live.chat')}</h3>
            <div className="dshc-scroll" style={{ flex: 1, maxHeight: '42vh', marginBottom: 8 }}>
              {chat.length === 0 ? <Empty>{t('common.empty')}</Empty> : chat.map((message) => (
                <div key={message.id} className="dshc-bubble" style={{ maxWidth: '100%', marginBottom: 6 }}>
                  <strong style={{ fontSize: 11 }}>{message.from}</strong>
                  <div>{message.text}</div>
                  <div className="dshc-bubbleMeta">{formatTime(message.at)}</div>
                </div>
              ))}
            </div>
            <div className="dshc-row">
              <input
                className="dshc-input"
                placeholder={t('live.chatPlaceholder')}
                value={chatDraft}
                onChange={(e) => setChatDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') sendChat(); }}
              />
              <Button size="sm" variant="primary" disabled={action.busy || !chatDraft.trim()} onClick={sendChat}>
                {t('messages.send')}
              </Button>
            </div>
            <div className="dshc-hint">{t('live.injectHint')}</div>

            <div style={{ marginTop: 10 }}>
              <KV rows={[
                [t('live.events'), room?.eventCount ?? 0],
                ['seq', room?.seq ?? 0],
                [t('live.gaps'), snapshot.data?.droppedEvents ?? 0],
                ['范围', room?.scope ?? '—'],
                ['粒度', room?.mode ?? '—'],
              ]} />
            </div>
            {room && (
              <div style={{ marginTop: 8 }}>
                <div className="dshc-cardMeta">直播间 ID</div>
                <Mono>{room.id}</Mono>
                <CopyButton text={room.id} label={t('common.copy')} copiedLabel={t('common.copied')} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 开播对话框。
 *
 * 与分享对话框一样，**预览是硬前置**：Host 的 ConsentGate 在 requirePreview 为真时
 * 会拒绝没有 previewed 标记的开播请求。
 */
export function GoLiveDialog({ client, sessionId, t, onClose, onOpened }) {
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState('');
  const [summary, setSummary] = useState('');
  const [mode, setMode] = useState('standard');
  const [preview, setPreview] = useState(null);
  const [previewed, setPreviewed] = useState(false);
  const [started, setStarted] = useState(false);
  // 用 useStableAction：它的 run 引用永久稳定，可以安全放进 useEffect 依赖。
  const action = useStableAction();

  /**
   * 打开对话框就**自动加载预览**。
   *
   * 之前是"用户必须先点『生成预览』，否则开播按钮是灰的"。这个设计有个很实际的后果：
   * 用户看到的是一个点不动的按钮，界面上只有一句不太起眼的提示，
   * 感受就是「这个按钮坏了」——而且因为 Host 侧强制要求 previewed 标记，
   * 这个动作确实什么都不会发生。
   *
   * 自动加载之后：预览内容在按钮**上方**先渲染出来，用户看到的就是将要广播的东西，
   * 按钮随之可用。既保住了"必须先看过"的语义（内容确实在点击之前就在屏幕上），
   * 又不会给出一个无法点击的主按钮。
   */
  const loadPreview = useCallback(async () => {
    if (!sessionId) return;
    await action.run(async () => {
      const result = await client.call('sessions.preview', { sessionId });
      setPreview(result);
      setPreviewed(true);
    });
  }, [client, sessionId, action.run]);

  // 依赖里只放稳定的 run —— 放整个 action 对象会造成无限循环。
  useEffect(() => { loadPreview(); }, [loadPreview]);

  const items = (preview?.items ?? []).filter((item) => {
    const allowedByMode = mode === 'full' ? ['prompt', 'answer', 'artifact', 'tool']
      : mode === 'minimal' ? ['answer'] : ['prompt', 'answer', 'artifact'];
    return allowedByMode.includes(item.contentKind);
  });

  // 主按钮为什么不可用——必须写在按钮旁边，不能只留在代码里。
  const blockedReason = !sessionId ? t('err.noSession')
    : action.busy ? null
      : !previewed ? '正在加载预览…'
        : items.length === 0 ? '当前粒度下没有可广播的内容，请换一个粒度'
          : null;

  return (
    <div className="dshc-overlay" role="presentation">
      <div className="dshc-modal" role="dialog" aria-modal="true" aria-label={t('live.title')}>
        <div className="dshc-modalHead">
          <strong style={{ flex: 1 }}>{t('live.title')}</strong>
          <Button variant="ghost" size="sm" onClick={onClose}>✕</Button>
        </div>
        <div className="dshc-modalBody">
          <ErrorLine error={action.error} />
          {!sessionId ? <Empty>{t('err.noSession')}</Empty> : (
            <>
              <div className="dshc-field">
                <label className="dshc-label">{t('live.titleLabel')}</label>
                <input className="dshc-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：用 AI 从零实现一个 Vue 登录页" />
              </div>
              <div className="dshc-field">
                <label className="dshc-label">{t('live.tags')}</label>
                <input className="dshc-input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="编程, 学习" />
              </div>
              <div className="dshc-field">
                <label className="dshc-label">{t('live.summary')}</label>
                <textarea className="dshc-textarea" value={summary} onChange={(e) => setSummary(e.target.value)} />
              </div>
              <div className="dshc-field">
                <label className="dshc-label">{t('share.mode')}</label>
                <select className="dshc-select" value={mode} onChange={(e) => setMode(e.target.value)}>
                  <option value="standard">{t('share.mode.standard')}</option>
                  <option value="full">{t('share.mode.full')}</option>
                  <option value="minimal">{t('share.mode.minimal')}</option>
                </select>
              </div>

              <div className="dshc-field">
                <div className="dshc-rowBetween">
                  <label className="dshc-label" style={{ marginBottom: 0 }}>{t('share.preview')}</label>
                  <Button size="sm" variant="ghost" onClick={loadPreview} disabled={action.busy}>
                    {t('common.refresh')}
                  </Button>
                </div>
                <Notice tone="info">{t('share.previewHint')}</Notice>
                {previewed ? (
                  <>
                    <div className="dshc-cardMeta" style={{ marginBottom: 6 }}>
                      当前粒度会广播 <strong>{items.length}</strong> 条（会话共 {preview?.total ?? 0} 条可分享事件）
                    </div>
                    <div style={{ maxHeight: 200, overflow: 'auto' }}>
                      {items.slice(0, 50).map((item) => (
                        <div key={item.seq} className="dshc-previewItem" data-role={item.role}>
                          <div className="dshc-cardMeta">#{item.seq} · {item.contentKind}</div>
                          <pre className="dshc-pre">{truncate(item.redacted?.value?.text ?? item.text, 500)}</pre>
                        </div>
                      ))}
                    </div>
                  </>
                ) : <Spinner label={t('common.loading')} />}
              </div>
            </>
          )}
        </div>
        <div className="dshc-modalFoot">
          {blockedReason && <span className="dshc-cardMeta" style={{ flex: 1 }}>{blockedReason}</span>}
          {started && <span className="dshc-cardMeta">已开播，正在进入直播间…</span>}
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            disabled={blockedReason !== null}
            title={blockedReason ?? undefined}
            onClick={() => action.run(async () => {
              const room = await client.call('live.open', {
                sessionId,
                title,
                tags: tags.split(',').map((s2) => s2.trim()).filter(Boolean),
                summary,
                mode,
                scope: 'public',
                previewed,
              });
              setStarted(true);
              onOpened?.(room);
            })}
          >
            {action.busy ? t('live.opening') : started ? '已开播' : t('live.open')}
          </Button>
        </div>
      </div>
    </div>
  );
}
