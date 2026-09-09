# Fixture for the "no adapter" test (Session 22; probe language changed from
# Python to Ruby in Session 91, once Python gained a real adapter). Ruby has
# no languages.json entry, so every LucidHover provider must return nothing
# for this file -- not an empty/placeholder hover or lens, no invocation at
# all.

def add(a, b)
  a + b
end
