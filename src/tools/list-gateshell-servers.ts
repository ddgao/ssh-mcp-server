import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { ServerEntry } from "../services/gateshell-manager.js";
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

export function registerListGateShellServersTool(server: McpServer): void {
  const sshManager = SSHConnectionManager.getInstance();

  server.registerTool(
    "list-gateshell-servers",
    {
      description:
        "List available servers behind a GateShell (bastion host). Only works for connections with type 'gateshell'.",
      inputSchema: {
        connectionName: z
          .string()
          .optional()
          .describe("SSH connection name (optional, default is 'default')"),
      },
    },
    async ({ connectionName }) => {
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
        const servers = await gsManager.listServers();
        return {
          content: [
            { type: "text" as const, text: formatGateShellServerList(servers) },
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
