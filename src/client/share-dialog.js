/**
 * 分享会话对话框（规划 §6.1 分享流程）。
 *
 * 规划把分享流程拆成五步，这个对话框按同样顺序排列：
 *   1. 访问范围 → 2. 内容类型 → 3. 访问者能做什么（是否允许复制）→
 *   4. 由谁保存（MVP 只做本机保存，如实标注）→ 5. 有效期与发布前预览与隐私检查
 *
 * 第 5 步里的**预览是硬前置**：Host 侧的 ConsentGate 在 requirePreview 为真时会拒绝
 * 没有 previewed 标记的授权请求。也就是说，就算有人绕过这个界面直接调 RPC，
 * 也拿不到授权。界面上"必须先看过预览"这句话因此不是提醒，而是事实描述。
 */
import {
  Fragment,
  Badge, Button, Card, Checkbox, Empty, ErrorLine, Field, Input, Modal, Mono, Notice,
  Select, Spinner, h, truncate, useCallback, useEffect, useStableAction, useState,
} from './kit.js';

const SCOPES = ['self', 'friends', 'group', 'link', 'public'];
const MODES = ['standard', 'full', 'minimal'];

/** 各粒度允许的内容类型，与 Host 侧 SHARING_MODE_CONTENT 保持一致。 */
const MODE_KINDS = {
  full: ['prompt', 'answer', 'artifact', 'tool'],
  standard: ['prompt', 'answer', 'artifact'],
  minimal: ['answer'],
};

