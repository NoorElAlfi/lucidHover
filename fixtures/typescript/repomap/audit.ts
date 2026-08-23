// TS constructs the JS fixture can't exercise: a decorator on a class
// method, and a function whose enclosing scope is a namespace. Both are
// still picked up by the ordinary function/method patterns in
// typescript_tags.scm -- tree-sitter queries match regardless of nesting, so
// no namespace- or decorator-aware pattern is needed for either.
//
// Session 49: `auditWrite` (a top-level arrow-const -- the same
// `variable_declarator` + `arrow_function` shape session 25 found the
// `isFunctionLike` bug on) sits between `AuditLogger.record` (a class
// method) and `logEvent` (a free function), giving the graph-view features
// (blast radius, execution trace) a real class-method -> arrow-const ->
// free-function chain to walk -- nothing else in this fixture mixes all
// three shapes in one chain.

import { logEvent } from './logging';

function traced(_target: unknown, propertyKey: string, _descriptor: PropertyDescriptor): void {
  logEvent(`tracing ${propertyKey}`);
}

const auditWrite = (event: string): void => {
  logEvent(`audit write: ${event}`);
};

export class AuditLogger {
  @traced
  record(event: string): void {
    auditWrite(event);
  }
}

export namespace AuditNamespace {
  export function recordNamespaced(event: string): void {
    logEvent(`namespaced audit: ${event}`);
  }
}
