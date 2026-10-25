// This file extends the AdapterConfig type from "@iobroker/types"
import type { FloatWordOrder, NavigatorFamily } from './constants';

// Augment the globally declared type ioBroker.AdapterConfig
declare global {
    namespace ioBroker {
        interface AdapterConfig {
            /** hostname or IP address of the Navigator (static IP recommended) */
            host: string;
            /** Modbus TCP port, 502 on the Navigator */
            port: number;
            /** Modbus unit id, 1 on the Navigator */
            unitId: number;
            /** register family the user selected - never auto-detected in v1 */
            family: NavigatorFamily;
            /** FLOAT word order, spec open point O1 */
            floatWordOrder: FloatWordOrder;
            /** Modbus request timeout in ms */
            requestTimeoutMs: number;
            /** pause between two requests in ms (min MIN_REQUEST_PAUSE_MS) */
            requestPauseMs: number;
            /** polling intervals in seconds (spec Modul A) */
            intervalFastS: number;
            intervalMediumS: number;
            intervalSlowS: number;
            /** interval of the settings group (modes, setpoints, curves) in seconds */
            intervalConfigS: number;
            /** heating circuits A-G present / their display names */
            hcA: boolean;
            hcB: boolean;
            hcC: boolean;
            hcD: boolean;
            hcE: boolean;
            hcF: boolean;
            hcG: boolean;
            hcNameA: string;
            hcNameB: string;
            hcNameC: string;
            hcNameD: string;
            hcNameE: string;
            hcNameF: string;
            hcNameG: string;
            /** number of zone modules (0-10) and rooms per module (1-8) */
            zoneModules: number;
            roomsPerZone: number;
            /** optional register blocks */
            blockSolar: boolean;
            blockIsc: boolean;
            blockCascade: boolean;
            blockBivalence: boolean;
            blockPv: boolean;
            /** Navigator 10: booster heat pumps A and B */
            blockBooster: boolean;
            /** statistics module (spec Modul G) */
            statsEnabled: boolean;
            /** external electrical meter: cumulative counter state and its unit (auto, kWh, Wh) */
            extElecCounterId: string;
            extElecCounterUnit: string;
            /** external electrical meter: power state and its unit (auto, kW, W) */
            extElecPowerId: string;
            extElecPowerUnit: string;
            /** external heat meter: cumulative counter state and unit */
            extHeatCounterId: string;
            extHeatCounterUnit: string;
            /** external heat meter: power state and unit */
            extHeatPowerId: string;
            extHeatPowerUnit: string;
            /** which heat meter counts: navigator or external */
            thermalSource: string;
            /** electricity price per kWh (fixed) or a state delivering it, and the currency shown on the cost states */
            pricePerKwh: number | string;
            /** how the price (fixed and state) is given: 'currency' per kWh (default) or 'cent' */
            priceUnit: string;
            priceStateId: string;
            currency: string;
            /** CO2 factor in g/kWh */
            co2GramsPerKwh: number | string;
            /** how the CO2 factor (fixed and state) is given: 'g' per kWh (default) or 'kg' */
            co2Unit: string;
            /** state with the current CO₂ intensity of the electricity in g/kWh (optional) */
            co2StateId: string;
            /** age in seconds after which an external value counts as stale */
            externalMaxAgeS: number;
            /** control: write enable per group (all off by default) */
            writeSystem: boolean;
            writeDhw: boolean;
            writeHcA: boolean;
            writeHcB: boolean;
            writeHcC: boolean;
            writeHcD: boolean;
            writeHcE: boolean;
            writeHcF: boolean;
            writeHcG: boolean;
            /** room setpoints and operating modes of the zone modules (Navigator Pro) */
            writeZones: boolean;
            /** expert mode: bivalence and cascade settings */
            writeExpert: boolean;
            writeSolar: boolean;
            /** minimum seconds between two writes of one EEPROM register */
            eepromMinIntervalS: number;
            /** warning threshold for writes of one register per day */
            dailyWriteWarn: number;
            /** PV module (spec Modul D): feeds PV values from foreign states to the Navigator */
            pvEnabled: boolean;
            pvIntervalS: number;
            pvMaxAgeS: number;
            /** `direct`: the surplus state is written as it is; `calculated`: production minus house consumption */
            pvSurplusMode: string;
            /** source state of the PV surplus (74); empty = not sent */
            pvSurplusStateId: string;
            pvSurplusFactor: number | string;
            pvSurplusInvert: boolean;
            pvSurplusMin: number | string | null;
            pvSurplusMax: number | string | null;
            /** source state of the PV production (78); empty = not sent */
            pvProductionStateId: string;
            pvProductionFactor: number | string;
            pvProductionInvert: boolean;
            pvProductionMin: number | string | null;
            pvProductionMax: number | string | null;
            /** source state of the PV house consumption (82); empty = not sent */
            pvHouseStateId: string;
            pvHouseFactor: number | string;
            pvHouseInvert: boolean;
            pvHouseMin: number | string | null;
            pvHouseMax: number | string | null;
            /** source state of the PV battery discharge (84); empty = not sent */
            pvBatteryStateId: string;
            pvBatteryFactor: number | string;
            pvBatteryInvert: boolean;
            pvBatteryMin: number | string | null;
            pvBatteryMax: number | string | null;
            /** source state of the PV battery level % (86); empty = not sent */
            pvSocStateId: string;
            pvSocFactor: number | string;
            /** the table of rows of versions before 0.1.16; moved to the fields above at the first start */
            pvSources: {
                register: string;
                stateId: string;
                /** text fields (a decimal point or comma works); older configurations hold numbers */
                factor: number | string;
                invert: boolean;
                min: number | string | null;
                max: number | string | null;
            }[];
            /** room temperature feeding (spec Modul C) */
            roomsEnabled: boolean;
            roomSources: {
                circuit: string;
                stateId: string;
                factor: number | string;
                offset: number | string;
                heartbeatS: number;
                toleranceC: number | string;
                min: number | string;
                max: number | string;
                maxAgeS: number;
                onStale: string;
                fixedValue: number | string | null;
            }[];
            /** other building automation values (spec Modul E) */
            gltEnabled: boolean;
            gltSources: {
                function: string;
                stateId: string;
                factor: number | string;
                offset: number | string;
                heartbeatS: number | null;
                min: number | string | null;
                max: number | string | null;
                maxAgeS: number | null;
            }[];
            /** hot water boost through the hot water demand (spec Modul E) */
            boostEnabled: boolean;
            boostTargetC: number;
            boostMaxMinutes: number;
            /** web interface module (spec Modul H): room names and room data via the display PIN */
            webEnabled: boolean;
            webPin: string;
            webPort: number;
            webIntervalS: number;
            /** interval of the web statistics in seconds, 0 = not read */
            webStatisticsIntervalS: number;
            /** heat pump diagram (spec Modul I): 'auto', 'air' or 'ground' */
            diagramHeatSource: string;
            /** where power and COP come from: 'internal' (Navigator) or 'external' (external meters) */
            diagramSource: string;
            /** the COP rows: 'source' (one, from the source), 'both' or 'none' (the old values 'internal'/'external' still work) */
            diagramCop: string;
            /** how buffer and hot water are drawn: 'combined' (one vessel, Hygienik with stratification plate) or 'separate' (two vessels) */
            diagramStorage: string;
            /** size of the diagram in percent of the original size (default 90) */
            diagramScale: number;
            /** parts to leave out of the diagram (buffer, dhw, freshwater, pv, solar, bivalence) */
            diagramHidden: string[];
            /** the heating circuit next to the rooms of a zone module */
            diagramZoneCircuit: { zone: number; circuit: string }[];
            /** create states when the Navigator reports the first real value and remove those of hardware that never does */
            hideUnavailable: boolean;
            /** delete states of registers the configuration no longer enables */
            removeInactiveStates: boolean;
        }
    }
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};
