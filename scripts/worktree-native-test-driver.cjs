const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
exports.run = async () => {
 const root = process.env.BGV_SWITCH_ROOT;
 const git = (await vscode.extensions.getExtension('vscode.git').activate()).getAPI(1);
 // Capture the real registered handler in the disposable host, avoiding OS URL
 // routing that could deliver a test link to an unrelated normal Code window.
 let uriHandler;
 const registerUriHandler = vscode.window.registerUriHandler;
 vscode.window.registerUriHandler = handler => { uriHandler=handler; return registerUriHandler(handler); };
 let api;
 try { api = await vscode.extensions.getExtension('EthanSK.better-git-vscode').activate(); }
 finally { vscode.window.registerUriHandler=registerUriHandler; }
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
    else if(request.action==='uri') {
     if(!uriHandler) throw new Error('Better Git URI handler was not captured');
     value=await uriHandler.handleUri(vscode.Uri.parse(request.uri));
    }
    else if(request.action==='config') {
     const config=vscode.workspace.getConfiguration('better-git-vscode');
     for(const [key,setting] of Object.entries(request.settings)) await config.update(key,setting,vscode.ConfigurationTarget.Global);
     const current=vscode.workspace.getConfiguration('better-git-vscode');
     value={enabled:current.get('worktreeLinkReturnFocus'),app:current.get('worktreeLinkReturnApp')};
    }
    else if(request.action==='copy') {
     const before=await vscode.env.clipboard.readText();
     let copied;
     try { await vscode.commands.executeCommand('better-git-vscode.copy-worktree-link',{rootUri:vscode.Uri.file(roots[request.repo])}); copied=await vscode.env.clipboard.readText(); value=copied; }
     finally { if(copied!==undefined && await vscode.env.clipboard.readText()===copied) await vscode.env.clipboard.writeText(before); }
    }
    else if(request.action==='command') value=await vscode.commands.executeCommand(request.command,...(request.args??[]));
    else if(request.action==='stop') { clearInterval(timer); resolve(); }
    fs.writeFileSync(output,JSON.stringify({id:request.id,ok:true,value,...state()}));
   } catch(error) { fs.writeFileSync(output,JSON.stringify({id:request.id,ok:false,error:String(error),...state()})); }
   finally { busy=false; }
  },30);
 });
};
