// Hand-written validator for the JSON Schema subset used by
// schema/now.schema.json. Supported keywords:
//
//   type (object|array|string|number|integer|boolean), const, enum,
//   required, additionalProperties: false, properties, items, maxItems,
//   minLength, maxLength, pattern, format: date | date-time.
//
// `format: date` accepts real calendar dates in YYYY-MM-DD. `format:
// date-time` is the stricter contract this repo declares (README §Contract.4,
// issue #1 §Behaviour): UTC, second precision, trailing Z. A relative or
// offset date is not accepted, which is how `check` rejects "2 hours ago".

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function isDateTime(value) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(
    typeof value === 'string' ? value : '',
  );
  if (!match) return false;
  if (!isDate(match[1])) return false;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  return hours < 24 && minutes < 60 && seconds < 60;
}

function jsonType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function checkType(value, schema, path, errors) {
  if (schema.type === 'integer') {
    if (!(typeof value === 'number' && Number.isInteger(value))) {
      errors.push(`${path}: expected integer, got ${jsonType(value)}`);
      return false;
    }
    return true;
  }
  if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`${path}: expected number, got ${jsonType(value)}`);
      return false;
    }
    return true;
  }
  if (jsonType(value) !== schema.type) {
    errors.push(`${path}: expected ${schema.type}, got ${jsonType(value)}`);
    return false;
  }
  return true;
}

function checkValue(value, schema, path, errors) {
  if (!isPlainObject(schema)) return;

  if (Object.prototype.hasOwnProperty.call(schema, 'const') && !deepEqual(value, schema.const)) {
    errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => deepEqual(entry, value))) {
    errors.push(`${path}: must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}`);
  }

  if (schema.type !== undefined && !checkType(value, schema, path, errors)) {
    return;
  }

  if (typeof value === 'string') {
    const length = Array.from(value).length;
    if (schema.minLength !== undefined && length < schema.minLength) {
      errors.push(`${path}: must be at least ${schema.minLength} character(s)`);
    }
    if (schema.maxLength !== undefined && length > schema.maxLength) {
      errors.push(`${path}: must be at most ${schema.maxLength} character(s)`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: must match ${schema.pattern}`);
    }
    if (schema.format === 'date' && !isDate(value)) {
      errors.push(`${path}: must be an absolute YYYY-MM-DD date`);
    }
    if (schema.format === 'date-time' && !isDateTime(value)) {
      errors.push(`${path}: must be a UTC date-time YYYY-MM-DDTHH:MM:SSZ`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path}: must contain at most ${schema.maxItems} item(s)`);
    }
    if (schema.items !== undefined) {
      value.forEach((entry, index) => {
        checkValue(entry, schema.items, `${path}[${index}]`, errors);
      });
    }
  }

  if (isPlainObject(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          errors.push(`${path}: missing required property "${key}"`);
        }
      }
    }
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const [key, entry] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        checkValue(entry, properties[key], `${path}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: unexpected property "${key}"`);
      }
    }
  }
}

export function validate(value, schema) {
  const errors = [];
  checkValue(value, schema, '$', errors);
  return errors;
}
