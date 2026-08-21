// Types-only file -- no functions here. Exercises TS constructs the JS
// fixture can't (interfaces, generics via a mapped/utility type, an enum,
// and a plain type alias), consumed by other files in this corpus via
// `import type`. Contributes zero definitions to the call-graph corpus,
// which is a valid case (nothing to miss), not a gap.

export interface User {
  id: number;
  email: string;
  password: string;
}

export type UserFields = Partial<Pick<User, 'email' | 'password'>>;

export enum Role {
  Admin,
  Member,
}
