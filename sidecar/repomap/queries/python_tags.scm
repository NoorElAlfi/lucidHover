; Adapted from Aider-AI/aider's aider/queries/tree-sitter-language-pack/python-tags.scm
; (Apache-2.0): https://github.com/Aider-AI/aider/blob/main/aider/queries/tree-sitter-language-pack/python-tags.scm
;
; Trimmed for LucidHover's function-level call graph, mirroring the exact cut
; javascript_tags.scm already made from its own Aider source: dropped the
; `definition.class`/`definition.constant` patterns since v0 explains
; functions, not classes or module-level assignments.
;
; Unlike JS/TS, no method-specific pattern is needed: Python has no separate
; "method" node type -- a method inside a class body and a free function at
; module scope are both, identically, `function_definition` (confirmed
; directly against the real grammar, Session 83). One pattern below covers
; both; there is deliberately no `definition.method` capture for Python.
;
; No lambda-assignment pattern (`x = lambda: ...`), matching Aider's own
; upstream file, which has none either -- not a LucidHover-specific omission.
;
; No decorator pattern: a decorator is a sibling node to the `function_definition`
; it wraps, not an argument to a call, so it is structurally invisible to a
; call-expression-only query no matter how the call pattern is written
; (Session 83). Aider's own upstream Python query has no decorator handling
; either. Decorator-registration-as-signal (distinct from a call-graph edge)
; is a named, real, explicitly-not-queued follow-up candidate -- see Session
; 83's artifact -- not attempted here.
;
; Same predicate caveat as javascript_tags.scm/typescript_tags.scm: this
; project's tree-sitter binding does not evaluate `#not-eq?`/`#not-match?`
; predicates via QueryCursor.matches(). Aider's own upstream Python query
; carries no predicates to begin with (unlike its JS file), so there is
; nothing to drop here, and this session invented no equivalent exclusion --
; `defNames`/`refNames` both start empty in languages.json's "python" entry
; (Session 83's recommendation: let Session 44's generic ambiguous-
; caller/callee confidence machinery handle same-named defs like `__init__`
; across unrelated files, rather than pre-emptively porting JS's
; pre-Session-44-era `constructor` exclusion forward by analogy).

(function_definition
  name: (identifier) @name.definition.function) @definition.function

(call
  function: [
      (identifier) @name.reference.call
      (attribute
        attribute: (identifier) @name.reference.call)
  ]) @reference.call
