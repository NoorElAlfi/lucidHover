# Python construct the JS/TS fixtures can't exercise the same way: a
# decorated class method. Still picked up by the ordinary function pattern in
# python_tags.scm -- tree-sitter queries match regardless of nesting or the
# wrapping `decorated_definition` node, so no decorator-aware pattern is
# needed (Session 83, confirmed directly against this exact shape before
# writing it into a fixture).
#
# `traced` itself has zero real callers: a bare `@traced` decorator
# application is a `decorator` node holding a plain identifier, not a `call`
# node (Session 83's structural finding #2), so it is invisible to a
# call-expression-only query -- the same known, accepted gap TS's own
# `audit.ts` documents for its own `@traced`. `record` is called via
# `logger.record(event)`, an attribute-call (the `(attribute attribute:
# (identifier) @name.reference.call)` branch of python_tags.scm), proving
# Python's no-separate-method-node shape resolves a class method the same
# way a free function does.

from logging import log_event


def traced(fn):
    def wrapper(*args, **kwargs):
        return fn(*args, **kwargs)

    return wrapper


class AuditLogger:
    @traced
    def record(self, event):
        log_event(f"audit write: {event}")


def audit_signup(logger, event):
    logger.record(event)
