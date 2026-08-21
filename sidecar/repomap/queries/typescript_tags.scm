; TypeScript tags query for LucidHover's function-level call graph.
;
; NOT a port of Aider-AI/aider's aider/queries/tree-sitter-languages/typescript-tags.scm
; (Apache-2.0): that file has zero `@reference.call` patterns (only
; `@reference.type` and `@reference.class`) and doesn't capture arrow-function/
; function-expression assignments the way its own javascript-tags.scm does --
; ported faithfully, it would produce a TypeScript call graph with no call
; edges at all, failing this project's cross-file-resolution requirement.
;
; Instead this is our own javascript_tags.scm's pattern set re-verified
; against tree-sitter-typescript's grammar (Session 24): every JS pattern
; below matches an identically-named TS grammar node (function_declaration,
; generator_function_declaration, variable_declarator, assignment_expression,
; pair, method_definition, call_expression all carry over unchanged -- TS's
; grammar is a superset of JS's here), confirmed empirically before writing
; this file. One addition beyond JS parity: `public_field_definition` with an
; arrow/function value, for TS/class-field-arrow properties (e.g.
; `handler = () => {...}` as a class field), which is idiomatic enough in TS
; to be worth the extra pattern; JS's query has no equivalent capture since it
; was trimmed before class fields came up.
;
; Definitions intentionally out of scope, matching javascript_tags.scm's own
; scope ("v0 explains functions, not classes"): class/interface/type-alias/
; enum/namespace declarations themselves, and any bodyless signature
; (function_signature, method_signature, abstract_method_signature) -- there
; is no function body to explain. Functions *inside* those constructs (a
; method inside a class, a function inside a namespace) are still captured
; normally by the patterns below; tree-sitter queries match regardless of
; nesting, so no namespace/class-aware pattern is needed for that.
;
; Same predicate caveat as javascript_tags.scm: `#not-eq?`/`#not-match?`
; predicates are not evaluated by this project's tree-sitter binding version
; via QueryCursor.matches() -- no predicates here either; extraction.py's
; manifest-driven def/ref-name exclusion filters "constructor" defs in
; Python instead.

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
