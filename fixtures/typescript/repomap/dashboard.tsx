// The only `.tsx` file in this corpus -- proves the `typescriptreact`
// manifest entry's `language_tsx` grammar (not `language_typescript`, which
// misparses real JSX -- confirmed directly before adding this file: it
// still finds top-level definitions but silently drops call references
// inside JSX) is actually wired up, and that its cross-file calls resolve
// into the `.ts` files above by name, same as any other file in this repo.
//
// Session 78 addition: exercises the new jsx_opening_element/
// jsx_self_closing_element reference capture (typescript_tsx_tags.scm) --
// `UserBadge` (a capitalized component, used 3x, must now show up as a real
// captured caller edge from `Dashboard`), the pre-existing lowercase `<div>`
// host element (must NOT produce a reference at all -- confirmed at the
// extraction level, not just absence from the graph), and `<Menu.Item>` (a
// namespaced/compound usage that resolves to its root identifier, `Menu`,
// per this session's decision -- see adapters/tree_sitter.py and the
// session artifact for why "Menu" rather than "Item"). `Menu` is defined
// here as a plain function, not the `Object.assign` compound-component
// pattern session 77 found separately invisible on the *definition* side
// (that gap is unrelated and still open) -- specifically so this reference
// resolves into a real definition, proving the capture/resolution
// mechanism itself end-to-end.

import { logEvent } from './logging';
import { findUserByEmail } from './db';

function UserBadge(props: { label: string }): JSX.Element {
  return <span>{props.label}</span>;
}

function Menu(props: { children?: JSX.Element }): JSX.Element {
  return <nav>{props.children}</nav>;
}

export function Dashboard(props: { email: string }): JSX.Element {
  const user = findUserByEmail(props.email);
  logEvent(`rendered dashboard for ${props.email}`);
  return (
    <div className="dashboard">
      <UserBadge label="primary" />
      <UserBadge label="secondary" />
      <UserBadge label="tertiary" />
      <Menu.Item />
      {user ? user.email : 'unknown'}
    </div>
  );
}
