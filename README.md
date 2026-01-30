# Tableau MCP Server for Databricks

A Model Context Protocol (MCP) server that enables Databricks AI agents to interact with Tableau Cloud. This server exposes Tableau's capabilities as MCP tools that can be used by AI assistants in the Databricks AI Playground.

## Overview

This is a customized port of the [Tableau MCP Server](https://github.com/tableau/tableau-mcp) optimized for deployment as a Databricks App. It includes schema simplification to ensure compatibility with Databricks' MCP client.

### Features

- **Content Discovery**: Search workbooks, views, and data sources
- **Data Querying**: Query published data sources using natural language
- **View Rendering**: Get images of Tableau views and dashboards
- **Pulse Metrics**: Access Tableau Pulse insights and metrics

## Architecture

```
┌─────────────────────┐     ┌──────────────────────┐     ┌─────────────────┐
│  Databricks         │     │  Tableau MCP Server  │     │  Tableau Cloud  │
│  AI Playground      │────▶│  (Databricks App)    │────▶│  REST API       │
│                     │ MCP │                      │     │                 │
└─────────────────────┘     └──────────────────────┘     └─────────────────┘
```

The server:

1. Receives MCP requests from Databricks AI agents
2. Translates them to Tableau REST API calls
3. Returns structured responses compatible with Databricks

## Configuration

### app.yaml

```yaml
command:
  - npm
  - run
  - start:http
env:
  - name: SERVER
    value: "https://prod-apsoutheast-a.online.tableau.com"
  - name: SITE_NAME
    value: "your-site"
  - name: AUTH
    value: "direct-trust"
  - name: CONNECTED_APP_CLIENT_ID
    valueFrom: CONNECTED_APP_CLIENT_ID
  - name: CONNECTED_APP_SECRET_ID
    valueFrom: CONNECTED_APP_SECRET_ID
  - name: CONNECTED_APP_SECRET_VALUE
    valueFrom: CONNECTED_APP_SECRET_VALUE
  - name: JWT_SUB_CLAIM
    value: "your-tableau-username"
```

### Authentication Methods

#### Direct Trust (Recommended)

Uses Tableau Connected Apps for JWT-based authentication. Best for production as it supports concurrent requests.

Required secrets in Databricks:

- `CONNECTED_APP_CLIENT_ID`
- `CONNECTED_APP_SECRET_ID`
- `CONNECTED_APP_SECRET_VALUE`

#### Personal Access Tokens

For development and testing:

```yaml
env:
  - name: AUTH
    value: "pat"
  - name: PAT_NAME
    valueFrom: TABLEAU_PAT_NAME
  - name: PAT_VALUE
    valueFrom: TABLEAU_PAT_VALUE
```

## Deployment

### Prerequisites

- Databricks workspace with Apps enabled
- Tableau Cloud site with API access
- Tableau Connected App (for Direct Trust auth)

### Deploy to Databricks

1. Create Databricks secrets for Tableau credentials:

   ```bash
   databricks secrets put --scope tableau-mcp --key CONNECTED_APP_CLIENT_ID
   databricks secrets put --scope tableau-mcp --key CONNECTED_APP_SECRET_ID
   databricks secrets put --scope tableau-mcp --key CONNECTED_APP_SECRET_VALUE
   ```

2. Update `app.yaml` with your Tableau site details

3. Deploy as a Databricks App:

   ```bash
   databricks apps deploy ges-tableau-mcp --source-code-path ./
   ```

4. Connect in AI Playground:
   - Go to AI Playground in Databricks
   - Add Tool → MCP Server
   - Enter the app URL

## Available Tools

| Tool | Description |
|------|-------------|
| `search-content` | Search for workbooks, views, and data sources |
| `list-workbooks` | List workbooks with filtering options |
| `list-views` | List views in workbooks |
| `get-view-image` | Get a rendered image of a view |
| `list-datasources` | List published data sources |
| `query-datasource` | Query a datasource with dimensions/measures |
| `get-pulse-metrics` | Get Tableau Pulse metrics |

## Example Prompts

### Querying Data

```
For the Superstore Datasource, what are the top 5 states with the most sales?
```

### Content Discovery

```
Find me all workbooks related to sales in the Marketing project.
```

### Getting Views

```
Show me an image of the "Revenue Dashboard" view.
```

## Technical Notes

### Schema Simplification

Databricks' MCP client requires simplified JSON schemas. This server includes a transport wrapper that:

- Converts type arrays to single types (e.g., `["string", "null"]` → `"string"`)
- Removes unsupported schema keywords (`anyOf`, `oneOf`, `$ref`)
- Flattens deeply nested schemas

### Session Management

The server supports both:

- **Session-based**: For persistent connections (default)
- **Session-less**: Configure with `DISABLE_SESSION_MANAGEMENT=true`

## Development

### Local Testing

```bash
npm install
npm run build
npm run start:http
```

### Environment Variables

For local development, create a `.env` file:

```
SERVER=https://your-tableau-server.com
SITE_NAME=your_site
AUTH=pat
PAT_NAME=your_pat_name
PAT_VALUE=your_pat_value
```

## License

Apache-2.0

Based on [Tableau MCP](https://github.com/tableau/tableau-mcp) by Tableau.
