/* Plant description for the heat pump diagram: works out WHAT KIND of plant is connected (heat source, hot gas line, storage, cooling,
   heating circuits, additions) from the states that carry a real value. Pure function, no drawing; runs in the browser (global
   DiagramPlant) and in the unit tests (module.exports). The rules and their evidence are in docs/idm-models-and-schemes.md,
   chapter 6a ("Plant model for detection"). Sensors are strong evidence, actor states are weak (they read "not available" while idle). */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.DiagramPlant = factory();
    }
})(this, function () {
    'use strict';

    var CIRCUIT_LETTERS = 'ABCDEFG';

    /* The state ids of the measuring points and actors by IDM tag (`Bxx` sensors, `Mxx` actors). Modbus registers first, the Navigator
       web interface (`web.io.*`) where Modbus does not deliver the part. */
    var TAG_STATES = {
        B1: ['web.io.digital_in.b1'],
        B2: ['web.io.sensors.b2'],
        B5: ['web.io.digital_in.b5'],
        B31: ['hc.humidity_sensor'],
        B33: ['hp.hp_flow_temp', 'hp.heat_sink_flow_temp'],
        B34: ['hp.hp_return_temp', 'hp.heat_sink_return_temp'],
        B35: ['hp.hgl_flow_temp'],
        B36: ['hp.heat_source_outlet_temp'],
        B37: ['hp.air_intake_temp'],
        B38: ['dhw.storage_temp', 'hp.storage_temp'],
        B40: ['dhw.cold_storage_temp'],
        B41: ['dhw.dhw_temp_bottom'],
        B42: ['dhw.dhw_tapping_temp'],
        B43: ['hp.heat_source_inlet_temp'],
        B44: ['isc.isc_charging_temp_cooling'],
        B45: ['hp.charging_sensor_temp'],
        B46: ['hp.air_intake_temp_2'],
        B48: ['dhw.dhw_temp_top', 'dhw.dhw_temp'],
        B49: ['isc.isc_recooling_temp'],
        B72: ['hp.air_heat_exchanger_temp'],
        B73: ['solar.solar_collector_temp'],
        B74: ['solar.solar_charging_temp'],
        B75: ['solar.solar_return_temp'],
        B76: ['solar.solar_wq_pool_temp'],
        B77: ['web.io.sensors.b77'],
        B84: ['web.io.sensors.b84'],
        M13: ['web.io.analog_out.m13'],
        M15: ['hp.heat_source_pump_status'],
        M16: ['hp.brine_pump_status'],
        M17: ['isc.isc_recooling_pump_status'],
        M22: ['web.io.analog_out.m22', 'web.io.digital_out.m22'],
        M51: ['web.io.digital_out.m51'],
        M61: ['hp.valve_hc_heat_cool'],
        M62: ['hp.valve_storage_heat_cool'],
        M63: ['hp.valve_heat_dhw'],
        M64: ['dhw.circulation_pump', 'web.io.digital_out.m64'],
        M71: ['web.io.analog_out.m71'],
        M73: ['hp.charging_pump_status', 'web.io.analog_out.m73'],
        M74: ['hp.valve_heat_source_heat_cool'],
        M75: ['web.io.digital_out.m75'],
        M76: ['web.io.digital_out.m76'],
        M78: ['solar.valve_solar_heat_dhw'],
        M79: ['solar.valve_solar_storage_heat_source'],
        M84: ['isc.isc_cold_storage_pump_status'],
        M88: ['web.io.analog_out.m88', 'web.io.digital_out.m88'],
        M89: ['isc.valve_isc_heat_source_cold_storage'],
        M94: ['web.io.digital_out.m94'],
        M99: ['isc.valve_isc_storage_bypass'],
        M111: ['web.io.digital_out.m111'],
    };

    /* the electric heating rod stages of the Navigator (web outputs) */
    var ROD_STAGE_IDS = [
        'web.io.digital_out.elektroheizeinsatz_1kw',
        'web.io.digital_out.elektroheizeinsatz_2kw',
        'web.io.digital_out.elektroheizeinsatz_3kw',
    ];
    var COMPRESSOR_IDS = [1, 2, 3, 4].map(function (n) {
        return `hp.compressor_status_${n}`;
    });

    /**
     * The state ids behind a tag (also circuit tags: pump M31..M37, mixer M41..M47, flow B51..B57, room B61..B67).
     *
     * @param tag IDM tag such as B38 or M31
     */
    function statesOf(tag) {
        if (TAG_STATES[tag]) {
            return TAG_STATES[tag];
        }
        var number = Number(tag.slice(1));
        var kind = tag.charAt(0);
        var index;
        if (kind === 'M' && number >= 31 && number <= 37) {
            return [`web.io.digital_out.m${number}`];
        }
        if (kind === 'M' && number >= 41 && number <= 47) {
            return [`web.io.digital_out.m${number}`];
        }
        if (kind === 'B' && number >= 51 && number <= 57) {
            index = number - 51;
            return [`hc.${CIRCUIT_LETTERS[index]}.flow_temp`];
        }
        if (kind === 'B' && number >= 61 && number <= 67) {
            index = number - 61;
            return [`hc.${CIRCUIT_LETTERS[index]}.room_temp`];
        }
        return [];
    }

    /**
     * Describe the plant.
     *
     * @param has `has(id)` is true when the state `id` carries a real value (not null / "not available")
     * @returns the description: `source`, `hotGasLine`, `compressors`, `cooling`, `storage`, `circuits`, `additions` and the list of
     *   `confirm` questions the tags cannot answer (ask the user, keep an override for each)
     */
    function describePlant(has) {
        var tag = function (t) {
            return statesOf(t).some(has);
        };
        var any = function (tags) {
            return tags.some(tag);
        };

        // heat source: an air intake or heat exchanger sensor means air, source sensors or pumps brine / water
        var air = any(['B37', 'B46', 'B72']);
        var ground = any(['B36', 'B43', 'M15', 'M16']);
        var source = air ? 'air' : ground ? 'ground' : 'unknown';

        var compressors = COMPRESSOR_IDS.filter(has).length;

        var cooling = {
            reversal: tag('M51'),
            buffer: any(['B40', 'B31', 'M74']),
            isc: any(['B44', 'B49', 'M17', 'M84', 'M89', 'M99']),
            humiditySensor: tag('B31'),
            dewPointMonitor: tag('B5'),
        };
        cooling.any = cooling.reversal || cooling.buffer || cooling.isc;

        // storage: B38 = a heating buffer volume exists (in a Hygienik with STP, or in a TERMO); B41 / B48 = a hot water volume;
        // M22 / B42 / B1 = a hot water station
        var storage = {
            heatingBuffer: tag('B38'),
            hotWater: any(['B41', 'B48']),
            station: any(['M22', 'B42', 'B1']),
            coolingBuffer: tag('B40'),
            chargingSensor: tag('B45'),
        };

        var circuits = [];
        CIRCUIT_LETTERS.split('').forEach(function (letter, i) {
            var flow = tag(`B${51 + i}`);
            var active = has(`hc.${letter}.active_mode`);
            var pump = tag(`M${31 + i}`);
            var mixer = tag(`M${41 + i}`);
            var room = tag(`B${61 + i}`);
            if (flow || active || pump || mixer || room) {
                circuits.push({
                    letter: letter,
                    flowSensor: flow,
                    pump: pump,
                    mixer: mixer,
                    roomDevice: room,
                    // a mixer circuit has a mixer, a direct circuit a pump without one; where the web tables do not tell, unknown
                    kind: mixer ? 'mixer' : pump ? 'direct' : 'unknown',
                });
            }
        });

        var rodStages = ROD_STAGE_IDS.filter(has).length;
        var additions = {
            solar: any(['B73', 'B74', 'B75', 'B76', 'M78', 'M79']) || has('solar.solar_mode'),
            solarPumps: any(['M75', 'M76']),
            boiler: tag('M111'),
            stove: any(['M88', 'B84']),
            rodStages: rodStages,
            circulation: tag('M64'),
            wasteHeatPump: tag('M94'),
            cascade: has('cascade.cascade_available_heating'),
        };

        // what tags cannot decide (docs/idm-models-and-schemes.md, chapter 6a)
        var confirm = ['product', 'build'];
        if (storage.heatingBuffer && storage.hotWater) {
            confirm.push('stpOrTermo');
        }
        if (!storage.heatingBuffer && (storage.hotWater || storage.station)) {
            confirm.push('directCircuitNoBuffer');
        }

        return {
            source: source,
            hotGasLine: any(['B35', 'M71']),
            compressors: compressors,
            cooling: cooling,
            storage: storage,
            circuits: circuits,
            additions: additions,
            confirm: confirm,
        };
    }

    return { describePlant: describePlant, statesOf: statesOf, TAG_STATES: TAG_STATES };
});
