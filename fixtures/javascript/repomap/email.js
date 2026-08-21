const { formatDate } = require('./utils');
const { logEvent } = require('./logging');

function sendWelcomeEmail(user) {
  const sentOn = formatDate(new Date());
  logEvent(`welcome email queued for ${user.email} on ${sentOn}`);
  return true;
}

function sendPasswordReset(user) {
  logEvent(`password reset email queued for ${user.email}`);
  return true;
}

function renderTemplate(name, data) {
  return `<template ${name}>${JSON.stringify(data)}</template>`;
}

module.exports = { sendWelcomeEmail, sendPasswordReset, renderTemplate };
