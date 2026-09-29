import assert from "node:assert/strict";
import test from "node:test";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { estimateContext, estimateProviderToolsTokens, installContextEstimates } from "./data.ts";

const tool = { name: "fabric_exec", description: "Execute TypeScript", parameters: createReadTool(process.cwd()).parameters };
const expected = Math.ceil(JSON.stringify(tool).length / 4);
const toolsCategory = (snapshot: ReturnType<typeof estimateContext>) => snapshot.categories.find(c => c.name === "Tools")!;

test("Tools counts schema JSON only and contributes to totals and percentages", () => {
 const decorated = { ...tool, sourceInfo: {path:"ignored".repeat(1000)}, promptGuidelines:["ignored".repeat(1000)] };
 const snapshot = estimateContext([{role:"user",content:"abcd"}], "abcd", "context hook", [decorated]);
 assert.equal(toolsCategory(snapshot).tokens, expected);
 assert.equal(snapshot.total, expected + 2);
 assert.equal(toolsCategory(snapshot).percent, expected / (expected + 2) * 100);
 assert.ok(Math.abs(snapshot.categories.reduce((sum,c)=>sum+(c.percent??0),0)-100)<1e-9);
 assert.equal(toolsCategory(estimateContext([], "", "active branch", [])).tokens, 0);
 assert.equal(toolsCategory(estimateContext([])).tokens, undefined);
 assert.equal(estimateProviderToolsTokens({ tools: [tool] }), Math.ceil(JSON.stringify([tool]).length / 4));
 assert.equal(estimateProviderToolsTokens({}), 0);
 assert.equal(estimateProviderToolsTokens(undefined), undefined);
 const cyclic: any = {type:"object"}; cyclic.self = cyclic;
 assert.equal(toolsCategory(estimateContext([], "", "active branch", [tool, {...tool,parameters:cyclic}])).tokens, undefined);
});

test("tracker filters active tools, refreshes dynamic schemas, caches reads and resets", () => {
 const handlers = new Map<string, Function>();
 let active = ["fabric_exec", "fabric_exec"];
 let all = [tool, {...tool,name:"captured_read",description:"not exposed".repeat(100)}];
 let reads = 0;
 let fail = false;
 const tracker = installContextEstimates({
  on:(name:string,fn:Function)=>handlers.set(name,fn),
  getActiveTools:()=>{if(fail) throw new Error("unavailable");return active;},
  getAllTools:()=>{reads++;return all;},
 } as any, ()=>{});
 const ctx = {sessionManager:{buildContextEntries:()=>[]},getSystemPrompt:()=>""};
 handlers.get("session_start")!({},ctx);
 assert.equal(toolsCategory(tracker.getSnapshot()).tokens, expected);
 const cached = tracker.getSnapshot(); const priorReads = reads;
 assert.strictEqual(tracker.getSnapshot(),cached); assert.equal(reads,priorReads);
 active = ["captured_read"];
 handlers.get("context")!({messages:[]},ctx);
 assert.ok(toolsCategory(tracker.getSnapshot()).tokens! > expected);
 handlers.get("before_provider_request")!({payload:{tools:[tool]}},ctx);
 assert.equal(toolsCategory(tracker.getSnapshot()).tokens, Math.ceil(JSON.stringify([tool]).length/4));
 all = [{...tool,description:"changed"}]; active = ["fabric_exec"];
 handlers.get("turn_end")!({},ctx);
 // The last provider payload remains authoritative through active-branch refresh.
 assert.equal(toolsCategory(tracker.getSnapshot()).tokens, Math.ceil(JSON.stringify([tool]).length/4));
 active = [];
 handlers.get("agent_settled")!({},ctx);
 // The observed request remains the best provider-level measurement until the next context reset.
 assert.equal(toolsCategory(tracker.getSnapshot()).tokens, Math.ceil(JSON.stringify([tool]).length/4));
 active = ["missing"];
 handlers.get("session_tree")!({},ctx);
 assert.equal(toolsCategory(tracker.getSnapshot()).tokens,undefined);
 fail = true;
 handlers.get("session_compact")!({},ctx);
 assert.equal(toolsCategory(tracker.getSnapshot()).tokens,undefined);
 handlers.get("session_shutdown")!();
 assert.equal(tracker.getSnapshot().source,"unavailable");
 assert.equal(toolsCategory(tracker.getSnapshot()).tokens,undefined);
});
