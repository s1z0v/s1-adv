#!/usr/bin/env node
// Standalone bridge equivalent of the native agent tool. It needs the same
// private config access the operator already granted to the agent.
import { createAgentStatusTool } from '../src/agent-status.mjs';
const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2) {
  if(!args[i]?.startsWith('--') || args[i+1]===undefined) throw new Error('Expected --name value arguments.');
  options[args[i].slice(2)]=args[i+1];
}
const tool=createAgentStatusTool({sessionKey:options['session-key']},{configPath:options.config});
if(!tool) throw new Error('No private configured Cardputer session.');
const result=await tool.execute('standalone-status',{
  request_id:options['request-id'],task_id:options['task-id'],state:options.state,
  work_kind:options['work-kind'],question:options.question
});
console.log(result.content[0].text);
