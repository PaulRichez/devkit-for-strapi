import ts from 'typescript';
import { isStrapi, pluginNameOf } from './patterns';
import { parseSource } from './parse';

/** The service/controller ref a `strapi.service('ref')` / `.controller('ref')` call targets. */
function refOfServiceCall(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const method = callee.name.text;
  if (method !== 'service' && method !== 'controller') return undefined;
  const arg = call.arguments[0];
  const lit = arg && ts.isStringLiteralLike(arg) ? arg.text : undefined;
  if (!lit) return undefined;
  const obj = callee.expression;
  const plugin = pluginNameOf(obj);
  if (plugin !== undefined) return `plugin::${plugin}.${lit}`;
  return isStrapi(obj) ? lit : undefined;
}

export interface MemberRefLocation {
  /** `method:<ref>.<methodName>` */
  key: string;
  /** Char offsets of the method identifier. */
  start: number;
  end: number;
  /** How the call reached the method: inline `member` or via a binding `member-var`. */
  via: 'member' | 'member-var';
}

/** A node that binds its own `this` (everything except an arrow function). */
function isThisBindingFunction(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

/**
 * Method calls on a resolved service/controller — the `notify` in
 * `strapi.service('…').notify()` (`via: 'member'`) **and** the binding form
 * `const e = strapi.service('…'); e.notify()` (`via: 'member-var'`). These
 * reference the service's method — used by find-references, list_unused and
 * method rename so they agree on the forms.
 * *Garantir, ne pas deviner*: alias tracking is **lexically scoped** — a
 * `const e = strapi.service('X')` binding only resolves calls within the block
 * that declares it (and inner blocks), so two functions in the same file each
 * binding the same name to a *different* service don't get merged (which would
 * make a method rename rewrite the wrong call site).
 */
export function collectMemberReferences(filePath: string, text: string): MemberRefLocation[] {
  if (filePath.endsWith('.json') || !/strapi/.test(text)) return [];
  const sf = parseSource(filePath, text);
  const out: MemberRefLocation[] = [];
  // Stack of block scopes; a binding lives in the innermost open scope, a use
  // resolves against the scope chain (innermost first → shadowing works).
  const scopes: Map<string, string>[] = [];
  const resolve = (name: string): string | undefined => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const r = scopes[i]!.get(name);
      if (r !== undefined) return r;
    }
    return undefined;
  };
  const push = (ref: string, name: ts.MemberName, via: 'member' | 'member-var'): void => {
    out.push({ key: `method:${ref}.${name.text}`, start: name.getStart(sf), end: name.getEnd(), via });
  };
  const visit = (node: ts.Node): void => {
    const opensScope = ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node);
    if (opensScope) scopes.push(new Map());
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      const ref = refOfServiceCall(node.initializer);
      if (ref && scopes.length) scopes[scopes.length - 1]!.set(node.name.text, ref);
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (ts.isCallExpression(node.expression)) {
        const ref = refOfServiceCall(node.expression);
        if (ref) push(ref, node.name, 'member');
      } else if (ts.isIdentifier(node.expression)) {
        const ref = resolve(node.expression.text);
        if (ref) push(ref, node.name, 'member-var');
      }
    }
    node.forEachChild(visit);
    if (opensScope) scopes.pop();
  };
  visit(sf);
  return out;
}

export interface ThisMemberAccess {
  name: string;
  start: number;
  end: number;
  /**
   * Start offset of the object literal that owns this `this` — i.e. the object
   * whose method (the nearest enclosing non-arrow function) contains the access.
   * `-1` when the `this` is not bound to an object-literal method (a nested
   * class, a standalone function, or module scope). Matches
   * `factoryObjectRange().start`, so a caller keeps only the factory's OWN
   * self-calls — never a `this.x()` belonging to a nested object with its own
   * `this` (which a rename must not rewrite).
   */
  ownerObjectStart: number;
}

/** The object literal that owns the `this` at `node` (see {@link ThisMemberAccess.ownerObjectStart}). */
function ownerObjectStartOf(node: ts.Node, sf: ts.SourceFile): number {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (ts.isArrowFunction(cur)) continue; // arrows inherit `this` — keep climbing
    if (!isThisBindingFunction(cur)) continue;
    // Found the nearest non-arrow function (the `this` host). Its owning object:
    const p = cur.parent;
    if (p && ts.isObjectLiteralExpression(p)) return p.getStart(sf); // object method shorthand
    if (p && ts.isPropertyAssignment(p) && ts.isObjectLiteralExpression(p.parent)) return p.parent.getStart(sf); // `name: function(){}`
    return -1; // class method / named function → not an object-literal method
  }
  return -1; // module-scope `this`
}

/**
 * `this.<name>` property accesses — a service/controller method calling a sibling
 * (`this.notify()`). The caller resolves `this` to the file's own artifact, so a
 * method used only via `this` is no longer mistaken for dead code. The caller
 * must filter to real indexed actions (we don't guess about unrelated `this.x`)
 * **and** to `ownerObjectStart === factoryObjectRange().start`, so a nested
 * object literal with its own `this` is never attributed to the factory.
 */
export function collectThisMemberReferences(filePath: string, text: string): ThisMemberAccess[] {
  if (filePath.endsWith('.json') || !/this\./.test(text)) return [];
  const sf = parseSource(filePath, text);
  const out: ThisMemberAccess[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword) {
      out.push({
        name: node.name.text,
        start: node.name.getStart(sf),
        end: node.name.getEnd(),
        ownerObjectStart: ownerObjectStartOf(node, sf),
      });
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}
