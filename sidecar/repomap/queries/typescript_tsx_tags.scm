; TSX tags query, for the `typescriptreact` manifest entry (`.tsx`,
; `language_tsx` grammar) only -- NOT shared with plain `typescript_tags.scm`
; (`.ts`, `language_typescript` grammar).
;
; Session 78: this file exists because `Query()` construction throws
; "Invalid node type: jsx_opening_element" when compiled against
; `language_typescript()` -- confirmed empirically before writing this --
; since the plain (non-JSX) TypeScript grammar has no JSX node types at all.
; A single shared query file with JSX patterns would therefore crash adapter
; registration for the plain `typescript` entry, which reuses the same
; grammar family but not the JSX-capable grammar function. So this file
; duplicates typescript_tags.scm's non-JSX patterns verbatim (any future
; change to those patterns must be made in both files -- there is no clean
; way to `#include` one `.scm` file from another) and adds the JSX-specific
; patterns at the bottom. See typescript_tags.scm's own header for why *it*
; doesn't just carry these patterns instead.
;
; Same predicate caveat as the other two query files: `#not-eq?`/
; `#not-match?` predicates are not evaluated by this project's tree-sitter
; binding via QueryCursor.matches() -- no predicates here; the tree-sitter
; adapter's manifest-driven def/ref-name exclusion filters "constructor"
; defs in Python instead, and the JSX patterns' case-based component-vs-
; host-element filter is applied the same way (see
; adapters/tree_sitter.py's `_case_filtered_name_node`, manifest-driven via
; `exclusions.caseSensitiveRefKinds`). Both `jsx_opening_element`/
; `jsx_self_closing_element` are covered; their `name` field is always
; exactly `identifier` or `member_expression` (confirmed empirically against
; this exact grammar), never anything else.

(function_declaration
  name: (identifier) @name.definition.function) @definition.function

(function_expression
  name: (identifier) @name.definition.function) @definition.function

(generator_function_declaration
  name: (identifier) @name.definition.function) @definition.function

(variable_declarator
  name: (identifier) @name.definition.function
  value: [(arrow_function) (function_expression)]) @definition.function

(assignment_expression
  left: [
    (identifier) @name.definition.function
    (member_expression
      property: (property_identifier) @name.definition.function)
  ]
  right: [(arrow_function) (function_expression)]) @definition.function

(pair
  key: (property_identifier) @name.definition.function
  value: [(arrow_function) (function_expression)]) @definition.function

(public_field_definition
  name: (property_identifier) @name.definition.function
  value: [(arrow_function) (function_expression)]) @definition.function

(method_definition
  name: (property_identifier) @name.definition.method) @definition.method

(call_expression
  function: (identifier) @name.reference.call) @reference.call

(call_expression
  function: (member_expression
    property: (property_identifier) @name.reference.call)
  arguments: (_) @reference.call)

(jsx_opening_element
  name: (identifier) @name.reference.jsx) @reference.jsx

(jsx_self_closing_element
  name: (identifier) @name.reference.jsx) @reference.jsx

(jsx_opening_element
  name: (member_expression) @name.reference.jsx) @reference.jsx

(jsx_self_closing_element
  name: (member_expression) @name.reference.jsx) @reference.jsx
