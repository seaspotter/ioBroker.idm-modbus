import type { RoomSettings } from '../config';
import { ROOM_CONFLICT_AFTER, ROOM_TICK_MS, type FloatWordOrder } from '../constants';
import type { RegisterEntry } from '../registers/types';
import { type FeedHost, FeedRunner } from '../runner-kit';
import { decideRoomWrite, type LastRoomWrite } from './engine';

/** What the runner needs from the adapter; a fake in the tests. `publish` sets `rooms.writer_conflict` and `rooms.last_write`. */
export type RoomHost = FeedHost;

/** Settings of the runner. */
export interface RoomOptions {
    /** room settings */
    settings: { sources: RoomSettings['sources'] };
    /** registers of the family */
    registers: readonly RegisterEntry[];
    /** FLOAT word order */
    floatWordOrder: FloatWordOrder;
}

/**
 * Feeds the room temperature of heating circuits from foreign states (spec Modul C, target 1). A value is written when it
 * changed by the tolerance and otherwise at the heartbeat; after each write the register is read back to find a second writer.
 */
export class RoomRunner extends FeedRunner {
    private readonly last = new Map<string, LastRoomWrite>();
    private readonly mismatches = new Map<string, number>();
    private readonly warned = new Set<string>();

    /**
     * @param host adapter services
     * @param options settings and registers
     */
    public constructor(
        host: RoomHost,
        private readonly options: RoomOptions,
    ) {
        super(host, options.floatWordOrder, options.settings.sources, 'Room temperature');
    }

    /** Subscribe to the sources, read their current values and start the cycle. */
    public async start(): Promise<void> {
        for (const source of this.options.settings.sources) {
            await this.watch(source.stateId);
        }
        this.startCycle(ROOM_TICK_MS);
        this.host.log.info(`Feeding started for ${this.options.settings.sources.length} registers`);
    }

    /** One pass over all rows. Never throws. */
    public tick(): Promise<void> {
        return this.cycle(async () => {
            for (const source of this.options.settings.sources) {
                const reg = this.options.registers.find(r => r.id === source.registerId);
                if (!reg) {
                    continue;
                }
                const now = this.host.now();
                const decision = decideRoomWrite(
                    source,
                    this.inputs.get(source.stateId),
                    now,
                    this.last.get(source.registerId),
                );
                if ('skip' in decision) {
                    this.noteSkip(source.registerId, decision.skip);
                    continue;
                }
                this.warned.delete(`${source.registerId}:stale`);
                const value = await this.write(reg, decision.write);
                if (value === 'failed') {
                    return;
                }
                if (value !== 'refused') {
                    this.last.set(source.registerId, { value, at: now });
                    this.host.publish('last_write', now);
                    await this.readBack(source.registerId, reg, value);
                }
            }
        });
    }

    private noteSkip(registerId: string, reason: 'invalid' | 'stale' | 'range' | 'unchanged'): void {
        if (reason === 'unchanged') {
            return;
        }
        const key = `${registerId}:${reason}`;
        if (!this.warned.has(key)) {
            this.warned.add(key);
            const text = {
                invalid: 'is missing or not a number',
                stale: 'is too old',
                range: 'is outside the allowed range',
            }[reason];
            this.host.log.warn(`The source of ${registerId} ${text}, nothing is written`);
        }
    }

    private async readBack(registerId: string, reg: RegisterEntry, expected: number): Promise<void> {
        const differs = await this.differs(reg, expected, 0.15);
        if (differs === undefined) {
            return;
        }
        this.mismatches.set(registerId, differs ? (this.mismatches.get(registerId) ?? 0) + 1 : 0);
        this.setConflict(
            [...this.mismatches.values()].some(n => n >= ROOM_CONFLICT_AFTER),
            `${registerId} keeps changing after it was written: another program seems to write it too`,
        );
    }
}
