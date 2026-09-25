import * as assert from "assert";
import { agentFlowSelectionIsFresh, parseAgentFlowSelectionRequest } from "../../agentFlowSelectionProtocol";

suite("AgentFlow selection protocol", () => {
    const request = { version: 1 as const, nonce: "12345678-1234-1234-1234-123456789012", sourcePID: 42,
        gestureStartedAt: 9000, requestedAt: 10_000 };
    test("only a bounded versioned recent request is accepted", () => {
        assert.deepStrictEqual(parseAgentFlowSelectionRequest(request, 10_050), request);
        for (const update of [{ version: 2 }, { nonce: "bad" }, { sourcePID: -1 },
            { gestureStartedAt: 10_001 }, { requestedAt: 20_000 }, { requestedAt: 1 },
            { gestureStartedAt: NaN }, { sourcePID: 1.5 }]) {
            assert.strictEqual(parseAgentFlowSelectionRequest({ ...request, ...update }, 10_050), undefined);
        }
    });
    test("fresh selection belongs to this gesture, including a long drag", () => {
        assert.ok(agentFlowSelectionIsFresh(request, 9001, 10_050));
        assert.ok(!agentFlowSelectionIsFresh(request, 8500, 10_050));
        assert.ok(!agentFlowSelectionIsFresh(request, 11_000, 10_050));
        assert.ok(!agentFlowSelectionIsFresh(request, 9500, 12_000));
    });
});
