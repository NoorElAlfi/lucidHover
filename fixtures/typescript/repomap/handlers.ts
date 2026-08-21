// `validateAndPersistSignup` deliberately mirrors fixtures/javascript's own
// handlers.js: two callers (handleSignupRoute, retryQueueWorker), one of
// which -- the retry path -- has no rate limiting. Also the fixture's
// line-shift case (REQUIREMENTS.md structural requirement 4):
// `validateAndPersistSignup` is immediately followed by `handleSignupRoute`
// and `retryQueueWorker`, so editing inside the first shifts the other two's
// line numbers without changing their content.

import { validateEmail, hashPassword } from './utils';
import { insertUser, findUserByEmail, updateUser, deleteUser } from './db';
import { sendWelcomeEmail, sendPasswordReset, renderTemplate } from './email';
import { logEvent } from './logging';
import type { User, Role } from './models';

interface SignupPayload {
  email: string;
  password: string;
}

interface RouteContext {
  body: SignupPayload;
  params: { id: string };
  query: unknown;
}

const updateCache = new Map<number, { user: User; cachedAt: number }>();

export function validateAndPersistSignup(data: SignupPayload): User {
  validateEmail(data.email);
  hashPassword(data.password);
  const user = insertUser(data as unknown as User);
  sendWelcomeEmail(user);
  logEvent(`signup persisted for ${data.email}`);
  return user;
}

export function handleSignupRoute(ctx: RouteContext): User {
  const user = validateAndPersistSignup(ctx.body);
  logEvent('handled signup route');
  return user;
}

export function retryQueueWorker(job: { data: SignupPayload }): User {
  const user = validateAndPersistSignup(job.data);
  logEvent('retried signup from queue');
  return user;
}

export function handleLoginRoute(ctx: RouteContext): User | null {
  const user = findUserByEmail(ctx.body.email);
  hashPassword(ctx.body.password);
  logEvent('handled login route');
  return user;
}

export function handleUpdateRoute(ctx: RouteContext): unknown {
  const user = updateUser(Number(ctx.params.id), ctx.body);
  updateCache.set(Number(ctx.params.id), { user: user as unknown as User, cachedAt: Date.now() });
  logEvent('handled update route');
  return user;
}

export function handleDeleteRoute(ctx: RouteContext): void {
  deleteUser(Number(ctx.params.id));
  logEvent('handled delete route');
}

export function handlePasswordResetRoute(ctx: RouteContext): void {
  sendPasswordReset(ctx.body as unknown as User);
  logEvent('handled password reset route');
}

export function handleRenderRoute(ctx: RouteContext): string {
  const html = renderTemplate('page', ctx.query);
  logEvent('handled render route');
  return html;
}

export function handleHealthCheck(defaultRole: Role): void {
  logEvent(`handled health check (default role ${defaultRole})`);
}
