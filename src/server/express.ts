import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest, LoggingLevel } from '@modelcontextprotocol/sdk/types.js';
import cors from 'cors';
import express, { Request, RequestHandler, Response } from 'express'
import fs, { existsSync } from 'fs';
import http from 'http';
import https from 'https';

import { Config } from '../config.js';
import { setLogLevel } from '../logging/log.js';
import { Server } from '../server.js';
import { createSession, getSession, Session } from '../sessions.js';
import { handlePingRequest, validateProtocolVersion } from './middleware.js';
import { getTableauAuthInfo } from './oauth/getTableauAuthInfo.js';
import { OAuthProvider } from './oauth/provider.js';
import { TableauAuthInfo } from './oauth/schemas.js';
import { AuthenticatedRequest } from './oauth/types.js';
import { wrapTransportForDatabricks } from './transportWrapper.js';

const SESSION_ID_HEADER = 'mcp-session-id';


export async function startExpressServer({
  basePath,
  config,
  logLevel,
}: {
  basePath: string;
  config: Config;
  logLevel: LoggingLevel;
}): Promise<{ url: string; app: express.Application; server: http.Server }> {
  const app = express();

  app.use(express.json({ type: ['application/json', 'application/json-rpc'] }));
  app.use(express.urlencoded({ extended: false }));

  app.use(
    cors({
      origin: config.corsOriginConfig,
      credentials: true,
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'Cache-Control',
        'Accept',
        'MCP-Protocol-Version',
      ],
      exposedHeaders: [SESSION_ID_HEADER, 'x-session-id'],
    }),
  );

  if (config.trustProxyConfig !== null) {
    // https://expressjs.com/en/guide/behind-proxies.html
    app.set('trust proxy', config.trustProxyConfig);
  }

  const middleware: Array<RequestHandler> = [handlePingRequest];
  if (config.oauth.enabled) {
    const oauthProvider = new OAuthProvider();
    oauthProvider.setupRoutes(app);
    middleware.push(oauthProvider.authMiddleware);
    middleware.push(validateProtocolVersion);
  }

  const path = `/${basePath}`;
  app.post(path, ...middleware, createMcpServer);
  app.get(
    path,
    ...middleware,
    config.disableSessionManagement ? methodNotAllowed : handleSessionRequest,
  );
  app.delete(
    path,
    ...middleware,
    config.disableSessionManagement ? methodNotAllowed : handleSessionRequest,
  );

  const useSsl = !!(config.sslKey && config.sslCert);
  if (!useSsl) {
    return new Promise((resolve) => {
      const server = http
        .createServer(app)
        .listen(config.httpPort, () =>
          resolve({ url: `http://localhost:${config.httpPort}/${basePath}`, app, server }),
        );
    });
  }

  if (!existsSync(config.sslKey)) {
    throw new Error('SSL key file does not exist');
  }

  if (!existsSync(config.sslCert)) {
    throw new Error('SSL cert file does not exist');
  }

  const options = {
    key: fs.readFileSync(config.sslKey),
    cert: fs.readFileSync(config.sslCert),
  };

  return new Promise((resolve) => {
    const server = https
      .createServer(options, app)
      .listen(config.httpPort, () =>
        resolve({ url: `https://localhost:${config.httpPort}/${basePath}`, app, server }),
      );
  });

  async function createMcpServer(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      let transport: StreamableHTTPServerTransport;

      if (config.disableSessionManagement) {
        const server = new Server();
        const rawTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        transport = wrapTransportForDatabricks(rawTransport);

        res.on('close', () => {
          transport.close();
          server.close();
        });

        await connect(server, transport, logLevel, getTableauAuthInfo(req.auth));
      } else {
        const sessionId = req.headers[SESSION_ID_HEADER] as string | undefined;

        let session: Session | undefined;
        if (sessionId && (session = getSession(sessionId))) {
          transport = session.transport;
        } else if (!sessionId && isInitializeRequest(req.body)) {
          const clientInfo = req.body.params.clientInfo;
          transport = createSession({ clientInfo });

          const server = new Server({ clientInfo });
          await connect(server, transport, logLevel, getTableauAuthInfo(req.auth));
        } else {
          res.status(400).json({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'Bad Request: No valid session ID provided',
            },
            id: null,
          });
          return;
        }
      }

      // Ensure body is a valid object before passing to SDK
      // If express.json() worked, req.body is the object.
      // We explicitly pass it to avoid SDK trying to read the consumed stream.
      let bodyToPass = req.body;

      // If body is empty or not an object, verify if we should error early
      if (!bodyToPass || typeof bodyToPass !== 'object' || Object.keys(bodyToPass).length === 0) {
        // Empty body - standard SDK might try to read stream if we pass undefined
      } else {
        // Sanitize object to remove null prototype issues if any
        bodyToPass = JSON.parse(JSON.stringify(bodyToPass));

        // Strip Databricks-specific fields not in JSON-RPC 2.0 or MCP spec
        const extraFields = ['catalog', 'schema', 'functionName', 'indexName', 'genieSpaceId'];
        for (const field of extraFields) {
          if (field in bodyToPass) {
            delete bodyToPass[field];
          }
        }

        // Strip null values in params that shouldn't be present per JSON-RPC spec
        if (bodyToPass.params && typeof bodyToPass.params === 'object') {
          const nullableFields = ['name', 'arguments', 'cursor', '_meta'];
          for (const field of nullableFields) {
            if (field in bodyToPass.params && bodyToPass.params[field] === null) {
              delete bodyToPass.params[field];
            }
          }
        }

        // Remove null params entirely per JSON-RPC 2.0 spec
        if (bodyToPass.params === null) {
          delete bodyToPass.params;
        }
      }

      await transport.handleRequest(req, res, bodyToPass);

    } catch (error) {
      console.error('Error handling MCP request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        });
      }
    }
  }
}

async function connect(
  server: Server,
  transport: StreamableHTTPServerTransport,
  logLevel: LoggingLevel,
  authInfo: TableauAuthInfo | undefined,
): Promise<void> {
  await server.registerTools(authInfo);
  server.registerRequestHandlers();

  await server.connect(transport);
  setLogLevel(server, logLevel);
}

async function methodNotAllowed(_req: Request, res: Response): Promise<void> {
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Method not allowed.',
      },
      id: null,
    }),
  );
}

async function handleSessionRequest(req: express.Request, res: express.Response): Promise<void> {
  const sessionId = req.headers[SESSION_ID_HEADER] as string | undefined;

  let session: Session | undefined;
  if (!sessionId || !(session = getSession(sessionId))) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }

  await session.transport.handleRequest(req, res);
}
