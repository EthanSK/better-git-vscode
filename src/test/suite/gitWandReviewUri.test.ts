import * as assert from "assert";
import {parseWandReviewUri} from "../../wandReviewUri";
suite("Wand review URI",()=>{
 const base={scheme:"vscode",authority:"ethansk.better-git-vscode",path:"/wand-review/begin",query:"version=1&id=12345678-1234-1234-1234-123456789abc&seq=0&direction=next&mode=changes"};
 test("admits only the versioned own-source lifecycle",()=>{for(const phase of ["begin","step","mode","finish","cancel","heartbeat"]){assert.strictEqual(parseWandReviewUri({...base,path:"/wand-review/"+phase})?.phase,phase);}});
 test("rejects forged source, paths, duplicate arguments and malformed numbers",()=>{for(const change of [{scheme:"https"},{authority:"other.extension"},{path:"/wand-review/stage-any-file"},{query:base.query+"&source=corsair"},{query:base.query+"&seq=1"},{query:base.query.replace("seq=0","seq=-1")},{query:base.query.replace("mode=changes","mode=eyes")}]){assert.strictEqual(parseWandReviewUri({...base,...change}),undefined);}});
});
