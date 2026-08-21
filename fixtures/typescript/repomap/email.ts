import { formatDate } from './utils';
import { logEvent } from './logging';
import type { User } from './models';

export function sendWelcomeEmail(user: User): boolean {
  const sentOn = formatDate(new Date());
  logEvent(`welcome email queued for ${user.email} on ${sentOn}`);
  return true;
}

export function sendPasswordReset(user: User): boolean {
  logEvent(`password reset email queued for ${user.email}`);
  return true;
}

export function renderTemplate(name: string, data: unknown): string {
  return `<template ${name}>${JSON.stringify(data)}</template>`;
}
