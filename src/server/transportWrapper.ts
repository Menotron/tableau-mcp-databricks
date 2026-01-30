/**
 * Wrapper for StreamableHTTPServerTransport that intercepts tools/list responses
 * to simplify JSON schemas for Databricks compatibility.
 * 
 * This approach works by wrapping the transport's send method, which is called
 * by the MCP server when sending JSON-RPC responses to clients.
 */

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { simplifyToolsListResponse } from './schemaSimplifier.js';

/**
 * Wrap a StreamableHTTPServerTransport to intercept and simplify tools/list responses.
 * 
 * This wrapper patches the transport's send method to:
 * 1. Detect tools/list responses (JSON-RPC responses with result.tools)
 * 2. Apply schema simplification to make them compatible with Databricks
 * 3. Pass through all other messages unchanged
 */
export function wrapTransportForDatabricks(
    transport: StreamableHTTPServerTransport
): StreamableHTTPServerTransport {
    const originalSend = transport.send.bind(transport);

    transport.send = async (message: JSONRPCMessage): Promise<void> => {
        if (isToolsListResponse(message)) {
            const simplified = simplifyToolsListResponse(message);
            return originalSend(simplified as JSONRPCMessage);
        }
        return originalSend(message);
    };


    return transport;
}

/**
 * Check if a JSON-RPC message is a tools/list response.
 */
function isToolsListResponse(message: unknown): boolean {
    if (!message || typeof message !== 'object') return false;

    const msg = message as Record<string, unknown>;

    // Must be a response (has result, no method)
    if (msg.method || !msg.result) return false;

    // Must have tools array in result
    const result = msg.result as Record<string, unknown>;
    return Array.isArray(result.tools);
}
