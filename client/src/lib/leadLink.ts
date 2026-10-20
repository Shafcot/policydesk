import { useSearchParams } from 'react-router-dom';

/** Opens the lead page over the current screen (?lead=<id>). */
export function useOpenLead() {
  const [, setParams] = useSearchParams();
  return (id: string) => setParams((p) => { p.set('lead', id); return p; });
}
