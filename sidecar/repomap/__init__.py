"""
repomap: per-function call-graph ranking for LucidHover.

Adapted from Aider-AI/aider's aider/repomap.py (Apache-2.0):
https://github.com/Aider-AI/aider/blob/main/aider/repomap.py

Aider's original builds a *whole-repo* map (tree-sitter tag extraction ->
file-level PageRank -> token-budget binary-search packing) to fit as much
relevant repo context as possible into a chat prompt. LucidHover only needs,
for one function at a time, its direct callers and callees ranked by global
call-graph importance so the ~15-each cap in the spec's Context Budget can
decide what to keep. That narrower goal let this port diverge from Aider in
three ways (see individual module docstrings for detail):

  - graph.py builds a *function-level* call graph (nodes are individual
    definitions), not Aider's file-level MultiDiGraph -- callers/callees of a
    specific function is exactly what's needed here, and file-level ranks
    would have to be redistributed back down to functions anyway.
  - rank.py runs plain, unpersonalized nx.pagerank() -- Aider's
    chat-file/mentioned-identifier personalization exists to bias a whole-repo
    map toward what the user is actively discussing, which doesn't apply to
    indexing every function uniformly.
  - No token-budget binary search: the spec caps caller/callee lists at a
    fixed count (~15) rather than a token budget, so context.py does a
    straight rank-and-slice instead of Aider's render/estimate/retry loop.

Tag extraction (extraction.py) and the tree-sitter query file
(queries/javascript_tags.scm) stay close to Aider's approach since that part
of the problem -- extract named defs/refs from source via tree-sitter -- is
unchanged by the narrower goal.
"""
