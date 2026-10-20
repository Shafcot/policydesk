import { useEffect, type ReactNode } from 'react';
import { RES, STG, type CallResult, type Stage } from '../lib/domain';
import { initials } from '../lib/format';
import { Icon } from './Icon';

export const StagePill = ({ stage }: { stage: Stage }) => (
  <span className="pill dotted" style={{ ['--c' as string]: `var(${STG[stage].c})` }}>{STG[stage].n}</span>
);
export const ResultPill = ({ result }: { result: CallResult }) => (
  <span className="pill" style={{ ['--c' as string]: `var(${RES[result].c})` }}>{RES[result].n}</span>
);
export const Pill = ({ color, children }: { color: string; children: ReactNode }) => (
  <span className="pill" style={{ ['--c' as string]: `var(${color})` }}>{children}</span>
);

const AGENT_COLORS = ['--s1', '--s4', '--s5', '--s2', '--s8', '--s3'];
/** Stable colour per person id. */
export const colorFor = (id: string | null | undefined) => {
  if (!id) return '--s9';
  let h = 0; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return AGENT_COLORS[Math.abs(h) % AGENT_COLORS.length];
};
export const Avatar = ({ name, color = '--brand', size = '' }: { name: string; color?: string; size?: '' | 'sm' | 'lg' }) => (
  <span className={`av ${size}`} style={{ ['--c' as string]: `var(${color})` }}>{initials(name)}</span>
);

export const Bar = ({ value, accent, thick }: { value: number; accent?: boolean; thick?: boolean }) => (
  <div className={`bar ${accent ? 'accent' : ''} ${thick ? 'thick' : ''}`}><i style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></div>
);

export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <>
      <div className="overlay" style={{ zIndex: 80 }} onClick={onClose} />
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-h"><h2>{title}</h2><button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button></div>
        <div className="modal-b">{children}</div>
        {footer && <div className="modal-f">{footer}</div>}
      </div>
    </>
  );
}

export const PageHead = ({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) => (
  <div className="page-head"><div><h1>{title}</h1>{sub && <p>{sub}</p>}</div><div className="head-actions">{actions}</div></div>
);

export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;
export const Loading = () => <div className="empty">Loading…</div>;
