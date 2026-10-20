import { useLocation } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { ALL_NAV } from '../components/Shell';

/** Placeholder for screens scheduled later in Milestone 1. */
export function ComingSoon() {
  const { pathname } = useLocation();
  const item = ALL_NAV.find((n) => n.to === pathname);
  return (
    <div className="soon">
      <div className="ring"><Icon name={item?.icon ?? 'clock'} className="lg" /></div>
      <h1>{item?.label ?? 'This screen'}</h1>
      <p className="muted">The builder screen is next in Milestone 1; it runs on the automation engine from Milestone 2. The design is in the approved HTML prototype.</p>
    </div>
  );
}
