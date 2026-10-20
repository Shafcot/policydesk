import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { Icon } from '../components/Icon';

type Toast = { id: number; text: string; icon: string };
const Ctx = createContext<(text: string, icon?: string) => void>(() => {});
let n = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback((text: string, icon = 'check') => {
    const id = ++n;
    setList((l) => [...l, { id, text, icon }]);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), 4200);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div id="toasts" aria-live="polite">
        {list.map((t) => <div className="toast" key={t.id}><Icon name={t.icon} /><span>{t.text}</span></div>)}
      </div>
    </Ctx.Provider>
  );
}
export const useToast = () => useContext(Ctx);
