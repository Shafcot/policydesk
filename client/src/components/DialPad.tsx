// Phone keypad: the dial pad for typing a number, and in-call touch tones (press 1 for sales…).
import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

const KEYS: [string, string][] = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'], ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', '+'], ['#', '']];

export function Keypad({ onKey, compact }: { onKey: (k: string) => void; compact?: boolean }) {
  return (
    <div className={`keypad ${compact ? 'compact' : ''}`}>
      {KEYS.map(([k, sub]) => (
        <button key={k} type="button" className="key" onClick={() => onKey(k)} aria-label={k === '*' ? 'star' : k === '#' ? 'pound' : k}>
          <span>{k}</span>{!compact && <small>{sub || ' '}</small>}
        </button>
      ))}
    </div>
  );
}

/** Formats as the agent types: (512) 555-0123, or leaves +international numbers alone. */
export const formatTyped = (v: string) => {
  if (v.startsWith('+') && !v.startsWith('+1')) return v;
  const d = v.replace(/\D/g, '').replace(/^1(?=\d{10})/, '');
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  if (d.length <= 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return v;
};

/** Number entry + keypad + call button. Typing on the keyboard works too. */
export function DialPad({ onCall, busy, error, callingFrom }: { onCall: (number: string) => void; busy?: boolean; error?: string; callingFrom?: string | null }) {
  const [v, setV] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const digits = v.replace(/[^\d+]/g, '');
  const valid = digits.replace(/\D/g, '').length >= 10 || (digits.startsWith('+') && digits.length >= 9);
  const press = (k: string) => { setV((x) => (k === '+' ? (x ? x : '+') : x + k)); input.current?.focus(); };
  return (
    <form className="dialpad" onSubmit={(e) => { e.preventDefault(); if (valid && !busy) onCall(digits); }}>
      <div className="dial-display">
        <input ref={input} className="mono" inputMode="tel" autoComplete="off" placeholder="Enter a number" value={formatTyped(v)} aria-label="Phone number"
          onChange={(e) => setV(e.target.value.replace(/[^\d+*#]/g, ''))} />
        {v && <button type="button" className="icon-btn sm" onClick={() => setV((x) => x.slice(0, -1))} onDoubleClick={() => setV('')} aria-label="Delete digit" title="Delete (double-click to clear)"><Icon name="left" className="sm" /></button>}
      </div>
      <Keypad onKey={(k) => press(k === '0' && v === '' ? '0' : k)} />
      {error && <p className="optout" role="alert">{error}</p>}
      <button className="btn accent lg dial-call" disabled={!valid || busy} aria-label="Call"><Icon name="phone" className="sm" />{busy ? 'Checking…' : 'Call'}</button>
      {callingFrom !== undefined && <small className="help" style={{ textAlign: 'center' }}>{callingFrom ? `Calling from ${callingFrom}` : 'Calling from the agency’s default number'}</small>}
    </form>
  );
}
