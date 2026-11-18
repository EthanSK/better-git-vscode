// Count first-action observations from retained Better Git logs; pass log paths, or pipe logs on stdin.
import { readFileSync } from 'node:fs';

const sessions = new Map();
const inputs = process.argv.slice(2);
for (const input of inputs.length ? inputs : [0]) {
    for (const line of readFileSync(input, 'utf8').split('\n')) {
        const marker = '[worktree-usage] ';
        const start = line.indexOf(marker);
        if (start < 0) { continue; }
        let event;
        try { event = JSON.parse(line.slice(start + marker.length)); } catch { continue; }
        if (typeof event?.id !== 'string') { continue; }
        const session = sessions.get(event.id) ?? { clicked: false };
        if (event.event === 'click') { session.clicked = true; }
        // The owning window records the actual review. The receiving host's
        // routing receipt is part of that same click, not a second attempt.
        if (event.event === 'outcome' && event.reason === 'routed-to-window') { session.forwarded = true; }
        if (event.event === 'outcome' && ['review-input-first', 'codex-return-first', 'automatic-return-configured', 'unknown'].includes(event.outcome)) {
            session.outcome ??= event.outcome;
        }
        sessions.set(event.id, session);
    }
}
const counts = { clicks: 0, reviewInputFirst: 0, codexReturnFirst: 0, automaticReturnsConfigured: 0, unknown: 0, pending: 0, outcomesMissingClick: 0 };
for (const session of sessions.values()) {
    if (session.forwarded) { continue; }
    if (!session.clicked) { counts.outcomesMissingClick++; continue; }
    counts.clicks++;
    switch (session.outcome) {
        case 'review-input-first': counts.reviewInputFirst++; break;
        case 'codex-return-first': counts.codexReturnFirst++; break;
        case 'automatic-return-configured': counts.automaticReturnsConfigured++; break;
        case 'unknown': counts.unknown++; break;
        default: counts.pending++; break;
    }
}
console.log(JSON.stringify(counts, null, 2));
