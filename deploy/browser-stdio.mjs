// A native DSH MCP child process: no shell, no credentials, no browser logic.
import {connect} from 'node:net'
const socket=connect('/run/yoyo-browser/mcp.sock')
process.stdin.pipe(socket);socket.pipe(process.stdout)
socket.on('error',()=>{process.stderr.write('Isolated browser bridge unavailable\n');process.exitCode=1})
socket.on('close',()=>process.exit(process.exitCode??0))
process.stdin.on('end',()=>socket.end())
