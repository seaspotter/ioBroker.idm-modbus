import { expect } from 'chai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

type Reply = { error?: string; result?: unknown } | 'silent';
interface Handlers {
    onSnapshot(data: { states: Record<string, unknown> }): void;
    onState(id: string, value: unknown, before: unknown): void;
    onConnection(connected: boolean, message?: string): void;
}

/**
 * The page script runs in the browser: run the same file against a fake socket, fake timers and a fake document.
 *
 * @param answers what the fake server answers to a request (`'silent'` = no answer at all)
 */
function setup(answers: (command: string, args: unknown[]) => Reply): {
    start(): Promise<void>;
    handlers: Handlers & { snapshots: number; changes: string[]; connection: (boolean | string)[] };
    sockets: {
        emitted: string[];
        connected: boolean;
        closed: boolean;
        fire(event: string, ...args: unknown[]): void;
    }[];
    advance(ms: number): Promise<void>;
} {
    const timers: { at: number; every?: number; run: () => void; id: number }[] = [];
    let now = 0;
    let nextTimer = 1;
    const sockets: ReturnType<typeof setup>['sockets'] = [];
    const listeners = new Map<string, ((...a: unknown[]) => void)[]>();
    const makeSocket = (): ReturnType<typeof setup>['sockets'][number] => {
        const events = new Map<string, ((...a: unknown[]) => void)[]>();
        const socket = {
            emitted: [] as string[],
            connected: true,
            closed: false,
            fire: (event: string, ...args: unknown[]) => (events.get(event) ?? []).forEach(cb => cb(...args)),
        };
        Object.assign(socket, {
            on: (event: string, cb: (...a: unknown[]) => void) => events.set(event, [...(events.get(event) ?? []), cb]),
            emit: (command: string, ...args: unknown[]) => {
                socket.emitted.push(command);
                const callback = args[args.length - 1];
                if (typeof callback !== 'function') {
                    return;
                }
                const reply = answers(command, args.slice(0, -1));
                if (reply !== 'silent') {
                    callback(reply.error ?? null, reply.result);
                }
            },
            close: () => {
                socket.closed = true;
            },
        });
        sockets.push(socket);
        return socket;
    };
    const context: Record<string, unknown> = {
        navigator: { language: 'en' },
        io: () => makeSocket(),
        document: {
            head: {
                appendChild: (script: { onload: () => void }) => queueMicrotask(() => script.onload()),
            },
            createElement: () => ({}),
            visibilityState: 'visible',
            addEventListener: (event: string, cb: () => void) =>
                listeners.set(event, [...(listeners.get(event) ?? []), cb]),
        },
        setTimeout: (run: () => void, ms: number) => {
            timers.push({ at: now + ms, run, id: nextTimer });
            return nextTimer++;
        },
        clearTimeout: (id: number) => {
            const i = timers.findIndex(t => t.id === id);
            if (i >= 0) {
                timers.splice(i, 1);
            }
        },
        setInterval: (run: () => void, ms: number) => {
            timers.push({ at: now + ms, every: ms, run, id: nextTimer });
            return nextTimer++;
        },
        clearInterval: (id: number) => {
            const i = timers.findIndex(t => t.id === id);
            if (i >= 0) {
                timers.splice(i, 1);
            }
        },
    };
    context.window = context;
    const script = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'www', 'data.js'), 'utf8');
    vm.runInNewContext(script, context); // `this` is the global object of the context: the script puts DiagramData there
    const flush = async (): Promise<void> => {
        for (let i = 0; i < 10; i++) {
            await new Promise<void>(resolve => setImmediate(resolve));
        }
    };
    const handlers = {
        snapshots: 0,
        changes: [] as string[],
        connection: [] as (boolean | string)[],
        onSnapshot: () => void handlers.snapshots++,
        onState: (id: string, value: unknown, before: unknown) =>
            void handlers.changes.push(`${id}:${String(before)}>${String(value)}`),
        onConnection: (connected: boolean, message?: string) => void handlers.connection.push(message ?? connected),
    };
    return {
        handlers,
        sockets,
        start: async () => {
            (context.DiagramData as { connect(options: object, handlers: Handlers): unknown }).connect(
                { instance: 0 },
                handlers,
            );
            await flush();
            sockets[0]?.fire('connect');
            await flush();
        },
        advance: async (ms: number) => {
            const end = now + ms;
            for (;;) {
                const due = timers.filter(t => t.at <= end).sort((a, b) => a.at - b.at)[0];
                if (!due) {
                    break;
                }
                now = due.at;
                if (due.every) {
                    due.at += due.every;
                } else {
                    timers.splice(timers.indexOf(due), 1);
                }
                due.run();
                await flush();
            }
            now = end;
        },
    };
}

describe('diagram data layer', () => {
    const ok = (result: unknown): Reply => ({ result });

    it('corrects a missed update at the next re-sync, without loading the objects again', async () => {
        let states: Record<string, unknown> = { 'idm-modbus.0.a': { val: 1 } };
        const t = setup(command =>
            command === 'getStates' ? ok(states) : ok(command === 'getObjectView' ? { rows: [] } : {}),
        );
        await t.start();
        expect(t.handlers.connection).to.include(true);
        states = { 'idm-modbus.0.a': { val: 2 }, 'idm-modbus.0.b': { val: 3 } };
        await t.advance(60000);
        expect(t.handlers.changes).to.have.members(['a:1>2', 'b:undefined>3']);
        await t.advance(60000);
        expect(t.handlers.changes).to.have.length(2); // nothing differs: nothing reported
    });

    it('opens the connection again when it stops answering', async () => {
        let silent = false;
        const t = setup(command =>
            silent && command === 'getStates' ? 'silent' : ok(command === 'getObjectView' ? { rows: [] } : {}),
        );
        await t.start();
        silent = true;
        await t.advance(60000 + 15000); // first re-sync: no answer
        await t.advance(60000 + 15000); // second one: the socket is replaced
        expect(t.sockets).to.have.length(2);
        expect(t.sockets[0].closed).to.equal(true);
        expect(t.handlers.connection).to.include('No answer to getStates');
    });

    it('tries a load again that failed after a connect', async () => {
        let fail = true;
        const t = setup(command =>
            command === 'getStates' && fail ? { error: 'denied' } : ok(command === 'getObjectView' ? { rows: [] } : {}),
        );
        await t.start();
        expect(t.handlers.snapshots).to.equal(0);
        expect(t.handlers.connection).to.include('denied');
        fail = false;
        await t.advance(5000);
        expect(t.handlers.snapshots).to.equal(1);
        expect(t.handlers.connection[t.handlers.connection.length - 1]).to.equal(true);
    });

    it('subscribes before it loads, so that nothing that changes in between is lost', async () => {
        const t = setup(command => ok(command === 'getObjectView' ? { rows: [] } : {}));
        await t.start();
        expect(t.sockets[0].emitted.indexOf('subscribe')).to.be.lessThan(t.sockets[0].emitted.indexOf('getStates'));
    });
});
