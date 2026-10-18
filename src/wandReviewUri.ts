/** Strict transport admission only; Better Git owns the review transaction. */
export interface WandReviewCommand {phase:"begin"|"step"|"finish"|"cancel"|"heartbeat";id:string;seq:number;direction:"next"|"previous";mode:"changes"|"files"}
export function parseWandReviewUri(uri:{scheme:string;authority:string;path:string;query:string}):WandReviewCommand|undefined {
 if(uri.scheme!=="vscode" || uri.authority.toLowerCase()!=="ethansk.better-git-vscode" || uri.query.length>512){return;}
 const match=/^\/wand-review\/(begin|step|finish|cancel|heartbeat)$/.exec(uri.path);if(!match){return;}
 const p=new URLSearchParams(uri.query),keys=[...p.keys()];
 if(keys.length!==5 || new Set(keys).size!==5 || keys.some(k=>!["id","seq","direction","mode","version"].includes(k)) || p.get("version")!=="1"){return;}
 const id=p.get("id")??"",raw=p.get("seq")??"",seq=Number(raw),direction=p.get("direction"),mode=p.get("mode");
 if(!/^[0-9a-f-]{36}$/i.test(id)||!/^\d+$/.test(raw)||!Number.isSafeInteger(seq)||seq>2147483647||(direction!=="next"&&direction!=="previous")||(mode!=="changes"&&mode!=="files")){return;}
 return {phase:match[1] as WandReviewCommand["phase"],id,seq,direction,mode};
}
