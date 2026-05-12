import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";

/**
 * Register disconnect tool
 */
export function registerDisconnectTool(server: McpServer): void {
  server.registerTool(
    "disconnect",
    {
      description:
        "Disconnect an SSH connection by name. If no name is provided, disconnects the default connection.",
      inputSchema: {
        connectionName: z
          .string()
          .optional()
          .describe(
            "SSH connection name to disconnect (optional, default is 'default')",
          ),
      },
    },
    async ({ connectionName }) => {
      const sshManager = SSHConnectionManager.getInstance();
      const name = connectionName || "default";
      sshManager.disconnectByName(name);
      return {
        content: [
          {
            type: "text",
            text: `SSH connection '${name}' disconnected.`,
          },
        ],
      };
    },
  );
}
