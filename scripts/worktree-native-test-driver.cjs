const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
exports.run = async () => {
 const root = process.env.BGV_SWITCH_ROOT;
 const git = (await vscode.extensions.getExtension('vscode.git').activate()).getAPI(1);
 const api = await vscode.extensions.getExtension('EthanSK.better-git-vscode').activate();
 const roots = JSON.parse(fs.readFileSync(path.join(root,'roots.json'),'utf8'));
 for(const p of roots.slice(0, -1)) { const repo=git.getRepository(vscode.Uri.file(p)) ?? await git.openRepository(vscode.Uri.file(p)); await repo.status(); }
 await vscode.commands.executeCommand('workbench.view.scm');
 await vscode.commands.executeCommand('workbench.scm.action.expandAllRepositories');
 const input = path.join(root,'request.json'), output=path.join(root,'result.json');
 let previous=0, busy=false;
 const state=()=>({ focused:vscode.window.state.focused, badge:api.getCurrentReviewUri() ? api.getReviewDecorationBadge(vscode.Uri.parse(api.getCurrentReviewUri())) : undefined, trace:api.getScmTreeCommandTrace(), active:String(vscode.window.activeTextEditor?.document.uri), tabs:vscode.window.tabGroups.activeTabGroup.tabs.map(t=>({label:t.label,active:t.isActive})) });
 fs.writeFileSync(path.join(root,'ready.json'),JSON.stringify({ roots, version:vscode.version, ...state() }));
 await new Promise(resolve=> {
  const timer=setInterval(async()=> {
   if(busy || !fs.existsSync(input)) return;
   let request; try { request=JSON.parse(fs.readFileSync(input,'utf8')); } catch {return;}
   if(request.id===previous) return;
   previous=request.id; busy=true;
   try {
    let value;
    if(request.action==='badge') value=api.getReviewDecorationBadge(vscode.Uri.file(path.join(roots[request.repo],request.file)));
    else if(request.action==='open') value=await vscode.commands.executeCommand('better-git-vscode.open-worktree-in-source-control',vscode.Uri.file(roots[request.repo]));
    else if(request.action==='plain') value=await vscode.commands.executeCommand('vscode.open',vscode.Uri.file(path.join(roots[request.repo],'a.txt')));
    else if(request.action==='refresh') value=await git.getRepository(vscode.Uri.file(roots[request.repo])).status();
    else if(request.action==='command') value=await vscode.commands.executeCommand(request.command,...(request.args??[]));
    else if(request.action==='stop') { clearInterval(timer); resolve(); }
    fs.writeFileSync(output,JSON.stringify({id:request.id,ok:true,value,...state()}));
   } catch(error) { fs.writeFileSync(output,JSON.stringify({id:request.id,ok:false,error:String(error),...state()})); }
   finally { busy=false; }
  },30);
 });
};
