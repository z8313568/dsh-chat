/**
 * 自研 UI 基础件。
 *
 * 为什么不 import 官方的 primitives：官方 UI 规范**明确禁止**
 * `require('@deepseek-ai/dsh-client-ui-primitives')` 或任何 `@deepseek-ai/dsh-client-*` 包——
 * 它们随时会变，而纯 JS 插件没有类型检查，一个抛错的组件会把整个 slot 渲染成空白
 * （控制台只会留一句 `slot entry crashed in '<slot>'`）。
 *
 * 所以这里自己写控件，只依赖 `--dsw-alias-*` 主题变量，保持与宿主一致的观感。
 */
import * as React from 'react';

export const h = React.createElement;
export const Fragment = React.Fragment;
export const { useState, useEffect, useRef, useCallback, useMemo } = React;

export function cx(...values) {
  return values.filter(Boolean).join(' ');
}

export function Button({ variant = 'default', size, className, children, ...rest }) {
  const variantClass = variant === 'primary' ? 'dshc-btnPrimary'
    : variant === 'danger' ? 'dshc-btnDanger'
      : variant === 'ghost' ? 'dshc-btnGhost' : '';
  return (
    <button
      type="button"
      className={cx('dshc-btn', variantClass, size === 'sm' && 'dshc-btnSm', className)}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Section({ title, children, actions }) {
  return (
    <section className="dshc-section">
      {(title || actions) && (
        <div className="dshc-rowBetween">
          {title ? <h3 className="dshc-sectionTitle">{title}</h3> : <span />}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Card({ title, meta, children, actions, className }) {
  return (
    <div className={cx('dshc-card', className)}>
      {(title || actions) && (
        <div className="dshc-rowBetween">
          <p className="dshc-cardTitle">{title}</p>
          {actions ? <div className="dshc-row">{actions}</div> : null}
        </div>
      )}
      {meta ? <div className="dshc-cardMeta">{meta}</div> : null}
      {children}
    </div>
  );
}

export function Field({ label, hint, children }) {
  return (
    <div className="dshc-field">
      {label ? <label className="dshc-label">{label}</label> : null}
      {children}
      {hint ? <div className="dshc-hint">{hint}</div> : null}
    </div>
  );
}

export function Input(props) {
  return <input className="dshc-input" {...props} />;
}

export function Textarea(props) {
  return <textarea className="dshc-textarea" {...props} />;
}

export function Select({ options, ...rest }) {
  return (
    <select className="dshc-select" {...rest}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  );
}

export function Checkbox({ label, checked, onChange, disabled }) {
  return (
    <label className="dshc-check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function Badge({ tone = 'default', children }) {
  const toneClass = tone === 'live' ? 'dshc-badgeLive'
    : tone === 'ok' ? 'dshc-badgeOk'
      : tone === 'warn' ? 'dshc-badgeWarn'
        : tone === 'idle' ? 'dshc-badgeIdle' : '';
  return <span className={cx('dshc-badge', toneClass)}>{children}</span>;
}

export function Dot({ on }) {
  return <span className={cx('dshc-dot', on && 'dshc-dotOn')} />;
}

export function Notice({ tone = 'info', children }) {
  const toneClass = tone === 'warn' ? 'dshc-noticeWarn' : tone === 'error' ? 'dshc-noticeError' : 'dshc-noticeInfo';
  return <div className={cx('dshc-notice', toneClass)}>{children}</div>;
}

export function Empty({ children }) {
  return <div className="dshc-empty">{children}</div>;
}

export function Mono({ children }) {
  return <span className="dshc-mono">{children}</span>;
}

export function KV({ rows }) {
  return (
    <dl className="dshc-kv">
      {rows.filter(Boolean).map(([key, value]) => (
        <Fragment key={key}>
          <dt>{key}</dt>
          <dd>{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

export function Modal({ title, children, footer, onClose }) {
  // Escape 关闭 + 聚焦：官方规范要求复制宿主控件的行为，这两条是用户真正依赖的。
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="dshc-overlay" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="dshc-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="dshc-modalHead">
          <strong style={{ flex: 1 }}>{title}</strong>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="close">✕</Button>
        </div>
        <div className="dshc-modalBody">{children}</div>
        {footer ? <div className="dshc-modalFoot">{footer}</div> : null}
      </div>
    </div>
  );
}

export function CopyButton({ text, label, copiedLabel }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text ?? '');
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // 剪贴板被拒时保持原样，不弹错误——用户可以直接选中复制。
        }
      }}
    >
      {copied ? copiedLabel : label}
    </Button>
  );
}

export function Spinner({ label }) {
  return <span className="dshc-cardMeta">{label}</span>;
}

/**
 * 把一个 RPC 调用包装成可刷新的状态。
 * `revision` 变化时会重新拉取——实时推送（SSE）到达时把它加一即可。
 */
export function useRpc(client, method, payload, revision = 0) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const payloadKey = JSON.stringify(payload ?? {});
  const seq = useRef(0);

  const reload = useCallback(async () => {
    if (!client) return;
    const current = ++seq.current;
    try {
      const data = await client.call(method, payload ?? {});
      // 只接受最后一次请求的结果，避免快速切换时旧响应覆盖新数据。
      if (current === seq.current) setState({ loading: false, data, error: null });
    } catch (error) {
      if (current === seq.current) setState({ loading: false, data: null, error });
    }
  }, [client, method, payloadKey, revision]);

  useEffect(() => {
    reload();
    return () => { seq.current += 1; };
  }, [reload]);

  return { ...state, reload };
}

/** 定时轮询。SSE 不可用时的兜底。 */
export function usePolling(callback, intervalMs, enabled = true) {
  const saved = useRef(callback);
  saved.current = callback;
  useEffect(() => {
    if (!enabled || !intervalMs) return undefined;
    const timer = setInterval(() => saved.current?.(), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, enabled]);
}

/**
 * 统一处理异步动作的忙碌/错误状态，省掉每个界面重复写三行。
 *
 * 返回对象用 `useMemo` 固定：每次渲染都返回新对象的话，把它放进任何
 * `useEffect` 的依赖数组都会造成「effect 每轮都重跑」。
 *
 * ⚠️ 但即使这样，`action` 仍会随 `busy` 变化——所以**绝对不要把 `action` 本身
 * 放进一个会触发 `action.run()` 的 effect 依赖里**，那是一个自我维持的循环：
 * effect 跑 → run 改 busy → action 变 → effect 再跑 → ……
 * 需要"挂载时跑一次"时，用 `useStableAction()`（见下）。
 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = useCallback(async (fn) => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (cause) {
      setError(cause?.message ?? String(cause));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return useMemo(() => ({ busy, error, run, setError }), [busy, error, run]);
}

/**
 * 给「组件挂载时自动跑一次异步动作」用的版本（比如对话框一打开就加载预览）。
 *
 * 与 `useAction` 的唯一区别：`run` 的引用**永久稳定**（`useCallback([])`），
 * 而 `busy` / `error` 是分开的普通值。于是 `useEffect(..., [run])` 只会跑一次，
 * 不会因为 busy 变化而自我触发。
 *
 * 这个区分是被一次真实的无限循环逼出来的：对话框用了
 * `useEffect(() => { loadPreview(); }, [loadPreview])`，而 `loadPreview` 的依赖里
 * 有 `useAction()` 返回的对象——那个对象每轮渲染都是新的，
 * 于是 effect 每轮都重跑，`setBusy` 又触发下一轮渲染，测试直接挂死。
 */
export function useStableAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = useCallback(async (fn) => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (cause) {
      setError(cause?.message ?? String(cause));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run };
}

/**
 * 错误行。
 *
 * 注意这里必须取出 `message` 再渲染：直接把 Error 对象塞进 JSX 会让 React 抛
 * 「Objects are not valid as a React child」，结果是——**出错时界面反而整个崩掉**，
 * 用户看到的是一片空白而不是错误原因。这个 bug 是渲染冒烟测试抓到的。
 */
export function ErrorLine({ error }) {
  if (!error) return null;
  const text = error instanceof Error
    ? error.message
    : (typeof error === 'string' ? error : (error?.message ?? String(error)));
  return <Notice tone="error">{text}</Notice>;
}

export function formatTime(ms) {
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

export function truncate(text, max = 120) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
