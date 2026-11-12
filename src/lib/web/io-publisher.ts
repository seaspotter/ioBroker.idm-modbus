import { ManagedObjects, type ObjectHost } from './managed';
import { buildIoStates, type IoGroup, type IoItem } from './io';

/** What the publisher needs from the adapter. */
export interface IoHost extends ObjectHost {
    /** set a state (acknowledged) */
    publish(id: string, value: string | number | boolean | null): void;
    /** does Modbus deliver a value for the part with this IDM tag (B33, M73, ...)? The web copy is not needed then. */
    hasModbusValue(tag: string): boolean;
}

/**
 * Turns the input/output tables of the Navigator (read through the PHP pages or the Navigator 10 WebSocket) into states below
 * `web.io`: Modbus wins over the web copy, only changed values are written, and objects that exist stay.
 */
export class IoPublisher {
    private readonly objects: ManagedObjects;
    private readonly values = new Map<string, number | string | boolean>();

    /**
     * @param host adapter services
     */
    public constructor(private readonly host: IoHost) {
        this.objects = new ManagedObjects(host, 'web.io');
    }

    /**
     * Bring the objects and states in line with the tables just read.
     *
     * @param io the rows of the tables that could be read
     */
    public async update(io: Partial<Record<IoGroup, IoItem[]>>): Promise<void> {
        const states = buildIoStates(io, tag => this.host.hasModbusValue(tag));
        await this.objects.sync(states.objects);
        // a state that exists stays current when Modbus delivers the part later (M73 reads -1 while the pump stands, so its web copy was created then)
        const current = new Map(states.values);
        states.copies.forEach((value, id) => this.objects.has(id) && current.set(id, value));
        for (const id of this.values.keys()) {
            if (!current.has(id)) {
                this.values.delete(id); // no longer created: publish it again if it comes back
            }
        }
        current.forEach((value, id) => {
            if (this.values.get(id) !== value) {
                this.values.set(id, value);
                this.host.publish(id, value);
            }
        });
    }
}
