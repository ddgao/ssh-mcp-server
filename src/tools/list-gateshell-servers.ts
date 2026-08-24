import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import {
  ListServersResult,
  ServerEntry,
} from "../services/gateshell-manager.js";
import { Logger } from "../utils/logger.js";
import { toToolError } from "../utils/tool-error.js";

export function formatGateShellServerList(servers: ServerEntry[]): string {
  if (servers.length === 0) {
    return "No servers found on this GateShell connection.";
  }
  const lines = servers.map((s) => {
    const parts = [
      String(s.index).padStart(3, "0"),
      s.name,
      s.host,
      s.protocol,
      s.username,
    ];
    if (s.group) parts.push(s.group);
    return parts.join(" | ");
  });
  return ["GateShell servers:", ...lines].join("\n");
}

export function formatGateShellListResult(result: ListServersResult): string {
  const parts = [formatGateShellServerList(result.servers)];
  parts.push(`phase: ${result.phase}`);
  if (result.currentServer) {
    const s = result.currentServer;
    parts.push(
      `current: ${String(s.index).padStart(3, "0")} ${s.name} (${s.host}) as ${s.username}`,
    );
  }
  if (result.reusedCache) {
    parts.push("note: returned cached list; pass refresh=true to re-read the bastion menu.");
  }
  if (result.phase === "server") {
    parts.push(
      "note: currently on a backend host. execute-command runs there. disconnect first to leave the host.",
    );
  }
  return parts.join("\n");
}

export function registerListGateShellServersTool(server: McpServer): void {
  const sshManager = SSHConnectionManager.getInstance();

  server.registerTool(
    "list-gateshell-servers",
    {
      description:
        "List available servers behind a GateShell (bastion host). Only works for connections with type 'gateshell'. If already connected to a backend host, returns the cached list and current server instead of parsing bash output as an empty menu. Pass refresh=true to exit the host and re-read the bastion menu.",
      inputSchema: {
        connectionName: z
          .string()
          .optional()
          .describe("SSH connection name (optional, default is 'default')"),
        refresh: z
          .boolean()
          .optional()
          .describe(
            "If true, leave the current backend host (if any) and re-read the bastion menu",
          ),
      },
    },
    async ({ connectionName, refresh }) => {
      try {
        const config = sshManager.getConfig(connectionName);
        if (config.type !== "gateshell") {
          return {
            content: [
              {
                type: "text" as const,
                text: `Connection '${connectionName || "default"}' is not a gateshell type.`,
              },
            ],
            isError: true,
          };
        }
        await sshManager.connect(connectionName);
        const gsManager = sshManager.getGateShellManager(connectionName);
        await gsManager.openShell();
        const result = await gsManager.listServers({ refresh: refresh === true });
        return {
          content: [
            { type: "text" as const, text: formatGateShellListResult(result) },
          ],
        };
      } catch (error: unknown) {
        const toolError = toToolError(error, "UNKNOWN_ERROR");
        Logger.handleError(toolError, "Failed to list GateShell servers");
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  code: toolError.code,
                  message: toolError.message,
                  retriable: toolError.retriable,
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
