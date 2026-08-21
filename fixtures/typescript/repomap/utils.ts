// `isEmpty` is intentionally never called anywhere in this fixture and calls
// nothing itself -- it exercises the "no callers, no callees" case for
// repomap ranking (mirrors fixtures/javascript/repomap/utils.js). Made
// generic here to double as the fixture's generics requirement.

import { logEvent } from './logging';

export function validateEmail(email: string): boolean {
  logEvent(`validating email: ${email}`);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function hashPassword(password: string): string {
  logEvent('hashing password');
  return password.split('').reverse().join('') + '_hashed';
}

export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function isEmpty<T>(value: T | null | undefined): boolean {
  return value === null || value === undefined || (value as unknown) === '';
}
