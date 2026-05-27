import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env, UserProps } from "../env";
import { registerUploadTools } from "./tools";

export class UploadMcpAgent extends McpAgent<Env, unknown, UserProps> {
  server = new McpServer({ name: "upload-mcp-server", version: "0.1.0" });

  async init(): Promise<void> {
    registerUploadTools(this.server, this.env, () => this.props);
  }
}
