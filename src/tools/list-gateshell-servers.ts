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
        "List available servers behind a GateShell (bastion host). Only works for connections with type 'gateshell'. If already connected to a backend host, returns the cached list and current server. Pass refresh=true to disconnect and rebuild this SSH connection, then read a fresh menu. This ends the current host session. Concurrent terminal operations are rejected with GATESHELL_BUSY.",
      inputSchema: {
        connectionName: z
          .string()
          .optional()
          .describe("SSH connection name (optional, defaults to the configured GateShell bastion)"),
        refresh: z
          .boolean()
          .optional()
          .describe(
            "If true, fully reconnect SSH and read a fresh menu; this may terminate processes attached to the old session",
          ),
      },
    },
    async ({ connectionName, refresh }) => {
      try {
        const name = sshManager.resolveGateShellName(connectionName);
        const config = sshManager.getConfig(name);
        if (config.type !== "gateshell") {
          return {
            content: [
              {
                type: "text" as const,
                text: `Connection '${name}' is not a gateshell type. Specify the GateShell connectionName.`,
              },
            ],
            isError: true,
          };
        }
        const result = await sshManager.withGateShellOperation(name, async () => {
          // This bastion does not reliably return a menu on a second shell of
          // the same SSH transport. Refresh must rebuild the transport itself.
          if (refresh === true) sshManager.disconnectByName(name);
          await sshManager.connect(name);
          const gsManager = sshManager.getGateShellManager(name);
          await gsManager.openShell();
          return gsManager.listServers();
        });
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
