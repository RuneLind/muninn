/**
 * OpenAPI 3.1.0 specification for the Javrvis Dashboard API.
 *
 * Covers all JSON API endpoints from both dashboard routes (/) and
 * simulator routes (/chat). Excludes HTML pages, CORS OPTIONS, WebSocket,
 * and SSE streaming endpoints.
 */

// ---------------------------------------------------------------------------
// Helpers to reduce repetition
// ---------------------------------------------------------------------------

const botQuery = {
  name: "bot",
  in: "query" as const,
  schema: { type: "string" as const },
  description: "Filter by bot name",
  required: false,
};

function limitQuery(defaultVal: number, max: number) {
  return {
    name: "limit",
    in: "query" as const,
    schema: { type: "integer" as const, default: defaultVal, maximum: max, minimum: 1 },
    description: `Max results (default ${defaultVal}, max ${max})`,
    required: false,
  };
}

function pathId(name: string, description: string) {
  return {
    name,
    in: "path" as const,
    schema: { type: "string" as const },
    description,
    required: true,
  };
}

const errorResponse = {
  description: "Error",
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
};

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

export const spec = {
  openapi: "3.1.0",
  info: {
    title: "Javrvis API",
    version: "1.0.0",
    description: "Dashboard and Chat API for the Javrvis multi-bot AI assistant platform.",
  },
  servers: [{ url: "/", description: "Current host" }],

  tags: [
    { name: "Core", description: "Bots, stats, and activity" },
    { name: "Users", description: "User summaries and settings" },
    { name: "Messages", description: "Conversation messages" },
    { name: "Memory", description: "Memories CRUD and search" },
    { name: "Goals & Tasks", description: "Goals and scheduled tasks" },
    { name: "Threads", description: "Conversation threads (per-user+bot)" },
    { name: "Traces", description: "Request tracing and prompt snapshots" },
    { name: "Watchers", description: "Background watchers" },
    { name: "Slack", description: "Slack analytics" },
    { name: "Logs", description: "JSONL log file access" },
    { name: "Knowledge Search", description: "Knowledge API proxy" },
    { name: "Research", description: "Research workbench" },
    { name: "MCP Debug", description: "MCP server debugging" },
    { name: "YouTube", description: "YouTube summarizer and browse" },
    { name: "Simulator", description: "Chat simulator (mounted at /chat)" },
  ],

  components: {
    schemas: {
      Error: {
        type: "object" as const,
        properties: {
          error: { type: "string" as const },
        },
        required: ["error"],
      },
      Thread: {
        type: "object" as const,
        properties: {
          id: { type: "string" as const, format: "uuid" },
          userId: { type: "string" as const },
          botName: { type: "string" as const },
          name: { type: "string" as const },
          createdAt: { type: "integer" as const, description: "Epoch ms" },
          lastActiveAt: { type: "integer" as const, description: "Epoch ms" },
        },
      },
      Memory: {
        type: "object" as const,
        properties: {
          id: { type: "integer" as const },
          userId: { type: "string" as const },
          botName: { type: "string" as const },
          content: { type: "string" as const },
          scope: { type: "string" as const, enum: ["personal", "shared"] },
          createdAt: { type: "integer" as const },
        },
      },
      Goal: {
        type: "object" as const,
        properties: {
          id: { type: "integer" as const },
          userId: { type: "string" as const },
          title: { type: "string" as const },
          status: { type: "string" as const },
          createdAt: { type: "integer" as const },
        },
      },
      ScheduledTask: {
        type: "object" as const,
        properties: {
          id: { type: "integer" as const },
          userId: { type: "string" as const },
          botName: { type: "string" as const },
          description: { type: "string" as const },
          scheduledAt: { type: "integer" as const },
        },
      },
      Watcher: {
        type: "object" as const,
        properties: {
          id: { type: "integer" as const },
          userId: { type: "string" as const },
          botName: { type: "string" as const },
          type: { type: "string" as const },
          filter: { type: "string" as const },
          intervalMs: { type: "integer" as const },
        },
      },
      Message: {
        type: "object" as const,
        properties: {
          id: { type: "integer" as const },
          role: { type: "string" as const, enum: ["user", "assistant"] },
          content: { type: "string" as const },
          createdAt: { type: "integer" as const },
          threadId: { type: ["string", "null"] as const },
        },
      },
      Conversation: {
        type: "object" as const,
        properties: {
          id: { type: "string" as const },
          type: { type: "string" as const, enum: ["telegram_dm", "slack_dm", "slack_channel", "slack_assistant", "web"] },
          botName: { type: "string" as const },
          userId: { type: "string" as const },
          username: { type: "string" as const },
          channelName: { type: ["string", "null"] as const },
          messageCount: { type: "integer" as const },
          status: { type: "string" as const },
        },
      },
    },
  },

  paths: {
    // ===================== Core =====================

    "/api/bots": {
      get: {
        tags: ["Core"],
        summary: "List bot names",
        description: "Returns distinct bot names from the messages table.",
        operationId: "getBots",
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { type: "object", properties: { bots: { type: "array", items: { type: "string" } } } } } },
          },
          "500": errorResponse,
        },
      },
    },

    "/api/stats": {
      get: {
        tags: ["Core"],
        summary: "Dashboard statistics",
        description: "Aggregate stats: message counts, token usage, 7-day chart data.",
        operationId: "getStats",
        parameters: [botQuery],
        responses: {
          "200": { description: "Dashboard stats object" },
          "500": errorResponse,
        },
      },
    },

    "/api/activity": {
      get: {
        tags: ["Core"],
        summary: "Recent activity events",
        description: "Returns the 50 most recent in-memory activity events plus aggregate stats.",
        operationId: "getActivity",
        responses: {
          "200": { description: "Activity events and stats" },
        },
      },
    },

    // ===================== Users =====================

    "/api/users": {
      get: {
        tags: ["Users"],
        summary: "User summaries",
        description: "Summarised list of all users with message/memory counts.",
        operationId: "getUsers",
        parameters: [botQuery],
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { users: { type: "array", items: { type: "object" } } } } } } },
          "500": errorResponse,
        },
      },
      post: {
        tags: ["Users"],
        summary: "Create user",
        description: "Create a new user by provisioning a default thread and adding to chat config.",
        operationId: "createUser",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["userId", "username", "botName"], properties: { userId: { type: "string", description: "Platform user ID (e.g. Slack ID)" }, username: { type: "string", description: "Display name" }, botName: { type: "string", description: "Bot name" } } } } },
        },
        responses: {
          "201": { description: "User created" },
          "400": errorResponse,
          "500": errorResponse,
        },
      },
    },

    "/api/users/{userId}/overview": {
      get: {
        tags: ["Users"],
        summary: "User overview",
        description: "Detailed overview for a single user: messages, memories, goals, tasks.",
        operationId: "getUserOverview",
        parameters: [pathId("userId", "Telegram user ID"), botQuery],
        responses: {
          "200": { description: "User overview object" },
          "400": errorResponse,
          "500": errorResponse,
        },
      },
    },

    "/api/user-settings/{userId}": {
      get: {
        tags: ["Users"],
        summary: "User settings",
        description: "Per-user settings (quiet hours, timezone, etc.).",
        operationId: "getUserSettings",
        parameters: [pathId("userId", "Telegram user ID")],
        responses: {
          "200": { description: "Settings object" },
          "400": errorResponse,
          "500": errorResponse,
        },
      },
    },

    // ===================== Messages =====================

    "/api/messages/{userId}": {
      get: {
        tags: ["Messages"],
        summary: "Recent messages for user",
        description: "Conversation messages for a user, optionally filtered by bot and thread.",
        operationId: "getMessages",
        parameters: [
          pathId("userId", "Telegram user ID"),
          limitQuery(50, 200),
          botQuery,
          { name: "thread", in: "query", schema: { type: "string" }, description: "Thread ID filter", required: false },
        ],
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { messages: { type: "array", items: { $ref: "#/components/schemas/Message" } } } } } } },
          "400": errorResponse,
        },
      },
    },

    // ===================== Memory =====================

    "/api/memories": {
      get: {
        tags: ["Memory"],
        summary: "Recent memories",
        description: "Most recent memories across all users.",
        operationId: "getMemories",
        parameters: [limitQuery(20, 100), botQuery],
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { memories: { type: "array", items: { $ref: "#/components/schemas/Memory" } } } } } } },
          "500": errorResponse,
        },
      },
    },

    "/api/memories/by-user": {
      get: {
        tags: ["Memory"],
        summary: "Memories grouped by user",
        description: "Memory counts and summaries grouped by user ID.",
        operationId: "getMemoriesByUser",
        parameters: [botQuery],
        responses: {
          "200": { description: "Grouped memory data" },
          "500": errorResponse,
        },
      },
    },

    "/api/memories/user/{userId}": {
      get: {
        tags: ["Memory"],
        summary: "Memories for a user",
        description: "All memories for a specific user.",
        operationId: "getMemoriesForUser",
        parameters: [pathId("userId", "User ID"), limitQuery(20, 100), botQuery],
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { memories: { type: "array", items: { $ref: "#/components/schemas/Memory" } } } } } } },
          "400": errorResponse,
          "500": errorResponse,
        },
      },
    },

    "/api/memsearch": {
      get: {
        tags: ["Memory"],
        summary: "Search memories",
        description: "Hybrid, semantic, or text search across memories using embeddings.",
        operationId: "searchMemories",
        parameters: [
          { name: "q", in: "query", schema: { type: "string" }, description: "Search query", required: true },
          { name: "mode", in: "query", schema: { type: "string", enum: ["hybrid", "semantic", "text"], default: "hybrid" }, description: "Search mode", required: false },
          limitQuery(25, 100),
          botQuery,
          { name: "scope", in: "query", schema: { type: "string", enum: ["personal", "shared"] }, description: "Memory scope filter", required: false },
        ],
        responses: {
          "200": { description: "Search results with similarity scores" },
          "500": errorResponse,
        },
      },
    },

    "/api/memsearch-stats": {
      get: {
        tags: ["Memory"],
        summary: "Memory search statistics",
        description: "Embedding coverage and memory count stats.",
        operationId: "getMemsearchStats",
        parameters: [botQuery],
        responses: {
          "200": { description: "Search stats" },
          "500": errorResponse,
        },
      },
    },

    // ===================== Goals & Tasks =====================

    "/api/goals": {
      get: {
        tags: ["Goals & Tasks"],
        summary: "All goals",
        description: "All goals across users.",
        operationId: "getAllGoals",
        parameters: [botQuery],
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { goals: { type: "array", items: { $ref: "#/components/schemas/Goal" } } } } } } },
          "500": errorResponse,
        },
      },
    },

    "/api/goals/{userId}": {
      get: {
        tags: ["Goals & Tasks"],
        summary: "Active goals for user",
        description: "Active goals for a specific user.",
        operationId: "getUserGoals",
        parameters: [pathId("userId", "User ID")],
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { goals: { type: "array", items: { $ref: "#/components/schemas/Goal" } } } } } } },
          "400": errorResponse,
        },
      },
    },

    "/api/tasks": {
      get: {
        tags: ["Goals & Tasks"],
        summary: "All scheduled tasks",
        description: "All scheduled tasks across users.",
        operationId: "getAllTasks",
        parameters: [botQuery],
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { tasks: { type: "array", items: { $ref: "#/components/schemas/ScheduledTask" } } } } } } },
          "500": errorResponse,
        },
      },
    },

    "/api/scheduled-tasks/{userId}": {
      get: {
        tags: ["Goals & Tasks"],
        summary: "Scheduled tasks for user",
        description: "Scheduled tasks for a specific user.",
        operationId: "getUserScheduledTasks",
        parameters: [pathId("userId", "User ID")],
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { tasks: { type: "array", items: { $ref: "#/components/schemas/ScheduledTask" } } } } } } },
          "400": errorResponse,
        },
      },
    },

    // ===================== Threads =====================

    "/api/threads": {
      get: {
        tags: ["Threads"],
        summary: "List all threads",
        description: "All conversation threads, optionally filtered by bot.",
        operationId: "getThreads",
        parameters: [botQuery],
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { threads: { type: "array", items: { $ref: "#/components/schemas/Thread" } } } } } } },
          "500": errorResponse,
        },
      },
    },

    "/api/threads/{id}": {
      delete: {
        tags: ["Threads"],
        summary: "Delete a thread",
        description: "Deletes a thread and all associated messages, memories, and goals. Cannot delete the 'main' thread.",
        operationId: "deleteThread",
        parameters: [pathId("id", "Thread UUID")],
        responses: {
          "200": { description: "Deleted", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, thread: { $ref: "#/components/schemas/Thread" } } } } } },
          "404": errorResponse,
          "500": errorResponse,
        },
      },
    },

    // ===================== Traces =====================

    "/api/traces": {
      get: {
        tags: ["Traces"],
        summary: "Recent traces",
        description: "Paginated list of recent request traces.",
        operationId: "getTraces",
        parameters: [
          limitQuery(50, 200),
          { name: "offset", in: "query", schema: { type: "integer", default: 0 }, description: "Pagination offset", required: false },
          botQuery,
          { name: "name", in: "query", schema: { type: "string" }, description: "Filter by trace name", required: false },
        ],
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { traces: { type: "array", items: { type: "object" } } } } } } },
          "500": errorResponse,
        },
      },
    },

    "/api/traces/{traceId}": {
      get: {
        tags: ["Traces"],
        summary: "Get trace spans",
        description: "All spans for a specific trace, including child spans for tool calls.",
        operationId: "getTrace",
        parameters: [pathId("traceId", "Trace ID (UUID)")],
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { spans: { type: "array", items: { type: "object" } } } } } } },
          "500": errorResponse,
        },
      },
    },

    "/api/prompts/{traceId}": {
      get: {
        tags: ["Traces"],
        summary: "Get prompt snapshot",
        description: "The full prompt snapshot (persona, memories, goals, history) used for a trace.",
        operationId: "getPromptSnapshot",
        parameters: [pathId("traceId", "Trace ID (UUID)")],
        responses: {
          "200": { description: "Prompt snapshot object" },
          "404": errorResponse,
          "500": errorResponse,
        },
      },
    },

    "/api/trace-stats": {
      get: {
        tags: ["Traces"],
        summary: "Trace statistics",
        description: "Aggregate trace stats (counts, durations, error rates).",
        operationId: "getTraceStats",
        parameters: [botQuery],
        responses: {
          "200": { description: "Trace stats" },
          "500": errorResponse,
        },
      },
    },

    "/api/trace-filters": {
      get: {
        tags: ["Traces"],
        summary: "Trace filter options",
        description: "Available filter values for the traces UI (bot names, trace names).",
        operationId: "getTraceFilters",
        responses: {
          "200": { description: "Filter options" },
          "500": errorResponse,
        },
      },
    },

    // ===================== Watchers =====================

    "/api/watchers": {
      get: {
        tags: ["Watchers"],
        summary: "All watchers",
        description: "All registered background watchers.",
        operationId: "getWatchers",
        parameters: [botQuery],
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { watchers: { type: "array", items: { $ref: "#/components/schemas/Watcher" } } } } } } },
          "500": errorResponse,
        },
      },
    },

    // ===================== Slack =====================

    "/api/slack-analytics": {
      get: {
        tags: ["Slack"],
        summary: "Slack analytics",
        description: "Slack-specific usage analytics.",
        operationId: "getSlackAnalytics",
        parameters: [botQuery],
        responses: {
          "200": { description: "Slack analytics data" },
          "500": errorResponse,
        },
      },
    },

    // ===================== Logs =====================

    "/api/logs/dates": {
      get: {
        tags: ["Logs"],
        summary: "Available log dates",
        description: "Lists dates for which JSONL log files exist.",
        operationId: "getLogDates",
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { dates: { type: "array", items: { type: "string", format: "date" } } } } } } },
        },
      },
    },

    "/api/logs": {
      get: {
        tags: ["Logs"],
        summary: "Read log entries",
        description: "All log entries for a specific date.",
        operationId: "getLogs",
        parameters: [
          { name: "date", in: "query", schema: { type: "string", format: "date" }, description: "Date in YYYY-MM-DD format", required: true },
        ],
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { entries: { type: "array", items: { type: "object" } } } } } } },
          "400": errorResponse,
          "500": errorResponse,
        },
      },
    },

    "/api/logs/tail": {
      get: {
        tags: ["Logs"],
        summary: "Tail log entries",
        description: "Returns log entries after a given timestamp for live tailing.",
        operationId: "tailLogs",
        parameters: [
          { name: "date", in: "query", schema: { type: "string", format: "date" }, description: "Date in YYYY-MM-DD format", required: true },
          { name: "after", in: "query", schema: { type: "string" }, description: "ISO timestamp — return entries after this", required: true },
        ],
        responses: {
          "200": { description: "New log entries" },
          "400": errorResponse,
          "500": errorResponse,
        },
      },
    },

    // ===================== Knowledge Search =====================

    "/api/search/health": {
      get: {
        tags: ["Knowledge Search"],
        summary: "Knowledge API health",
        description: "Proxied health check for the external Knowledge API.",
        operationId: "searchHealth",
        responses: {
          "200": { description: "Healthy" },
          "502": errorResponse,
          "503": errorResponse,
        },
      },
    },

    "/api/search/collections": {
      get: {
        tags: ["Knowledge Search"],
        summary: "List collections",
        description: "Lists all document collections from the Knowledge API.",
        operationId: "searchCollections",
        responses: {
          "200": { description: "Collections list" },
          "502": errorResponse,
          "503": errorResponse,
        },
      },
    },

    "/api/search/search": {
      get: {
        tags: ["Knowledge Search"],
        summary: "Search knowledge base",
        description: "Full-text + semantic search across knowledge collections.",
        operationId: "searchKnowledge",
        parameters: [
          { name: "q", in: "query", schema: { type: "string" }, description: "Search query", required: true },
          limitQuery(10, 100),
          { name: "collection", in: "query", schema: { type: "string" }, description: "Collection filter (repeatable)", required: false },
        ],
        responses: {
          "200": { description: "Search results" },
          "502": errorResponse,
          "503": errorResponse,
        },
      },
    },

    "/api/search/collection/{name}/documents": {
      get: {
        tags: ["Knowledge Search"],
        summary: "List collection documents",
        description: "All documents in a specific collection.",
        operationId: "searchCollectionDocuments",
        parameters: [pathId("name", "Collection name")],
        responses: {
          "200": { description: "Documents list" },
          "502": errorResponse,
          "503": errorResponse,
        },
      },
    },

    "/api/search/document/{collection}/{docPath}": {
      get: {
        tags: ["Knowledge Search"],
        summary: "Get document",
        description: "Retrieve a specific document by collection and document path.",
        operationId: "searchGetDocument",
        parameters: [
          pathId("collection", "Collection name"),
          pathId("docPath", "Document path (may contain slashes)"),
        ],
        responses: {
          "200": { description: "Document content" },
          "502": errorResponse,
          "503": errorResponse,
        },
      },
    },

    // ===================== Research =====================

    "/api/research/bots": {
      get: {
        tags: ["Research"],
        summary: "List research bots",
        description: "All discovered bots available for research.",
        operationId: "getResearchBots",
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { bots: { type: "array", items: { type: "object", properties: { name: { type: "string" } } } } } } } } },
        },
      },
    },

    "/api/research/bot-collections": {
      get: {
        tags: ["Research"],
        summary: "Bot knowledge collections",
        description: "Returns KNOWLEDGE_COLLECTIONS from a bot's .mcp.json env config.",
        operationId: "getResearchBotCollections",
        parameters: [botQuery],
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { collections: { type: "array", items: { type: "string" } } } } } } },
        },
      },
    },

    "/api/research/tags": {
      get: {
        tags: ["Research"],
        summary: "Collection tags",
        description: "Tags for a knowledge collection.",
        operationId: "getResearchTags",
        parameters: [
          { name: "collection", in: "query", schema: { type: "string" }, description: "Collection name", required: true },
        ],
        responses: {
          "200": { description: "Tags list" },
          "400": errorResponse,
          "502": errorResponse,
          "503": errorResponse,
        },
      },
    },

    "/api/research/documents": {
      get: {
        tags: ["Research"],
        summary: "Collection documents",
        description: "All documents in a knowledge collection.",
        operationId: "getResearchDocuments",
        parameters: [
          { name: "collection", in: "query", schema: { type: "string" }, description: "Collection name", required: true },
        ],
        responses: {
          "200": { description: "Documents list" },
          "400": errorResponse,
          "502": errorResponse,
          "503": errorResponse,
        },
      },
    },

    "/api/research/document/{collection}/{docPath}": {
      get: {
        tags: ["Research"],
        summary: "Get research document",
        description: "Retrieve a single document from a collection.",
        operationId: "getResearchDocument",
        parameters: [
          pathId("collection", "Collection name"),
          pathId("docPath", "Document path"),
        ],
        responses: {
          "200": { description: "Document content" },
          "502": errorResponse,
          "503": errorResponse,
        },
      },
    },

    "/api/research/similar": {
      get: {
        tags: ["Research"],
        summary: "Similar documents",
        description: "Find similar documents by semantic search.",
        operationId: "getResearchSimilar",
        parameters: [
          { name: "q", in: "query", schema: { type: "string" }, description: "Search query", required: true },
          { name: "collection", in: "query", schema: { type: "string" }, description: "Collection filter", required: false },
        ],
        responses: {
          "200": { description: "Similar results" },
          "400": errorResponse,
          "502": errorResponse,
          "503": errorResponse,
        },
      },
    },

    "/api/research/chat": {
      post: {
        tags: ["Research"],
        summary: "Start research chat",
        description: "Creates a thread and queues a research prompt for bot processing. Returns a chat URL.",
        operationId: "postResearchChat",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  bot: { type: "string", description: "Bot name (defaults to first)" },
                  title: { type: "string", description: "Thread title (defaults to text excerpt)" },
                  text: { type: "string", description: "Research prompt / Jira content" },
                },
                required: ["text"],
              },
            },
          },
        },
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { threadId: { type: "string" }, conversationId: { type: "string" }, chatUrl: { type: "string" } } } } } },
          "400": errorResponse,
          "500": errorResponse,
        },
      },
    },

    // ===================== MCP Debug =====================

    "/api/mcp/bots": {
      get: {
        tags: ["MCP Debug"],
        summary: "List MCP bots",
        description: "Bot names with MCP config available.",
        operationId: "getMcpBots",
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { bots: { type: "array", items: { type: "string" } } } } } } },
        },
      },
    },

    "/api/mcp/config": {
      get: {
        tags: ["MCP Debug"],
        summary: "Get bot MCP config",
        description: "Returns the .mcp.json configuration for a bot.",
        operationId: "getMcpConfig",
        parameters: [
          { name: "bot", in: "query", schema: { type: "string" }, description: "Bot name", required: true },
        ],
        responses: {
          "200": { description: "MCP config" },
          "400": errorResponse,
          "404": errorResponse,
        },
      },
    },

    "/api/mcp/connect": {
      post: {
        tags: ["MCP Debug"],
        summary: "Connect to MCP server",
        description: "Establishes a connection to a bot's MCP server and returns available tools.",
        operationId: "postMcpConnect",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  bot: { type: "string" },
                  server: { type: "string" },
                },
                required: ["bot", "server"],
              },
            },
          },
        },
        responses: {
          "200": { description: "Connection result with tools list" },
          "400": errorResponse,
          "404": errorResponse,
          "500": errorResponse,
        },
      },
    },

    "/api/mcp/call": {
      post: {
        tags: ["MCP Debug"],
        summary: "Call MCP tool",
        description: "Invokes a tool on a connected MCP server.",
        operationId: "postMcpCall",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  bot: { type: "string" },
                  server: { type: "string" },
                  tool: { type: "string" },
                  arguments: { type: "object" },
                },
                required: ["bot", "server", "tool"],
              },
            },
          },
        },
        responses: {
          "200": { description: "Tool result" },
          "400": errorResponse,
          "500": errorResponse,
        },
      },
    },

    "/api/mcp/disconnect": {
      post: {
        tags: ["MCP Debug"],
        summary: "Disconnect MCP server",
        description: "Disconnects from a bot's MCP server.",
        operationId: "postMcpDisconnect",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  bot: { type: "string" },
                  server: { type: "string" },
                },
                required: ["bot", "server"],
              },
            },
          },
        },
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" } } } } } },
          "400": errorResponse,
          "500": errorResponse,
        },
      },
    },

    // ===================== YouTube =====================

    "/api/youtube/summarize": {
      post: {
        tags: ["YouTube"],
        summary: "Summarize a video",
        description: "Starts a background summarization job for a YouTube video.",
        operationId: "postYoutubeSummarize",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  url: { type: "string", format: "uri" },
                  video_id: { type: "string" },
                },
                required: ["url", "video_id"],
              },
            },
          },
        },
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { job_id: { type: "string" }, dashboard_url: { type: "string" } } } } } },
          "400": errorResponse,
          "500": errorResponse,
        },
      },
    },

    "/api/youtube/jobs": {
      get: {
        tags: ["YouTube"],
        summary: "Recent summarization jobs",
        description: "List recent YouTube summarization jobs.",
        operationId: "getYoutubeJobs",
        parameters: [limitQuery(20, 100)],
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { jobs: { type: "array", items: { type: "object" } } } } } } },
        },
      },
    },

    "/api/youtube/categories": {
      get: {
        tags: ["YouTube"],
        summary: "Video categories",
        description: "Categories from the YouTube summaries knowledge collection.",
        operationId: "getYoutubeCategories",
        responses: {
          "200": { description: "Categories list" },
          "502": errorResponse,
          "503": errorResponse,
        },
      },
    },

    "/api/youtube/documents": {
      get: {
        tags: ["YouTube"],
        summary: "Stored video summaries",
        description: "All documents in the youtube-summaries collection.",
        operationId: "getYoutubeDocuments",
        responses: {
          "200": { description: "Documents list" },
          "502": errorResponse,
          "503": errorResponse,
        },
      },
    },

    "/api/youtube/document/{docPath}": {
      get: {
        tags: ["YouTube"],
        summary: "Get video summary",
        description: "A specific stored YouTube video summary document.",
        operationId: "getYoutubeDocument",
        parameters: [pathId("docPath", "Document path")],
        responses: {
          "200": { description: "Document content" },
          "400": errorResponse,
          "502": errorResponse,
          "503": errorResponse,
        },
      },
    },

    "/api/youtube/similar": {
      get: {
        tags: ["YouTube"],
        summary: "Similar videos",
        description: "Find similar YouTube summaries by semantic search.",
        operationId: "getYoutubeSimilar",
        parameters: [
          { name: "q", in: "query", schema: { type: "string" }, description: "Search query", required: true },
        ],
        responses: {
          "200": { description: "Similar results" },
          "400": errorResponse,
          "502": errorResponse,
          "503": errorResponse,
        },
      },
    },

    // ===================== Simulator (/chat prefix) =====================

    "/chat/config": {
      get: {
        tags: ["Simulator"],
        summary: "Chat config",
        description: "Chat configuration — user mappings from chat.config.json or auto-discovered.",
        operationId: "getChatConfig",
        responses: {
          "200": { description: "Config with users and mode" },
        },
      },
    },

    "/chat/knowledge-config": {
      get: {
        tags: ["Simulator"],
        summary: "Knowledge viewable collections",
        description: "Collections config for rendering document links in chat.",
        operationId: "getChatKnowledgeConfig",
        responses: {
          "200": { description: "Viewable collections config" },
        },
      },
    },

    "/chat/bots": {
      get: {
        tags: ["Simulator"],
        summary: "List chat bots",
        description: "Available bots with platform and model info.",
        operationId: "getChatBots",
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { bots: { type: "array", items: { type: "object" } } } } } } },
        },
      },
    },

    "/chat/conversations": {
      get: {
        tags: ["Simulator"],
        summary: "List conversations",
        description: "All simulator conversations with status and message count.",
        operationId: "getChatConversations",
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { conversations: { type: "array", items: { $ref: "#/components/schemas/Conversation" } } } } } } },
        },
      },
      post: {
        tags: ["Simulator"],
        summary: "Create conversation",
        description: "Creates a new simulator conversation for a bot/user/platform combination.",
        operationId: "postChatConversation",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["telegram_dm", "slack_dm", "slack_channel", "slack_assistant", "web"] },
                  botName: { type: "string" },
                  userId: { type: "string" },
                  username: { type: "string" },
                  channelName: { type: "string" },
                },
                required: ["type", "botName"],
              },
            },
          },
        },
        responses: {
          "201": { description: "Created", content: { "application/json": { schema: { type: "object", properties: { conversation: { $ref: "#/components/schemas/Conversation" } } } } } },
          "400": errorResponse,
          "404": errorResponse,
        },
      },
    },

    "/chat/conversations/{id}": {
      get: {
        tags: ["Simulator"],
        summary: "Get conversation",
        description: "Full conversation with all messages.",
        operationId: "getChatConversation",
        parameters: [pathId("id", "Conversation ID")],
        responses: {
          "200": { description: "Conversation with messages" },
          "404": errorResponse,
        },
      },
      delete: {
        tags: ["Simulator"],
        summary: "Delete conversation",
        description: "Delete a simulator conversation.",
        operationId: "deleteChatConversation",
        parameters: [pathId("id", "Conversation ID")],
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" } } } } } },
          "404": errorResponse,
        },
      },
    },

    "/chat/conversations/{id}/messages": {
      get: {
        tags: ["Simulator"],
        summary: "Get conversation messages",
        description: "Messages for a conversation, optionally filtered by thread.",
        operationId: "getChatMessages",
        parameters: [
          pathId("id", "Conversation ID"),
          { name: "thread", in: "query", schema: { type: "string" }, description: "Thread ID filter", required: false },
          { name: "raw", in: "query", schema: { type: "string", enum: ["true", "false"] }, description: "Return raw markdown (skip HTML formatting)", required: false },
        ],
        responses: {
          "200": { description: "Messages list" },
          "404": errorResponse,
        },
      },
      post: {
        tags: ["Simulator"],
        summary: "Send message",
        description: "Send a message in a conversation — triggers async Claude processing. Response comes via WebSocket.",
        operationId: "postChatMessage",
        parameters: [pathId("id", "Conversation ID")],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  text: { type: "string" },
                  threadId: { type: "string" },
                  connector: { type: "string", enum: ["claude-cli", "copilot-sdk"] },
                },
                required: ["text"],
              },
            },
          },
        },
        responses: {
          "202": { description: "Accepted — processing asynchronously" },
          "400": errorResponse,
          "404": errorResponse,
        },
      },
    },

    "/chat/threads": {
      post: {
        tags: ["Simulator"],
        summary: "Create thread",
        description: "Create a new conversation thread for a user+bot.",
        operationId: "postChatThread",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  userId: { type: "string" },
                  botName: { type: "string" },
                  name: { type: "string" },
                },
                required: ["userId", "botName", "name"],
              },
            },
          },
        },
        responses: {
          "201": { description: "Created", content: { "application/json": { schema: { type: "object", properties: { thread: { $ref: "#/components/schemas/Thread" } } } } } },
          "400": errorResponse,
          "404": errorResponse,
        },
      },
    },

    "/chat/threads/{userId}/{botName}": {
      get: {
        tags: ["Simulator"],
        summary: "List user threads",
        description: "Threads for a user+bot combination (excludes Slack threads).",
        operationId: "getChatUserThreads",
        parameters: [
          pathId("userId", "User ID"),
          pathId("botName", "Bot name"),
        ],
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { threads: { type: "array", items: { $ref: "#/components/schemas/Thread" } } } } } } },
        },
      },
    },

    "/chat/threads/{id}": {
      delete: {
        tags: ["Simulator"],
        summary: "Delete thread (chat)",
        description: "Deletes a thread with cascade — same as DELETE /api/threads/{id}.",
        operationId: "deleteChatThread",
        parameters: [pathId("id", "Thread UUID")],
        responses: {
          "200": { description: "Deleted", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, thread: { $ref: "#/components/schemas/Thread" } } } } } },
          "404": errorResponse,
          "500": errorResponse,
        },
      },
    },

    "/chat/pending/{threadId}": {
      get: {
        tags: ["Simulator"],
        summary: "Consume pending message",
        description: "Consumes a one-time pending research message for a thread.",
        operationId: "getChatPending",
        parameters: [pathId("threadId", "Thread ID")],
        responses: {
          "200": { description: "Pending message or null" },
        },
      },
    },

    "/chat/reports/{botName}/{userId}/{issueKey}": {
      get: {
        tags: ["Simulator"],
        summary: "Get research report",
        description: "Retrieve a saved research report markdown file.",
        operationId: "getChatReport",
        parameters: [
          pathId("botName", "Bot name"),
          pathId("userId", "User ID"),
          pathId("issueKey", "Jira issue key (e.g. PROJ-123)"),
        ],
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { content: { type: "string" } } } } } },
          "400": errorResponse,
          "404": errorResponse,
        },
      },
      post: {
        tags: ["Simulator"],
        summary: "Save research report",
        description: "Saves a research report as a markdown file in bots/<bot>/reports/<userId>/.",
        operationId: "postChatReport",
        parameters: [
          pathId("botName", "Bot name"),
          pathId("userId", "User ID"),
          pathId("issueKey", "Jira issue key (e.g. PROJ-123)"),
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  content: { type: "string", description: "Markdown content" },
                },
                required: ["content"],
              },
            },
          },
        },
        responses: {
          "201": { description: "Created", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, path: { type: "string" } } } } } },
          "400": errorResponse,
          "404": errorResponse,
        },
      },
    },
  },
} as const;
