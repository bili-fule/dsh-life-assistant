import { Runtime } from './runtime.mjs'

export const name = 'dsh-life-assistant'
export const inject = ['llm','attachments']

export async function apply(ctx, config = {}) {
  const runtime = new Runtime({ ...config, llm: ctx.llm, attachments: ctx.get('attachments') })
  ctx.on('dispose', () => runtime.stop())
  await runtime.start()
}
