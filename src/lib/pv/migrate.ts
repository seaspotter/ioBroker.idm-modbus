import { pvRowsToFields } from '../config';

/** The two object calls the move needs (the adapter's own methods fit). */
export interface PvMoveHost {
    /** read an object */
    getForeignObjectAsync(id: string): Promise<ioBroker.Object | null | undefined>;
    /** replace an object */
    setForeignObjectAsync(id: string, obj: ioBroker.Object): Promise<unknown>;
}

/**
 * Moves the PV rows of a configuration before 0.1.16 (a table) into the fixed fields of the settings page and empties the table.
 * The instance object is written back whole: `extendObject` merges arrays by index, so an empty array would not clear the table
 * and the move would repeat on every start (an endless restart loop).
 *
 * @param host object access
 * @param instanceId id of the instance object (`system.adapter.<ns>`)
 * @param rows the old `pvSources`
 * @returns the number of registers moved, or `null` when the instance object is missing
 */
export async function movePvRowsToFields(
    host: PvMoveHost,
    instanceId: string,
    rows: readonly unknown[],
): Promise<number | null> {
    const instance = await host.getForeignObjectAsync(instanceId);
    if (!instance) {
        return null;
    }
    const fields = pvRowsToFields(rows);
    instance.native = { ...instance.native, ...fields, pvSources: [] };
    await host.setForeignObjectAsync(instanceId, instance);
    return Object.keys(fields).filter(key => key.endsWith('StateId')).length;
}
