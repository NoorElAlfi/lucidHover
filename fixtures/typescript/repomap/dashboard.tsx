// The only `.tsx` file in this corpus -- proves the `typescriptreact`
// manifest entry's `language_tsx` grammar (not `language_typescript`, which
// misparses real JSX -- confirmed directly before adding this file: it
// still finds top-level definitions but silently drops call references
// inside JSX) is actually wired up, and that its cross-file calls resolve
// into the `.ts` files above by name, same as any other file in this repo.

import { logEvent } from './logging';
import { findUserByEmail } from './db';

export function Dashboard(props: { email: string }): JSX.Element {
  const user = findUserByEmail(props.email);
  logEvent(`rendered dashboard for ${props.email}`);
  return <div className="dashboard">{user ? user.email : 'unknown'}</div>;
}
