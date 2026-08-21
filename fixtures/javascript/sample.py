# Fixture for the "no adapter" test (Session 22): languages.json has no
# python entry, so every LucidHover provider must return nothing for this
# file -- not an empty/placeholder hover or lens, no invocation at all.


def add(a, b):
    return a + b
