import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";
import { toToolError } from "../utils/tool-error.js";

export function registerConnectGateShellServerTool(server: McpServer): void {
  const sshManager = SSHConnectionManager.getInstance();

  server.registerTool(
    "connect-gateshell-server",
    {
      description:
        "Connect to a specific server behind a GateShell (bastion host) by its index. Use list-gateshell-servers first to get available servers.",
      inputSchema: {
        serverIndex: z.number().describe("Server index from the GateShell server list"),
        connectionName: z
          .string()
          .optional()
          .describe("SSH connection name (optional, default is 'default')"),
      },
    },
    async ({ serverIndex, connectionName }) => {
      try {
        const gsManager = sshManager.getGateShellManager(connectionName);
        await gsManager.connectServer(serverIndex);
        return {
          content: [
            {
              type: "text" as const,
              text: `Connected to server ${serverIndex} through GateShell.`,
            },
          ],
        };
      } catch (error: unknown) {
        const toolError = toToolError(error, "UNKNOWN_ERROR");
        Logger.handleError(toolError, "Failed to connect to GateShell server");
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
