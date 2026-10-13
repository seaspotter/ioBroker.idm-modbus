import type { PlannedObject } from '../object-tree';

/** What a managed set of objects needs from the adapter. */
export interface ObjectHost {
    /** create or update channels and states */
    createObjects(objects: PlannedObject[]): Promise<void>;
    /** ids (relative to the instance) of the existing objects below `prefix` */
    existingIds(prefix: string): Promise<string[]>;
}

/**
 * The objects below one prefix: planned ones that do not exist yet are created. Nothing is ever deleted here (a state that was
 * there stays, whatever the plan says now; only a scan or the user removes states). The first call also takes in what an
 * earlier start left in the object tree.
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
        if (!this.loaded) {
            this.loaded = true;
            (await this.host.existingIds(this.prefix)).forEach(id => this.known.add(id));
        }
        const fresh = planned.filter(object => !this.known.has(object.id));
        if (fresh.length) {
            await this.host.createObjects(fresh);
            fresh.forEach(object => this.known.add(object.id));
        }
    }
}
