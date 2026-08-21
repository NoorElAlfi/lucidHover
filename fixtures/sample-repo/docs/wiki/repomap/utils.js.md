# repomap/utils.js

The `repomap/utils.js` file contains several utility functions designed to assist with common tasks in the codebase. These functions are categorized under the "Utility" role and serve various purposes such as validating email addresses, hashing passwords, formatting dates, and checking for emptiness. The `validateEmail` function uses a regular expression to ensure that an email address is correctly formatted, while the `hashPassword` function takes a plain text password and returns its SHA-256 hash. The `formatDate` function converts a date object into a string in the format YYYY-MM-DD, which is useful for storing dates in a standardized format. Finally, the `isEmpty` function checks if a value is null, undefined, or an empty string, which is essential for validating user inputs and ensuring data integrity.

## Functions

### validateEmail (Utility)

A utility function that validates an email address using a regular expression.

Line 7.

### hashPassword (Utility)

A utility function that takes a password and returns it hashed.

Line 12.

### formatDate (Utility)

A utility function that formats a date to YYYY-MM-DD.

Line 17.

### isEmpty (Utility)

A utility function to check if a value is null, undefined, or an empty string.

Line 21.
