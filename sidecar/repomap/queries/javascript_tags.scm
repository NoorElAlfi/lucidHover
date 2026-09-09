; Adapted from Aider-AI/aider's aider/queries/tree-sitter-language-pack/javascript-tags.scm
; (Apache-2.0): https://github.com/Aider-AI/aider/blob/main/aider/queries/tree-sitter-language-pack/javascript-tags.scm
;
; Trimmed for LucidHover's function-level call graph: dropped the @doc
; comment-association patterns (#strip!/#select-adjacent!) since we don't
; extract docstrings here, and dropped class/`new`-expression patterns since
; v0 explains functions, not classes.
;
; NOTE: `#not-eq?`/`#not-match?` predicates are NOT evaluated by this
; project's tree-sitter binding version when queried via QueryCursor.matches()
; -- verified empirically (constructor/require both still matched). So this
; file carries no predicates; the tree-sitter adapter (adapters/tree_sitter.py)
; filters "constructor" defs and "require" calls explicitly in Python instead,
; manifest-driven via each language's `exclusions.defNames`/`refNames`.
;
; Session 78: the same predicate gap applies to the `@reference.jsx` patterns
; below -- a JSX tag name is only a real component/value reference when it's
; capitalized (`<Button>`) or a dotted member expression (`<Menu.Item>`);
; lowercase (`<div>`) is a host element, never a reference. That case check
; can't be expressed as a query predicate here either, so it's applied the
; same way, in Python (`adapters/tree_sitter.py`'s `_case_filtered_name_node`,
; manifest-driven via `exclusions.caseSensitiveRefKinds`). Both
; `jsx_opening_element`/`jsx_self_closing_element` are covered; their `name`
; field is always exactly `identifier` or `member_expression` (confirmed
; empirically), never anything else.

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
