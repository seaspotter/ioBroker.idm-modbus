import type { PlannedObject } from '../object-tree';

/** What a managed set of objects needs from the adapter. */
export interface ObjectHost {
    /** create or update channels and states */
    createObjects(objects: PlannedObject[]): Promise<void>;
    /** ids (relative to the instance) of the existing objects below `prefix` */
    existingIds(prefix: string): Promise<string[]>;
}

/**
 * The objects below one prefix: planned ones that do not exist yet are created. The first call of a start also brings the existing
 * ones up to date (a renamed part or a new translation reaches old installations; objects are merged, so user additions such as
 * history settings stay) and takes in what an earlier start left. Nothing is ever deleted here; only a scan or the user removes
 * states.
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
     * Whether the object exists (created now or by an earlier start).
     *
     * @param id id of the object, relative to the instance
     */
    public has(id: string): boolean {
        return this.known.has(id);
    }

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
