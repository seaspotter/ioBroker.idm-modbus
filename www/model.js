/* Model of the heat pump diagram: works out which parts of the plant exist from the objects and states of the adapter instance.
   Runs in the browser (global DiagramModel) and in the unit tests (module.exports). */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.DiagramModel = factory();
    }
})(this, function () {
    'use strict';

    var CIRCUIT_LETTERS = 'ABCDEFG';
    var PARTS = ['buffer', 'dhw', 'freshwater', 'pv', 'solar', 'bivalence'];

    /* The state ids the diagram draws, by logical name, each with the candidates in order of preference. Register ids are the ones
       `stateIdFor` makes of them (a unit test checks that they exist); `web.io.*` ids are the keys of the web interface tables. */
    var STATE_IDS = {
        outdoor: ['system.outdoor_temp'],
        // with a separating heat exchanger the Navigator 10 does not answer 1050/1052 and reports 1068/1070 instead
        hpFlow: ['hp.hp_flow_temp', 'hp.heat_sink_flow_temp'],
        hpReturn: ['hp.hp_return_temp', 'hp.heat_sink_return_temp'],
        hgl: ['hp.hgl_flow_temp'],
        // the mixer M71 sends heat through the hot gas line while it is open (above 0 V)
        hglMixer: ['web.io.analog_out.m71'],
        hpMode: ['hp.hp_operating_mode'],
        compressor: ['hp.compressor_status_1'],
        power: ['energy.power_consumption_hp'],
        // the external meters' power (the adapter publishes it when a meter delivers power)
        powerExternal: ['calc.power_electrical_external'],
        thermalPowerExternal: ['calc.power_thermal_external'],
        // the heat output (Navigator 1.7 has the instantaneous total instead of the flow sensor value)
        thermalPower: ['energy.thermal_power_flow_sensor', 'energy.thermal_power_total'],
        copInternal: ['calc.cop_internal'],
        copExternal: ['calc.cop_external'],
        buffer: ['dhw.storage_temp', 'hp.storage_temp'],
        dhwTop: ['dhw.dhw_temp_top', 'dhw.dhw_temp'],
        dhwBottom: ['dhw.dhw_temp_bottom'],
        dhwSetpoint: ['dhw.dhw_setpoint'],
        dhwTap: ['dhw.dhw_tapping_temp'],
        pvProduction: ['pv.pv_production'],
        pvHouse: ['pv.house_consumption'],
        pvSurplus: ['pv.pv_surplus'],
        pvBattery: ['pv.battery_soc'],
        pvBatteryPower: ['pv.battery_discharge'],
        solarCollector: ['solar.solar_collector_temp'],
        bivalence: ['bivalence.bivalence_state'],
        pumpBrine: ['hp.brine_pump_status'],
        pumpSource: ['hp.heat_source_pump_status'],
        dhwFlow: ['web.io.digital_in.b1'],
        pumpM22: ['web.io.analog_out.m22'],
        pumpM73: ['hp.charging_pump_status', 'web.io.analog_out.m73'],
        pumpM31: ['web.io.digital_out.m31'],
        // the mixer of heating circuit A; the Navigator reports a text for it
        mixerM41: ['web.io.digital_out.m41'],
        fanM13: ['web.io.analog_out.m13'],
        // the hot water circulation pump
        circulation: ['dhw.circulation_pump', 'web.io.digital_out.m64'],
        // the cold storage (cooling buffer)
        coldBuffer: ['dhw.cold_storage_temp'],
        // the solar pumps (web outputs), the priority valve M111 of an oil / gas boiler, the tiled stove pump M88 and its sensor B84
        // (the manuals name them; the state keys follow the web module's rule and are not confirmed on a device)
        // (tools/diagram-tags.ts lists the same ids by tag; a unit test keeps the two equal)
        solarPump1: ['web.io.digital_out.m75'],
        solarPump2: ['web.io.digital_out.m76'],
        boilerValve: ['web.io.digital_out.m111'],
        stovePump: ['web.io.analog_out.m88', 'web.io.digital_out.m88'],
        stoveTemp: ['web.io.sensors.b84'],
    };

    /* the stages of the electric heating rod (web outputs), each with the kW it stands for */
    var ROD_STAGES = [
        { id: 'web.io.digital_out.elektroheizeinsatz_1kw', label: '1 kW' },
        { id: 'web.io.digital_out.elektroheizeinsatz_2kw', label: '2 kW' },
        { id: 'web.io.digital_out.elektroheizeinsatz_3kw', label: '3 kW' },
    ];

    /* an air intake sensor means an air heat pump, source sensors and pumps a ground or groundwater one */
    var AIR_INTAKE_ID = 'hp.air_intake_temp';
    var GROUND_SOURCE_IDS = ['hp.heat_source_inlet_temp', 'hp.heat_source_outlet_temp'];

    /* group of the sensors by their IDM tag (B35 hot gas line, B43 heat source inlet, ...) */
    var SENSOR_GROUPS = {
        B2: 'heatpump',
        B35: 'heatpump',
        B45: 'heatpump',
        B36: 'source',
        B37: 'source',
        B43: 'source',
        B46: 'source',
        B72: 'source',
        B40: 'storage',
        B42: 'storage',
        B73: 'solar',
        B74: 'solar',
        B75: 'solar',
        B76: 'solar',
        B44: 'isc',
        B49: 'isc',
    };

    /* sensors of the web interface that the diagram shows (the heating flow rate); the others exist as states only */
    var WEB_SENSOR_TAGS = { B2: true };

    function hasValue(states, id) {
        return states[id] !== undefined && states[id] !== null;
    }
    /* the stages of a cascade by mode: how many are available and how many run; null on a single unit (the registers answer "not
       available" there) */
    function cascadeOf(states) {
        var rows = ['heating', 'cooling', 'dhw']
            .map(function (mode) {
                return {
                    mode: mode,
                    available: `cascade.cascade_available_${mode}`,
                    running: `cascade.cascade_running_${mode}`,
                };
            })
            .filter(function (row) {
                return Number(states[row.available]) > 0;
            });
        return rows.length ? { rows: rows } : null;
    }
    /* The further heat generators the plant reports, each with the states that say it runs (`run`; the pipes of a generator flow while
       one of them does): the other heat pumps of a cascade (master and members; only the stage counts are exposed, no sensors of the
       members), an oil / gas boiler (priority valve M111) and a tiled stove (pump M88, sensor B84). */
    function generatorsOf(states, ids) {
        var generators = [];
        var cascade = cascadeOf(states);
        if (cascade) {
            generators.push({
                kind: 'cascade',
                rows: cascade.rows,
                run: cascade.rows.map(function (row) {
                    return row.running;
                }),
            });
        }
        if (ids.boilerValve) {
            generators.push({ kind: 'boiler', valve: ids.boilerValve, run: [ids.boilerValve] });
        }
        if (ids.stovePump || ids.stoveTemp) {
            generators.push({
                kind: 'stove',
                temp: ids.stoveTemp,
                pump: ids.stovePump,
                run: ids.stovePump ? [ids.stovePump] : [],
            });
        }
        return generators;
    }
    /* a name that is a string or an object with the texts by language */
    function textOf(name, language) {
        if (typeof name === 'string') {
            return name;
        }
        return (name && (name[language] || name.en)) || '';
    }

    /**
     * The IDM tags of the flow and room sensor of a heating circuit: B51 to B57 and B61 to B67 for the circuits A to G (circuit A is
     * B51/B61 in the IDM plant diagram; Xerolux verified the sequence live at a Navigator 10 with circuits A and D).
     *
     * @param letter circuit letter A-G
     */
    function circuitTags(letter) {
        var index = CIRCUIT_LETTERS.indexOf(letter);
        return index < 0 ? null : { flow: `B${51 + index}`, room: `B${61 + index}` };
    }

    /* the IDM tag of a state and its name without the tag: web states carry it at the start of the name, Modbus registers at the end
       (`tail`: only at the very end) */
    function splitTag(isWeb, english, local, tail) {
        var pattern = isWeb ? /^([BME]\d+v?)\s+/ : tail ? /\s*\(([BME]\d+v?)\)\s*$/ : /\s*\(([BME]\d+v?)\)/;
        var match = pattern.exec(english);
        return { tag: match ? match[1] : undefined, name: local.replace(pattern, '') };
    }

    /* The sensors with an IDM tag: Modbus registers carry it at the end of their label ("Heat storage temperature (B38)"), the
       states of the web interface at the start of their name ("B2 Heating flow sensor"). */
    function findSensors(objects, states, language) {
        var sensors = [];
        Object.keys(objects).forEach(function (id) {
            var common = objects[id].common || {};
            if (
                objects[id].type !== 'state' ||
                (common.unit !== '°C' && common.unit !== 'l/min') ||
                !hasValue(states, id)
            ) {
                return;
            }
            var english = textOf(common.name, 'en');
            var name = textOf(common.name, language);
            var isWeb = id.indexOf('web.io.sensors.') === 0;
            var split = splitTag(isWeb, english, name, false);
            if (split.tag && (!isWeb || WEB_SENSOR_TAGS[split.tag])) {
                sensors.push({ id: id, tag: split.tag, name: split.name, unit: common.unit });
            }
        });
        return sensors;
    }

    /* The name of every measuring point and actor by its IDM tag, in the language of the page: Modbus registers carry the tag at the
       end of their label ("Heat storage temperature (B38)"), the states of the web interface at the start ("M73 Charging pump").
       Modbus names come first (they are translated with the register files), web names fill the rest. */
    function findTagNames(objects, language) {
        var names = {};
        var ids = Object.keys(objects).sort(function (a, b) {
            return (a.indexOf('web.io.') === 0) - (b.indexOf('web.io.') === 0);
        });
        ids.forEach(function (id) {
            var common = objects[id].common || {};
            if (objects[id].type !== 'state' || !common.name) {
                return;
            }
            var english = textOf(common.name, 'en');
            var split = splitTag(id.indexOf('web.io.') === 0, english, textOf(common.name, language), true);
            if (split.tag && split.name && !names[split.tag]) {
                names[split.tag] = split.name;
            }
        });
        return names;
    }

    /* The tags of the heating circuits get a name of our own where the Navigator delivers none (a circuit that has no web table
       entry, or none in this language): pump M31..M37, mixer M41..M47, flow sensor B51..B57, room device B61..B67. */
    function withCircuitNames(names, labels) {
        CIRCUIT_LETTERS.split('').forEach(function (letter, i) {
            var named = function (tag, template) {
                if (!names[tag] && template) {
                    names[tag] = template.replace('{i}', letter);
                }
            };
            named(`M${31 + i}`, labels.circuitPump);
            named(`M${41 + i}`, labels.circuitMixer);
            named(`B${51 + i}`, labels.circuitFlow);
            named(`B${61 + i}`, labels.circuitRoom);
        });
        return names;
    }

    function fillLabels(labels, language) {
        var result = {};
        Object.keys(labels || {}).forEach(function (key) {
            result[key] = labels[key][language] || labels[key].en;
        });
        return result;
    }

    /**
     * Work out which parts of the diagram exist, from the states that have real values (so hardware the plant does not have never
     * shows up) and from the settings.
     *
     * @param input `language`, `states` (id relative to the instance -> value), `objects` (id -> object), `labels` (the content
     *   of labels.json) and `settings` (`heatSource`, `hidden`, `zoneCircuit`)
     */
    function buildModel(input) {
        var language = input.language || 'en';
        var states = input.states;
        var objects = input.objects;
        var settings = input.settings || {};
        var hidden = settings.hidden || [];
        var labels = fillLabels(input.labels, language);
        var pick = function (candidates) {
            return (
                candidates.find(function (id) {
                    return hasValue(states, id);
                }) || null
            );
        };
        var ids = { connection: 'info.connection' };
        Object.keys(STATE_IDS).forEach(function (name) {
            ids[name] = pick(STATE_IDS[name]);
        });

        // power and COP come from the Navigator or from the external meters; where an external value is missing, the Navigator's
        // is shown
        var external = settings.source === 'external';
        if (external) {
            ids.power = ids.powerExternal || ids.power;
            ids.thermalPower = ids.thermalPowerExternal || ids.thermalPower;
        }
        var copRows = settings.cop || 'source';
        ids.cop = copRows === 'none' ? null : external ? ids.copExternal || ids.copInternal : ids.copInternal;
        ids.cop2 = copRows === 'both' ? ids.copExternal : null;
        if (copRows === 'both') {
            ids.cop = ids.copInternal;
        }

        var circuits = [];
        for (var i = 0; i < CIRCUIT_LETTERS.length; i++) {
            var letter = CIRCUIT_LETTERS[i];
            var flow = pick([`hc.${letter}.flow_temp`]);
            // the circuit pump M31..M37 and the mixer M41..M47 (web tables); a direct circuit has a pump and no mixer and no flow sensor
            var pump = pick([`web.io.digital_out.m${31 + i}`]);
            var mixer = pick([`web.io.digital_out.m${41 + i}`]);
            var active = pick([`hc.${letter}.active_mode`]);
            if (flow || pump || mixer || active) {
                var channel = objects[`hc.${letter}`];
                var tags = circuitTags(letter);
                circuits.push({
                    letter: letter,
                    name: (channel && textOf(channel.common.name, language)) || labels.circuit.replace('{i}', letter),
                    flow: flow,
                    setpoint: pick([`hc.${letter}.setpoint_flow_temp`]),
                    active: active,
                    room: pick([`hc.${letter}.room_temp`]),
                    pump: pump,
                    mixer: mixer,
                    pumpTag: `M${31 + i}`,
                    mixerTag: `M${41 + i}`,
                    flowTag: tags.flow,
                    roomTag: tags.room,
                });
            }
        }

        /* the rooms of zone module N stand next to heating circuit N unless the settings say otherwise (the last circuit takes the
           rest) */
        var circuitOfZone = function (zone) {
            var chosen = (settings.zoneCircuit || []).find(function (entry) {
                return entry.zone === zone;
            });
            var known = chosen
                ? circuits.find(function (c) {
                      return c.letter === chosen.circuit;
                  })
                : null;
            var byNumber = circuits[Math.min(Math.max(zone, 1), circuits.length) - 1];
            return (known || byNumber || {}).letter || null;
        };
        var rooms = [];
        Object.keys(states).forEach(function (id) {
            var match = /^zones\.(\d+)\.rooms\.(\d+)\.temp$/.exec(id);
            if (match && hasValue(states, id)) {
                var zone = Number(match[1]);
                var room = Number(match[2]);
                var base = `zones.${zone}.rooms.${room}`;
                var name = states[`${base}.name`];
                rooms.push({
                    zone: zone,
                    circuit: circuitOfZone(zone),
                    name: typeof name === 'string' && name ? name : `${zone}.${room}`,
                    temperature: id,
                    target: hasValue(states, `${base}.setpoint`) ? `${base}.setpoint` : null,
                });
            }
        });
        rooms.sort(function (a, b) {
            return a.name.localeCompare(b.name);
        });

        var drawn = {};
        Object.keys(ids).forEach(function (name) {
            drawn[ids[name]] = true;
        });
        var sensors = findSensors(objects, states, language)
            .filter(function (sensor) {
                return !drawn[sensor.id];
            })
            .map(function (sensor) {
                sensor.group = SENSOR_GROUPS[sensor.tag] || 'other';
                return sensor;
            })
            .sort(function (a, b) {
                return parseInt(a.tag.slice(1), 10) - parseInt(b.tag.slice(1), 10) || a.tag.localeCompare(b.tag);
            });

        var detectedGround =
            !hasValue(states, AIR_INTAKE_ID) &&
            (GROUND_SOURCE_IDS.some(function (id) {
                return hasValue(states, id);
            }) ||
                ids.pumpBrine !== null ||
                ids.pumpSource !== null);
        var heatSource = settings.heatSource === 'air' || settings.heatSource === 'ground' ? settings.heatSource : null;
        var modes = (objects['hp.hp_operating_mode'] && objects['hp.hp_operating_mode'].common.states) || {};
        var show = function (part) {
            return hidden.indexOf(part) < 0;
        };
        var parts = {
            buffer: ids.buffer !== null && show('buffer'),
            dhw: ids.dhwTop !== null && show('dhw'),
            freshwater: ids.dhwTap !== null && show('freshwater'),
            pv: (ids.pvProduction !== null || ids.pvSurplus !== null) && show('pv'),
            solar: ids.solarCollector !== null && show('solar'),
            bivalence: ids.bivalence !== null && show('bivalence'),
        };
        return {
            language: language,
            heatSource: heatSource || (detectedGround ? 'ground' : 'air'),
            // size of the drawing in percent of the original size
            scale: Math.min(200, Math.max(40, Number(settings.scale) || 90)),
            // two vessels (hot water above, a separate heating buffer below) only where both exist
            storage:
                settings.storage === 'separate' && ids.dhwTop !== null && ids.buffer !== null ? 'separate' : 'combined',
            parts: parts,
            generators: generatorsOf(states, ids),
            // the hot water vessel hangs below the pipes when there is no heating buffer or a separate one
            // (a fresh water station without hot water sensors still has a vessel: the schemes draw a Hygienik without B41 / B48)
            hungDhw:
                (parts.dhw || (parts.freshwater && !parts.buffer)) &&
                (settings.storage === 'separate' || !parts.buffer),
            // a vessel in the middle: the heating buffer, with the hot water inside unless that hangs apart
            centralTank: parts.buffer,
            ids: ids,
            circuits: circuits,
            // the compressors that report (a Twin unit has two, large ones up to four)
            compressors: [1, 2, 3, 4]
                .map(function (n) {
                    return `hp.compressor_status_${n}`;
                })
                .filter(function (id) {
                    return hasValue(states, id);
                }),
            tagNames: withCircuitNames(findTagNames(objects, language), labels),
            rods: ROD_STAGES.filter(function (stage) {
                return hasValue(states, stage.id);
            }),
            rooms: rooms,
            sensors: sensors,
            hpModes: modes,
            labels: labels,
        };
    }

    return { buildModel: buildModel, circuitTags: circuitTags, STATE_IDS: STATE_IDS, PARTS: PARTS };
});
