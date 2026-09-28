import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { codexBaseline, discoverCommitModels, selectClaudeCommitModel, selectCodexCommitModel } from "../../commitMessageModels";

suite("Commit model selection", () => {
    const codex = (model: string, efforts = ["low"], hidden = false) => ({ model, hidden,
        supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort })) });
    const claude = (family: string, version: string) => ({ value: family,
        resolvedModel: `claude-${family}-${version.replace('.', '-')}`, displayName: `${family} ${version}`,
        supportsEffort: true, supportedEffortLevels: ["low", "high"] });
    test("Codex uses the newest small generation, not a newer flagship or hidden model", () => {
        const selected = selectCodexCommitModel([codex("gpt-8-astra"), codex("gpt-6-luna"),
            codex("gpt-7-luna"), codex("gpt-9-mini", ["low"], true), codex("claude-opus-9")]);
        assert.strictEqual(selected.id, "gpt-7-luna");
        assert.strictEqual(selected.effort, "low");
    });
    test("Codex ranks version numbers numerically and picks the smallest at that version", () => {
        assert.strictEqual(selectCodexCommitModel([codex("gpt-9-luna"), codex("gpt-10-luna"),
            codex("gpt-10-mini"), codex("gpt-10-nano")]).id, "gpt-10-nano");
    });
    test("Codex uses supported none effort but never invents it", () => {
        assert.strictEqual(selectCodexCommitModel([codex("gpt-6-luna", ["none", "low"])]).effort, "none");
        assert.strictEqual(selectCodexCommitModel([codex("gpt-6-luna", ["low"])]).effort, "low");
    });
    test("old, malformed or special-purpose catalogues use Luna rather than the CLI default", () => {
        for (const list of [[], [null], [codex("gpt-5.5")], [codex("codex-auto-review")],
            [codex("gpt-6-mini-preview")], [codex("gpt-6-luna", ["ultra"])]]) {
            assert.deepStrictEqual(selectCodexCommitModel(list), codexBaseline);
        }
    });
    test("Claude picks Opus 5.5 over older smaller families", () => {
        assert.strictEqual(selectClaudeCommitModel([claude("haiku", "4.5"), claude("sonnet", "5"),
            claude("fable", "5.1"), claude("opus", "5.5")])?.id, "opus");
    });
    test("Claude follows a new smallest family within the newest version", () => {
        assert.strictEqual(selectClaudeCommitModel([claude("opus", "5.5"), claude("sonnet", "5.5")])?.id, "sonnet");
        assert.strictEqual(selectClaudeCommitModel([claude("opus", "6"), claude("haiku", "6")])?.id, "haiku");
    });
    test("Claude handles older display-name metadata, dated IDs and models without effort", () => {
        const model = selectClaudeCommitModel([{ value: "haiku", displayName: "Haiku 4.5" },
            { value: "claude-haiku-4-5-20251001", resolvedModel: "claude-haiku-4-5-20251001" }]);
        assert.strictEqual(model?.id, "haiku");
        assert.strictEqual(model?.effort, undefined);
    });
    test("Claude ignores disabled, default, plan, extended and unrecognized catalogue entries", () => {
        assert.strictEqual(selectClaudeCommitModel([null, { ...claude("opus", "99"), disabled: true },
            { ...claude("opus", "99"), value: "default" }, { ...claude("opus", "99"), value: "opusplan" },
            { ...claude("opus", "99"), value: "opus[1m]" }, { value: "other", displayName: "Other 100" }]), undefined);
    });
});

suite("Commit model discovery", () => {
    let directory: string;
    setup(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "bgv-model-protocol-")); });
    teardown(() => fs.rmSync(directory, { recursive: true, force: true }));
    const script = (body: string): string => {
        const executable = path.join(directory, "fake-cli");
        fs.writeFileSync(executable, `#!${process.execPath}\n${body}`); fs.chmodSync(executable, 0o755); return executable;
    };
    test("Codex handshakes, handles split lines and follows pagination without starting a turn", async () => {
        const executable = script(`const rl = require('readline').createInterface({input:process.stdin});
rl.on('line',line=>{const m=JSON.parse(line);let r;
if(m.method==='initialize') r={id:m.id,result:{}};
else if(m.method==='initialized') return;
else if(m.method==='model/list') r={id:m.id,result:{data:[m.params.cursor?'second':'first'],nextCursor:m.params.cursor?null:'page2'}};
else process.exit(9);
const s=JSON.stringify(r)+'\\n';process.stdout.write(s.slice(0,5));setTimeout(()=>process.stdout.write(s.slice(5)),5);});`);
        assert.deepStrictEqual(await discoverCommitModels("codex", executable, directory, new AbortController().signal), ["first", "second"]);
    });
    test("Claude asks for metadata only and ignores unrelated notifications", async () => {
        const executable = script(`require('readline').createInterface({input:process.stdin}).on('line',line=>{
const m=JSON.parse(line);if(m.type!=='control_request'||m.request.subtype!=='initialize')process.exit(9);
console.log(JSON.stringify({type:'system'}));console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{models:['opus']}}}));});`);
        assert.deepStrictEqual(await discoverCommitModels("claude", executable, directory, new AbortController().signal), ["opus"]);
    });
    test("cancellation and a hung CLI terminate discovery", async () => {
        const executable = script("setInterval(()=>{},1000)");
        const controller = new AbortController();
        const running = discoverCommitModels("codex", executable, directory, controller.signal);
        controller.abort(); await assert.rejects(running, /cancelled/);
        await assert.rejects(discoverCommitModels("codex", executable, directory, new AbortController().signal, 30), /timed out/);
    });
    test("exit, error response and excessive output fail instead of hanging", async () => {
        for (const body of ["process.exit(1)", "process.stdout.write('x'.repeat(1000001));setInterval(()=>{},1000)",
            "console.log(JSON.stringify({id:1,error:{message:'no'}}));setInterval(()=>{},1000)"]) {
            await assert.rejects(discoverCommitModels("codex", script(body), directory, new AbortController().signal, 500));
        }
    });
});
