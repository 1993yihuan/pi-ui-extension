import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth, ScrollView } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { ContextPanel } from "./panel.ts";
import { estimateContext } from "./data.ts";
import { createActivityTracker } from "./activity.ts";

for (const width of [18, 30, 50]) test(`composition is always visible below a separator at width ${width}`, () => {
 const panel = new ContextPanel({fg:(_c:string,s:string)=>s} as any, {
  getDesiredWidth:()=>width, getUsage:()=>({percent:25,contextWindow:100000} as any),
  getCacheHitRate:()=>42,
  getModel:()=>"model", getThinkingLevel:()=>"off",
  getEstimate:()=>estimateContext([{role:"toolResult",toolName:"read",toolCallId:"1",content:[{type:"text",text:"x".repeat(400000)}]}]),
 });
 const lines=panel.render(width);
 assert.ok(lines.every(line=>visibleWidth(line)<=width));
 assert.ok(lines[2].includes("25%/100K"));
 if (width >= 30) assert.ok(lines[2].includes("Cache:42%"));
 const separator=lines.findIndex(line=>line===`│ ${"─".repeat(width-4)} │`);
 if (width >= 30) assert.ok(separator>0);
 for(const label of ["System", "Tools", "Messages", "Tool Results", "Summary", "Other", "Images"])
  assert.ok(lines.findIndex(line=>line.includes(label))>separator,label);
 assert.ok(lines.some(line=>line.includes("~100K")));
 assert.doesNotMatch(lines.join("\n"), /Composition|▸|▾|Top 3/);
 assert.deepEqual(panel.render(width),lines);
 for(const narrow of [1,2,4,12])assert.ok(panel.render(narrow).every(line=>visibleWidth(line)<=narrow));
 const scroll=new ScrollView(panel,{follow:"none"});
 const frame=renderLayoutFrame(scroll,width,7,()=>{});
 assert.equal(frame.lines.length,7);
 assert.ok(lines.length>frame.lines.length);
});

test("run delta renders on the bar and after the window value", () => {
 const theme={fg:(_c:string,s:string)=>s} as any;
 const build=(delta:number|undefined)=>new ContextPanel(theme,{
  getDesiredWidth:()=>50,getUsage:()=>({percent:25,contextWindow:200000} as any),
  getCacheHitRate:()=>42,getModel:()=>"model",getThinkingLevel:()=>"off",
  getDelta:()=>delta,
  getEstimate:()=>estimateContext([{role:"user",content:"abcd"}]),
 });
 const lines=build(12000).render(50);
 assert.ok(lines[2].includes("25%/200K +12K"));
 assert.ok(lines[2].includes("Cache:42%"));
 assert.doesNotMatch(lines[2], /Catch/);
 // The accent segment is the last slice of the already-filled bar, so the bar length never grows.
 assert.equal(lines[3],`│ ${"█".repeat(12)}${"░".repeat(34)} │`);
 assert.equal(build(undefined).render(50)[3],lines[3]);
 assert.ok(build(-210000).render(50)[2].includes("25%/200K −210K"));
 assert.equal(build(-210000).render(50)[3],lines[3]);
 const colored=new ContextPanel({fg:(c:string,s:string)=>`[${c}]${s}`} as any,{
  getDesiredWidth:()=>50,getUsage:()=>({percent:25,contextWindow:200000} as any),
  getDelta:()=>12000,getModel:()=>"model",getThinkingLevel:()=>"off",
 });
 const coloredLines=colored.render(50);
 assert.ok(coloredLines[3].includes("[accent]███"));
 assert.ok(coloredLines[3].includes("[success]█████████"));
 assert.ok(coloredLines[2].includes("[accent] +12K"));
 assert.ok(!build(undefined).render(50)[2].includes("+"));
 const narrow=build(12000).render(18);
 assert.ok(narrow[2].includes("+12K"));
 assert.ok(narrow.every(line=>visibleWidth(line)<=18));
});
test("missing snapshot is visible without interaction",()=>{
 const panel=new ContextPanel({fg:(_c:string,s:string)=>s} as any,{
  getDesiredWidth:()=>50,getUsage:()=>undefined,getModel:()=>"",getThinkingLevel:()=>"",
 });
 assert.match(panel.render(50).join("\n"),/No snapshot available/);
 assert.match(panel.render(50).join("\n"),/not observed/);
 assert.match(panel.render(50).join("\n"),/Cache:\?/);
});

