/** The single DynamoDB table's key schema. infra/lib/stack.ts defines the
 *  deployed table; the local dev server creates tables from this constant,
 *  and a stack test keeps the two in step. */
export const TABLE_KEYS = {
  partitionKey: "PK",
  sortKey: "SK",
  ttlAttribute: "expiresAt",
} as const;
