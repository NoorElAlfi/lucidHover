from logging import log_event
from utils import validate_email


def insert_user(user):
    validate_email(user["email"])
    log_event(f"inserting user {user['email']}")
    return {"id": 1, **user}


def find_user_by_email(email):
    log_event(f"looking up {email}")
    return None


def update_user(user_id, fields):
    log_event(f"updating user {user_id}")
    return {"id": user_id, **fields}


def delete_user(user_id):
    log_event(f"deleting user {user_id}")
    return True
