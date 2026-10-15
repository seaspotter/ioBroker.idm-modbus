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
        solarReturn: 'B75',
    };

    /* layout in SVG units: the heat pump on the left, the storage in the middle, the circuits with their rooms on the right */
    var L = {
        originX: 170, // the drawing is shifted right by this much: room for the outdoor value left of the heat pump
        minWidth: 1170,
        displayScale: 1.35, // the page shows the drawing at this size (a larger window does not stretch it further)
        marginRight: 24,
        outdoorX: -150,
        hp: { x: -20, w: 330, minH: 270, rowGap: 50, iconSize: 96 },
        tank: { x: 520, w: 150, top: 80, h: 460, hSolar: 540, radius: 58, levelInset: 56, levelH: 30, pipeInset: 12 },
        // two vessels: the hot water vessel above takes this share of the height, a gap separates it from the heating buffer
        split: { dhwShare: 0.34, gap: 50, branchFeedY: 216, branchReturnY: 230, feedX: 36, returnX: 22, reach: 40 },
        pipeGap: 100, // between hot gas line, flow and return pipe
        circuit: { x: 980, w: 216, h: 170, gap: 28, pipeDy: 40, manifold: 60 },
        room: { w: 114, h: 52, gap: 8 },
        station: { y: 128, w: 124, h: 134, hxW: 70, hxH: 70, gap: 48 }, // gap: from the storage to the station card
        solar: { sensorGap: 40, reserve: 110 }, // reserve: room at the bottom of the tank for the solar coil
        cards: { wrap: 1000, w: 310, gap: 330, rowH: 44 },
        tile: { w: 176, h: 62, gap: 12 },
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
    var tankCount = 0; // one gradient per vessel
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
    /* call `apply(true|false)` whenever one of the states changes; true while any of them is running */
    function whenRunning(ids, apply) {
        var list = [].concat(ids || []).filter(Boolean);
        var refresh = function () {
            apply(
                list.some(function (id) {
                    return isRunning(state[id]);
                }),
            );
        };
        list.forEach(function (id) {
            bind(id, refresh);
        });
    }
    /* like whenRunning, but true only while every group has something running (a mixer that is open AND a pump that runs) */
    function whenAllRunning(groups, apply) {
        var lists = groups.map(function (ids) {
            return [].concat(ids || []).filter(Boolean);
        });
        var refresh = function () {
            apply(
                lists.every(function (list) {
                    return list.some(function (id) {
                        return isRunning(state[id]);
                    });
                }),
            );
        };
        lists.forEach(function (list) {
            list.forEach(function (id) {
                bind(id, refresh);
            });
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
        return view.roleColor[id] || tempColor(v);
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

    function rawPipe(parent, d, color) {
        return el('path', { d: d, class: 'pipe', stroke: color }, parent);
    }
    /* where in the dash pattern a pipe starts, so that a branch continues the dashes of the pipe it joins: the pattern position at
       the joint is the length of the pipe so far, modulo the period */
    function phaseOf(length) {
        return ((length % DASH_PERIOD) + DASH_PERIOD) % DASH_PERIOD;
    }
    /* a pipe coloured by its sensor; it flows while one of the `activeIds` runs */
    function pipe(parent, d, sensorId, activeIds, phase) {
        var p = rawPipe(parent, d, IDLE_COLOR);
        if (phase) {
            p.style.setProperty('--phase', `${phase}px`);
        }
        bind(sensorId, function (v) {
            p.setAttribute('stroke', colorOf(sensorId, v));
        });
        // `{ all: [groupA, groupB] }`: flows only while both groups have something running
        (activeIds && activeIds.all ? whenAllRunning.bind(null, activeIds.all) : whenRunning.bind(null, activeIds))(
            function (running) {
                p.classList.toggle('flowing', running);
            },
        );
        return p;
    }
    /* a pipe made of straight pieces; `points` are [x, y] pairs */
    function line(parent, points, sensorId, activeIds, phase) {
        var d = points
            .map(function (pt, k) {
                return `${(k ? 'L' : 'M') + pt[0]} ${pt[1]}`;
            })
            .join(' ');
        return pipe(parent, d, sensorId, activeIds, phase);
    }
    function hline(parent, x1, x2, y, sensorId, activeIds, phase) {
        return line(
            parent,
            [
                [x1, y],
                [x2, y],
            ],
            sensorId,
            activeIds,
            phase,
        );
    }
    /* a value chip with the IDM tag in front, sitting on a pipe */
    function tagChip(parent, cx, cy, id, tag) {
        var g = el('g', {}, parent);
        var r = el('rect', { x: cx - 52, y: cy - 13, width: 104, height: 26, rx: 13, fill: IDLE_COLOR }, g);
        var t = text(g, cx, cy + 5, tag, 'chiptext', 'middle');
        bind(id, function (v) {
            r.setAttribute('fill', colorOf(id, v));
            t.textContent = `${tag}  ${fmt(v, 1, '°C')}`;
        });
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
    function tank(parent, x, y, w, h, levels, title, reserveBottom) {
        var gradientId = `tank-gradient-${tankCount++}`;
        var grad = el('linearGradient', { id: gradientId, x1: 0, y1: 0, x2: 0, y2: 1 }, el('defs', {}, parent));
        [
            ['0%', '#f28a3a'],
            ['50%', '#f3b266'],
            ['78%', '#9cc3e8'],
            ['100%', '#3f8fdc'],
        ].forEach(function (stop) {
            el('stop', { offset: stop[0], 'stop-color': stop[1] }, grad);
        });
        el(
            'rect',
            { x: x, y: y, width: w, height: h, rx: L.tank.radius, fill: `url(#${gradientId})`, class: 'tank' },
            parent,
        );
        text(parent, x + w / 2, y - 28, title, 'title', 'middle');
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
        var root = el('g', { transform: `translate(${L.originX} 0)` }, svg);
        return {
            m: m,
            roleColor: colorRoles(m),
            /* back to front: pipes, the station card with its storage pipes (above the other pipes, below the tank), parts */
            pipes: el('g', {}, root),
            mid: el('g', {}, root),
            parts: el('g', {}, root),
        };
    }
    /* the rows of pipes that run at fixed heights: the tank is centred, the three heat pump pipes sit around its middle */
    function gridOf(m) {
        var tankH = m.parts.solar ? L.tank.hSolar : L.tank.h;
        var yFlow = L.tank.top + tankH / 2;
        var dhwH = Math.round(tankH * L.split.dhwShare);
        return {
            tankH: tankH,
            tankBottom: L.tank.top + tankH,
            yHgl: yFlow - L.pipeGap,
            yFlow: yFlow,
            yRet: yFlow + L.pipeGap,
            // the two vessels of a separate heating buffer: hot water above, the heating buffer below
            dhwH: dhwH,
            bufTop: L.tank.top + dhwH + L.split.gap,
        };
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
        var h = Math.max(L.hp.minH, 70 + rows.length * L.hp.rowGap + 70);
        var y = g.yFlow - h / 2;
        var textX = x + 142;
        var statusY = y + h - 62;

        card(parts, x, y, L.hp.w, h, m.labels.heatPump);
        dot(parts, x + L.hp.w - 20, y + 22, ids.compressor);
        if (m.heatSource === 'ground') {
            pumpIcon(parts, x + 72, y + 118, L.hp.iconSize, [ids.pumpBrine, ids.pumpSource]);
        } else {
            fan(parts, x + 72, y + 118, L.hp.iconSize, ids.compressor, ids.fanM13);
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
        if (ids.pumpM73) {
            badge(parts, x + 16, statusY, 'M73', ids.pumpM73, true);
        }
        /* the hot gas mixer next to the pump and the fan speed under the fan; both are 0-10 V outputs shown as 0-100 % */
        if (ids.hglMixer) {
            mixerBadge(parts, x + 120, statusY, 'M71', ids.hglMixer, describeVoltage);
        }
        if (ids.fanM13 && m.heatSource !== 'ground') {
            // under the fan it belongs to
            var fanLabel = text(parts, x + 72, y + 118 + L.hp.iconSize / 2 + 16, 'M13 –', 'small', 'middle');
            bind(ids.fanM13, function (v) {
                fanLabel.textContent = `M13 ${percentOfVolts(v)}`;
            });
        }
        /* brine / intermediate circuit pump M16 and heat source / groundwater pump M15 */
        [
            ['M16', ids.pumpBrine],
            ['M15', ids.pumpSource],
        ]
            .filter(function (pump) {
                return pump[1];
            })
            .forEach(function (pump, i) {
                badge(parts, textX, statusY - i * 14, pump[0], pump[1], true);
            });
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
        var levels = [];
        if (m.parts.dhw) {
            levels.push({ id: ids.dhwTop, tag: TAG.dhwTop });
            if (ids.dhwBottom) {
                levels.push({ id: ids.dhwBottom, tag: TAG.dhwBottom });
            }
        }
        if (m.parts.buffer) {
            levels.push({ id: ids.buffer, tag: TAG.buffer });
        }
        var hasTank = levels.length > 0;
        var hpRight = L.hp.x + L.hp.w;
        /* the water moves while the charging pump M73 or the flow sensor B2 says so (the pump runs on after the compressor stops);
           the hot gas line only carries water while its mixer M71 is open and the water moves (without an M71 value it follows the water) */
        var flowRate = sensorByTag(m, TAG.flowRate);
        var water = [ids.pumpM73, flowRate && flowRate.id].filter(Boolean);
        var waterActive = water.length ? water : ids.compressor;
        var pipes = [
            { y: g.yFlow, id: ids.hpFlow, tag: TAG.hpFlow, active: waterActive },
            // the return flows from the storage back to the heat pump
            { y: g.yRet, id: ids.hpReturn, tag: TAG.hpReturn, active: waterActive, back: true },
        ];
        if (hasTank && m.storage === 'separate') {
            var sp = L.split;
            var tankX = L.tank.x;
            var bufH = g.tankBottom - g.bufTop;
            var dhwLevels = levels.filter(function (level) {
                return level.id !== ids.buffer;
            });
            tank(view.parts, tankX, L.tank.top, L.tank.w, g.dhwH, dhwLevels, m.labels.dhw, 0);
            tank(
                view.parts,
                tankX,
                g.bufTop,
                L.tank.w,
                bufH,
                [{ id: ids.buffer, tag: TAG.buffer }],
                m.labels.buffer,
                m.parts.solar ? L.solar.reserve : 0,
            );
            // the hot water vessel is charged by the hot gas line where there is one, else from the heat pump flow (the valve M63
            // chooses the side); its return joins the return pipe
            var feedX = tankX - sp.feedX;
            var returnX = tankX - sp.returnX;
            var reachX = tankX + sp.reach;
            if (!ids.hgl) {
                line(
                    view.pipes,
                    [
                        [feedX, g.yFlow],
                        [feedX, sp.branchFeedY],
                        [reachX, sp.branchFeedY],
                    ],
                    ids.hpFlow,
                    waterActive,
                );
            }
            line(
                view.pipes,
                [
                    [reachX, sp.branchReturnY],
                    [returnX, sp.branchReturnY],
                    [returnX, g.yRet],
                ],
                ids.hpReturn,
                waterActive,
            );
            if (ids.hgl) {
                pipes.unshift({
                    y: g.yHgl,
                    id: ids.hgl,
                    tag: TAG.hgl,
                    active: ids.hglMixer ? { all: [ids.hglMixer, waterActive] } : waterActive,
                });
            }
        } else if (hasTank) {
            var title =
                m.parts.dhw && m.parts.buffer
                    ? `${m.labels.buffer} / ${m.labels.dhw}`
                    : m.parts.dhw
                      ? m.labels.dhw
                      : m.labels.buffer;
            tank(
                view.parts,
                L.tank.x,
                L.tank.top,
                L.tank.w,
                g.tankH,
                levels,
                title,
                m.parts.solar ? L.solar.reserve : 0,
            );
            if (ids.hgl) {
                pipes.unshift({
                    y: g.yHgl,
                    id: ids.hgl,
                    tag: TAG.hgl,
                    active: ids.hglMixer ? { all: [ids.hglMixer, waterActive] } : waterActive,
                });
            }
        }
        var chipX = hasTank ? (hpRight + L.tank.x) / 2 : hpRight + 80;
        pipes.forEach(function (p) {
            if (hasTank) {
                // into a separate vessel the pipe reaches further: the rounded corner of a short vessel is further in
                var tankSide = L.tank.x + (m.storage === 'separate' ? L.split.reach : L.tank.pipeInset);
                // a pipe flows from its first to its last point, so the return is drawn from the storage to the heat pump
                hline(view.pipes, p.back ? tankSide : hpRight, p.back ? hpRight : tankSide, p.y, p.id, p.active);
            }
            tagChip(view.parts, chipX, p.y, p.id, p.tag);
        });
        return hasTank;
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
    function drawCircuits(g, hasTank) {
        var m = view.m;
        var ids = m.ids;
        var parts = view.parts;
        var c = L.circuit;
        var roomsX = c.x + c.w + 12;
        var flowManifold = c.x - c.manifold;
        var returnManifold = c.x - c.manifold - 18;
        var fromX = hasTank ? L.tank.x + L.tank.w - L.tank.pipeInset : L.hp.x + L.hp.w;
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
            hline(view.pipes, flowManifold, c.x, y + c.pipeDy, circuit.flow, running[i], flowPhase);
            hline(view.pipes, c.x, returnManifold, y + returnDy, ids.hpReturn, running[i], returnPhase);
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
            line(
                view.pipes,
                [
                    [fromX, g.yFlow],
                    [flowManifold, g.yFlow],
                    [flowManifold, lastTop + c.pipeDy],
                ],
                ids.hpFlow,
                any,
            );
            line(
                view.pipes,
                [
                    [returnManifold, lastTop + returnDy],
                    [returnManifold, g.yRet],
                    [fromX, g.yRet],
                ],
                ids.hpReturn,
                any,
            );
        }
        return { bottom: m.circuits.length ? next : 0, maxRight: maxRight };
    }

    /* the fresh water station beside the upper part of the storage: one heat exchanger with the storage water on its left (in at
       the top, back at the bottom) and the drinking water on its right (cold inlet below, outlet above leading to the tap) */
    function drawStation() {
        var m = view.m;
        var ids = m.ids;
        var s = L.station;
        var x = L.tank.x + L.tank.w + s.gap;
        var y = s.y;
        var hxX = x + 22;
        var hxY = y + 20;
        var hxRight = hxX + s.hxW;
        var inY = hxY + 16;
        var outY = hxY + s.hxH - 16;
        var tankInside = L.tank.x + L.tank.w - 60; // the storage pipes start where the tank wall is straight
        /* the station runs while the hot water flow switch B1 or the station pump M22 says so (else with the compressor) */
        var active = ids.dhwFlow || ids.pumpM22 ? [ids.dhwFlow, ids.pumpM22] : [ids.compressor];
        var coldEnd = x + s.w + 54;
        var tapX = x + s.w + 90;
        var tapY = inY - 20;

        card(view.mid, x, y, s.w, s.h, null);
        text(view.mid, x + s.w / 2, y + 108, m.labels.freshwater, 'small', 'middle');
        if (ids.pumpM22) {
            badge(view.mid, x + 14, y + 126, 'M22', ids.pumpM22, true);
        }
        hline(view.mid, tankInside, hxX, inY, ids.dhwTop, active);
        hline(view.mid, hxX, tankInside, outY, ids.dhwBottom || ids.buffer, active);
        el('rect', { x: hxX, y: hxY, width: s.hxW, height: s.hxH, rx: 6, class: 'hx' }, view.parts);
        el('path', { d: `M${hxX} ${hxY + s.hxH} L${hxRight} ${hxY}`, class: 'hxline' }, view.parts);

        rawPipe(view.parts, `M${hxRight} ${inY} H${tapX + 2}`, FLOW_COLOR);
        rawPipe(view.parts, `M${coldEnd} ${outY} H${hxRight}`, tempColor(10));
        text(view.parts, coldEnd, outY + 22, m.labels.coldWater, 'small', 'middle');
        faucet(view.parts, tapX, tapY, ids.dhwFlow);
        labeled(view.parts, tapX + 56, tapY + 12, TAG.tap, ids.dhwTap, 1, '°C');
        if (ids.dhwSetpoint) {
            labeled(view.parts, tapX + 56, tapY + 54, m.labels.setpoint, ids.dhwSetpoint, 0, '°C');
        }
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
        var h = others.length ? 126 + others.length * L.solar.sensorGap : 110;
        var y = Math.max(hp.y + hp.h + 24, g.tankBottom - h - 20);
        var flowY = Math.min(y + 36, g.tankBottom - 30);
        var returnY = Math.min(y + 76, g.tankBottom - 24);
        var right = x + L.hp.w;
        var chipX = (right + L.tank.x) / 2;

        card(parts, x, y, L.hp.w, h, m.labels.solar);
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
        hline(view.pipes, right, L.tank.x + 40, flowY, m.ids.solarCollector);
        hline(view.pipes, L.tank.x + 40, right, returnY, (back || {}).id || m.ids.solarCollector);
        if (charge) {
            tagChip(parts, chipX, flowY, charge.id, TAG.solarCharge);
        }
        if (back) {
            tagChip(parts, chipX, returnY, back.id, TAG.solarReturn);
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
        card(view.parts, L.hp.x, top, 220, 100, m.labels.bivalence);
        var t = text(view.parts, L.hp.x + 16, top + 80, '–', 'big');
        bind(m.ids.bivalence, function (v) {
            t.textContent = v === null || v === undefined ? '–' : String(v);
        });
        return top + 120;
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
        var hasTank = drawStorage(g);
        var circuits = drawCircuits(g, hasTank);
        var bottom = Math.max(hp.y + hp.h, hasTank ? g.tankBottom + 60 : 0, circuits.bottom);
        if (m.parts.freshwater && hasTank) {
            drawStation();
        }
        if (m.parts.solar && hasTank) {
            bottom = Math.max(bottom, drawSolar(g, hp));
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
        svg.style.maxWidth = `${Math.round(width * L.displayScale)}px`;
        applyAll();
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
    function updateStatus() {
        if (!model) {
            return;
        }
        var connected = socketUp && state[model.ids.connection] === true;
        var labels = model.labels;
        document.getElementById('dot').classList.toggle('on', connected);
        document.getElementById('statusText').textContent = `${
            connected ? labels.connected : labels.disconnected
        } · ${labels.updated} ${new Date().toLocaleTimeString(model.language)}`;
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
