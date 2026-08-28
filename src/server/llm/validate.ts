/**
 * Schema validation via ajv (pure JS, no native build).
 *
 * Deliberately not hand-rolled: a silent validation bug here becomes a wrong fact in an email
 * sent to a real person.
 */
import Ajv from "ajv";
import type { ValidateFunction } from "ajv";

const AjvCtor = ((Ajv as unknown as { default?: typeof Ajv }).default ?? Ajv) as typeof Ajv;

const ajv = new AjvCtor({
  allErrors: true,
  strict: false,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
});

const cache = new Map<string, ValidateFunction>();

function compile(schema: object): ValidateFunction {
  const key = JSON.stringify(schema);
  let fn = cache.get(key);
  if (!fn) {
    fn = ajv.compile(schema);
    cache.set(key, fn);
  }
  return fn;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/** Short human sentences, e.g. `/contacts/0/email: must be string`. Fed back to the model verbatim. */
export function validate(schema: object, value: unknown): ValidationResult {
  const fn = compile(schema);
  if (fn(value)) return { ok: true, errors: [] };
  const errors = (fn.errors ?? []).map((e) => {
    const path = e.instancePath || "/";
    const extra = e.params && Object.keys(e.params).length > 0 ? ` (${JSON.stringify(e.params)})` : "";
    return `${path}: ${e.message}${extra}`;
  });
  return { ok: false, errors: errors.slice(0, 20) };
}
