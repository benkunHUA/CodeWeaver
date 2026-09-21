type JsonSchemaType = "object" | "array" | "string" | "integer" | "number" | "boolean";

export interface JsonSchemaProperty {
  readonly type?: JsonSchemaType | readonly JsonSchemaType[];
  readonly minimum?: number;
  readonly minLength?: number;
  readonly items?: JsonSchemaProperty;
}

export interface JsonSchemaObject {
  readonly type: "object";
  readonly properties?: Readonly<Record<string, JsonSchemaProperty>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}

function isObject(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function matchesScalarType(input: unknown, expected: JsonSchemaType): boolean {
  if (expected === "string") return typeof input === "string";
  if (expected === "integer") return Number.isInteger(input);
  if (expected === "number") return typeof input === "number" && Number.isFinite(input);
  if (expected === "boolean") return typeof input === "boolean";
  if (expected === "array") return Array.isArray(input);
  if (expected === "object") return isObject(input);
  return false;
}

function matchesType(input: unknown, expected: JsonSchemaProperty["type"]): boolean {
  if (expected === undefined) return true;
  const list = Array.isArray(expected) ? expected : [expected];
  return list.some((type) => matchesScalarType(input, type));
}

function validatePropertySchema(
  name: string,
  value: unknown,
  schema: JsonSchemaProperty,
): string[] {
  const errors: string[] = [];
  if (!matchesType(value, schema.type)) {
    const kinds = Array.isArray(schema.type) ? schema.type.join("|") : (schema.type ?? "any");
    errors.push(`${name} must be ${kinds}`);
    return errors;
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${name} must be >= ${schema.minimum}`);
  }
  if (typeof value === "string" && schema.minLength !== undefined && Array.from(value).length < schema.minLength) {
    errors.push(`${name} must have at least ${schema.minLength} characters`);
  }
  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    value.forEach((item, index) => {
      errors.push(...validatePropertySchema(`${name}[${index}]`, item, schema.items as JsonSchemaProperty));
    });
  }
  return errors;
}

export function validateObjectSchema(
  name: string,
  input: unknown,
  schema: JsonSchemaObject,
): string[] {
  const errors: string[] = [];
  if (!isObject(input)) {
    errors.push(`${name} must be object`);
    return errors;
  }
  for (const required of schema.required ?? []) {
    if (!(required in input)) {
      errors.push(`${required} is required`);
    }
  }
  const properties = schema.properties ?? {};
  for (const key of Object.keys(properties)) {
    if (!(key in input)) continue;
    errors.push(...validatePropertySchema(`${name}.${key}`, input[key], properties[key] as JsonSchemaProperty));
  }
  return errors;
}
