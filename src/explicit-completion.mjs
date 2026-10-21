import { randomUUID } from 'node:crypto'

// Use the native stopping boundary, never a second model loop. Repeated refusal
// is an interrupted run, not successful completion or an unbounded wake loop.
export function completionGuard({decided,reminder,maxReminders=2}) {
  let lastTurn=null,reminders=0
  return ({agent,turn})=>{
    if(lastTurn!==turn){lastTurn=turn;reminders=0}
    if(decided())return
    if(reminders++>=maxReminders)throw Error('尚未明确结束任务：保留进度，等待处理')
    agent.steer({id:randomUUID(),role:'user',source:{kind:'user'},content:[{type:'text',text:reminder}]})
  }
}
