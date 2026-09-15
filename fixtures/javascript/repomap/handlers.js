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

// Exercises the docked panel's "Calls" list scrolling past its ~4-5-row
// max-height, via a real, non-fabricated callee edge for each name (every
// one of these is a genuine import already used elsewhere in this file) --
// 7 real callees. Deliberately avoids two functions this fixture already
// uses as exact-caller-set/blast-radius test anchors:
// `logEvent` (>15-caller/truncation case, REQUIREMENTS.md/
// `test_truncates_callers_past_cap_with_omitted_count`) and `validateEmail`
// (blast-radius root with a hardcoded depth-1/depth-2 caller set,
// `test_get_blast_radius_multi_hop_with_shared_convergent_node` and
// siblings) -- a 9th/3rd real caller on either would shift hardcoded
// counts in tests unrelated to this function's own purpose.
function handleAdminDashboard(req, res) {
  const user = findUserByEmail(req.query.email);
  hashPassword(req.body.newPassword);
  updateUser(user.id, req.body);
  deleteUser(req.body.staleUserId);
  sendWelcomeEmail(user);
  sendPasswordReset(user);
  renderTemplate('admin-dashboard', { user });
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
  handleAdminDashboard,
};
