import type { Contract, JSONSchema7 } from "../core/types.js";

/**
 * Validation issue shaped like a Zod issue, so ToolkitCatalogue's error
 * formatter (issue.path.join + issue.message) works unchanged for
 * schema-validated MCP tools.
 * @public
 */
export interface JsonSchemaIssue {
  path: (string | number)[];
  message: string;
}

interface JsonSchemaValidationFailure {
  success: false;
  error: { issues: JsonSchemaIssue[] };
}

type JsonSchemaValidationResult =
  | { success: true; data: Record<string, unknown> }
  | JsonSchemaValidationFailure;

/**
 * Build a structural Contract from a JSON Schema (the shape MCP servers
 * publish for tool inputs).
 *
 * Validation covers the interoperable subset every mainstream server emits:
 * type (string/number/integer/boolean/object/array/null, single or list),
 * required, properties, items, enum and additionalProperties:false.
 * Unknown keywords are ignored (permissive) - the MCP server performs
 * authoritative validation anyway; this contract exists so the model gets
 * the same structured argument feedback native Zod tools provide, and so
 * the catalogue's strict-validation path stays uniform across sources.
 *
 * The returned contract carries the source schema on a `jsonSchema`
 * property; CapabilityRouter detects it and projects manifests directly
 * from the server's schema instead of round-tripping through Zod.
 *
 * A missing schema yields a permissive contract (pass-through).
 * @public
 */
export function jsonSchemaContract(
  schema: JSONSchema7 | undefined,
): Contract<Record<string, unknown>> & { jsonSchema?: JSONSchema7 } {
  if (schema === undefined) {
    return {
      safeParse(v: unknown): JsonSchemaValidationResult {
        return { success: true, data: (v ?? {}) as Record<string, unknown> };
      },
      parse(v: unknown): Record<string, unknown> {
        return (v ?? {}) as Record<string, unknown>;
      },
    };
  }

  return {
    jsonSchema: schema,
    safeParse(v: unknown): JsonSchemaValidationResult {
      if (v === null || typeof v !== "object" || Array.isArray(v)) {
        return failure([{ path: [], message: "expected an arguments object" }]);
      }
      const issues: JsonSchemaIssue[] = [];
      validateProperties(v as Record<string, unknown>, schema, [], issues);
      return issues.length > 0
        ? failure(issues)
        : { success: true, data: v as Record<string, unknown> };
    },
    parse(v: unknown): Record<string, unknown> {
      const result = this.safeParse(v);
      if (!result.success) {
        const issues = (result.error as { issues: JsonSchemaIssue[] }).issues;
        throw new Error(
          `JSON Schema validation failed: ${issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        );
      }
      return result.data;
    },
  };
}

function failure(issues: JsonSchemaIssue[]): JsonSchemaValidationFailure {
  return { success: false, error: { issues } };
}

function validateProperties(
  value: Record<string, unknown>,
  schema: JSONSchema7,
  path: (string | number)[],
  issues: JsonSchemaIssue[],
): void {
  const properties = isRecord(schema.properties) ? (schema.properties as Record<string, JSONSchema7>) : undefined;
  const required = Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === "string") : [];

  for (const key of required) {
    if (!(key in value)) {
      issues.push({ path: [...path, key], message: "required property is missing" });
    }
  }
  if (properties !== undefined) {
    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in value && childSchema !== null && typeof childSchema === "object") {
        validateValue(value[key], childSchema as JSONSchema7, [...path, key], issues);
      }
    }
  }
  if (schema.additionalProperties === false && properties !== undefined) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) {
        issues.push({ path: [...path, key], message: "additional property is not allowed" });
      }
    }
  }
}

function validateValue(
  value: unknown,
  schema: JSONSchema7,
  path: (string | number)[],
  issues: JsonSchemaIssue[],
): void {
  const types = Array.isArray(schema.type)
    ? schema.type.filter((t): t is string => typeof t === "string")
    : typeof schema.type === "string"
      ? [schema.type]
      : [];

  if (types.length > 0 && !types.some((t) => matchesType(value, t))) {
    issues.push({
      path,
      message: `expected ${types.join(" | ")}, received ${describeType(value)}`,
    });
    return; // Type mismatch voids deeper checks.
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => deepEqual(value, candidate))) {
    issues.push({ path, message: `value must be one of ${JSON.stringify(schema.enum)}` });
    return;
  }

  if (types.includes("object") && isRecord(value)) {
    validateProperties(value, schema, path, issues);
  }
  if (types.includes("array") && Array.isArray(value) && schema.items !== null && typeof schema.items === "object") {
    value.forEach((element, index) =>
      validateValue(element, schema.items as JSONSchema7, [...path, index], issues),
    );
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    default:
      return true; // Unknown type keyword: permissive.
  }
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    return (
      keysA.length === keysB.length &&
      keysA.every((key) => key in b && deepEqual(a[key], b[key]))
    );
  }
  return false;
}
