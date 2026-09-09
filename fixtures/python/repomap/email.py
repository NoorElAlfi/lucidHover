import datetime

from logging import log_event
from utils import format_date


def send_welcome_email(user):
    sent_on = format_date(datetime.datetime.now())
    log_event(f"welcome email queued for {user['email']} on {sent_on}")
    return True


def send_password_reset(user):
    log_event(f"password reset email queued for {user['email']}")
    return True


def render_template(name, data):
    return f"<template {name}>{data}</template>"
