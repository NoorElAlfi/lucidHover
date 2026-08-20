// `validateAndPersistSignup` deliberately mirrors the spec's Output Schema
// example (Session 3): two callers (handleSignupRoute, retryQueueWorker),
// one of which -- the retry path -- has no rate limiting, same as the
// `risk_note` example in codebase-explainer-vscode-extension.md.

const { validateEmail, hashPassword } = require('./utils');
const { insertUser, findUserByEmail, updateUser, deleteUser } = require('./db');
const { sendWelcomeEmail, sendPasswordReset, renderTemplate } = require('./email');
const { logEvent } = require('./logging');

const updateCache = new Map();

function validateAndPersistSignup(data) {
  validateEmail(data.email);
  hashPassword(data.password);
  const user = insertUser(data);
  sendWelcomeEmail(user);
  logEvent(`signup persisted for ${data.email}`);
  return user;
}

function handleSignupRoute(req, res) {
  const user = validateAndPersistSignup(req.body);
  logEvent('handled signup route');
  res.json(user);
}

function retryQueueWorker(job) {
  const user = validateAndPersistSignup(job.data);
  logEvent('retried signup from queue');
  return user;
}

function handleLoginRoute(req, res) {
  const user = findUserByEmail(req.body.email);
  hashPassword(req.body.password);
  logEvent('handled login route');
  res.json(user);
}

function handleUpdateRoute(req, res) {
  const user = updateUser(req.params.id, req.body);
  updateCache.set(user.id, { user, cachedAt: Date.now() });
  logEvent('handled update route');
  res.json(user);
}

function handleDeleteRoute(req, res) {
  deleteUser(req.params.id);
  logEvent('handled delete route');
  res.status(204).end();
}

function handlePasswordResetRoute(req, res) {
  sendPasswordReset(req.body);
  logEvent('handled password reset route');
  res.status(202).end();
}

function handleRenderRoute(req, res) {
  const html = renderTemplate('page', req.query);
  logEvent('handled render route');
  res.send(html);
}

function handleHealthCheck(req, res) {
  logEvent('handled health check');
  res.status(200).end();
}

module.exports = {
  validateAndPersistSignup,
  handleSignupRoute,
  retryQueueWorker,
  handleLoginRoute,
  handleUpdateRoute,
  handleDeleteRoute,
  handlePasswordResetRoute,
  handleRenderRoute,
  handleHealthCheck,
};
