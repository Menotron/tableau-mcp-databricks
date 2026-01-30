/**
 * Schema Simplification Layer for Databricks Compatibility
 * 
 * Databricks MCP clients struggle with complex JSON schemas that contain:
 * - anyOf/oneOf discriminated unions
 * - Deeply nested objects
 * - $ref cross-references
 * 
 * This module flattens these schemas to simpler structures that
 * Databricks clients can deserialize.
 */

interface JsonSchema {
    type?: string | string[];  // Can be single type or array like ["string", "null"]
    properties?: Record<string, JsonSchema>;
    items?: JsonSchema;
    required?: string[];
    anyOf?: JsonSchema[];
    oneOf?: JsonSchema[];
    allOf?: JsonSchema[];
    $ref?: string;
    $defs?: Record<string, JsonSchema>;
    definitions?: Record<string, JsonSchema>;
    enum?: unknown[];
    const?: unknown;
    description?: string;
    default?: unknown;
    additionalProperties?: boolean | JsonSchema;
    [key: string]: unknown;
}

/**
 * Normalize type arrays to single types for Databricks compatibility.
 * Databricks Java client cannot deserialize type: ["number", "string", "null"]
 * Use the first non-null type.
 */
function normalizeType(type: string | string[] | undefined): string | undefined {
    if (!type) return undefined;
    if (typeof type === 'string') return type;

    // It's an array - find first non-null type
    const nonNullTypes = type.filter(t => t !== 'null');
    if (nonNullTypes.length > 0) {
        return nonNullTypes[0];
    }
    // All types are null - return null (shouldn't happen in practice)
    return 'null';
}

/**
 * Simplify a JSON schema for Databricks compatibility.
 * 
 * Transformations:
 * 1. Convert type arrays to single type (pick first non-null)
 * 2. Flatten anyOf/oneOf to object with all optional properties
 * 3. Inline $ref references
 * 4. Remove $defs/definitions
 * 5. Limit nesting depth
 */
export function simplifySchemaForDatabricks(
    schema: JsonSchema,
    maxDepth: number = 4,
    currentDepth: number = 0,
    definitions?: Record<string, JsonSchema>
): JsonSchema {
    // Collect definitions from root
    const defs = definitions || schema.$defs || schema.definitions || {};

    // If we've exceeded max depth, return a generic object type
    if (currentDepth > maxDepth) {
        return { type: 'object', additionalProperties: true };
    }

    // Normalize type arrays to single types
    let schemaToProcess = schema;
    if (Array.isArray(schema.type)) {
        schemaToProcess = { ...schema, type: normalizeType(schema.type) };
    }

    // Handle $ref - inline the reference
    if (schemaToProcess.$ref) {
        const refPath = schemaToProcess.$ref.replace('#/$defs/', '').replace('#/definitions/', '');
        const refSchema = defs[refPath];
        if (refSchema) {
            return simplifySchemaForDatabricks(refSchema, maxDepth, currentDepth, defs);
        }
        // If ref not found, return generic object
        return { type: 'object', additionalProperties: true };
    }

    // Handle anyOf/oneOf - merge all options into single object with all properties optional
    if (schemaToProcess.anyOf || schemaToProcess.oneOf) {
        const options = schemaToProcess.anyOf || schemaToProcess.oneOf || [];
        return mergeSchemaOptions(options, maxDepth, currentDepth, defs);
    }

    // Handle allOf - merge all schemas
    if (schemaToProcess.allOf) {
        return mergeSchemaOptions(schemaToProcess.allOf, maxDepth, currentDepth, defs);
    }

    // Handle object type - recurse into properties
    if (schemaToProcess.type === 'object' && schemaToProcess.properties) {
        const simplifiedProperties: Record<string, JsonSchema> = {};

        for (const [key, propSchema] of Object.entries(schemaToProcess.properties)) {
            simplifiedProperties[key] = simplifySchemaForDatabricks(
                propSchema,
                maxDepth,
                currentDepth + 1,
                defs
            );
        }

        return {
            type: 'object',
            properties: simplifiedProperties,
            required: schemaToProcess.required,
            ...(schemaToProcess.description && { description: schemaToProcess.description }),
            ...(schemaToProcess.additionalProperties !== undefined && { additionalProperties: schemaToProcess.additionalProperties }),
        };
    }

    // Handle array type - simplify items
    if (schemaToProcess.type === 'array' && schemaToProcess.items) {
        return {
            type: 'array',
            items: simplifySchemaForDatabricks(schemaToProcess.items, maxDepth, currentDepth + 1, defs),
            ...(schemaToProcess.description && { description: schemaToProcess.description }),
        };
    }

    // Handle primitive types - copy essential properties
    const simplified: JsonSchema = {};

    // Use normalized type (always string, never array)
    if (schemaToProcess.type) simplified.type = schemaToProcess.type;
    if (schemaToProcess.enum) simplified.enum = schemaToProcess.enum;
    if (schemaToProcess.const !== undefined) simplified.const = schemaToProcess.const;
    if (schemaToProcess.description) simplified.description = schemaToProcess.description;
    if (schemaToProcess.default !== undefined) simplified.default = schemaToProcess.default;

    // If no type but has enum, infer type from enum values
    if (!simplified.type && simplified.enum && simplified.enum.length > 0) {
        const firstValue = simplified.enum[0];
        if (typeof firstValue === 'string') simplified.type = 'string';
        else if (typeof firstValue === 'number') simplified.type = 'number';
        else if (typeof firstValue === 'boolean') simplified.type = 'boolean';
    }

    return Object.keys(simplified).length > 0 ? simplified : { type: 'object' };
}

