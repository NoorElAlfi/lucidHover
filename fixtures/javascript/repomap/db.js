const { validateEmail } = require('./utils');
const { logEvent } = require('./logging');

function insertUser(user) {
  validateEmail(user.email);
  logEvent(`inserting user ${user.email}`);
  return { id: 1, ...user };
}

function findUserByEmail(email) {
  logEvent(`looking up ${email}`);
  return null;
}

function updateUser(id, fields) {
  logEvent(`updating user ${id}`);
  return { id, ...fields };
}

function deleteUser(id) {
  logEvent(`deleting user ${id}`);
  return true;
}

module.exports = { insertUser, findUserByEmail, updateUser, deleteUser };
