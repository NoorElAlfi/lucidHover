// TS constructs the JS fixture can't exercise: a decorator on a class
// method, and a function whose enclosing scope is a namespace. Both are
// still picked up by the ordinary function/method patterns in
// typescript_tags.scm -- tree-sitter queries match regardless of nesting, so
// no namespace- or decorator-aware pattern is needed for either.

import { logEvent } from './logging';

function traced(_target: unknown, propertyKey: string, _descriptor: PropertyDescriptor): void {
  logEvent(`tracing ${propertyKey}`);
}

export class AuditLogger {
  @traced
  record(event: string): void {
    logEvent(`audit: ${event}`);
  }
}

export namespace AuditNamespace {
  export function recordNamespaced(event: string): void {
    logEvent(`namespaced audit: ${event}`);
  }
}
