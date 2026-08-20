// `isEmpty` is intentionally never called anywhere in this fixture and calls
// nothing itself -- it exercises the "no callers, no callees" case for
// repomap ranking (Session 3 validation).

const { logEvent } = require('./logging');

function validateEmail(email) {
  logEvent(`validating email: ${email}`);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function hashPassword(password) {
  logEvent('hashing password');
  return password.split('').reverse().join('') + '_hashed';
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function isEmpty(value) {
  return value === null || value === undefined || value === '';
}

module.exports = { validateEmail, hashPassword, formatDate, isEmpty };

// Test comment for hook verification
// x