export function ShareDialog({ client, sessionId, t, onClose, onPublished }) {
  const [mode, setMode] = useState('standard');
  const [scope, setScope] = useState(sessionId ? 'self' : 'self');
  const [kinds, setKinds] = useState(MODE_KINDS.standard);
  const [title, setTitle] = useState('');
  const [copyable, setCopyable] = useState(false);
  const [expiresHours, setExpiresHours] = useState(0);
  const [preview, setPreview] = useState(null);
  const [previewed, setPreviewed] = useState(false);
  const [published, setPublished] = useState(null);
  // run 引用稳定，可安全放进 useEffect 依赖（见 kit.js 的说明）。
  const action = useStableAction();

  const changeMode = (next) => {
    setMode(next);
    // 切换粒度时把勾选收敛到该粒度的上限内——不允许"留着上次勾的工具调用"这种暗坑。
    setKinds((current) => current.filter((kind) => MODE_KINDS[next].includes(kind)));
    // **不重置 previewed**：粒度与勾选只影响"发哪几条"，不影响"用户已经看过预览内容"这个事实。
    // 早先这里把 previewed 置回 false，而自动加载的 effect 依赖没变、不会重跑，
    // 结果是按钮永远灰着、理由还写着"正在加载预览…"——用户被卡在一个假的加载态里。
  };

  const toggleKind = (kind) => {
    // 同上：勾选变化只改变过滤结果，不需要重新拉预览，也不该重置"看过预览"这个状态。
    setKinds((current) => (current.includes(kind) ? current.filter((k) => k !== kind) : [...current, kind]));
  };

  const loadPreview = useCallback(async () => {
    if (!sessionId) return;
    await action.run(async () => {
      const result = await client.call('sessions.preview', { sessionId });
      setPreview(result);
      setPreviewed(true);
    });
  }, [client, sessionId, action.run]);

  // 打开对话框就自动加载预览，理由与开播对话框相同：
  // 主按钮不该以一个"点不动且不说为什么"的状态出现。
  // 依赖里只放 loadPreview（它只依赖稳定的 run），否则会无限重跑。
  useEffect(() => { loadPreview(); }, [loadPreview]);

  const publish = () => action.run(async () => {
    const share = await client.call('share.create', {
      sessionId,
      title,
      scope,
      mode,
      contentKinds: kinds,
      copyable,
      expiresInMs: expiresHours > 0 ? expiresHours * 3600 * 1000 : 0,
      previewed,
    });
    setPublished(share);
    onPublished?.(share);
  });

  const filteredPreview = preview?.items?.filter((item) => kinds.includes(item.contentKind)) ?? [];

  /**
   * 主按钮为什么不可用——必须写在按钮旁边。
   * 之前是"按钮灰着 + 一句提示在很远的地方"，用户读到的是"按钮坏了"。
   */
  const blockedReason = !sessionId ? t('err.noSession')
    : action.busy && !published ? null
      : !previewed ? '正在加载预览…'
        : kinds.length === 0 ? '至少勾选一种要分享的内容类型'
          : filteredPreview.length === 0 ? '当前勾选下没有可分享的内容'
            : null;

  if (!sessionId) {
    return (
      <Modal title={t('share.title')} onClose={onClose}>
        <Empty>请先打开一个会话，再从会话页点击「{t('share.action')}」。</Empty>
      </Modal>
    );
  }

  return (
    <Modal
      title={t('share.title')}
      onClose={onClose}
      footer={
        published ? (
          <Button variant="primary" onClick={onClose}>{t('common.close')}</Button>
        ) : (
          <>
            {blockedReason && <span className="dshc-cardMeta" style={{ flex: 1 }}>{blockedReason}</span>}
            <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              disabled={blockedReason !== null}
              title={blockedReason ?? undefined}
              onClick={publish}
            >
              {action.busy ? t('share.publishing') : t('share.publish')}
            </Button>
          </>
        )
      }
    >
      <ErrorLine error={action.error} />

      {published ? (
        <>
          <Notice tone="info">{t('share.published')}</Notice>
          <Card title={published.title} meta={`${published.itemCount} ${t('share.items')}`}>
            <div className="dshc-row">
              <Badge>{published.policy.scope}</Badge>
              <Badge>{published.policy.mode}</Badge>
              {published.policy.copyable && <Badge tone="ok">可复制</Badge>}
            </div>
            <div className="dshc-cardMeta" style={{ marginTop: 8 }}>
              <div>{t('share.merkle')}</div>
              <Mono>{published.merkleRoot}</Mono>
            </div>
            <div className="dshc-cardMeta" style={{ marginTop: 6 }}>
              <div>分享 ID</div>
              <Mono>{published.id}</Mono>
            </div>
          </Card>
          <Notice>{t('share.honestNote')}</Notice>
        </>
      ) : (
        <>
          <Field label={t('share.titleLabel')}>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：用 AI 从零实现一个 Vue 登录页" />
          </Field>

          <Field label={t('share.scope')} hint="公开内容可以由多个节点缓存；私密内容需要加密后只向被授权者分发密钥。">
            <Select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              options={SCOPES.map((value) => ({ value, label: t(`share.scope.${value}`) }))}
            />
          </Field>

          <Field label={t('share.mode')}>
            <Select
              value={mode}
              onChange={(e) => changeMode(e.target.value)}
              options={MODES.map((value) => ({ value, label: t(`share.mode.${value}`) }))}
            />
          </Field>

          <Field label={t('share.content')} hint="规划要求：不得默认公开完整对话、密钥、私人附件或所有工具执行结果。">
            {MODE_KINDS[mode].map((kind) => (
              <Checkbox
                key={kind}
                label={kind}
                checked={kinds.includes(kind)}
                onChange={() => toggleKind(kind)}
              />
            ))}
          </Field>

          <Field>
            <Checkbox label={t('share.allowCopy')} checked={copyable} onChange={setCopyable} />
          </Field>

          <Field label="有效期（小时，0 表示不过期）">
            <Input
              type="number"
              min="0"
              value={expiresHours}
              onChange={(e) => setExpiresHours(Number(e.target.value) || 0)}
            />
          </Field>

          <Field label={t('share.preview')}>
            <Notice tone="info">{t('share.previewHint')}</Notice>
            <div className="dshc-row" style={{ marginBottom: 6 }}>
              <Button size="sm" variant="ghost" onClick={loadPreview} disabled={action.busy}>{t('common.refresh')}</Button>
              {previewed && <Badge tone="ok">已预览 {filteredPreview.length} 条</Badge>}
              {preview && preview.total !== filteredPreview.length && (
                <span className="dshc-cardMeta">
                  （会话共 {preview.total} 条可分享事件，当前勾选会发出 {filteredPreview.length} 条）
                </span>
              )}
            </div>
          </Field>

          {action.busy && !preview && <Spinner label={t('common.loading')} />}

          {previewed && (
            <div style={{ maxHeight: 320, overflow: 'auto', marginTop: 6 }}>
              {filteredPreview.length === 0 ? <Empty>{t('common.empty')}</Empty> : filteredPreview.map((item) => {
                const redacted = item.redacted?.value?.text ?? item.text;
                const changed = item.redacted?.changed === true;
                return (
                  <div key={item.seq} className="dshc-previewItem" data-role={item.role}>
                    <div className="dshc-rowBetween">
                      <span className="dshc-cardMeta">#{item.seq} · {item.contentKind} · {item.type}</span>
                      {changed && <Badge tone="warn">已脱敏 {item.redacted.reasons.join(',')}</Badge>}
                    </div>
                    <pre className="dshc-pre">{truncate(redacted, 1200)}</pre>
                  </div>
                );
              })}
            </div>
          )}

          {!previewed && (
            <Notice tone="warn">{t('share.previewRequired')}</Notice>
          )}
        </>
      )}
    </Modal>
  );
}
