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
// per that session's decision -- see adapters/tree_sitter.py and that
// session's artifact for why "Menu" rather than "Item").
//
// Session 105 addition: `Menu` is now the real `Object.assign` compound-
// component pattern session 77 flagged as separately invisible on the
// *definition* side (`const Menu = Object.assign(MenuRoot, {Item:
// MenuItem})` previously produced zero graph node for "Menu" at all -- see
// js_ts_aliases.scm/graph.py's `_resolve_callees`) -- `<Menu.Item>`'s
// existing root-identifier resolution to "Menu" now actually resolves
// through the alias into `MenuRoot`'s real definition, closing that gap
// end-to-end rather than only proving the reference-capture half of it.
// `Tooltip.Arrow = TooltipArrow` (called once, below, as a plain
// `Tooltip.Arrow()`) exercises the session's second, distinct idiom --
// static-property assignment to an already-declared function reference,
// as opposed to `Object.assign`'s two-argument call form. It's called
// directly (not via JSX) because JSX member-expression resolution already
// discards everything but the root identifier ("Tooltip"), so a JSX-only
// usage would never actually exercise the "Arrow" -> `TooltipArrow` alias
// this idiom is meant to test.

import { logEvent } from './logging';
import { findUserByEmail } from './db';

function UserBadge(props: { label: string }): JSX.Element {
  return <span>{props.label}</span>;
}

function MenuRoot(props: { children?: JSX.Element }): JSX.Element {
  return <nav>{props.children}</nav>;
}

function MenuItem(): JSX.Element {
  return <span className="menu-item" />;
}

const Menu = Object.assign(MenuRoot, { Item: MenuItem });

function TooltipArrow(): JSX.Element {
  return <span className="tooltip-arrow" />;
}

function Tooltip(props: { label: string }): JSX.Element {
  return <span className="tooltip">{props.label}</span>;
}
Tooltip.Arrow = TooltipArrow;

export function Dashboard(props: { email: string }): JSX.Element {
  const user = findUserByEmail(props.email);
  logEvent(`rendered dashboard for ${props.email}`);
  Tooltip.Arrow();
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
