import { Runtime } from './runtime.mjs'

export const name = 'dsh-life-assistant'
export const inject = ['sessionController','workspaceController','agentPresets','tools','systemPrompt','sessions','attachments','tokenMeter']

export async function apply(ctx, config = {}) {
  const runtime = new Runtime({ ...config, nativeContext: ctx, attachments: ctx.get('attachments') })
  ctx.on('dispose', () => runtime.stop())
  await runtime.start()
}
