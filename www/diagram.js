/* Heat pump diagram: draws the plant the adapter reports (model.js) and keeps the values live (data.js). Read only. */
(function () {
    'use strict';

    var SVG_NS = 'http://www.w3.org/2000/svg';
    var REBUILD_DELAY_MS = 500;
    var DASH_PERIOD = 22; // dash and gap of a flowing pipe, see diagram.css
    var NARROW_SPACE = String.fromCharCode(0x202f);
    var IDLE_COLOR = '#9aa5b1';
    /* flow pipes and their sensors are always warm, return ones always cold; anything else follows its temperature */
    var FLOW_COLOR = '#f08a3a';
    var RETURN_COLOR = '#3b82f6';
    // the drinking water that enters a fresh water station is drawn in the colour of this temperature (degrees Celsius)
    var COLD_WATER_TEMP = 10;
    // in cooling operation the cold water has the blue used for cold water everywhere else
    var COOL_COLOR = RETURN_COLOR;
    // value of the operating mode register while the heat pump cools
    var COOLING_MODE = 2;
    // the fan icon: number of blades and the outline of one blade (the shape of the adapter logo, 86 units long)
    var FAN_BLADES = 5;
    var FAN_BLADE_PATH = 'M0 0 C 20 -22 52 -70 14 -86 C -18 -66 -22 -24 0 0 Z';
    // the solar loop counts as running when the charge pipe is at least this much (K) warmer than the return
    var SOLAR_MIN_DIFF = 2;

    /* IDM measuring points shown next to their values, as in the plant diagram of the Navigator */
    var TAG = {
        outdoor: 'B32',
        hgl: 'B35',
        flowRate: 'B2',
        hpFlow: 'B33',
        hpReturn: 'B34',
        dhwTop: 'B48',
        dhwBottom: 'B41',
        buffer: 'B38',
        tap: 'B42',
        collector: 'B73',
        solarCharge: 'B74',
        coldStorage: 'B40',
        solarReturn: 'B75',
    };

    /* layout in SVG units: the heat pump on the left, the storage in the middle, the circuits with their rooms on the right */
    var L = {
        originX: 250, // the drawing is shifted right by this much: room for the outdoor value left of the heat pump
        minWidth: 1170,
        displayScale: 1.35, // the page shows the drawing at this size, times the size setting (a larger window does not stretch it further)
        marginRight: 24,
        outdoorX: -230,
        hp: {
            x: -100,
            w: 330,
            minH: 270,
            rowGap: 50,
            iconSize: 96,
            // inside the box: the icon, the first value row (x of the text, distance from the top and the bottom), the status badges
            // (three per row, from the bottom edge) and the operating mode pill (from the bottom edge)
            iconX: 72,
            iconY: 118,
            textX: 142,
            topPad: 70,
            bottomPad: 70,
            badgeStride: 104,
            badgeRowH: 20,
            statusFromBottom: 62,
            pillFromBottom: 48,
            pillH: 34,
            outdoorDy: 100,
        },
        tank: { x: 520, w: 150, top: 80, h: 460, hSolar: 540, radius: 58, levelInset: 56, levelH: 30, pipeInset: 12 },
        // two vessels: the heating buffer keeps its place and size, the hot water vessel hangs below it and is wired from the side
        split: {
            gapBelow: 80,
            hungGap: 70,
            stackGap: 80,
            rodGap: 40,
            dhwH: 190,
            feedX: 22,
            returnX: 36,
            lane: 28,
            circuitShift: 180,
        },
        pipeGap: 100, // between hot gas line, flow and return pipe
        circuit: { x: 980, w: 216, h: 170, gap: 28, pipeDy: 40, manifold: 60 },
        room: { w: 114, h: 52, gap: 8 },
        station: { y: 128, w: 184, h: 146, titleH: 24, hxW: 70, hxH: 70, gap: 48, circulationGap: 74 }, // gap: from the storage to the station card
        solar: { sensorGap: 40, reserve: 110 }, // reserve: room at the bottom of the tank for the solar coil
        cards: { wrap: 1000, w: 310, gap: 330, rowH: 44 },
        tile: { w: 176, h: 62, gap: 12 },
        chip: { w: 104, h: 26 }, // the value chip on a pipe
        rod: { pillW: 46, pillH: 22, gap: 8 }, // the stages of the heating rod
        freeRoom: { columns: 5, w: 180, stride: 192, rowH: 64, headH: 36 }, // rooms of a plant without circuits
        // the cards of the further generators and of the bivalence value in the row below the plant; rows: the lines of the cascade card
        smallCard: { w: 220, h: 100, gap: 20, rowsTop: 54, rowsPad: 2, rowH: 22 },
        // the risers that join a generator to the storage: one pair per generator, left of the lanes of the hung vessels
        generator: {
            riserInset: 36,
            riserStep: 36,
            returnGap: 16,
            flowRow: 30,
            returnRow: 50,
            flowDy: 70,
            returnInset: 36,
        },
    };

    var FAUCET_PATHS = [
        'M20 120 H60 a30 30 0 0 1 30 30 V255 a30 30 0 0 1 -30 30 H20 Z', // wall plate
        'M120 150 H190 V75 H305 V150 H330 A140 140 0 0 1 470 290 V300 H365 V280 A35 35 0 0 0 330 255 H120 Z', // body and spout
        'M155 15 H335 V45 H260 V75 H230 V45 H155 Z', // handle
        'M425 330 C425 330 355 410 355 445 A70 70 0 0 0 495 445 C495 410 425 330 425 330 Z', // drop
    ];

    var svg = document.getElementById('diagram');
    var model = null;
    var modelJson = '';
    var state = {}; // latest value per state id
    var bindings = {}; // state id -> functions that show the value
    var tankCount = 0; // one gradient per vessel; the count only grows, so a rebuilt drawing never reuses an id
    var view = null; // what the current render draws into: model, layers, colours of the flow and return sensors

    /* ---------- values and bindings ---------- */

    function bind(id, show) {
        if (!id) {
            return;
        }
        (bindings[id] = bindings[id] || []).push(show);
        if (Object.prototype.hasOwnProperty.call(state, id)) {
            show(state[id]);
        }
    }
    function fire(id) {
        (bindings[id] || []).forEach(function (show) {
            show(state[id]);
        });
    }
    function num(v) {
        return typeof v === 'number' && isFinite(v) ? v : null;
    }
    /* running: a switch that is on, or a speed above zero (a pump at -1 % is not driven) */
    function isRunning(v) {
        return v === true || (num(v) !== null && v > 0);
    }
    /* The rule "is it running" of a pipe or a part as `{ fn, ids }` (`fn` is checked again whenever one of the states `ids` changes).
       `spec` is one id or a list (running while any runs), `{ all: [groupA, groupB] }` (running while every group has something
       running: a mixer that is open AND a pump that runs) or already `{ fn, ids }`. */
    function activityOf(spec) {
        if (spec && spec.fn) {
            return spec;
        }
        var lists = (spec && spec.all ? spec.all : [spec]).map(function (ids) {
            return [].concat(ids || []).filter(Boolean);
        });
        return {
            fn: function () {
                return lists.every(function (list) {
                    return list.some(function (id) {
                        return isRunning(state[id]);
                    });
                });
            },
            ids: [].concat.apply([], lists),
        };
    }
    /* call `apply(true|false)` whenever the rule `spec` (see activityOf) changes its answer */
    function whenRunning(spec, apply) {
        var activity = activityOf(spec);
        var refresh = function () {
            apply(activity.fn());
        };
        activity.ids.forEach(function (id) {
            bind(id, refresh);
        });
    }
    function fmt(v, decimals, unit) {
        var n = num(v);
        if (n === null) {
            return '–';
        }
        var s = n.toFixed(decimals);
        if (model && model.language === 'de') {
            s = s.replace('.', ',');
        }
        return s + (unit ? NARROW_SPACE + unit : '');
    }
    function decimalsOf(unit) {
        return unit === 'V' ? 2 : 1;
    }
    /* the sensor name without the word "temperature" (in the languages the adapter has), to fit the heat pump box; only a
       separate word after another word goes, never the end of a compound or the first word ("Luftansaugtemperatur" stays whole), Chinese has no spaces */
    function stripTemperature(name) {
        return name
            .replace(/\s(temperature|temperatur|température|temperatura|temperatuur)(?=\s|$)/i, ' ')
            .replace(/温度/, '')
            .trim();
    }

    /* blue (cold) to orange (hot), with a light step in between so the blend does not turn grey */
    var TEMPERATURE_STOPS = [
        [10, [40, 110, 230]],
        [32, [90, 170, 225]],
        [45, [244, 160, 70]],
        [60, [235, 95, 30]],
    ];
    function tempColor(t) {
        var n = num(t);
        if (n === null) {
            return IDLE_COLOR;
        }
        var stops = TEMPERATURE_STOPS;
        var rgb = stops[stops.length - 1][1];
        if (n <= stops[0][0]) {
            rgb = stops[0][1];
        }
        for (var k = 1; k < stops.length && n > stops[0][0]; k++) {
            if (n <= stops[k][0]) {
                var from = stops[k - 1];
                var to = stops[k];
                var f = (n - from[0]) / (to[0] - from[0]);
                rgb = from[1].map(function (c, q) {
                    return Math.round(c + (to[1][q] - c) * f);
                });
                break;
            }
        }
        return `rgb(${rgb.join(',')})`;
    }
    function colorOf(id, v) {
        var cool = view.mode === COOLING_MODE && view.coolRole[id];
        if (cool) {
            return COOL_COLOR;
        }
        return view.roleColor[id] || tempColor(v);
    }
    /* the pipes whose colour changes with cooling: the heat pump flow and return and the flow of the circuits (while the heat pump
       cools, cold water runs in all of them) */
    function coolRoles(m) {
        var roles = {};
        [m.ids.hpFlow, m.ids.hpReturn]
            .concat(
                m.circuits.map(function (c) {
                    return c.flow;
                }),
            )
            .forEach(function (id) {
                if (id) {
                    roles[id] = true;
                }
            });
        return roles;
    }
    /* Which way the water goes depends on the operating mode: heating charges the heating buffer and the circuits take their heat from
       it, hot water charges the hot water vessel, cooling charges the cold storage and the circuits take their cold from it (without
       a cold storage the heat pump cools straight through the circuits). While the heat pump does nothing (off, defrost) the path
       'rest' is on: the circuits still draw from the heating buffer. Without a mode value both heating and hot water count. */
    function pathOn(path) {
        if (path === 'solar') {
            // the solar loop works while its charge pipe is clearly warmer than its return (set by drawSolar; without both sensors always)
            return view.solarOn ? view.solarOn() : true;
        }
        var mode = view.mode;
        if (mode === null) {
            return path !== 'cool' && path !== 'rest';
        }
        // 'rest': the heat pump itself does nothing (off or defrosting); the circuits still draw from the heating buffer then
        if (path === 'rest') {
            return mode === 0 || mode === 8;
        }
        return path === 'heat' ? mode === 1 : path === 'dhw' ? mode === 4 : mode === COOLING_MODE;
    }
    function inUse(uses) {
        return !uses || uses.some(pathOn);
    }
    /* where the pipes meet the wall of the heating buffer */
    function tankWallLeft() {
        return L.tank.x + L.tank.pipeInset;
    }
    function tankWallRight() {
        return L.tank.x + L.tank.w - L.tank.pipeInset;
    }
    /* the hung vessel of a kind ('dhw' or 'cold'), if there is one */
    function hungOf(hung, kind) {
        return hung.find(function (vessel) {
            return vessel.kind === kind;
        });
    }
    /* the compressors that report; a plant that reports none still shows its one compressor dot */
    function compressorIds() {
        return view.m.compressors.length ? view.m.compressors : [view.m.ids.compressor];
    }

    /* ---------- drawing primitives ---------- */

    function el(tag, attrs, parent) {
        var node = document.createElementNS(SVG_NS, tag);
        Object.keys(attrs || {}).forEach(function (k) {
            node.setAttribute(k, attrs[k]);
        });
        if (parent) {
            parent.appendChild(node);
        }
        return node;
    }
    function text(parent, x, y, str, cls, anchor) {
        var t = el('text', { x: x, y: y, class: cls || 'label' }, parent);
        if (anchor) {
            t.setAttribute('text-anchor', anchor);
        }
        t.textContent = str;
        return t;
    }
    /* squeeze a text that is wider than `maxWidth` into it instead of cutting it off (long names in some languages) */
    function fitText(t, maxWidth) {
        var width = t.getComputedTextLength ? t.getComputedTextLength() : 0;
        if (width > maxWidth) {
            t.setAttribute('textLength', maxWidth);
            t.setAttribute('lengthAdjust', 'spacingAndGlyphs');
        }
    }
    function value(parent, x, y, id, decimals, unit, cls, anchor) {
        var t = text(parent, x, y, '–', cls || 'value', anchor);
        bind(id, function (v) {
            t.textContent = fmt(v, decimals, unit);
        });
        return t;
    }
    /* a small label with its value `dy` below */
    function labeled(parent, x, y, label, id, decimals, unit, cls, dy, maxWidth) {
        var t = text(parent, x, y, label, 'label');
        if (maxWidth) {
            fitText(t, maxWidth);
        }
        return value(parent, x, y + (dy || 20), id, decimals, unit, cls || 'value');
    }
    function sensorValue(parent, x, y, sensor) {
        return labeled(parent, x, y, `${sensor.tag} ${sensor.name}`, sensor.id, decimalsOf(sensor.unit), sensor.unit);
    }
    function card(parent, x, y, w, h, title) {
        el('rect', { x: x, y: y, width: w, height: h, rx: 14, class: 'box' }, parent);
        if (title) {
            // a long name (another language) is squeezed to leave room for the status dot in the corner
            fitText(text(parent, x + 16, y + 28, title, 'title'), w - 48);
        }
    }
    function dot(parent, cx, cy, ids) {
        var c = el('circle', { cx: cx, cy: cy, r: 6, fill: IDLE_COLOR }, parent);
        whenRunning(ids, function (running) {
            c.setAttribute('fill', running ? 'var(--good)' : IDLE_COLOR);
        });
    }
    /* a pump from the web interface or Modbus: a small pump symbol (green = running, grey = off) with the IDM tag; analog pumps
       show their speed */
    function badge(parent, x, y, tag, id, showPercent) {
        var r = 7;
        var cy = y - 4;
        var body = el('circle', { cx: x + r, cy: cy, r: r, class: 'pumpbody smallpump' }, parent);
        var k = r / 26;
        var arrow = el(
            'path',
            {
                d: `M${x + r - 10 * k} ${cy - 15 * k} L${x + r + 15 * k} ${cy} L${x + r - 10 * k} ${cy + 15 * k} Z`,
                class: 'pumparrow',
            },
            parent,
        );
        var label = text(parent, x + 2 * r + 6, y, `${tag} ${view.m.labels.off}`, 'small');
        bind(id, function (v) {
            var on = isRunning(v);
            arrow.style.fill = on ? 'var(--good)' : 'var(--muted)';
            body.style.stroke = on ? 'var(--good)' : 'var(--muted)';
            label.textContent = `${tag} ${on ? (showPercent ? `${Math.round(v)} %` : view.m.labels.on) : view.m.labels.off}`;
        });
    }
    /* a mixer valve (two triangles meeting in a point, as in the IDM plant diagram) with its tag and value: green while it is
       driven, grey otherwise. `describe(value)` returns the text and whether it is driven. */
    function mixerBadge(parent, x, y, tag, id, describe) {
        var s = 6;
        var cx = x + s + 2;
        var cy = y - 4;
        var valve = el(
            'path',
            {
                d: `M${cx - s} ${cy - s} L${cx} ${cy} L${cx - s} ${cy + s} Z M${cx + s} ${cy - s} L${cx} ${cy} L${cx + s} ${cy + s} Z`,
                class: 'valve',
            },
            parent,
        );
        var label = text(parent, x + 2 * s + 8, y, tag, 'small');
        bind(id, function (v) {
            var info = describe(v);
            valve.style.fill = info.active ? 'var(--good)' : 'var(--muted)';
            label.textContent = `${tag} ${info.text}`;
        });
    }
    /* an analog output of 0 to 10 V is 0 to 100 % (the hot gas mixer M71, the fan M13) */
    function percentOfVolts(v) {
        var n = num(v);
        return n === null ? '–' : fmt(n * 10, 0, '%');
    }
    function describeVoltage(v) {
        var n = num(v);
        return { text: percentOfVolts(v), active: n !== null && n > 0 };
    }
    /* M41, the heating circuit mixer: the Navigator reports a text (German "Aus" while it does not move) */
    function describeMixerText(v) {
        var t = v === null || v === undefined ? '' : String(v).trim();
        return { text: t || '–', active: t !== '' && !/^(aus|off|zu|closed|geschlossen|0|-)$/i.test(t) };
    }
    function roomTile(parent, x, y, w, room) {
        el('rect', { x: x, y: y, width: w, height: L.room.h, rx: 10, class: 'box' }, parent);
        text(parent, x + 10, y + 21, room.name, 'label');
        value(parent, x + 10, y + 43, room.temperature, 1, '°C', 'value');
        if (room.target) {
            value(parent, x + w - 8, y + 43, room.target, 1, '', 'small', 'end');
        }
    }

    /* ---------- pipes ---------- */

    /* where in the dash pattern a pipe starts, so that a branch continues the dashes of the pipe it joins: the pattern position at
       the joint is the length of the pipe so far, modulo the period */
    function phaseOf(length) {
        return ((length % DASH_PERIOD) + DASH_PERIOD) % DASH_PERIOD;
    }
    /* A pipe is a thin grey base (all bases lie in one layer below), a solid coloured line while the pipe is on the active path (`uses`
       names the paths that use it: heat, dhw, cool, rest, solar), and light dashes that move along it while it runs (`activeIds`, see activityOf).
       The colour comes from the sensor `sensorId` unless `opts.color` is given; `opts.phase` shifts the dash pattern (see phaseOf).
       A pipe on the active path that does not flow stays grey: no water, no colour. Without any state that could say so (`activeIds`
       empty) the pipe counts as flowing. */
    function pipe(parent, d, sensorId, activeIds, opts) {
        var phase = opts && opts.phase;
        var uses = opts && opts.uses;
        var fixedColor = opts && opts.color;
        el('path', { d: d, class: 'pipe-base' }, parent === view.pipes ? view.pipesBase : parent);
        var color = el('path', { d: d, class: 'pipe-color' }, parent);
        var light = el('path', { d: d, class: 'pipe-light' }, parent);
        if (phase) {
            light.style.setProperty('--phase', `${phase}px`);
        }
        var activity = activityOf(activeIds);
        var known = activity.ids.length > 0;
        var running = false;
        // what is on the screen, so that a temperature update that changes nothing writes nothing
        var shown = null;
        var flowing = null;
        var stroke = null;
        var update = function () {
            var on = inUse(uses) && (!known || running);
            if (on !== shown) {
                color.style.display = on ? '' : 'none';
                light.style.display = on ? '' : 'none';
                shown = on;
            }
            var moves = on && running;
            if (moves !== flowing) {
                light.classList.toggle('flowing', moves);
                flowing = moves;
            }
            if (on) {
                var next = fixedColor || colorOf(sensorId, state[sensorId]);
                if (next !== stroke) {
                    color.setAttribute('stroke', next);
                    stroke = next;
                }
            }
        };
        var check = function () {
            running = activity.fn();
            update();
        };
        bind(sensorId, update);
        activity.ids.forEach(function (id) {
            bind(id, check);
        });
        update();
        if (uses) {
            view.modeIds.add(sensorId);
            activity.ids.forEach(function (id) {
                view.modeIds.add(id);
            });
        }
        return color;
    }
    /* a pipe made of straight pieces; `points` are [x, y] pairs */
    function line(parent, points, sensorId, activeIds, opts) {
        var d = points
            .map(function (pt, k) {
                return `${(k ? 'L' : 'M') + pt[0]} ${pt[1]}`;
            })
            .join(' ');
        return pipe(parent, d, sensorId, activeIds, opts);
    }
    function hline(parent, x1, x2, y, sensorId, activeIds, opts) {
        return line(
            parent,
            [
                [x1, y],
                [x2, y],
            ],
            sensorId,
            activeIds,
            opts,
        );
    }
    function vline(parent, x, y1, y2, sensorId, activeIds, opts) {
        return line(
            parent,
            [
                [x, y1],
                [x, y2],
            ],
            sensorId,
            activeIds,
            opts,
        );
    }
    /* a value chip with the IDM tag in front, sitting on a pipe: coloured while the pipe is on the active path and flows (`activeIds`) */
    function tagChip(parent, cx, cy, id, tag, uses, activeIds) {
        var g = el('g', {}, parent);
        var r = el(
            'rect',
            {
                x: cx - L.chip.w / 2,
                y: cy - L.chip.h / 2,
                width: L.chip.w,
                height: L.chip.h,
                rx: L.chip.h / 2,
                fill: IDLE_COLOR,
            },
            g,
        );
        var t = text(g, cx, cy + 5, tag, 'chiptext', 'middle');
        var activity = activityOf(activeIds);
        // grey while the pipe it sits on rests
        var refresh = function () {
            var on = inUse(uses) && (!activity.ids.length || activity.fn());
            r.setAttribute('fill', on ? colorOf(id, state[id]) : IDLE_COLOR);
        };
        activity.ids.forEach(function (activeId) {
            bind(activeId, refresh);
        });
        bind(id, function (v) {
            refresh();
            t.textContent = `${tag}  ${fmt(v, 1, '°C')}`;
        });
        view.modeIds.add(id);
    }

    /* ---------- parts ---------- */

    function iconBox(parent, cx, cy, size) {
        el('rect', { x: cx - size / 2, y: cy - size / 2, width: size, height: size, rx: 12, class: 'fanbg' }, parent);
    }
    /* the fan of an air heat pump; it turns with the fan voltage M13 (0-10 V, 0 V = standing), else while the compressor runs */
    function fan(parent, cx, cy, size, compressorId, speedId) {
        iconBox(parent, cx, cy, size);
        var g = el('g', { transform: `translate(${cx} ${cy})` }, parent);
        var blades = el('g', { class: 'fan' }, g);
        // five blades, the shape of the adapter logo
        for (var i = 0; i < FAN_BLADES; i++) {
            el(
                'path',
                {
                    d: FAN_BLADE_PATH,
                    fill: 'var(--accent)',
                    transform: `rotate(${(i * 360) / FAN_BLADES}) scale(${size / 205})`,
                },
                blades,
            );
        }
        el('circle', { r: 5, fill: 'var(--muted)' }, g);
        if (speedId) {
            bind(speedId, function (v) {
                var volts = num(v);
                blades.classList.toggle('spin', volts !== null && volts > 0);
                blades.style.animationDuration =
                    volts > 0 ? `${(3.2 - (2.6 * Math.min(volts, 10)) / 10).toFixed(2)}s` : '';
            });
        } else {
            whenRunning(compressorId, function (running) {
                blades.classList.toggle('spin', running);
            });
        }
    }
    /* the heat source of a ground or groundwater heat pump: a pump between two pipe stubs, lit while a source pump runs */
    function pumpIcon(parent, cx, cy, size, pumpIds) {
        iconBox(parent, cx, cy, size);
        var k = size / 96;
        var stubs = el(
            'path',
            { d: `M${cx - 40 * k} ${cy} H${cx - 26 * k} M${cx + 26 * k} ${cy} H${cx + 40 * k}`, class: 'pumpstub' },
            parent,
        );
        var body = el('circle', { cx: cx, cy: cy, r: 26 * k, class: 'pumpbody' }, parent);
        var arrow = el(
            'path',
            {
                d: `M${cx - 10 * k} ${cy - 15 * k} L${cx + 15 * k} ${cy} L${cx - 10 * k} ${cy + 15 * k} Z`,
                class: 'pumparrow',
            },
            parent,
        );
        whenRunning(pumpIds, function (running) {
            arrow.style.fill = running ? 'var(--good)' : 'var(--muted)';
            body.style.stroke = running ? 'var(--good)' : 'var(--muted)';
            stubs.classList.toggle('flowing', running);
        });
    }
    /* the storage: a vertical gradient from hot to cold with a chip per sensor level */
    function tank(parent, x, y, w, h, levels, title, reserveBottom, titleBelow, cold) {
        var gradientId = `tank-gradient-${tankCount++}`;
        var grad = el('linearGradient', { id: gradientId, x1: 0, y1: 0, x2: 0, y2: 1 }, el('defs', {}, parent));
        (cold
            ? [
                  ['0%', '#8cc0f0'],
                  ['100%', '#3f8fdc'],
              ]
            : [
                  ['0%', '#f28a3a'],
                  ['50%', '#f3b266'],
                  ['78%', '#9cc3e8'],
                  ['100%', '#3f8fdc'],
              ]
        ).forEach(function (stop) {
            el('stop', { offset: stop[0], 'stop-color': stop[1] }, grad);
        });
        el(
            'rect',
            { x: x, y: y, width: w, height: h, rx: L.tank.radius, fill: `url(#${gradientId})`, class: 'tank' },
            parent,
        );
        text(parent, x + w / 2, titleBelow ? y + h + 36 : y - 28, title, 'title', 'middle');
        levels.forEach(function (level, i) {
            var span = h - 2 * L.tank.levelInset - reserveBottom;
            var cy = levels.length === 1 ? y + h / 2 : y + L.tank.levelInset + (i * span) / (levels.length - 1);
            el(
                'rect',
                { x: x + 14, y: cy - L.tank.levelH / 2, width: w - 28, height: L.tank.levelH, rx: 15, class: 'level' },
                parent,
            );
            var t = text(parent, x + w / 2, cy + 5, '–', 'leveltext', 'middle');
            bind(level.id, function (v) {
                t.textContent = `${level.tag}  ${fmt(v, 1, '°C')}`;
            });
        });
    }
    /* a faucet; its drop is bright while hot water is drawn */
    function faucet(parent, x, y, flowId) {
        var g = el('g', { transform: `translate(${x} ${y}) scale(0.1)`, class: 'tap' }, parent);
        var drop;
        FAUCET_PATHS.forEach(function (d) {
            drop = el('path', { d: d }, g);
        });
        bind(flowId, function (v) {
            drop.setAttribute('opacity', isRunning(v) ? '1' : '0.25');
        });
    }

    /* ---------- the render: one function per part ---------- */

    function sensorByTag(m, tag) {
        return m.sensors.find(function (sensor) {
            return sensor.tag === tag;
        });
    }
    function colorRoles(m) {
        var ids = m.ids;
        var roles = {};
        var assign = function (list, color) {
            list.forEach(function (id) {
                if (id) {
                    roles[id] = color;
                }
            });
        };
        var charge = sensorByTag(m, TAG.solarCharge);
        var back = sensorByTag(m, TAG.solarReturn);
        assign([ids.hgl, ids.hpFlow, ids.dhwTop, ids.solarCollector, ids.dhwTap, charge && charge.id], FLOW_COLOR);
        assign(
            m.circuits.map(function (c) {
                return c.flow;
            }),
            FLOW_COLOR,
        );
        assign([ids.hpReturn, ids.dhwBottom || ids.buffer, back && back.id], RETURN_COLOR);
        return roles;
    }
    function createView(m) {
        while (svg.firstChild) {
            svg.removeChild(svg.firstChild);
        }
        document.getElementById('title').textContent = m.labels.title;
        document.title = m.labels.title;
        document.documentElement.lang = m.language;
        svg.setAttribute('aria-label', m.labels.title);
        bindings = {};
        var coolRole = coolRoles(m);
        var root = el('g', { transform: `translate(${L.originX} 0)` }, svg);
        return {
            m: m,
            roleColor: colorRoles(m),
            coolRole: coolRole,
            // the operating mode (1 heating, 2 cooling, 4 hot water), null while the Navigator reports none
            mode: null,
            // ids whose bindings are run again when the operating mode changes
            modeIds: new Set(Object.keys(coolRole)),
            /* back to front: pipes, the station card with its storage pipes (above the other pipes, below the tank), parts */
            pipesBase: el('g', {}, root),
            pipes: el('g', {}, root),
            mid: el('g', {}, root),
            parts: el('g', {}, root),
        };
    }
    /* the rows of pipes that run at fixed heights: the tank is centred, the three heat pump pipes sit around its middle */
    function gridOf(m) {
        var tankH = m.parts.solar ? L.tank.hSolar : L.tank.h;
        var yFlow = L.tank.top + tankH / 2;
        var tankBottom = L.tank.top + tankH;
        // the vessels that hang below: the hot water vessel (where it is a vessel of its own) and the cold storage; they start below
        // the heating buffer, or below the pipes that run straight from the heat pump to the circuits where there is none
        var cursor = m.centralTank ? tankBottom + L.split.gapBelow : yFlow + L.pipeGap + L.split.hungGap;
        var hung = [];
        // the cold storage hangs right below the heating buffer (it shares the pipes to the circuits), the hot water vessel below it
        if (m.ids.coldBuffer) {
            hung.push({ kind: 'cold', top: cursor, h: L.split.dhwH, bottom: cursor + L.split.dhwH });
            cursor += L.split.dhwH + L.split.stackGap;
        }
        if (m.hungDhw) {
            // taller where a solar coil sits at its bottom
            var dhwH = L.split.dhwH + (!m.centralTank && m.parts.solar ? L.solar.reserve : 0);
            hung.push({ kind: 'dhw', top: cursor, h: dhwH, bottom: cursor + dhwH });
        }
        var dhw = hungOf(hung, 'dhw');
        if (!m.centralTank && hung.length) {
            // the solar coil sits in the hot water vessel
            tankBottom = (dhw || hung[0]).bottom;
        }
        return {
            tankH: tankH,
            tankBottom: tankBottom,
            yHgl: yFlow - L.pipeGap,
            yFlow: yFlow,
            yRet: yFlow + L.pipeGap,
            hung: hung,
            dhwTop: dhw ? dhw.top : 0,
            dhwBottom: dhw ? dhw.bottom : 0,
            hungBottom: hung.length ? hung[hung.length - 1].bottom : tankBottom,
        };
    }
    /* a solar coil needs room for its flow and return pipe between the solar box (below the heat pump) and the bottom of the vessel it
       sits in; the vessel grows downwards when the box is too low, everything that hangs below moves with it */
    function growForSolar(g, hp) {
        var needed = hp.y + hp.h + 24 + 76 + 30;
        var delta = needed - g.tankBottom;
        if (!view.m.parts.solar || delta <= 0) {
            return;
        }
        g.tankBottom += delta;
        if (view.m.centralTank) {
            g.tankH += delta;
            g.hung.forEach(function (vessel) {
                vessel.top += delta;
                vessel.bottom += delta;
            });
        } else {
            var grown = false;
            g.hung.forEach(function (vessel) {
                if (!grown && vessel.kind === 'dhw') {
                    vessel.h += delta;
                    vessel.bottom += delta;
                    grown = true;
                } else if (grown) {
                    vessel.top += delta;
                    vessel.bottom += delta;
                }
            });
        }
        g.hungBottom = g.hung.length ? g.hung[g.hung.length - 1].bottom : g.tankBottom;
        var dhw = hungOf(g.hung, 'dhw');
        g.dhwTop = dhw ? dhw.top : 0;
        g.dhwBottom = dhw ? dhw.bottom : 0;
    }

    function heatPumpRows(m) {
        var sensors = m.sensors
            .filter(function (sensor) {
                return sensor.group === 'heatpump' || sensor.group === 'source';
            })
            .map(function (sensor) {
                var name = sensor.unit === '°C' ? stripTemperature(sensor.name) : sensor.name;
                return {
                    label: `${sensor.tag} ${name}`,
                    id: sensor.id,
                    decimals: decimalsOf(sensor.unit),
                    unit: sensor.unit,
                };
            });
        return [
            { label: m.labels.power, id: m.ids.power, decimals: 1, unit: 'kW' },
            { label: m.labels.thermalPower, id: m.ids.thermalPower, decimals: 1, unit: 'kW' },
            // with both COPs the rows say where each one comes from
            { label: m.ids.cop2 ? m.labels.copInternal : m.labels.cop, id: m.ids.cop, decimals: 1, unit: '' },
            { label: m.labels.copExternal, id: m.ids.cop2, decimals: 1, unit: '' },
        ]
            .concat(sensors)
            .filter(function (row) {
                return row.id;
            });
    }
    /* the status badges of the heat pump (charging pump, hot gas mixer, brine and source pumps) that the plant reports; they sit in a
       row of three, then wrap */
    function heatPumpStatus(ids) {
        return [
            { tag: 'M73', id: ids.pumpM73, mixer: false },
            { tag: 'M71', id: ids.hglMixer, mixer: true },
            { tag: 'M16', id: ids.pumpBrine, mixer: false },
            { tag: 'M15', id: ids.pumpSource, mixer: false },
        ].filter(function (item) {
            return item.id;
        });
    }
    /* the heat pump box: icon, power, COP, heat source sensors, pump status and operating mode; the outdoor value stands left of it */
    function drawHeatPump(g) {
        var m = view.m;
        var ids = m.ids;
        var parts = view.parts;
        var rows = heatPumpRows(m);
        var x = L.hp.x;
        var status = heatPumpStatus(ids);
        var extraRows = Math.max(0, Math.ceil(status.length / 3) - 1);
        var h = Math.max(
            L.hp.minH,
            L.hp.topPad + rows.length * L.hp.rowGap + L.hp.bottomPad + extraRows * L.hp.badgeRowH,
        );
        var y = g.yFlow - h / 2;
        var textX = x + L.hp.textX;
        var statusY = y + h - L.hp.statusFromBottom - extraRows * L.hp.badgeRowH;

        card(parts, x, y, L.hp.w, h, m.labels.heatPump);
        compressorIds().forEach(function (id, i) {
            dot(parts, x + L.hp.w - 20 - i * 16, y + 22, id);
        });
        if (m.heatSource === 'ground') {
            pumpIcon(parts, x + L.hp.iconX, y + L.hp.iconY, L.hp.iconSize, [ids.pumpBrine, ids.pumpSource]);
        } else {
            fan(parts, x + L.hp.iconX, y + L.hp.iconY, L.hp.iconSize, compressorIds(), ids.fanM13);
        }
        rows.forEach(function (row, i) {
            labeled(
                parts,
                textX,
                y + 70 + i * L.hp.rowGap,
                row.label,
                row.id,
                row.decimals,
                row.unit,
                'big',
                22,
                L.hp.w - L.hp.textX - 12,
            );
        });
        status.forEach(function (item, k) {
            var bx = x + 16 + (k % 3) * L.hp.badgeStride;
            var by = statusY + Math.floor(k / 3) * L.hp.badgeRowH;
            if (item.mixer) {
                // the hot gas mixer is a 0-10 V output shown as 0-100 %
                mixerBadge(parts, bx, by, item.tag, item.id, describeVoltage);
            } else {
                badge(parts, bx, by, item.tag, item.id, true);
            }
        });
        if (ids.fanM13 && m.heatSource !== 'ground') {
            // under the fan it belongs to
            var fanLabel = text(
                parts,
                x + L.hp.iconX,
                y + L.hp.iconY + L.hp.iconSize / 2 + 16,
                'M13 –',
                'small',
                'middle',
            );
            bind(ids.fanM13, function (v) {
                fanLabel.textContent = `M13 ${percentOfVolts(v)}`;
            });
        }
        if (ids.hpMode) {
            var pillY = y + h - L.hp.pillFromBottom;
            el(
                'rect',
                { x: x + 16, y: pillY, width: L.hp.w - 32, height: L.hp.pillH, rx: L.hp.pillH / 2, class: 'pill' },
                parts,
            );
            var mode = text(parts, x + L.hp.w / 2, pillY + L.hp.pillH / 2 + 5, '', 'pilltext', 'middle');
            bind(ids.hpMode, function (v) {
                mode.textContent = m.hpModes[String(v)] || '';
            });
        }
        if (ids.outdoor) {
            labeled(
                parts,
                L.outdoorX,
                y + L.hp.outdoorDy,
                `${TAG.outdoor} ${m.labels.outdoor}`,
                ids.outdoor,
                1,
                '°C',
                'big',
                30,
            );
        }
        return { y: y, h: h };
    }

    /* what the pieces of the storage share: the sensor levels of the vessel in the middle, the lanes of the hung vessels, the states
       that say whether water moves, and the paths the heat pump pipes carry */
    function storageContext(g) {
        var m = view.m;
        var ids = m.ids;
        var sp = L.split;
        var tankX = L.tank.x;
        var dhwLevels = [];
        if (m.parts.dhw) {
            dhwLevels.push({ id: ids.dhwTop, tag: TAG.dhwTop });
            if (ids.dhwBottom) {
                dhwLevels.push({ id: ids.dhwBottom, tag: TAG.dhwBottom });
            }
        }
        // the vessel in the middle: the heating buffer, with the hot water inside unless that hangs apart
        var centralLevels = m.parts.dhw && !m.hungDhw ? dhwLevels.slice() : [];
        if (m.parts.buffer) {
            centralLevels.push({ id: ids.buffer, tag: TAG.buffer });
        }
        var central = centralLevels.length > 0;
        /* the water moves while the charging pump M73 or the flow sensor B2 says so (the pump runs on after the compressor stops);
           the hot gas line only carries water while its mixer M71 is open and the water moves (without an M71 value it follows the water) */
        var flowRate = sensorByTag(m, TAG.flowRate);
        var water = [ids.pumpM73, flowRate && flowRate.id].filter(Boolean);
        var waterActive = water.length ? water : compressorIds();
        // the paths that take the water of the heat pump: the heating buffer (and, without a cold storage, cooling through it) or, with
        // no heating buffer, the pipes straight to the circuits; the hot water vessel and the cold storage on their own paths
        var endUses = hungOf(g.hung, 'cold') ? ['heat'] : ['heat', 'cool'];
        // a hot water vessel inside the central one (a Hygienik with stratification plate) is charged through the same pipes
        if (central && m.parts.dhw && !m.hungDhw) {
            endUses = endUses.concat(['dhw']);
        }
        // the vessels that hang below: charged by pipes that drop down left of the tanks and enter the side of the vessel, the feed at
        // the height of the upper sensor and the return at the lower one; the return is the outer pipe, so none crosses another, and
        // every further vessel takes the lane to the left of the one above
        var lanes = g.hung.map(function (vessel, i) {
            return {
                vessel: vessel,
                feedX: tankX - sp.feedX - i * sp.lane,
                returnX: tankX - sp.returnX - i * sp.lane,
                uses: vessel.kind === 'dhw' ? ['dhw'] : ['cool'],
                // the hot water vessel is charged by the hot gas line where there is one and no heating buffer takes it
                byHgl: vessel.kind === 'dhw' && ids.hgl && !central,
            };
        });
        return {
            central: central,
            centralLevels: centralLevels,
            dhwLevels: dhwLevels,
            hpRight: L.hp.x + L.hp.w,
            wall: tankWallLeft(),
            waterActive: waterActive,
            hglActive: ids.hglMixer ? { all: [ids.hglMixer, waterActive] } : waterActive,
            endUses: endUses,
            lanes: lanes,
        };
    }
    /* one of the pipes from the heat pump (flow or return) to the storage, drawn in pieces between the lanes: a piece carries water for
       every vessel beyond it. Returns the paths of the first piece, which the chip on the pipe follows. */
    function heatPumpPipe(st, y, id, laneKey, backward) {
        var firstUses = st.endUses;
        var far = st.lanes.slice().reverse(); // the farthest lane (the lowest vessel) is met first
        var xs = [st.hpRight].concat(
            far.map(function (lane) {
                return lane[laneKey];
            }),
        );
        xs.push(st.central ? st.wall : st.lanes.length ? st.lanes[0][laneKey] : st.hpRight);
        for (var k = 0; k < xs.length - 1; k++) {
            if (xs[k + 1] === xs[k]) {
                continue;
            }
            // the piece serves the vessels beyond it (the lanes from the k-th on) and the end of the row
            var uses = Array.from(
                new Set(
                    [].concat.apply(
                        st.endUses,
                        far.slice(k).map(function (lane) {
                            // a vessel on the hot gas line takes nothing from the flow pipe
                            return lane.byHgl && !backward ? [] : lane.uses;
                        }),
                    ),
                ),
            );
            var from = xs[k];
            var to = xs[k + 1];
            hline(view.pipes, backward ? to : from, backward ? from : to, y, id, st.waterActive, { uses });
            if (k === 0) {
                firstUses = uses;
            }
        }
        return firstUses;
    }
    /* the vessel in the middle and the hung ones, each hung vessel with the two pipes that drop down its lane */
    function drawVessels(g, st) {
        var m = view.m;
        var ids = m.ids;
        if (st.central) {
            var title =
                m.parts.dhw && !m.hungDhw && m.parts.buffer
                    ? `${m.labels.buffer} / ${m.labels.dhw}`
                    : m.parts.dhw && !m.hungDhw
                      ? m.labels.dhw
                      : m.labels.buffer;
            tank(
                view.parts,
                L.tank.x,
                L.tank.top,
                L.tank.w,
                g.tankH,
                st.centralLevels,
                title,
                m.parts.solar ? L.solar.reserve : 0,
            );
        }
        st.lanes.forEach(function (lane) {
            var vessel = lane.vessel;
            var isDhw = vessel.kind === 'dhw';
            tank(
                view.parts,
                L.tank.x,
                vessel.top,
                L.tank.w,
                vessel.h,
                isDhw ? st.dhwLevels : [{ id: ids.coldBuffer, tag: TAG.coldStorage }],
                isDhw ? m.labels.dhw : m.labels.coldStorage,
                isDhw && !st.central && m.parts.solar ? L.solar.reserve : 0,
                true,
                !isDhw,
            );
            var feedY = vessel.top + L.tank.levelInset;
            var returnY = vessel.bottom - L.tank.levelInset;
            var sourceY = lane.byHgl ? g.yHgl : g.yFlow;
            line(
                view.pipes,
                (lane.byHgl ? [[st.hpRight, sourceY]] : []).concat([
                    [lane.feedX, sourceY],
                    [lane.feedX, feedY],
                    [st.wall, feedY],
                ]),
                lane.byHgl ? ids.hgl : ids.hpFlow,
                lane.byHgl ? st.hglActive : st.waterActive,
                { uses: lane.uses },
            );
            line(
                view.pipes,
                [
                    [st.wall, returnY],
                    [lane.returnX, returnY],
                    [lane.returnX, g.yRet],
                ],
                ids.hpReturn,
                st.waterActive,
                { uses: lane.uses },
            );
        });
    }
    /* the storage with its sensor levels and the three pipes (hot gas line, flow, return) to the heat pump; false without sensors */
    function drawStorage(g) {
        var ids = view.m.ids;
        var st = storageContext(g);
        var central = st.central;
        var lanes = st.lanes;
        var hasPipes = central || lanes.length > 0;
        var flowChipUses = st.endUses;
        var returnChipUses = st.endUses;
        if (hasPipes) {
            flowChipUses = heatPumpPipe(st, g.yFlow, ids.hpFlow, 'feedX', false);
            returnChipUses = heatPumpPipe(st, g.yRet, ids.hpReturn, 'returnX', true);
            if (ids.hgl && central) {
                hline(view.pipes, st.hpRight, st.wall, g.yHgl, ids.hgl, st.hglActive, { uses: ['heat', 'dhw'] });
            }
        }
        drawVessels(g, st);
        var farthest = lanes.length ? lanes[lanes.length - 1].feedX : L.tank.x;
        var chipX = hasPipes ? (st.hpRight + farthest) / 2 : st.hpRight + 80;
        var chipPipes = [
            { y: g.yFlow, id: ids.hpFlow, tag: TAG.hpFlow, uses: flowChipUses, active: st.waterActive },
            { y: g.yRet, id: ids.hpReturn, tag: TAG.hpReturn, uses: returnChipUses, active: st.waterActive },
        ];
        if (ids.hgl && hasPipes) {
            chipPipes.unshift({
                y: g.yHgl,
                id: ids.hgl,
                tag: TAG.hgl,
                uses: central ? ['heat', 'dhw'] : ['dhw'],
                active: st.hglActive,
            });
        }
        chipPipes.forEach(function (p) {
            tagChip(view.parts, chipX, p.y, p.id, p.tag, p.uses, p.active);
        });
        // where the pipes to the circuits start: at the heating buffer, else where the straight pipes leave the lanes
        view.storage = {
            central: central,
            flowX: central ? st.wall : lanes.length ? lanes[0].feedX : st.hpRight,
            returnX: central ? st.wall : lanes.length ? lanes[0].returnX : st.hpRight,
            cold: hungOf(g.hung, 'cold'),
            // a heating buffer keeps feeding the circuits while the heat pump charges the hot water vessel
            trunkUses: central ? Array.from(new Set(st.endUses.concat(['dhw', 'rest']))) : st.endUses,
        };
        return { central: central, any: hasPipes };
    }

    /* the rooms next to each heating circuit (model.js assigns them from the zone modules and the settings) */
    function roomsOfCircuits(m) {
        return m.circuits.map(function (c) {
            return m.rooms.filter(function (room) {
                return room.circuit === c.letter;
            });
        });
    }
    /* where the circuit blocks, their manifolds and rooms stand, and which states say that a circuit runs */
    function circuitLayout(g) {
        var m = view.m;
        // beside a separate hot water vessel the station and its tap need the space left of the circuits: three or more circuits move
        // right so that their cards do not run into the tap
        var shift = m.hungDhw && m.circuits.length >= 3 ? L.split.circuitShift : 0;
        var c = Object.assign({}, L.circuit, { x: L.circuit.x + shift });
        var roomsOf = roomsOfCircuits(m);
        var tops = [];
        var next = g.yFlow - c.pipeDy;
        m.circuits.forEach(function (circuit, i) {
            tops.push(next);
            var roomRows = Math.ceil(roomsOf[i].length / 2);
            next += Math.max(c.h, roomRows * (L.room.h + L.room.gap) - L.room.gap) + c.gap;
        });
        return {
            c: c,
            roomsX: c.x + c.w + 12,
            flowManifold: c.x - c.manifold,
            returnManifold: c.x - c.manifold - 18,
            returnDy: c.pipeDy + (g.yRet - g.yFlow), // return pipe, from the top of a circuit block
            // the circuits are fed by the heating buffer (heating and hot water) or by the cold storage (cooling); without a heating
            // buffer the pipes come straight from the heat pump, which cannot feed them while it charges the hot water vessel
            circuitUses: view.storage.central ? ['heat', 'dhw', 'cool', 'rest'] : ['heat', 'cool'],
            roomsOf: roomsOf,
            /* water flows through a circuit while its pump runs (M31 for circuit A, M32 for B, ...); the mode alone says nothing (a circuit
               in heating mode with its pump off carries no water), and without a pump state nothing tells: no animation then */
            flows: m.circuits.map(function (circuit) {
                return circuit.pump ? [circuit.pump] : [];
            }),
            // the dot of a circuit without a pump state (the pump comes from the web interface) shows its mode: the best information left
            dots: m.circuits.map(function (circuit) {
                return circuit.pump ? [circuit.pump] : [circuit.active];
            }),
            tops: tops,
            bottom: next,
        };
    }
    /* the card of circuit number `i` with its branch pipes, values and rooms; returns the right edge of its rooms */
    function drawCircuitCard(g, cl, circuit, i) {
        var m = view.m;
        var ids = m.ids;
        var parts = view.parts;
        var c = cl.c;
        var y = cl.tops[i];
        var flows = cl.flows[i];
        // the branches continue the dashes of the trunk they join (the trunk runs from the storage and, for the return, ends there)
        var flowPhase = phaseOf(cl.flowManifold - view.storage.flowX + (y + c.pipeDy - g.yFlow));
        var returnPhase = phaseOf(cl.tops[cl.tops.length - 1] - y - (c.x - cl.returnManifold));
        hline(view.pipes, cl.flowManifold, c.x, y + c.pipeDy, circuit.flow || ids.hpFlow, flows, {
            phase: flowPhase,
            uses: cl.circuitUses,
        });
        hline(view.pipes, c.x, cl.returnManifold, y + cl.returnDy, ids.hpReturn, flows, {
            phase: returnPhase,
            uses: cl.circuitUses,
        });
        card(parts, c.x, y, c.w, c.h, circuit.name);
        dot(parts, c.x + c.w - 18, y + 22, cl.dots[i]);
        // pump and mixer of every circuit that reports them; a direct circuit shows the pump only
        if (circuit.pump) {
            badge(parts, c.x + 12, y + 150, circuit.pumpTag, circuit.pump, false);
        }
        // a circuit with a pump and no mixer is a direct circuit; say so, its card has few values
        if (circuit.pump && !circuit.mixer) {
            text(parts, c.x + 12, y + 46, m.labels.directCircuit, 'small');
        }
        if (circuit.mixer) {
            mixerBadge(parts, c.x + 104, y + 150, circuit.mixerTag, circuit.mixer, describeMixerText);
        }
        var columns = circuit.flow ? [{ label: `${circuit.flowTag} ${m.labels.flow}`, id: circuit.flow }] : [];
        if (circuit.setpoint) {
            columns.push({ label: m.labels.setpoint, id: circuit.setpoint });
        }
        if (circuit.room) {
            columns.push({ label: `${circuit.roomTag} ${m.labels.room}`, id: circuit.room });
        }
        // the columns share the card; two columns get more room, so "Vorlauf" and "Soll" do not touch
        var spacing = (c.w - 24) / Math.max(columns.length, 1);
        columns.forEach(function (column, k) {
            labeled(
                parts,
                c.x + 12 + k * spacing,
                y + 72,
                column.label.trim(),
                column.id,
                1,
                '°',
                'value',
                24,
                spacing - 8,
            );
        });
        var maxRight = 0;
        cl.roomsOf[i].forEach(function (room, k) {
            var rx = cl.roomsX + (k % 2) * (L.room.w + L.room.gap);
            roomTile(parts, rx, y + Math.floor(k / 2) * (L.room.h + L.room.gap), L.room.w, room);
            maxRight = Math.max(maxRight, rx + L.room.w);
        });
        return maxRight;
    }
    /* the pipes that feed all circuits: the trunks from the storage to the manifolds and the manifolds along the circuit cards */
    function drawCircuitTrunks(g, cl) {
        var ids = view.m.ids;
        var storage = view.storage;
        var cold = storage.cold;
        var wallRight = tankWallRight();
        // water flows in the trunk and in a stretch of the manifold while a circuit it feeds runs; as long as one of those circuits has
        // no pump state nothing tells, and the pipe is drawn coloured but not animated
        var flowOf = function (from) {
            var list = [];
            for (var n = from; n < cl.flows.length; n++) {
                if (!cl.flows[n].length) {
                    return [];
                }
                list = list.concat(cl.flows[n]);
            }
            return list;
        };
        var any = flowOf(0);
        var lastTop = cl.tops[cl.tops.length - 1];
        var flowBottom = lastTop + cl.c.pipeDy;
        var returnBottom = lastTop + cl.returnDy;
        // the pipes from the heat pump or the heating buffer (heating, and cooling where there is no cold storage) ...
        hline(view.pipes, storage.flowX, cl.flowManifold, g.yFlow, ids.hpFlow, any, { uses: storage.trunkUses });
        hline(view.pipes, cl.returnManifold, storage.returnX, g.yRet, ids.hpReturn, any, { uses: storage.trunkUses });
        // the manifolds run along the circuits in one stretch per circuit: water flows in a stretch only while a circuit at or below it
        // runs, so the pipes past the last running circuit rest
        for (var k = 1; k < cl.tops.length; k++) {
            var below = flowOf(k);
            var flowUpper = cl.tops[k - 1] + cl.c.pipeDy;
            var flowLower = cl.tops[k] + cl.c.pipeDy;
            var returnUpper = cl.tops[k - 1] + cl.returnDy;
            var returnLower = cl.tops[k] + cl.returnDy;
            vline(view.pipes, cl.flowManifold, flowUpper, flowLower, ids.hpFlow, below, {
                phase: phaseOf(cl.flowManifold - storage.flowX + (flowUpper - g.yFlow)),
                uses: cl.circuitUses,
            });
            vline(view.pipes, cl.returnManifold, returnLower, returnUpper, ids.hpReturn, below, {
                phase: phaseOf(returnBottom - returnLower),
                uses: cl.circuitUses,
            });
        }
        // ... and, where there is one, from the cold storage (cooling): its pipes join the manifolds on the right of the vessels
        if (cold) {
            var coldFlowY = cold.bottom - L.tank.levelInset;
            var coldReturnY = cold.top + L.tank.levelInset;
            var flowEnd = Math.max(flowBottom, coldFlowY);
            var returnEnd = Math.max(returnBottom, coldReturnY);
            if (flowEnd > flowBottom) {
                vline(view.pipes, cl.flowManifold, flowBottom, flowEnd, ids.hpFlow, any, { uses: ['cool'] });
            }
            if (returnEnd > returnBottom) {
                vline(view.pipes, cl.returnManifold, returnEnd, returnBottom, ids.hpReturn, any, { uses: ['cool'] });
            }
            hline(view.pipes, wallRight, cl.flowManifold, coldFlowY, ids.hpFlow, any, { uses: ['cool'] });
            hline(view.pipes, cl.returnManifold, wallRight, coldReturnY, ids.hpReturn, any, { uses: ['cool'] });
        }
    }
    /* the heating circuits, one block each: the card with its rooms (two columns) beside it, a branch of flow and return pipe,
       and the trunk from the storage that flows while any circuit runs */
    function drawCircuits(g) {
        var m = view.m;
        var cl = circuitLayout(g);
        var maxRight = cl.c.x + cl.c.w;
        m.circuits.forEach(function (circuit, i) {
            maxRight = Math.max(maxRight, drawCircuitCard(g, cl, circuit, i));
        });
        if (m.circuits.length) {
            drawCircuitTrunks(g, cl);
        }
        return { bottom: m.circuits.length ? cl.bottom : 0, maxRight: maxRight };
    }

    /* the fresh water station beside the upper part of the storage: one heat exchanger with the storage water on its left (in at
       the top, back at the bottom) and the drinking water on its right (cold inlet below, outlet above leading to the tap) */
    function drawStation(g) {
        var m = view.m;
        var ids = m.ids;
        var s = L.station;
        var x = L.tank.x + L.tank.w + s.gap;
        // beside the upper part of the storage; with a separate hot water vessel beside that vessel
        var y = m.hungDhw ? g.dhwTop + 20 : s.y;
        var w = s.w;
        // the heat exchanger stands in the middle of the card
        var hxX = x + (w - s.hxW) / 2;
        var hxY = y + 20;
        var hxRight = hxX + s.hxW;
        var inY = hxY + 16;
        var outY = hxY + s.hxH - 16;
        var tankInside = L.tank.x + L.tank.w - 60; // the storage pipes start where the tank wall is straight
        /* the station runs while the hot water flow switch B1 or the station pump M22 says so (both come from the web interface); without
           either nothing tells whether hot water is drawn, and the station is drawn coloured but not animated */
        var active = [ids.dhwFlow, ids.pumpM22];
        var coldEnd = x + w + 54;
        var tapX = x + w + 90;
        var tapY = inY - 20;

        // the title row sits above the heat exchanger, so the card grows upward and the pipes and the tap stay where they are
        card(view.mid, x, y - s.titleH, w, s.h + s.titleH, m.labels.freshwater);
        if (ids.pumpM22) {
            badge(view.mid, x + 14, y + 126, 'M22', ids.pumpM22, true);
        }
        if (ids.circulation) {
            badge(view.mid, x + 14 + (ids.pumpM22 ? s.circulationGap : 0), y + 126, 'M64', ids.circulation, false);
        }
        // hot in, back cooler, also where the vessel has no sensors
        hline(view.mid, tankInside, hxX, inY, ids.dhwTop, active, { color: FLOW_COLOR });
        hline(view.mid, hxX, tankInside, outY, ids.dhwBottom || ids.buffer, active, {
            color: RETURN_COLOR,
        });
        el('rect', { x: hxX, y: hxY, width: s.hxW, height: s.hxH, rx: 6, class: 'hx' }, view.parts);
        el('path', { d: `M${hxX} ${hxY + s.hxH} L${hxRight} ${hxY}`, class: 'hxline' }, view.parts);

        // the drinking water runs through the heat exchanger as soon as the station works: cold in, hot out to the tap
        pipe(view.parts, `M${hxRight} ${inY} H${tapX + 2}`, null, active, { color: FLOW_COLOR });
        pipe(view.parts, `M${coldEnd} ${outY} H${hxRight}`, null, active, {
            color: tempColor(COLD_WATER_TEMP),
        });

        text(view.parts, coldEnd, outY + 22, m.labels.coldWater, 'small', 'middle');
        faucet(view.parts, tapX, tapY, ids.dhwFlow);
        labeled(view.parts, tapX + 56, tapY + 12, TAG.tap, ids.dhwTap, 1, '°C');
        if (ids.dhwSetpoint) {
            labeled(view.parts, tapX + 56, tapY + 54, m.labels.setpoint, ids.dhwSetpoint, 0, '°C');
        }
    }

    /* the stages of the electric heating rod: a pill per stage, green while its output is on */
    function drawRod(g) {
        var m = view.m;
        var parts = view.parts;
        var count = m.rods.length;
        var pillW = L.rod.pillW;
        var gap = L.rod.gap;
        var total = count * pillW + (count - 1) * gap;
        var cx = L.tank.x + L.tank.w / 2;
        var y = m.hungDhw && !m.centralTank ? g.dhwBottom + 56 : g.tankBottom + 22;
        text(parts, cx, y, m.labels.rod, 'small', 'middle');
        m.rods.forEach(function (stage, i) {
            var x = cx - total / 2 + i * (pillW + gap);
            var pill = el(
                'rect',
                { x: x, y: y + 8, width: pillW, height: L.rod.pillH, rx: L.rod.pillH / 2, class: 'level' },
                parts,
            );
            var label = text(parts, x + pillW / 2, y + 24, stage.label, 'leveltext', 'middle');
            bind(stage.id, function (v) {
                var on = isRunning(v);
                pill.style.fill = on ? 'var(--good)' : '';
                label.style.fill = on ? '#fff' : '';
            });
        });
    }
    /* without a fresh water station (an AQA tank) the circulation pump stands beside the hot water part on its own */
    function drawCirculation(g) {
        var m = view.m;
        var x = L.tank.x + L.tank.w + L.station.gap;
        var y = (m.hungDhw ? g.dhwTop + 20 : L.station.y) + 40;
        text(view.parts, x + 14, y - 22, m.labels.circulation, 'small');
        badge(view.parts, x + 14, y, 'M64', m.ids.circulation, false);
    }

    /* whether the solar loop runs: where the solar pumps report they say it; else the loop works while its charge pipe is clearly warmer
       than its return; undefined (always) without either */
    function solarLoop(solarPumps, charge, back) {
        if (solarPumps.length) {
            return activityOf(
                solarPumps.map(function (pump) {
                    return pump[1];
                }),
            );
        }
        if (charge && back) {
            return {
                fn: function () {
                    var hot = num(state[charge.id]);
                    var cold = num(state[back.id]);
                    return hot !== null && cold !== null && hot - cold >= SOLAR_MIN_DIFF;
                },
                ids: [charge.id, back.id],
            };
        }
        return undefined;
    }
    /* solar thermal below the heat pump, connected to the lower part of the storage by a flow and a return pipe with a coil
       inside it; charging (B74) and return (B75) sit on their pipes, the other solar sensors in the box. Returns its bottom. */
    function drawSolar(g, hp) {
        var m = view.m;
        var parts = view.parts;
        var x = L.hp.x;
        var all = m.sensors.filter(function (sensor) {
            return sensor.group === 'solar';
        });
        var charge = sensorByTag(m, TAG.solarCharge);
        var back = sensorByTag(m, TAG.solarReturn);
        var others = all.filter(function (sensor) {
            return sensor !== charge && sensor !== back;
        });
        var solarPumps = [
            ['M75', m.ids.solarPump1],
            ['M76', m.ids.solarPump2],
        ].filter(function (pump) {
            return pump[1];
        });
        var h = (others.length ? 126 + others.length * L.solar.sensorGap : 110) + (solarPumps.length ? 26 : 0);
        var y = Math.max(hp.y + hp.h + 24, g.tankBottom - h - 20);
        var flowY = Math.min(y + 36, g.tankBottom - 30);
        var returnY = Math.min(y + 76, g.tankBottom - 24);
        var right = x + L.hp.w;
        var chipX = (right + L.tank.x) / 2;

        card(parts, x, y, L.hp.w, h, m.labels.solar);
        solarPumps.forEach(function (pump, i) {
            badge(parts, x + 16 + i * 104, y + h - 14, pump[0], pump[1], false);
        });
        labeled(
            parts,
            x + 16,
            y + 62,
            `${TAG.collector} ${m.labels.collector}`,
            m.ids.solarCollector,
            1,
            '°C',
            'big',
            28,
        );
        others.forEach(function (sensor, i) {
            sensorValue(parts, x + 16, y + 126 + i * L.solar.sensorGap, sensor);
        });
        var loop = solarLoop(solarPumps, charge, back);
        view.solarOn = loop ? loop.fn : null;
        hline(view.pipes, right, L.tank.x + 40, flowY, m.ids.solarCollector, loop, { uses: ['solar'] });
        hline(view.pipes, L.tank.x + 40, right, returnY, (back || {}).id || m.ids.solarCollector, loop, {
            uses: ['solar'],
        });
        // the chips follow the loop (the pumps, or the two sensors), like the pipes
        if (charge) {
            tagChip(parts, chipX, flowY, charge.id, TAG.solarCharge, ['solar'], loop);
        }
        if (back) {
            tagChip(parts, chipX, returnY, back.id, TAG.solarReturn, ['solar'], loop);
        }
        drawSolarCoil(flowY, returnY);
        return y + h + 20;
    }
    /* the heat exchanger coil inside the storage, between the flow and the return pipe */
    function drawSolarCoil(flowY, returnY) {
        var left = L.tank.x + 30;
        var rightEdge = L.tank.x + L.tank.w - 32;
        var step = (returnY - flowY) / 3;
        el(
            'path',
            {
                d: `M${left} ${flowY} H${rightEdge} V${flowY + step} H${left} V${flowY + 2 * step} H${rightEdge} V${returnY} H${left}`,
                class: 'coil',
            },
            view.parts,
        );
    }

    /* the remaining sensors in cards, by group, wrapping to a new row when the row is full; returns the bottom */
    function drawSensorCards(top) {
        var m = view.m;
        var cardsL = L.cards;
        var x = L.hp.x;
        var rowH = 0;
        var y = top;
        ['storage', 'isc', 'other'].forEach(function (group) {
            var list = m.sensors.filter(function (sensor) {
                return sensor.group === group;
            });
            if (!list.length) {
                return;
            }
            var h = 40 + list.length * cardsL.rowH;
            if (x + cardsL.w > cardsL.wrap) {
                x = L.hp.x;
                y += rowH + 16;
                rowH = 0;
            }
            card(view.parts, x, y, cardsL.w, h, m.labels[group]);
            list.forEach(function (sensor, i) {
                sensorValue(view.parts, x + 14, y + 50 + i * cardsL.rowH, sensor);
            });
            rowH = Math.max(rowH, h);
            x += cardsL.gap;
        });
        return y + rowH + (rowH ? 16 : 0);
    }
    function drawBivalence(top) {
        var m = view.m;
        card(view.parts, L.hp.x, top, L.smallCard.w, L.smallCard.h, m.labels.bivalence);
        var t = text(view.parts, L.hp.x + 16, top + 80, '–', 'big');
        bind(m.ids.bivalence, function (v) {
            t.textContent = v === null || v === undefined ? '–' : String(v);
        });
        return top + L.smallCard.h + L.smallCard.gap;
    }
    /* The pipes of a further generator (boiler, stove, cascade member) from the card whose right edge is at `cardRight`: the flow joins at
       the top of the heating buffer, the return comes back at its bottom; without a heating buffer both join the pipes of the heat pump
       (ALM 2-15 p. 49). `index` staggers the risers of several generators. `spec`: `flowSensor` / `returnSensor` (the sensors the colours
       come from, or `flowColor` / `returnColor` where fixed), the `uses` paths and the `active` rule (see activityOf). */
    function generatorPipes(g, cardRight, top, index, spec) {
        var storage = view.storage;
        if (!storage) {
            return; // no storage drawn (drawStorage sets it): nothing to join
        }
        var gen = L.generator;
        // the risers stand left of the lanes of the hung vessels, but never left of the card they leave
        var flowX = Math.max(
            L.tank.x -
                L.split.returnX -
                Math.max(g.hung.length, 1) * L.split.lane -
                gen.riserInset -
                index * gen.riserStep,
            cardRight + gen.riserInset,
        );
        var returnX = flowX - gen.returnGap;
        var wall = tankWallLeft();
        var flowY = storage.central ? L.tank.top + gen.flowDy : g.yFlow;
        var returnY = storage.central ? g.tankBottom - gen.returnInset : g.yRet;
        var flowPoints = [
            [cardRight, top + gen.flowRow],
            [flowX, top + gen.flowRow],
            [flowX, flowY],
        ];
        var returnPoints = [
            [returnX, returnY],
            [returnX, top + gen.returnRow],
            [cardRight, top + gen.returnRow],
        ];
        if (storage.central) {
            flowPoints.push([wall, flowY]);
            returnPoints.unshift([wall, returnY]);
        }
        line(view.pipes, flowPoints, spec.flowSensor, spec.active, {
            uses: spec.uses,
            color: spec.flowColor,
        });
        line(view.pipes, returnPoints, spec.returnSensor, spec.active, {
            uses: spec.uses,
            color: spec.returnColor,
        });
    }
    /* the cascade card: the stages that run of the stages that are available per mode */
    function drawCascadeCard(x, top, gen) {
        var m = view.m;
        var parts = view.parts;
        var sc = L.smallCard;
        var height = sc.rowsTop + sc.rowsPad + gen.rows.length * sc.rowH;
        card(parts, x, top, sc.w, height, m.labels.cascade);
        gen.rows.forEach(function (row, i) {
            var y = top + sc.rowsTop + i * sc.rowH;
            text(parts, x + 16, y, m.labels[row.mode], 'label');
            var count = text(parts, x + sc.w - 16, y, '–', 'mid', 'end');
            var refresh = function () {
                var running = num(state[row.running]);
                var available = num(state[row.available]);
                count.textContent = `${running === null ? '–' : running} / ${available === null ? '–' : available}`;
            };
            bind(row.running, refresh);
            bind(row.available, refresh);
        });
        return height;
    }
    function drawBoilerCard(x, top, gen) {
        var m = view.m;
        var onOff = function (v) {
            var on = isRunning(v);
            return { text: on ? m.labels.on : m.labels.off, active: on };
        };
        card(view.parts, x, top, L.smallCard.w, L.smallCard.h, m.labels.boiler);
        mixerBadge(view.parts, x + 16, top + 78, 'M111', gen.valve, onOff);
        return L.smallCard.h;
    }
    function drawStoveCard(x, top, gen) {
        card(view.parts, x, top, L.smallCard.w, L.smallCard.h, view.m.labels.stove);
        if (gen.temp) {
            labeled(view.parts, x + 16, top + 54, 'B84', gen.temp, 1, '°C', 'big', 22);
        }
        if (gen.pump) {
            badge(view.parts, x + 130, top + 78, 'M88', gen.pump, false);
        }
        return L.smallCard.h;
    }
    /* further heat generators in a row below the plant (`m.generators`): each is a card with its state, and its pipes join the storage
       or the heat pump pipes while it runs. The boiler's valves M111.1 / M111.2 choose the vessel (no state tells which), so it is drawn
       to the buffer. A cascade takes its colours from the heat pump pipes; a boiler or a stove heats: orange flow, blue return. */
    function drawHeatSources(top, g) {
        var m = view.m;
        var sc = L.smallCard;
        var cards = { cascade: drawCascadeCard, boiler: drawBoilerCard, stove: drawStoveCard };
        var x = L.hp.x;
        var height = sc.h;
        var index = 0;
        m.generators.forEach(function (gen) {
            height = Math.max(height, cards[gen.kind](x, top, gen));
            if (gen.run.length) {
                generatorPipes(
                    g,
                    x + sc.w,
                    top,
                    index++,
                    gen.kind === 'cascade'
                        ? {
                              flowSensor: m.ids.hpFlow,
                              returnSensor: m.ids.hpReturn,
                              uses: ['heat', 'cool'],
                              active: gen.run,
                          }
                        : {
                              flowSensor: gen.run[0],
                              returnSensor: gen.run[0],
                              flowColor: FLOW_COLOR,
                              returnColor: RETURN_COLOR,
                              active: gen.run,
                          },
                );
            }
            x += sc.w + sc.gap;
        });
        return top + height + sc.gap;
    }
    /* the rooms of a plant without heating circuits, in rows of five */
    function drawFreeRooms(top) {
        var m = view.m;
        text(view.parts, L.hp.x, top + 20, m.labels.rooms, 'title');
        var f = L.freeRoom;
        m.rooms.forEach(function (room, i) {
            roomTile(
                view.parts,
                L.hp.x + (i % f.columns) * f.stride,
                top + f.headH + Math.floor(i / f.columns) * f.rowH,
                f.w,
                room,
            );
        });
        return top + f.headH + Math.ceil(m.rooms.length / f.columns) * f.rowH + 16;
    }
    /* energy tiles (photovoltaics, battery, surplus, house, heat pump) centred below everything; they are not tied to the heat pump */
    function drawEnergyTiles(top, maxRight) {
        var m = view.m;
        var ids = m.ids;
        var battery = ids.pvBatteryPower
            ? { label: m.labels.battery, id: ids.pvBatteryPower, decimals: 2, unit: 'kW', sub: ids.pvBattery }
            : { label: m.labels.battery, id: ids.pvBattery, decimals: 0, unit: '%' };
        var tiles = [
            { label: m.labels.pv, id: ids.pvProduction, decimals: 2, unit: 'kW' },
            battery,
            { label: m.labels.surplus, id: ids.pvSurplus, decimals: 2, unit: 'kW' },
            { label: m.labels.house, id: ids.pvHouse, decimals: 2, unit: 'kW' },
            { label: m.labels.heatPump, id: ids.power, decimals: 2, unit: 'kW' },
        ].filter(function (tile) {
            return tile.id;
        });
        var t = L.tile;
        var startX = (maxRight + L.outdoorX - (tiles.length * t.w + (tiles.length - 1) * t.gap)) / 2;
        tiles.forEach(function (tile, i) {
            var x = startX + i * (t.w + t.gap);
            el('rect', { x: x, y: top, width: t.w, height: t.h, rx: 12, class: 'box pvtile' }, view.parts);
            labeled(view.parts, x + 12, top + 22, tile.label, tile.id, tile.decimals, tile.unit, 'value', 26);
            if (tile.sub) {
                value(view.parts, x + t.w - 12, top + 48, tile.sub, 0, '%', 'mid', 'end');
            }
        });
        return top + t.h + 10;
    }

    function render(m) {
        view = createView(m);
        var g = gridOf(m);
        var hp = drawHeatPump(g);
        // the water takes the path of the operating mode: the pipes follow it
        bind(m.ids.hpMode, function (v) {
            view.mode = num(v);
            view.modeIds.forEach(fire);
        });
        growForSolar(g, hp);
        var storage = drawStorage(g);
        var hasTank = storage.any;
        var circuits = drawCircuits(g);
        var bottom = Math.max(
            hp.y + hp.h,
            hasTank ? (g.hung.length ? g.hungBottom + 70 : g.tankBottom + 60) : 0,
            circuits.bottom,
        );
        // the station needs a hot water vessel to take its heat from
        if (m.parts.freshwater && (storage.central || m.hungDhw)) {
            drawStation(g);
        }
        if (m.rods.length && hasTank) {
            drawRod(g);
        }
        if (m.ids.circulation && hasTank && !m.parts.freshwater) {
            drawCirculation(g);
        }
        if (m.parts.solar && hasTank) {
            bottom = Math.max(bottom, drawSolar(g, hp));
        }
        if (m.generators.length) {
            bottom = drawHeatSources(bottom + 24, g);
        }
        bottom = drawSensorCards(bottom + 24);
        if (m.parts.bivalence) {
            bottom = drawBivalence(bottom);
        }
        if (!m.circuits.length && m.rooms.length) {
            bottom = drawFreeRooms(bottom);
        }
        if (m.parts.pv) {
            bottom = drawEnergyTiles(bottom, circuits.maxRight);
        }
        var width = Math.max(L.minWidth, circuits.maxRight + L.originX + L.marginRight);
        svg.setAttribute('viewBox', `0 0 ${width} ${bottom + 20}`);
        svg.style.maxWidth = `${Math.round((width * L.displayScale * m.scale) / 100)}px`;
        applyAll();
        addTagHovers();
    }

    /* A hover with the name of the part on every text that starts with an IDM tag (B38, M73, ...): a transparent area over the text
       carries the tooltip, because the text itself is replaced with every value. */
    function addTagHovers() {
        var names = view.m.tagNames || {};
        var stateWords = [view.m.labels.on, view.m.labels.off].map(function (word) {
            return String(word).toLowerCase().replace(/\.$/, '');
        });
        // a word of a name has four letters or more (two Chinese characters); states ("Aus", "Auf", "Zu") and units are shorter
        var isNameWord = function (word) {
            var plain = word.toLowerCase().replace(/\.$/, '');
            return (
                stateWords.indexOf(plain) < 0 &&
                (plain.length >= 4 || (/[\u4e00-\u9fff]/.test(plain) && plain.length >= 2))
            );
        };
        var hovers = [];
        Array.prototype.forEach.call(svg.querySelectorAll('text'), function (node) {
            var content = node.textContent.trim();
            var match = /^([BM]\d+[a-z]?)\b/.exec(content);
            var name = match && names[match[1]];
            // a text that already names the part ("B37 Air intake temperature") needs no hover
            var rest = content.slice(match ? match[0].length : 0).match(/[^\s\d.,:%°/()+\-–−]+/g) || [];
            if (name && !rest.some(isNameWord)) {
                hovers.push({ node: node, title: `${match[1]} ${name}`, box: node.getBBox() });
            }
        });
        hovers.forEach(function (hover) {
            var box = hover.box;
            var area = el(
                'rect',
                {
                    x: box.x - 2,
                    y: box.y - 2,
                    width: box.width + 4,
                    height: box.height + 4,
                    fill: 'transparent',
                    'pointer-events': 'all',
                },
                hover.node.parentNode,
            );
            el('title', {}, area).textContent = hover.title;
        });
    }

    /* ---------- live values ---------- */

    function applyAll() {
        Object.keys(bindings).forEach(function (id) {
            if (Object.prototype.hasOwnProperty.call(state, id)) {
                fire(id);
            }
        });
        updateStatus();
    }
    // the time formatter of the status line: building one costs more than the status update itself, and states arrive in bursts
    var clock = null;
    function updateStatus() {
        if (!model) {
            return;
        }
        var connected = socketUp && state[model.ids.connection] === true;
        var labels = model.labels;
        document.getElementById('dot').classList.toggle('on', connected);
        if (!clock || clock.language !== model.language) {
            clock = {
                language: model.language,
                format: new Intl.DateTimeFormat(model.language, { timeStyle: 'medium' }),
            };
        }
        document.getElementById('statusText').textContent = `${
            connected ? labels.connected : labels.disconnected
        } · ${labels.updated} ${clock.format.format(new Date())}`;
    }
    /* ---------- data ---------- */

    var snapshot = null; // states, objects, settings and language of the last snapshot
    var rebuildTimer = null;
    var socketUp = false; // the connection to the web adapter; info.connection is the one to the heat pump
    var labelTexts = null;

    /* Work out the plant from the data; draw again only when the plant itself changed, not just a value. */
    function rebuild() {
        rebuildTimer = null;
        if (!snapshot || !labelTexts) {
            return;
        }
        var m = DiagramModel.buildModel({
            language: snapshot.language,
            states: state,
            objects: snapshot.objects,
            labels: labelTexts,
            settings: snapshot.settings,
        });
        var json = JSON.stringify(m);
        if (json !== modelJson) {
            modelJson = json;
            model = m;
            render(m);
        } else {
            // the plant is the same, but a snapshot (a reconnect, an object that was added) brings the values of that moment: show them
            applyAll();
        }
    }
    function scheduleRebuild() {
        if (rebuildTimer === null) {
            rebuildTimer = setTimeout(rebuild, REBUILD_DELAY_MS);
        }
    }
    /* does the state say anything about the plant? A cascade that answers 0 stages is a single unit, like no answer at all. */
    function reports(id, value) {
        if (value === undefined || value === null) {
            return false;
        }
        return id.indexOf('cascade.cascade_available_') !== 0 || Number(value) > 0;
    }
    function onState(id, value, before) {
        // the data layer has stored the new value already, so it hands over the old one
        var appeared = reports(id, before) !== reports(id, value);
        state[id] = value;
        fire(id);
        updateStatus();
        if (appeared) {
            scheduleRebuild(); // a part of the plant may have started to report
        }
    }

    function parameter(name) {
        return new URLSearchParams(location.search).get(name);
    }
    /* the parameters: instance (default 0) and iob (address of the web adapter, only when the page is not served by it) */
    fetch('labels.json')
        .then(function (r) {
            return r.json();
        })
        .then(function (texts) {
            labelTexts = texts;
            DiagramData.connect(
                { instance: Number(parameter('instance')) || 0, origin: parameter('iob') || '' },
                {
                    onSnapshot: function (data) {
                        snapshot = data;
                        state = data.states;
                        rebuild();
                    },
                    onState: onState,
                    onConnection: function (connected) {
                        socketUp = connected;
                        updateStatus();
                    },
                },
            );
        });
})();
