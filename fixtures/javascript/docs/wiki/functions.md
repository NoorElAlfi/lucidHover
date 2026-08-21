# Key Functions

Top 24 function(s) repo-wide, ranked by call-graph importance.

| Function | File | Role | Summary |
|---|---|---|---|
| logEvent | [repomap/logging.js:1](repomap/logging.js.md) | Utility | A utility logging function that logs messages with a timestamp. |
| validateEmail | [repomap/utils.js:7](repomap/utils.js.md) | Utility | A utility function that validates an email address using a regular expression. |
| validateAndPersistSignup | [repomap/handlers.js:13](repomap/handlers.js.md) | Utility | A utility function that validates user data and persists the user into the database. |
| hashPassword | [repomap/utils.js:12](repomap/utils.js.md) | Utility | A utility function that takes a password and returns it hashed. |
| formatDate | [repomap/utils.js:17](repomap/utils.js.md) | Utility | A utility function that formats a date to YYYY-MM-DD. |
| updateUser | [repomap/db.js:15](repomap/db.js.md) | Utility | A utility function to update a user in the system. |
| deleteUser | [repomap/db.js:20](repomap/db.js.md) | Utility | A simple utility function that logs an event and returns a boolean indicating success. |
| sendPasswordReset | [repomap/email.js:10](repomap/email.js.md) | Utility | Sends a password reset email to a user. |
| renderTemplate | [repomap/email.js:15](repomap/email.js.md) | Utility | A utility function that takes a template name and data as arguments and returns a string containing the rendered HTML. |
| insertUser | [repomap/db.js:4](repomap/db.js.md) | Utility | Inserts a new user into the database after validating their email. |
| sendWelcomeEmail | [repomap/email.js:4](repomap/email.js.md) | Utility | A utility function that sends a welcome email to a new user after they have been validated and persisted. |
| findUserByEmail | [repomap/db.js:10](repomap/db.js.md) | Utility | A utility function that looks up a user by their email address in the database and logs an event. |
| isEmpty | [repomap/utils.js:21](repomap/utils.js.md) | Utility | A utility function to check if a value is null, undefined, or an empty string. |
| handleSignupRoute | [repomap/handlers.js:22](repomap/handlers.js.md) | Validator | Utility handler for validating and persisting user sign-up requests. |
| retryQueueWorker | [repomap/handlers.js:28](repomap/handlers.js.md) | Utility | A utility function that processes jobs from a queue and retries signup attempts. |
| handleLoginRoute | [repomap/handlers.js:34](repomap/handlers.js.md) | Utility | A utility handler for logging and validating user login requests. |
| handleUpdateRoute | [repomap/handlers.js:41](repomap/handlers.js.md) | Handler | Processes an update request for a specific user. |
| handleDeleteRoute | [repomap/handlers.js:48](repomap/handlers.js.md) | Handler | A simple HTTP DELETE handler that deletes a user from the database and logs an event. |
| handlePasswordResetRoute | [repomap/handlers.js:54](repomap/handlers.js.md) | Utility | Handles password reset requests by sending an email and logging an event. |
| handleRenderRoute | [repomap/handlers.js:60](repomap/handlers.js.md) | Utility | A utility function for rendering web pages based on query parameters. |
| handleHealthCheck | [repomap/handlers.js:66](repomap/handlers.js.md) | Utility | A simple health check endpoint that logs an event and returns a 200 OK response. |
| add | [sample.js:4](sample.js.md) | Utility | A simple utility function that takes two arguments and returns their sum. |
| greet | [sample.js:8](sample.js.md) | Utility | A simple utility function that logs a greeting message to the console and returns it. |
| increment | [sample.js:20](sample.js.md) | Utility | A simple utility function that increments a global counter and returns the new value. |