test("activity rows render below the composition and bar", () => {
 const activity={phase:"running",startedAt:1000,averagePerformance:{ttftMs:1000,tokensPerSecond:40},
  turns:[{number:1,startedAt:1000,durationMs:2000,performance:{ttftMs:1200,tokensPerSecond:30},tools:[]},
         {number:2,startedAt:3000,tools:[]}],
  activeTools:[],recentTools:[],completedCount:0,failedCount:0} as any;
 const panel=new ContextPanel({fg:(_c:string,s:string)=>s} as any,{
  getDesiredWidth:()=>50,getUsage:()=>({percent:25,contextWindow:200000} as any),getCacheHitRate:()=>42,
  getModel:()=>"model",getThinkingLevel:()=>"off",getActivity:()=>activity,now:()=>4000,
  getEstimate:()=>estimateContext([{role:"user",content:"abcd"}]),
 });
 const lines=panel.render(50);
 const output=lines.join("\n");
 assert.doesNotMatch(output,/ACTIVITY/);
 assert.match(output,/2 turns · 3s · AVG TTFT 1\.0s · AVG TPS 40\.0/);
 assert.match(output,/TTFT 1\.2s\[fast\]/);
 const activityTop=lines.findIndex(line=>line.includes("2 turns"));
 assert.ok(lines.findIndex(line=>line.includes("Images"))<activityTop);
 assert.ok(activityTop>lines.findIndex(line=>line.includes("25%/200K")));
 assert.ok(lines.every(line=>visibleWidth(line)<=50));
 const settled=new ContextPanel({fg:(_c:string,s:string)=>s} as any,{
  getDesiredWidth:()=>18,getUsage:()=>({percent:25,contextWindow:200000} as any),
  getModel:()=>"model",getThinkingLevel:()=>"off",now:()=>4000,
  getActivity:()=>({...activity,phase:"settled",durationMs:3000} as any),
 });
 const narrow=settled.render(18);
 assert.match(narrow.join("\n"),/done 3s/);
 assert.ok(narrow.every(line=>visibleWidth(line)<=18));
 const idle=new ContextPanel({fg:(_c:string,s:string)=>s} as any,{
  getDesiredWidth:()=>50,getUsage:()=>({percent:25,contextWindow:200000} as any),
  getModel:()=>"model",getThinkingLevel:()=>"off",now:()=>4000,
  getActivity:()=>({...activity,phase:"idle",turns:[],startedAt:undefined} as any),
 });
 assert.match(idle.render(50).join("\n"),/Ready/);
});

test("CTX translates Chinese copy and keeps narrow layouts within display columns", (t) => {
 const previous=process.env.PI_UI_LANG;
 process.env.PI_UI_LANG="zh";
 t.after(()=>{if(previous===undefined)delete process.env.PI_UI_LANG;else process.env.PI_UI_LANG=previous;});
 const activity=createActivityTracker("/fixture",()=>{});
 const panel=new ContextPanel({fg:(_c:string,s:string)=>s} as any,{
  getDesiredWidth:()=>72,getUsage:()=>undefined,getModel:()=>"",getThinkingLevel:()=>"",
  getActivity:()=>activity.getSnapshot(),now:()=>3000,
 });
 const idle=panel.render(72).join("\n");
 for(const label of ["就绪","暂无上下文快照","未观测到","图片","缓存:?","未选择模型"])
  assert.ok(idle.includes(label),label);
 assert.doesNotMatch(idle,/Ready|No snapshot available|not observed|Images|Cache:|no-model/);
 activity.startRun(0);
 activity.startTurn(0,0);
 activity.startResponse(0);
 assert.match(panel.render(72).join("\n"),/1 轮 · 3s/);
 assert.match(panel.render(72).join("\n"),/TTFT ~ · 等待中/);
 activity.updateResponseEstimate(1,1000);
 activity.finishResponse(80,3000);
 activity.settle(3000);
 for(const width of [18,30,50,72]){
  const lines=panel.render(width);
  assert.ok(lines.every(line=>visibleWidth(line)<=width),String(width));
  assert.match(lines.join("\n"),/已完成 3s/);
  assert.doesNotMatch(lines.join("\n"),/\bdone\b|\bturns?\b/);
 }
 assert.match(panel.render(72).join("\n"),/TTFT 1\.0s\[快\]/);
 activity.startRun(0);
 activity.startTurn(0,0);
 activity.settle(3000,true);
 assert.match(panel.render(18).join("\n"),/已中断 3s/);
 const composition=new ContextPanel({fg:(_c:string,s:string)=>s} as any,{
  getDesiredWidth:()=>72,getUsage:()=>undefined,getModel:()=>"model",getThinkingLevel:()=>"off",
  getEstimate:()=>({...estimateContext([{role:"user",content:"abcd"}]),imagesWire:{images:2,source:"provider payload"}}),
 });
 const output=composition.render(72).join("\n");
 for(const label of ["系统","工具定义","消息","工具结果","摘要","其他","未知","图片","2 张"])
  assert.ok(output.includes(label),label);
 assert.doesNotMatch(output,/System|Tools|Messages|Tool Results|Summary|Other|unknown|images/);
});
