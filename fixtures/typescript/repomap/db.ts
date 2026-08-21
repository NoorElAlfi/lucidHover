import { validateEmail } from './utils';
import { logEvent } from './logging';
import type { User, UserFields } from './models';

export function insertUser(user: User): User {
  validateEmail(user.email);
  logEvent(`inserting user ${user.email}`);
  return { id: 1, ...user };
}

export function findUserByEmail(email: string): User | null {
  logEvent(`looking up ${email}`);
  return null;
}

export function updateUser(id: number, fields: UserFields): UserFields & { id: number } {
  logEvent(`updating user ${id}`);
  return { id, ...fields };
}

export function deleteUser(id: number): boolean {
  logEvent(`deleting user ${id}`);
  return true;
}
