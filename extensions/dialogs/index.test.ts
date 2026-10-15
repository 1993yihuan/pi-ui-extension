import assert from "node:assert/strict";
import test from "node:test";
import { createDialogUI, modalFrame } from "./index.ts";
import { stripTerminalSequences, visibleWidth, type Component } from "@earendil-works/pi-tui";
const theme={fg(_key:string,text:string){return text;},bold(text:string){return text;}} as any;
type Modal=Component&{handleInput(data:string):void};
function fakeUI(rows=35,columns=100){
 const active:Modal[]=[],options:any[]=[];let closes=0;
 const tui={terminal:{rows,columns},requestRender(){}} as any;
 const ui={select(){throw Error('native selector')},input(){throw Error('native input')},confirm(){throw Error('native confirm')},editor(){throw Error('native editor')},notify(){},
 custom<T>(factory:any,opts:any):Promise<T>{options.push(opts);return new Promise<T>((resolve)=>{const modal=factory(tui,theme,{},(value:T)=>{closes++;resolve(value)});active.push(modal)})}} as any;
 return {ui:createDialogUI(ui),active,options,tui,get closes(){return closes}};
}
const plain=(c:Component,w=66)=>c.render(w).map(stripTerminalSequences);
test('danger confirmation defaults to cancel in a centered overlay',async()=>{
 const mock=fakeUI(),first=mock.ui.confirm('Clear other sessions','Move 2 inactive sessions to trash?'),view=mock.active[0]!;
 assert.match(plain(view).join('\n'),/Clear other sessions[\s\S]*Move 2 inactive[\s\S]*Cancel[\s\S]*Move to Trash/);
 assert.equal(mock.options[0].overlay,true);assert.equal(mock.options[0].overlayOptions.anchor,'center');
 view.handleInput('\r');assert.equal(await first,false);
 const second=mock.ui.confirm('Delete session','Move to trash?');mock.active[1]!.handleInput('\x1b[B');mock.active[1]!.handleInput('\r');
 assert.equal(await second,true);assert.equal(mock.closes,2);
});
test('Esc cancels selection, destructive confirmation and text input',async()=>{
 const mock=fakeUI();const a=mock.ui.select('Sort',['First','Second']);mock.active[0]!.handleInput('\x1b');assert.equal(await a,undefined);
 const b=mock.ui.confirm('Delete','Trash?');mock.active[1]!.handleInput('\x1b');assert.equal(await b,false);
 const c=mock.ui.input('Rename','Old');mock.active[2]!.handleInput('\x1b');assert.equal(await c,undefined);
});
test('selector supports keyboard and mouse; frame fits narrow widths',async()=>{
 const mock=fakeUI();const selected=mock.ui.select('Skills',['first','second','third','last '.repeat(28)]);
 for(const row of plain(mock.active[0]!,28))assert.ok(visibleWidth(row)<=28);
 mock.active[0]!.handleInput('\x1b[B');mock.active[0]!.handleInput('\r');assert.equal(await selected,'second');
 const mouse=mock.ui.select('Skills',['first','second','third']);const view=mock.active[1]!;view.render(50);
 const clicked=view.handleMouse?.({type:'click',button:'left',x:5,y:5,width:50,height:10,screenX:5,screenY:5} as any);
 assert.equal(clicked?.handled,true);assert.equal(await mouse,'third');
});
test('text input saves typing and read-only preview scrolls without editing',async()=>{
 const mock=fakeUI(20),pending=mock.ui.input('Rename','Old');for(const key of 'Updated')mock.active[0]!.handleInput(key);mock.active[0]!.handleInput('\r');assert.equal(await pending,'Updated');
 const original=Array.from({length:45},(_,i)=>`detail row ${i+1}`).join('\n'),result=mock.ui.editor('AGENTS.md',original),v=mock.active[1]!;
 assert.match(plain(v).join('\n'),/detail row 1\b/);v.handleInput('\x1b[6~');const after=plain(v).join('\n');assert.doesNotMatch(after,/detail row 1\b/);assert.match(after,/detail row 9\b/);
 v.handleInput('\x1b');assert.equal(await result,undefined);assert.equal(original.split('\n').length,45);
});
test('modal frame fits terminal widths and escapes long titles',()=>{
 for(const width of [8,12,20,38,76]){const f=modalFrame(theme,width,'A very long title with a name',['some extended content'],'Enter select · Esc cancel',true);for(const row of f)assert.ok(visibleWidth(row)<=width,`width ${width}`)}
});
