// Thin launch adapter around the official DSH per-Session MCP integration.
import {mountSessionMcp} from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
export const name='yoyo-isolated-playwright'
export const inject=['browserUse','agents','tools','systemPrompt']
export function apply(ctx){
 mountSessionMcp(ctx,{name:'playwright-mcp',exclusive:false,command:process.execPath,args:['/opt/dsh-life-assistant/deploy/browser-stdio.mjs'],toolCallTimeoutMs:45000})
}
