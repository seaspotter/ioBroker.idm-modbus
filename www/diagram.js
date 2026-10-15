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
    // in cooling operation the cold water has the blue used for cold water everywhere else
    var COOL_COLOR = RETURN_COLOR;
    // value of the operating mode register while the heat pump cools
    var COOLING_MODE = 2;
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
        hp: { x: -100, w: 330, minH: 270, rowGap: 50, iconSize: 96 },
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
        station: { y: 128, w: 124, h: 134, hxW: 70, hxH: 70, gap: 48, circulationExtra: 40, circulationGap: 74 }, // gap: from the storage to the station card
        solar: { sensorGap: 40, reserve: 110 }, // reserve: room at the bottom of the tank for the solar coil
        cards: { wrap: 1000, w: 310, gap: 330, rowH: 44 },
        tile: { w: 176, h: 62, gap: 12 },
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
       a cold storage the heat pump cools straight through the circuits). Without a mode value both heating and hot water count. */
    function pathOn(path) {
        if (path === 'solar') {
            // the solar loop works while its charge pipe is clearly warmer than its return (set by drawSolar; without both sensors always)
            return view.solarOn ? view.solarOn() : true;
        }
        var mode = view.mode;
        if (mode === null) {
            return path !== 'cool';
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
            text(parent, x + 16, y + 28, title, 'title');
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
        return { text: t || '–', active: t !== '' && !/^(aus|off|0|-)$/i.test(t) };
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
       names the paths that use it: heat, dhw, cool), and light dashes that move along it while it runs (`activeIds`, see activityOf).
       The colour comes from the sensor `sensorId` unless `fixedColor` is given. */
    function pipe(parent, d, sensorId, activeIds, phase, uses, fixedColor) {
        el('path', { d: d, class: 'pipe-base' }, parent === view.pipes ? view.pipesBase : parent);
        var color = el('path', { d: d, class: 'pipe-color' }, parent);
        var light = el('path', { d: d, class: 'pipe-light' }, parent);
        if (phase) {
            light.style.setProperty('--phase', `${phase}px`);
        }
        var activity = activityOf(activeIds);
        var running = false;
        // what is on the screen, so that a temperature update that changes nothing writes nothing
        var shown = null;
        var flowing = null;
        var stroke = null;
        var update = function () {
            var on = inUse(uses);
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
    function line(parent, points, sensorId, activeIds, phase, uses, fixedColor) {
        var d = points
            .map(function (pt, k) {
                return `${(k ? 'L' : 'M') + pt[0]} ${pt[1]}`;
            })
            .join(' ');
        return pipe(parent, d, sensorId, activeIds, phase, uses, fixedColor);
    }
    function hline(parent, x1, x2, y, sensorId, activeIds, phase, uses, fixedColor) {
        return line(
            parent,
            [
                [x1, y],
                [x2, y],
            ],
            sensorId,
            activeIds,
            phase,
            uses,
            fixedColor,
        );
    }
    function vline(parent, x, y1, y2, sensorId, activeIds, phase, uses, fixedColor) {
        return line(
            parent,
            [
                [x, y1],
                [x, y2],
            ],
            sensorId,
            activeIds,
            phase,
            uses,
            fixedColor,
        );
    }
    /* a value chip with the IDM tag in front, sitting on a pipe */
    function tagChip(parent, cx, cy, id, tag, uses) {
        var g = el('g', {}, parent);
        var r = el('rect', { x: cx - 52, y: cy - 13, width: 104, height: 26, rx: 13, fill: IDLE_COLOR }, g);
        var t = text(g, cx, cy + 5, tag, 'chiptext', 'middle');
        // grey while the pipe it sits on rests
        var refresh = function () {
            r.setAttribute('fill', inUse(uses) ? colorOf(id, state[id]) : IDLE_COLOR);
        };
        bind(id, function (v) {
            refresh();
            t.textContent = `${tag}  ${fmt(v, 1, '°C')}`;
        });
        view.modeIds.add(id);
        return refresh;
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
        for (var i = 0; i < 3; i++) {
            el(
                'path',
                {
                    d: 'M0 0 C 8 -10 22 -34 6 -44 C -9 -34 -10 -12 0 0 Z',
                    fill: 'var(--accent)',
                    transform: `rotate(${i * 120}) scale(${size / 110})`,
                },
                blades,
            );
        }
        el('circle', { r: 4, fill: 'var(--muted)' }, g);
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
    /* the heat pump box: icon, power, COP, heat source sensors, pump status and operating mode; the outdoor value stands left of it */
    function drawHeatPump(g) {
        var m = view.m;
        var ids = m.ids;
        var parts = view.parts;
        var rows = heatPumpRows(m);
        var x = L.hp.x;
        // the status badges (charging pump, hot gas mixer, brine and source pumps) sit in a row of three, then wrap
        var status = [];
        if (ids.pumpM73) {
            status.push({ tag: 'M73', id: ids.pumpM73, mixer: false });
        }
        if (ids.hglMixer) {
            status.push({ tag: 'M71', id: ids.hglMixer, mixer: true });
        }
        [
            ['M16', ids.pumpBrine],
            ['M15', ids.pumpSource],
        ].forEach(function (pump) {
            if (pump[1]) {
                status.push({ tag: pump[0], id: pump[1], mixer: false });
            }
        });
        var extraRows = Math.max(0, Math.ceil(status.length / 3) - 1);
        var h = Math.max(L.hp.minH, 70 + rows.length * L.hp.rowGap + 70 + extraRows * 20);
        var y = g.yFlow - h / 2;
        var textX = x + 142;
        var statusY = y + h - 62 - extraRows * 20;

        card(parts, x, y, L.hp.w, h, m.labels.heatPump);
        compressorIds().forEach(function (id, i) {
            dot(parts, x + L.hp.w - 20 - i * 16, y + 22, id);
        });
        if (m.heatSource === 'ground') {
            pumpIcon(parts, x + 72, y + 118, L.hp.iconSize, [ids.pumpBrine, ids.pumpSource]);
        } else {
            fan(parts, x + 72, y + 118, L.hp.iconSize, compressorIds(), ids.fanM13);
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
                L.hp.w - 142 - 12,
            );
        });
        status.forEach(function (item, k) {
            var bx = x + 16 + (k % 3) * 104;
            var by = statusY + Math.floor(k / 3) * 20;
            if (item.mixer) {
                // the hot gas mixer is a 0-10 V output shown as 0-100 %
                mixerBadge(parts, bx, by, item.tag, item.id, describeVoltage);
            } else {
                badge(parts, bx, by, item.tag, item.id, true);
            }
        });
        if (ids.fanM13 && m.heatSource !== 'ground') {
            // under the fan it belongs to
            var fanLabel = text(parts, x + 72, y + 118 + L.hp.iconSize / 2 + 16, 'M13 –', 'small', 'middle');
            bind(ids.fanM13, function (v) {
                fanLabel.textContent = `M13 ${percentOfVolts(v)}`;
            });
        }
        if (ids.hpMode) {
            el('rect', { x: x + 16, y: y + h - 48, width: L.hp.w - 32, height: 34, rx: 17, class: 'pill' }, parts);
            var mode = text(parts, x + L.hp.w / 2, y + h - 26, '', 'pilltext', 'middle');
            bind(ids.hpMode, function (v) {
                mode.textContent = m.hpModes[String(v)] || '';
            });
        }
        if (ids.outdoor) {
            labeled(parts, L.outdoorX, y + 100, `${TAG.outdoor} ${m.labels.outdoor}`, ids.outdoor, 1, '°C', 'big', 30);
        }
        return { y: y, h: h };
    }

    /* the storage with its sensor levels and the three pipes (hot gas line, flow, return) to the heat pump; false without sensors */
    function drawStorage(g) {
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
        var hpRight = L.hp.x + L.hp.w;
        var wall = tankWallLeft();
        /* the water moves while the charging pump M73 or the flow sensor B2 says so (the pump runs on after the compressor stops);
           the hot gas line only carries water while its mixer M71 is open and the water moves (without an M71 value it follows the water) */
        var flowRate = sensorByTag(m, TAG.flowRate);
        var water = [ids.pumpM73, flowRate && flowRate.id].filter(Boolean);
        var waterActive = water.length ? water : compressorIds();
        var hglActive = ids.hglMixer ? { all: [ids.hglMixer, waterActive] } : waterActive;
        var coldStorage = !!hungOf(g.hung, 'cold');
        // the paths that take the water of the heat pump: the heating buffer (and, without a cold storage, cooling through it) or, with
        // no heating buffer, the pipes straight to the circuits; the hot water vessel and the cold storage on their own paths
        var endUses = coldStorage ? ['heat'] : ['heat', 'cool'];
        var usesOf = function (vessel) {
            return vessel.kind === 'dhw' ? ['dhw'] : ['cool'];
        };
        // the vessels that hang below: charged by pipes that drop down left of the tanks and enter the side of the vessel, the feed at
        // the height of the upper sensor and the return at the lower one; the return is the outer pipe, so none crosses another, and
        // every further vessel takes the lane to the left of the one above
        var lanes = g.hung.map(function (vessel, i) {
            return {
                vessel: vessel,
                feedX: tankX - sp.feedX - i * sp.lane,
                returnX: tankX - sp.returnX - i * sp.lane,
                uses: usesOf(vessel),
                // the hot water vessel is charged by the hot gas line where there is one and no heating buffer takes it
                byHgl: vessel.kind === 'dhw' && ids.hgl && !central,
            };
        });
        // the pipes from the heat pump are drawn in pieces between the lanes: a piece carries water for every vessel beyond it
        var rows = function (y, id, laneKey, backward) {
            var firstUses = endUses;
            var far = lanes.slice().reverse(); // the farthest lane (the lowest vessel) is met first
            var xs = [hpRight].concat(
                far.map(function (lane) {
                    return lane[laneKey];
                }),
            );
            var last = central ? wall : lanes.length ? lanes[0][laneKey] : hpRight;
            xs.push(last);
            for (var k = 0; k < xs.length - 1; k++) {
                if (xs[k + 1] === xs[k]) {
                    continue;
                }
                // the piece serves the vessels beyond it (the lanes from the k-th on) and the end of the row
                var uses = Array.from(
                    new Set(
                        [].concat.apply(
                            endUses,
                            far.slice(k).map(function (lane) {
                                // a vessel on the hot gas line takes nothing from the flow pipe
                                return lane.byHgl && !backward ? [] : lane.uses;
                            }),
                        ),
                    ),
                );
                var from = xs[k];
                var to = xs[k + 1];
                hline(view.pipes, backward ? to : from, backward ? from : to, y, id, waterActive, undefined, uses);
                if (k === 0) {
                    firstUses = uses;
                }
            }
            return firstUses;
        };
        var flowChipUses = endUses;
        var returnChipUses = endUses;
        if (central || lanes.length) {
            flowChipUses = rows(g.yFlow, ids.hpFlow, 'feedX', false);
            returnChipUses = rows(g.yRet, ids.hpReturn, 'returnX', true);
            if (ids.hgl && central) {
                hline(view.pipes, hpRight, wall, g.yHgl, ids.hgl, hglActive, undefined, ['heat', 'dhw']);
            }
        }
        if (central) {
            var title =
                m.parts.dhw && !m.hungDhw && m.parts.buffer
                    ? `${m.labels.buffer} / ${m.labels.dhw}`
                    : m.parts.dhw && !m.hungDhw
                      ? m.labels.dhw
                      : m.labels.buffer;
            tank(
                view.parts,
                tankX,
                L.tank.top,
                L.tank.w,
                g.tankH,
                centralLevels,
                title,
                m.parts.solar ? L.solar.reserve : 0,
            );
        }
        lanes.forEach(function (lane) {
            var vessel = lane.vessel;
            var isDhw = vessel.kind === 'dhw';
            tank(
                view.parts,
                tankX,
                vessel.top,
                L.tank.w,
                vessel.h,
                isDhw ? dhwLevels : [{ id: ids.coldBuffer, tag: TAG.coldStorage }],
                isDhw ? m.labels.dhw : m.labels.coldStorage,
                isDhw && !central && m.parts.solar ? L.solar.reserve : 0,
                true,
                !isDhw,
            );
            var feedY = vessel.top + L.tank.levelInset;
            var returnY = vessel.bottom - L.tank.levelInset;
            // the hot water vessel is charged by the hot gas line where there is one and no heating buffer takes it
            var byHgl = lane.byHgl;
            var sourceY = byHgl ? g.yHgl : g.yFlow;
            line(
                view.pipes,
                (byHgl ? [[hpRight, sourceY]] : []).concat([
                    [lane.feedX, sourceY],
                    [lane.feedX, feedY],
                    [wall, feedY],
                ]),
                byHgl ? ids.hgl : ids.hpFlow,
                byHgl ? hglActive : waterActive,
                undefined,
                lane.uses,
            );
            line(
                view.pipes,
                [
                    [wall, returnY],
                    [lane.returnX, returnY],
                    [lane.returnX, g.yRet],
                ],
                ids.hpReturn,
                waterActive,
                undefined,
                lane.uses,
            );
        });
        var farthest = lanes.length ? lanes[lanes.length - 1].feedX : tankX;
        var chipX = central || lanes.length ? (hpRight + farthest) / 2 : hpRight + 80;
        var chipPipes = [
            { y: g.yFlow, id: ids.hpFlow, tag: TAG.hpFlow, uses: flowChipUses },
            { y: g.yRet, id: ids.hpReturn, tag: TAG.hpReturn, uses: returnChipUses },
        ];
        if (ids.hgl && (central || lanes.length)) {
            chipPipes.unshift({ y: g.yHgl, id: ids.hgl, tag: TAG.hgl, uses: central ? ['heat', 'dhw'] : ['dhw'] });
        }
        chipPipes.forEach(function (p) {
            tagChip(view.parts, chipX, p.y, p.id, p.tag, p.uses);
        });
        // where the pipes to the circuits start: at the heating buffer, else where the straight pipes leave the lanes
        view.storage = {
            central: central,
            flowX: central ? wall : lanes.length ? lanes[0].feedX : hpRight,
            returnX: central ? wall : lanes.length ? lanes[0].returnX : hpRight,
            cold: hungOf(g.hung, 'cold'),
            // a heating buffer keeps feeding the circuits while the heat pump charges the hot water vessel
            trunkUses: central ? endUses.concat(['dhw']) : endUses,
        };
        return { central: central, any: central || lanes.length > 0 };
    }

    /* the rooms next to each heating circuit (model.js assigns them from the zone modules and the settings) */
    function roomsOfCircuits(m) {
        return m.circuits.map(function (c) {
            return m.rooms.filter(function (room) {
                return room.circuit === c.letter;
            });
        });
    }
    /* the heating circuits, one block each: the card with its rooms (two columns) beside it, a branch of flow and return pipe,
       and the trunk from the storage that flows while any circuit runs */
    function drawCircuits(g) {
        var m = view.m;
        var ids = m.ids;
        var parts = view.parts;
        // beside a separate hot water vessel the station and its tap need the space left of the circuits: three or more circuits move
        // right so that their cards do not run into the tap
        var shift = m.hungDhw && m.circuits.length >= 3 ? L.split.circuitShift : 0;
        var c = Object.assign({}, L.circuit, { x: L.circuit.x + shift });
        var roomsX = c.x + c.w + 12;
        var flowManifold = c.x - c.manifold;
        var returnManifold = c.x - c.manifold - 18;
        var fromX = view.storage.flowX;
        var fromReturnX = view.storage.returnX;
        var cold = view.storage.cold;
        var trunkUses = view.storage.trunkUses;
        // the circuits are fed by the heating buffer (heating and hot water) or by the cold storage (cooling); without a heating buffer the
        // pipes come straight from the heat pump, which cannot feed them while it charges the hot water vessel
        var circuitUses = view.storage.central ? ['heat', 'dhw', 'cool'] : ['heat', 'cool'];
        var wallRight = tankWallRight();
        var returnDy = c.pipeDy + (g.yRet - g.yFlow); // return pipe, from the top of a circuit block
        var roomsOf = roomsOfCircuits(m);
        /* a circuit runs while its mode says so or its pump runs (M31 for circuit A, M32 for B, ...) */
        var running = m.circuits.map(function (circuit) {
            return circuit.pump ? [circuit.active, circuit.pump] : [circuit.active];
        });
        var tops = [];
        var next = g.yFlow - c.pipeDy;
        m.circuits.forEach(function (circuit, i) {
            tops.push(next);
            var roomRows = Math.ceil(roomsOf[i].length / 2);
            next += Math.max(c.h, roomRows * (L.room.h + L.room.gap) - L.room.gap) + c.gap;
        });
        var maxRight = c.x + c.w;

        m.circuits.forEach(function (circuit, i) {
            var y = tops[i];
            // the branches continue the dashes of the trunk they join (the trunk runs from the storage and, for the return, ends there)
            var flowPhase = phaseOf(flowManifold - fromX + (y + c.pipeDy - g.yFlow));
            var returnPhase = phaseOf(tops[tops.length - 1] - y - (c.x - returnManifold));
            hline(
                view.pipes,
                flowManifold,
                c.x,
                y + c.pipeDy,
                circuit.flow || ids.hpFlow,
                running[i],
                flowPhase,
                circuitUses,
            );
            hline(view.pipes, c.x, returnManifold, y + returnDy, ids.hpReturn, running[i], returnPhase, circuitUses);
            card(parts, c.x, y, c.w, c.h, circuit.name);
            dot(parts, c.x + c.w - 18, y + 22, running[i]);
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
            roomsOf[i].forEach(function (room, k) {
                var rx = roomsX + (k % 2) * (L.room.w + L.room.gap);
                roomTile(parts, rx, y + Math.floor(k / 2) * (L.room.h + L.room.gap), L.room.w, room);
                maxRight = Math.max(maxRight, rx + L.room.w);
            });
        });
        if (m.circuits.length) {
            var any = [].concat.apply([], running);
            var lastTop = tops[tops.length - 1];
            var flowBottom = lastTop + c.pipeDy;
            var returnBottom = lastTop + returnDy;
            // the pipes from the heat pump or the heating buffer (heating, and cooling where there is no cold storage) ...
            hline(view.pipes, fromX, flowManifold, g.yFlow, ids.hpFlow, any, undefined, trunkUses);
            hline(view.pipes, returnManifold, fromReturnX, g.yRet, ids.hpReturn, any, undefined, trunkUses);
            // ... and, where there is one, from the cold storage (cooling): its pipes join the manifolds on the right of the vessels
            var flowEnd = cold ? Math.max(flowBottom, cold.bottom - L.tank.levelInset) : flowBottom;
            var returnEnd = cold ? Math.max(returnBottom, cold.top + L.tank.levelInset) : returnBottom;
            vline(view.pipes, flowManifold, g.yFlow, flowBottom, ids.hpFlow, any, undefined, circuitUses);
            vline(view.pipes, returnManifold, returnBottom, g.yRet, ids.hpReturn, any, undefined, circuitUses);
            if (cold) {
                var coldFlowY = cold.bottom - L.tank.levelInset;
                var coldReturnY = cold.top + L.tank.levelInset;
                if (flowEnd > flowBottom) {
                    vline(view.pipes, flowManifold, flowBottom, flowEnd, ids.hpFlow, any, undefined, ['cool']);
                }
                if (returnEnd > returnBottom) {
                    vline(view.pipes, returnManifold, returnEnd, returnBottom, ids.hpReturn, any, undefined, ['cool']);
                }
                hline(view.pipes, wallRight, flowManifold, coldFlowY, ids.hpFlow, any, undefined, ['cool']);
                hline(view.pipes, returnManifold, wallRight, coldReturnY, ids.hpReturn, any, undefined, ['cool']);
            }
        }
        return { bottom: m.circuits.length ? next : 0, maxRight: maxRight };
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
        var hxX = x + 22;
        var hxY = y + 20;
        var hxRight = hxX + s.hxW;
        var inY = hxY + 16;
        var outY = hxY + s.hxH - 16;
        var tankInside = L.tank.x + L.tank.w - 60; // the storage pipes start where the tank wall is straight
        /* the station runs while the hot water flow switch B1 or the station pump M22 says so (else with the compressor) */
        var active = ids.dhwFlow || ids.pumpM22 ? [ids.dhwFlow, ids.pumpM22] : compressorIds();
        // the card is wider by the circulation pump badge beside the station pump
        var w = s.w + (ids.circulation ? s.circulationExtra : 0);
        var coldEnd = x + w + 54;
        var tapX = x + w + 90;
        var tapY = inY - 20;

        card(view.mid, x, y, w, s.h, null);
        text(view.mid, x + w / 2, y + 108, m.labels.freshwater, 'small', 'middle');
        if (ids.pumpM22) {
            badge(view.mid, x + 14, y + 126, 'M22', ids.pumpM22, true);
        }
        if (ids.circulation) {
            badge(view.mid, x + 14 + (ids.pumpM22 ? s.circulationGap : 0), y + 126, 'M64', ids.circulation, false);
        }
        // hot in, back cooler, also where the vessel has no sensors
        hline(view.mid, tankInside, hxX, inY, ids.dhwTop, active, undefined, undefined, FLOW_COLOR);
        hline(view.mid, hxX, tankInside, outY, ids.dhwBottom || ids.buffer, active, undefined, undefined, RETURN_COLOR);
        el('rect', { x: hxX, y: hxY, width: s.hxW, height: s.hxH, rx: 6, class: 'hx' }, view.parts);
        el('path', { d: `M${hxX} ${hxY + s.hxH} L${hxRight} ${hxY}`, class: 'hxline' }, view.parts);

        // the drinking water runs through the heat exchanger as soon as the station works: cold in, hot out to the tap
        pipe(view.parts, `M${hxRight} ${inY} H${tapX + 2}`, null, active, undefined, undefined, FLOW_COLOR);
        pipe(view.parts, `M${coldEnd} ${outY} H${hxRight}`, null, active, undefined, undefined, tempColor(10));

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
        var pillW = 46;
        var gap = 8;
        var total = count * pillW + (count - 1) * gap;
        var cx = L.tank.x + L.tank.w / 2;
        var y = m.hungDhw && !m.centralTank ? g.dhwBottom + 56 : g.tankBottom + 22;
        text(parts, cx, y, m.labels.rod, 'small', 'middle');
        m.rods.forEach(function (stage, i) {
            var x = cx - total / 2 + i * (pillW + gap);
            var pill = el('rect', { x: x, y: y + 8, width: pillW, height: 22, rx: 11, class: 'level' }, parts);
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
        // where the solar pumps report, they say whether the loop runs; else the loop works while its charge pipe is clearly warmer
        // than its return
        var loop = solarPumps.length
            ? activityOf(
                  solarPumps.map(function (pump) {
                      return pump[1];
                  }),
              )
            : charge && back
              ? {
                    fn: function () {
                        var hot = num(state[charge.id]);
                        var cold = num(state[back.id]);
                        return hot !== null && cold !== null && hot - cold >= SOLAR_MIN_DIFF;
                    },
                    ids: [charge.id, back.id],
                }
              : undefined;
        view.solarOn = loop ? loop.fn : null;
        hline(view.pipes, right, L.tank.x + 40, flowY, m.ids.solarCollector, loop, undefined, ['solar']);
        hline(view.pipes, L.tank.x + 40, right, returnY, (back || {}).id || m.ids.solarCollector, loop, undefined, [
            'solar',
        ]);
        var refreshCharge = charge ? tagChip(parts, chipX, flowY, charge.id, TAG.solarCharge, ['solar']) : null;
        var refreshBack = back ? tagChip(parts, chipX, returnY, back.id, TAG.solarReturn, ['solar']) : null;
        if (charge && back) {
            bind(back.id, refreshCharge);
            bind(charge.id, refreshBack);
        }
        /* the heat exchanger coil inside the storage, between the flow and the return pipe */
        var left = L.tank.x + 30;
        var rightEdge = L.tank.x + L.tank.w - 32;
        var step = (returnY - flowY) / 3;
        el(
            'path',
            {
                d: `M${left} ${flowY} H${rightEdge} V${flowY + step} H${left} V${flowY + 2 * step} H${rightEdge} V${returnY} H${left}`,
                class: 'coil',
            },
            parts,
        );
        return y + h + 20;
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
        var flowX =
            L.tank.x -
            L.split.returnX -
            Math.max(g.hung.length, 1) * L.split.lane -
            gen.riserInset -
            index * gen.riserStep;
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
        line(view.pipes, flowPoints, spec.flowSensor, spec.active, undefined, spec.uses, spec.flowColor);
        line(view.pipes, returnPoints, spec.returnSensor, spec.active, undefined, spec.uses, spec.returnColor);
    }
    /* the cascade: the stages that run of the stages that are available per mode. The members' own sensors are not exposed, so the card
       shows counts; its pipes join the heat pump's and run while any stage runs. */
    function drawCascade(x, top, g, index) {
        var m = view.m;
        var parts = view.parts;
        var sc = L.smallCard;
        var rows = m.cascade.rows;
        card(parts, x, top, sc.w, sc.rowsTop + sc.rowsPad + rows.length * sc.rowH, m.labels.cascade);
        rows.forEach(function (row, i) {
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
        generatorPipes(g, x + sc.w, top, index, {
            flowSensor: m.ids.hpFlow,
            returnSensor: m.ids.hpReturn,
            uses: ['heat', 'cool'],
            active: rows.map(function (row) {
                return row.running;
            }),
        });
        return sc.rowsTop + sc.rowsPad + rows.length * sc.rowH;
    }
    /* further heat generators in a row below the plant: a cascade, an oil / gas boiler with its priority valve M111 and a tiled stove with
       its pump M88 and sensor B84, as cards with their state. The boiler's valves M111.1 / M111.2 choose the vessel (no state tells
       which), so it is drawn to the buffer. The pipes run while the pump or valve runs. */
    function drawHeatSources(top, g) {
        var m = view.m;
        var ids = m.ids;
        var parts = view.parts;
        var sc = L.smallCard;
        var x = L.hp.x;
        var height = sc.h;
        var index = 0;
        var onOff = function (v) {
            var on = isRunning(v);
            return { text: on ? m.labels.on : m.labels.off, active: on };
        };
        // a boiler or a stove heats: orange flow, blue return, running while its pump or valve runs
        var heats = function (runId) {
            return {
                flowSensor: runId,
                returnSensor: runId,
                flowColor: FLOW_COLOR,
                returnColor: RETURN_COLOR,
                active: runId,
            };
        };
        if (m.cascade) {
            height = Math.max(height, drawCascade(x, top, g, index++));
            x += sc.w + sc.gap;
        }
        if (m.heatSources.boiler) {
            card(parts, x, top, sc.w, sc.h, m.labels.boiler);
            mixerBadge(parts, x + 16, top + 78, 'M111', ids.boilerValve, onOff);
            generatorPipes(g, x + sc.w, top, index++, heats(ids.boilerValve));
            x += sc.w + sc.gap;
        }
        if (m.heatSources.stove) {
            card(parts, x, top, sc.w, sc.h, m.labels.stove);
            if (ids.stoveTemp) {
                labeled(parts, x + 16, top + 54, 'B84', ids.stoveTemp, 1, '°C', 'big', 22);
            }
            if (ids.stovePump) {
                badge(parts, x + 130, top + 78, 'M88', ids.stovePump, false);
                generatorPipes(g, x + sc.w, top, index++, heats(ids.stovePump));
            }
        }
        return top + height + sc.gap;
    }
    /* the rooms of a plant without heating circuits, in rows of five */
    function drawFreeRooms(top) {
        var m = view.m;
        text(view.parts, L.hp.x, top + 20, m.labels.rooms, 'title');
        m.rooms.forEach(function (room, i) {
            roomTile(view.parts, L.hp.x + (i % 5) * 192, top + 36 + Math.floor(i / 5) * 64, 180, room);
        });
        return top + 36 + Math.ceil(m.rooms.length / 5) * 64 + 16;
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
        if (m.cascade || m.heatSources.boiler || m.heatSources.stove) {
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
            document.title = m.labels.title;
            document.getElementById('title').textContent = m.labels.title;
            document.documentElement.lang = m.language;
            render(m);
        } else {
            updateStatus();
        }
    }
    function scheduleRebuild() {
        if (rebuildTimer === null) {
            rebuildTimer = setTimeout(rebuild, REBUILD_DELAY_MS);
        }
    }
    function onState(id, value, before) {
        // the data layer has stored the new value already, so it hands over the old one
        var appeared = (before === undefined || before === null) !== (value === undefined || value === null);
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
