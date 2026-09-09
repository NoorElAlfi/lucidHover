# `is_empty` is intentionally never called anywhere in this fixture and calls
# nothing itself -- it exercises the "no callers, no callees" case for
# repomap ranking (mirrors fixtures/javascript/repomap/utils.js).

import re

from logging import log_event


def validate_email(email):
    log_event(f"validating email: {email}")
    return re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", email) is not None


def hash_password(password):
    log_event("hashing password")
    return password[::-1] + "_hashed"


def format_date(date):
    return date.isoformat()[:10]


def is_empty(value):
    return value is None or value == ""