/**
 * Merge multiple schema options (from anyOf/oneOf/allOf) into a single flat schema.
 * All properties from all options become optional (unless required in all).
 */
function mergeSchemaOptions(
    options: JsonSchema[],
    maxDepth: number,
    currentDepth: number,
    defs: Record<string, JsonSchema>
): JsonSchema {
    const mergedProperties: Record<string, JsonSchema> = {};
    const requiredSets: Set<string>[] = [];
    let hasObjectOptions = false;

    for (const option of options) {
        // Recursively simplify each option first
        const simplified = simplifySchemaForDatabricks(option, maxDepth, currentDepth, defs);

        if (simplified.type === 'object' && simplified.properties) {
            hasObjectOptions = true;

            // Track which fields each option requires
            const optionRequired = new Set(simplified.required || []);
            requiredSets.push(optionRequired);

            // Merge properties
            for (const [key, propSchema] of Object.entries(simplified.properties)) {
                if (!mergedProperties[key]) {
                    mergedProperties[key] = propSchema;
                } else {
                    // Property exists - merge the schemas
                    mergedProperties[key] = mergePropertySchemas(mergedProperties[key], propSchema);
                }
            }
        } else if (simplified.type && !hasObjectOptions) {
            // If all options are primitive types, keep as simple union description
            // Just return the first simplified schema
            return simplified;
        }
    }

    if (!hasObjectOptions) {
        return { type: 'object', additionalProperties: true };
    }

    // Find properties required in ALL options (intersection)
    let finalRequired: string[] = [];
    if (requiredSets.length > 0) {
        const firstSet = requiredSets[0];
        finalRequired = [...firstSet].filter(prop =>
            requiredSets.every(set => set.has(prop))
        );
    }

    return {
        type: 'object',
        properties: mergedProperties,
        ...(finalRequired.length > 0 && { required: finalRequired }),
    };
}

/**
 * Merge two property schemas when they appear in multiple anyOf options.
 * Uses the most permissive type.
 */
function mergePropertySchemas(schema1: JsonSchema, schema2: JsonSchema): JsonSchema {
    // If same type, keep first
    if (schema1.type === schema2.type) {
        return schema1;
    }

    // If one has type and other doesn't, use the typed one
    if (schema1.type && !schema2.type) return schema1;
    if (schema2.type && !schema1.type) return schema2;

    // Different types - create a generic schema
    // Combine descriptions if available
    const descriptions = [schema1.description, schema2.description].filter(Boolean);

    return {
        type: 'string', // Use string as most permissive serializable type
        ...(descriptions.length > 0 && {
            description: descriptions.join(' OR ')
        }),
    };
}

/**
 * Simplify the inputSchema for a tool definition.
 * This is the main entry point for tool schema simplification.
 */
export function simplifyToolInputSchema(inputSchema: JsonSchema | undefined): JsonSchema {
    if (!inputSchema) {
        return { type: 'object', properties: {} };
    }

    return simplifySchemaForDatabricks(inputSchema, 4, 0);
}

/**
 * Transform a tools/list response to use simplified schemas.
 */
export function simplifyToolsListResponse(response: unknown): unknown {
    if (!response || typeof response !== 'object') {
        return response;
    }

    const resp = response as Record<string, unknown>;

    // Check if this is a JSON-RPC response with result.tools
    if (resp.result && typeof resp.result === 'object') {
        const result = resp.result as Record<string, unknown>;

        if (Array.isArray(result.tools)) {
            // Clone and simplify each tool's inputSchema
            const simplifiedTools = result.tools.map((tool: unknown) => {
                if (!tool || typeof tool !== 'object') return tool;

                const t = tool as Record<string, unknown>;
                return {
                    ...t,
                    inputSchema: simplifyToolInputSchema(t.inputSchema as JsonSchema | undefined),
                };
            });

            return {
                ...resp,
                result: {
                    ...result,
                    tools: simplifiedTools,
                },
            };
        }
    }

    return response;
}

/**
 * Check if a JSON-RPC request is a tools/list request.
 */
export function isToolsListRequest(body: unknown): boolean {
    if (!body || typeof body !== 'object') return false;

    const req = body as Record<string, unknown>;
    return req.method === 'tools/list';
}
