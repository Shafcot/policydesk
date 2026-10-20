import { randomBytes } from 'node:crypto';

/** Public booking-page slug, e.g. "maya-3f9a". */
export const makeSlug = (name: string) =>
  `${name.toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9]/g, '') || 'agent'}-${randomBytes(2).toString('hex')}`;
