import {
    type Bucket,
    type DayBucket,
    type ElectricalSource,
    type Mode,
    type ThermalMode,
    emptyBucket,
    emptyModeEnergy,
} from './types';

/** Periods the statistics report. */
export type Period = 'day' | 'month' | 'year' | 'total' | 'rolling365';

/** Days of history kept (a rolling year plus slack). */
export const RETENTION_DAYS = 400;

/** Serialised ledger. */
export interface LedgerData {
    /** one bucket per day, oldest first */
    days: DayBucket[];
    /** sums since the statistics started */
    totals: Bucket;
}

/**
 * Days between two `YYYY-MM-DD` keys (calendar arithmetic, independent of time zones and daylight saving).
 *
 * @param from earlier date key
 * @param to later date key
 */
function daysBetween(from: string, to: string): number {
    const a = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)));
    const b = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)));
    return Math.round((b - a) / 86400000);
}

/**
 * Adds two buckets.
 *
 * @param target bucket that receives the sum
 * @param source bucket that is added
 */
function accumulate(target: Bucket, source: Bucket): void {
    for (const mode of Object.keys(target.elecInternal) as Mode[]) {
        target.elecInternal[mode] += source.elecInternal[mode];
        target.elecExternal[mode] += source.elecExternal[mode];
    }
    for (const mode of Object.keys(target.thermal) as ThermalMode[]) {
        target.thermal[mode] += source.thermal[mode];
    }
    target.thermalExternal += source.thermalExternal;
    target.thermalIntegrated += source.thermalIntegrated ?? 0;
    target.cost += source.cost;
    target.co2 += source.co2 ?? 0; // data saved before CO₂ was accrued has none
}

/** Energy sums per day and in total; the periods of the statistics are summed from the day buckets. */
export class Ledger {
    private days: DayBucket[] = [];
    private totals: Bucket = emptyBucket();

    private bucketFor(date: string): DayBucket {
        const last = this.days[this.days.length - 1];
        if (last?.date === date) {
            return last;
        }
        let bucket = this.days.find(day => day.date === date);
        if (!bucket) {
            bucket = { date, ...emptyBucket() };
            this.days.push(bucket);
            this.days.sort((a, b) => a.date.localeCompare(b.date));
            while (this.days.length > RETENTION_DAYS) {
                this.days.shift();
            }
        }
        return bucket;
    }

    /**
     * Apply a change to the bucket of the day and to the totals.
     *
     * @param date local date key
     * @param change the change
     */
    private add(date: string, change: (bucket: Bucket) => void): void {
        change(this.bucketFor(date));
        change(this.totals);
    }

    /**
     * Add thermal energy from the Navigator's counters.
     *
     * @param date local date key
     * @param mode counter mode
     * @param kwh energy in kWh
     */
    public addThermal(date: string, mode: ThermalMode, kwh: number): void {
        this.add(date, bucket => (bucket.thermal[mode] += kwh));
    }

    /**
     * Add thermal energy from an external heat meter.
     *
     * @param date local date key
     * @param kwh energy in kWh
     */
    public addThermalExternal(date: string, kwh: number): void {
        this.add(date, bucket => (bucket.thermalExternal += kwh));
    }

    /**
     * Add thermal energy integrated from the Navigator's thermal power register.
     *
     * @param date local date key
     * @param kwh energy in kWh
     */
    public addThermalIntegrated(date: string, kwh: number): void {
        this.add(date, bucket => (bucket.thermalIntegrated += kwh));
    }

    /**
     * Add electrical energy.
     *
     * @param date local date key
     * @param source internal power register or external meter
     * @param mode operating mode that was active
     * @param kwh energy in kWh
     */
    public addElectrical(date: string, source: ElectricalSource, mode: Mode, kwh: number): void {
        const key = source === 'internal' ? 'elecInternal' : 'elecExternal';
        this.add(date, bucket => (bucket[key][mode] += kwh));
    }

    /**
     * Add cost.
     *
     * @param date local date key
     * @param amount cost in the configured currency
     */
    public addCost(date: string, amount: number): void {
        this.add(date, bucket => (bucket.cost += amount));
    }

    /**
     * Add CO₂.
     *
     * @param date local date key
     * @param kg emissions in kg
     */
    public addCo2(date: string, kg: number): void {
        this.add(date, bucket => (bucket.co2 += kg));
    }

    /**
     * Sum of a period relative to today.
     *
     * @param period which period
     * @param today local date key of today
     */
    public sum(period: Period, today: string): Bucket {
        if (period === 'total') {
            return structuredClone(this.totals);
        }
        const result = emptyBucket();
        for (const day of this.days) {
            const inPeriod =
                period === 'day'
                    ? day.date === today
                    : period === 'month'
                      ? day.date.slice(0, 7) === today.slice(0, 7)
                      : period === 'year'
                        ? day.date.slice(0, 4) === today.slice(0, 4)
                        : daysBetween(day.date, today) >= 0 && daysBetween(day.date, today) < 365;
            if (inPeriod) {
                accumulate(result, day);
            }
        }
        return result;
    }

    /** The state to persist. */
    public serialize(): LedgerData {
        return {
            days: structuredClone(this.days),
            totals: structuredClone(this.totals),
        };
    }

    /**
     * Restore persisted data; malformed parts are ignored (the statistics then start from zero).
     *
     * @param data what {@link serialize} returned earlier
     */
    public restore(data: Partial<LedgerData> | null | undefined): void {
        const valid = (bucket: unknown): bucket is Bucket => {
            const b = bucket as Bucket | undefined;
            return (
                !!b &&
                typeof b.cost === 'number' &&
                typeof b.thermalExternal === 'number' &&
                !!b.elecInternal &&
                !!b.elecExternal &&
                !!b.thermal
            );
        };
        const fill = (bucket: Bucket): Bucket => {
            const result = emptyBucket();
            accumulate(result, {
                ...emptyBucket(),
                ...bucket,
                elecInternal: { ...emptyModeEnergy(), ...bucket.elecInternal },
                elecExternal: { ...emptyModeEnergy(), ...bucket.elecExternal },
                thermal: { ...emptyBucket().thermal, ...bucket.thermal },
            });
            return result;
        };
        this.days = (Array.isArray(data?.days) ? data.days : [])
            .filter((day): day is DayBucket => typeof day?.date === 'string' && valid(day))
            .map(day => ({ date: day.date, ...fill(day) }))
            .sort((a, b) => a.date.localeCompare(b.date))
            .slice(-RETENTION_DAYS);
        this.totals = valid(data?.totals) ? fill(data.totals) : emptyBucket();
    }
}
