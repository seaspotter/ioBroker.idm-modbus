import type { PlannedObject } from '../object-tree';

/** What a managed set of objects needs from the adapter. */
export interface ObjectHost {
    /** create or update channels and states */
    createObjects(objects: PlannedObject[]): Promise<void>;
    /** ids (relative to the instance) of the existing objects below `prefix` */
    existingIds(prefix: string): Promise<string[]>;
}

/**
 * The objects below one prefix: planned ones that do not exist yet are created, and on the first call of a start the ones that
 * already exist are brought up to date as well (a renamed part or a new translation reaches installations that created the object
 * earlier; the objects are merged, so what the user added, for example history settings, stays). Nothing is ever deleted here (a
 * state that was there stays, whatever the plan says now; only a scan or the user removes states). The first call also takes in
 * what an earlier start left in the object tree.
 */
export class ManagedObjects {
    private readonly known = new Set<string>();
    private loaded = false;

    /**
     * @param host adapter services
     * @param prefix id of the channel the objects live in (without a trailing dot)
     */
    public constructor(
        private readonly host: ObjectHost,
        private readonly prefix: string,
    ) {}

    /**
     * Make the objects below the prefix match the plan.
     *
     * @param planned the objects that should exist
     */
    public async sync(planned: PlannedObject[]): Promise<void> {
        const firstCall = !this.loaded;
        if (firstCall) {
            this.loaded = true;
            (await this.host.existingIds(this.prefix)).forEach(id => this.known.add(id));
        }
        const todo = planned.filter(object => firstCall || !this.known.has(object.id));
        if (todo.length) {
            await this.host.createObjects(todo);
            todo.forEach(object => this.known.add(object.id));
        }
    }
}
