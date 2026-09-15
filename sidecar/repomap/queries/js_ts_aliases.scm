; Compound-component alias detection (Session 105), shared by every JS/TS
; manifest entry (javascript, typescript, typescriptreact) -- unlike the
; jsx_*_tags.scm split (session 78), this file needs no per-grammar variant:
; both patterns below use only variable_declarator/call_expression/
; member_expression/assignment_expression/identifier/property_identifier,
; node types every one of those three grammars already shares (confirmed by
; typescript_tags.scm's own header, and every one of these node types is
; already used by the plain tag queries above). Python has none of these
; shapes and gets no `aliasQueryFile` entry at all -- see `languages.json`.
;
; Closes session 77's confirmed, carried-forward "compound-component exports
; vanish entirely" finding: `const Menu = Object.assign(MenuRoot, {Item:
; MenuItem})` and `Tooltip.Arrow = TooltipArrow` both declare a *new*,
; independently-resolvable name whose value is an *already-declared*
; function reference, not a function body of its own -- so neither can (or
; should) become a `@definition.function` Tag the way `javascript_tags.scm`'s
; own `Foo.Bar = () => {...}` pattern does. These captures feed a *separate*
; extraction pass (`TreeSitterAdapter.extract_aliases`, not `extract_tags`)
; that produces `Alias(name, target_name)` facts instead of Tags -- see
; graph.py's `_resolve_callees` for how a reference to the alias name then
; resolves through to the target's own, already-captured definition.
;
; Same predicate caveat as every other query file in this project: `#eq?`
; predicates are NOT evaluated by this project's tree-sitter binding via
; QueryCursor.matches() -- so the `Object.assign(...)` pattern below can't
; itself require the callee text to literally be "Object.assign"; that check
; is done in Python instead (`adapters/tree_sitter.py`'s `extract_aliases`),
; keyed off the `alias.calleeObject`/`alias.calleeMethod` captures.
;
; Session 105 scope note: only the declared alias name and the *first*
; argument/RHS identifier are captured -- e.g. `Object.assign(Root, {Item:
; MenuItem})`'s `Item: MenuItem` pair is NOT turned into a second `Item ->
; MenuItem` alias. That's a deliberate, measured scope cut (see the session
; artifact): JSX usage of a namespaced tag (`<Menu.Item>`) already resolves
; to the member expression's *root* identifier only (session 78's own
; decision, discarding the `.Item` segment entirely), so a second alias for
; the object-literal's own keys would have no reference-side consumer today.
;
; Neither pattern below is naturally scoped to module level -- both shapes
; match identically inside a function body (a local variable holding an
; `Object.assign(...)` merge, or a property assigned from a parameter/local),
; which is a routine, unrelated JS/TS idiom, not a compound-component export.
; Since tree-sitter can't express "not nested inside a function" as a query
; shape (and `#eq?`-style predicates aren't evaluated here either -- see
; above), this is rejected the same way, in Python:
; `adapters/tree_sitter.py`'s `_is_inside_function_scope` walks the matched
; declaration's ancestor chain and drops the match if any ancestor is a
; function/method/arrow -- confirmed via a real reproduced false positive in
; review before this check was added, not a hypothetical concern.

(variable_declarator
  name: (identifier) @name.alias.declared
  value: (call_expression
    function: (member_expression
      object: (identifier) @alias.calleeObject
      property: (property_identifier) @alias.calleeMethod)
    arguments: (arguments
      . (identifier) @name.alias.target))) @alias.compoundExport

(assignment_expression
  left: (member_expression
    property: (property_identifier) @name.alias.declared)
  right: (identifier) @name.alias.target) @alias.staticProperty
