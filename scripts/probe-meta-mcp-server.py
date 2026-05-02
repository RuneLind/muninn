#!/usr/bin/env python3
"""
Minimal MCP server for probing whether Claude CLI surfaces _meta in NDJSON.

Exposes one tool, `echo`, that returns a CallToolResult with both a text
content block AND a _meta dict. If Claude CLI's stream-json `tool_result`
event carries the _meta through, Phase 2 (out-of-band trace channel) is
viable for the claude-cli connector. If it strips _meta, we need a
fallback.

Run via:
  uv run --with mcp scripts/probe-meta-mcp-server.py

Or wired into a .mcp.json:
  {"probe": {"command": "uv", "args": ["run", "--with", "mcp",
   "scripts/probe-meta-mcp-server.py"]}}
"""
# /// script
# dependencies = ["mcp>=1.0"]
# ///

from mcp.server.fastmcp import FastMCP
from mcp.types import CallToolResult, TextContent

mcp = FastMCP("probe-meta")


@mcp.tool()
def echo(text: str) -> CallToolResult:
    """Echo the given text and attach _meta + structuredContent markers.

    We probe both side-channels in one call: _meta is the conventional
    protocol-level metadata field, structuredContent is the spec's
    structured-result counterpart to the textual content blocks.
    """
    return CallToolResult(
        content=[TextContent(type="text", text=f"echoed: {text}")],
        meta={
            "probe.marker": "META_PROBE_MARKER_42",
            "probe.payload": {"nested": True, "size": 3},
        },
        structuredContent={
            "structured_marker": "STRUCTURED_PROBE_MARKER_99",
            "echoed_text": text,
        },
    )


if __name__ == "__main__":
    mcp.run()
