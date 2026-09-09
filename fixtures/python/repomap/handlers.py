# `validate_and_persist_signup` deliberately mirrors the JS/TS fixtures'
# shape (Session 3's original design): two callers, `handle_signup_route` and
# `retry_queue_worker`, immediately following it in this file -- the
# line-shift structural requirement (fixtures/REQUIREMENTS.md #4). Editing
# inside `validate_and_persist_signup` shifts both callers' line numbers
# without changing their content.

from logging import log_event
from utils import validate_email, hash_password
from db import insert_user, find_user_by_email, update_user, delete_user
from email import send_welcome_email, send_password_reset, render_template

update_cache = {}


def validate_and_persist_signup(data):
    validate_email(data["email"])
    hash_password(data["password"])
    user = insert_user(data)
    send_welcome_email(user)
    log_event(f"signup persisted for {data['email']}")
    return user


def handle_signup_route(request):
    user = validate_and_persist_signup(request["body"])
    log_event("handled signup route")
    return user


def retry_queue_worker(job):
    user = validate_and_persist_signup(job["data"])
    log_event("retried signup from queue")
    return user


def handle_login_route(request):
    user = find_user_by_email(request["body"]["email"])
    hash_password(request["body"]["password"])
    log_event("handled login route")
    return user


def handle_update_route(request):
    user = update_user(request["params"]["id"], request["body"])
    update_cache[user["id"]] = user
    log_event("handled update route")
    return user


def handle_delete_route(request):
    delete_user(request["params"]["id"])
    log_event("handled delete route")


def handle_password_reset_route(request):
    send_password_reset(request["body"])
    log_event("handled password reset route")


def handle_render_route(request):
    html = render_template("page", request["query"])
    log_event("handled render route")
    return html


def handle_health_check(request):
    log_event("handled health check")
