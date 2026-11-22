// Identifying operations in addresses: the operationId, or "METHOD /path" when there is none.

/** The key that names an operation in a route. */
export const opKey = op => op.operation.operationId || `${op.method} ${op.path}`;

/** The operation a route key names, or undefined. */
export const findOperation = (ops, key) => ops.find(op => opKey(op) === key);
