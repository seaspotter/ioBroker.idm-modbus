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
    // in cooling operation the cold stretch of flow and return has the blue used for cold water everywhere else
    var COOL_FLOW_COLOR = RETURN_COLOR;
    var COOL_RETURN_COLOR = RETURN_COLOR;
    // value of the operating mode register while the heat pump cools
    var COOLING_MODE = 2;

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
        originX: 170, // the drawing is shifted right by this much: room for the outdoor value left of the heat pump
        minWidth: 1170,
        displayScale: 1.35, // the page shows the drawing at this size, times the size setting (a larger window does not stretch it further)
        marginRight: 24,
        outdoorX: -150,
        hp: { x: -20, w: 330, minH: 270, rowGap: 50, iconSize: 96 },
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
    function colorOf(id, v, isChip) {
        var cool = view.cooling && view.coolRole[id];
        if (cool) {
            // 'flow' / 'return': cold; 'idle-flow' / 'idle-return': the pipe beyond the cold storage's branch rests, but the chip on the
            // stretch shared with the cold storage stays cold
            var cold = cool.replace('idle-', '');
            if (cool.indexOf('idle-') === 0 && !isChip) {
                return IDLE_COLOR;
            }
            return cold === 'flow' ? COOL_FLOW_COLOR : COOL_RETURN_COLOR;
        }
        return view.roleColor[id] || tempColor(v);
    }
    /* the pipes whose colour changes with cooling: the heat pump flow and the flow of the circuits, and the return */
    function coolRoles(m) {
        var roles = {};
        // with a cold storage only the pipes to it are cold: the heating buffer and the circuits rest while the heat pump cools;
        // without one the heat pump cools through the circuits, so the flow is cold
        var flow = m.ids.coldBuffer ? 'idle-flow' : 'flow';
        var back = m.ids.coldBuffer ? 'idle-return' : 'return';
        [m.ids.hpFlow]
            .concat(
                m.circuits.map(function (c) {
                    return c.flow;
                }),
            )
            .forEach(function (id) {
                if (id) {
                    roles[id] = flow;
                }
            });
        if (m.ids.hpReturn) {
            roles[m.ids.hpReturn] = back;
        }
        return roles;
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
    function pipe(parent, d, sensorId, activeIds, phase, only) {
        var p = rawPipe(parent, d, IDLE_COLOR);
        if (phase) {
            p.style.setProperty('--phase', `${phase}px`);
        }
        // `only`: a pipe that carries water in cooling operation only (the cold storage) or in heating operation only (the hot water
        // vessel: the heat pump cannot charge it while it cools); outside its operation it rests grey
        var inUse = function () {
            if (only !== 'overlay' && view.cooling && String(view.coolRole[sensorId]).indexOf('idle-') === 0) {
                return false;
            }
            return String(only).indexOf('cooling') === 0 || only === 'overlay'
                ? view.cooling
                : only === 'heating'
                  ? !view.cooling
                  : true;
        };
        bind(sensorId, function (v) {
            // the pipes of the cold storage have the cold colours of flow and return
            var cold = only === 'cooling-flow' ? COOL_FLOW_COLOR : only === 'cooling-return' ? COOL_RETURN_COLOR : null;
            p.setAttribute('stroke', inUse() ? cold || colorOf(sensorId, v, only === 'overlay') : IDLE_COLOR);
            // an overlay is only there in cooling operation: it paints the shared stretch of the heat pump pipes cold
            if (only === 'overlay') {
                p.style.display = inUse() ? '' : 'none';
            }
        });
        // `{ all: [groupA, groupB] }`: flows only while both groups have something running
        (activeIds && activeIds.all ? whenAllRunning.bind(null, activeIds.all) : whenRunning.bind(null, activeIds))(
            function (running) {
                p.classList.toggle('flowing', running && inUse());
            },
        );
        if (only || view.coolRole[sensorId]) {
            view.modeIds.push(sensorId);
            []
                .concat(activeIds && activeIds.all ? [].concat.apply([], activeIds.all) : activeIds || [])
                .forEach(function (id) {
                    view.modeIds.push(id);
                });
        }
        return p;
    }
    /* a pipe made of straight pieces; `points` are [x, y] pairs */
    function line(parent, points, sensorId, activeIds, phase, only) {
        var d = points
            .map(function (pt, k) {
                return `${(k ? 'L' : 'M') + pt[0]} ${pt[1]}`;
            })
            .join(' ');
        return pipe(parent, d, sensorId, activeIds, phase, only);
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
            r.setAttribute('fill', colorOf(id, v, true));
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
        var root = el('g', { transform: `translate(${L.originX} 0)` }, svg);
        return {
            m: m,
            roleColor: colorRoles(m),
            coolRole: coolRoles(m),
            cooling: false,
            // ids whose bindings are run again when the operating mode changes
            modeIds: Object.keys(coolRoles(m)),
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
        var tankBottom = L.tank.top + tankH;
        // the vessels that hang below: the hot water vessel (where it is a vessel of its own) and the cold storage; they start below
        // the heating buffer, or below the pipes that run straight from the heat pump to the circuits where there is none
        var cursor = m.centralTank ? tankBottom + L.split.gapBelow : yFlow + L.pipeGap + L.split.hungGap;
        var hung = [];
        if (m.hungDhw) {
            // taller where a solar coil sits at its bottom
            var dhwH = L.split.dhwH + (!m.centralTank && m.parts.solar ? L.solar.reserve : 0);
            hung.push({ kind: 'dhw', top: cursor, h: dhwH, bottom: cursor + dhwH });
            cursor += dhwH + L.split.stackGap + (m.rods.length ? L.split.rodGap : 0);
        }
        if (m.ids.coldBuffer) {
            hung.push({ kind: 'cold', top: cursor, h: L.split.dhwH, bottom: cursor + L.split.dhwH });
        }
        var dhw = hung.find(function (vessel) {
            return vessel.kind === 'dhw';
        });
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
        var dhw = g.hung.find(function (vessel) {
            return vessel.kind === 'dhw';
        });
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
        /* the water moves while the charging pump M73 or the flow sensor B2 says so (the pump runs on after the compressor stops);
           the hot gas line only carries water while its mixer M71 is open and the water moves (without an M71 value it follows the water) */
        var flowRate = sensorByTag(m, TAG.flowRate);
        var water = [ids.pumpM73, flowRate && flowRate.id].filter(Boolean);
        var waterActive = water.length ? water : ids.compressor;
        view.waterActive = waterActive;
        var hglActive = ids.hglMixer ? { all: [ids.hglMixer, waterActive] } : waterActive;
        var pipes = [
            { y: g.yFlow, id: ids.hpFlow, tag: TAG.hpFlow, active: waterActive },
            // the return flows from the storage back to the heat pump
            { y: g.yRet, id: ids.hpReturn, tag: TAG.hpReturn, active: waterActive, back: true },
        ];
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
        // the vessels that hang below: charged by pipes that drop down left of the tanks and enter the side of the vessel, the feed at
        // the height of the upper sensor and the return at the lower one; the return is the outer pipe, so none crosses another, and
        // every further vessel takes the lane to the left of the one above
        g.hung.forEach(function (vessel, i) {
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
            var feedX = tankX - sp.feedX - i * sp.lane;
            var returnX = tankX - sp.returnX - i * sp.lane;
            if (!isDhw) {
                view.coldLane = { feedX: feedX, returnX: returnX };
            }
            var wall = tankX + L.tank.pipeInset;
            var feedY = vessel.top + L.tank.levelInset;
            var returnY = vessel.bottom - L.tank.levelInset;
            // the hot water vessel is charged by the hot gas line where there is one and no heating buffer takes it
            var byHgl = isDhw && ids.hgl && !central;
            var sourceY = byHgl ? g.yHgl : g.yFlow;
            var flowId = isDhw ? (byHgl ? ids.hgl : ids.hpFlow) : ids.coldBuffer;
            line(
                view.pipes,
                (byHgl ? [[hpRight, sourceY]] : []).concat([
                    [feedX, sourceY],
                    [feedX, feedY],
                    [wall, feedY],
                ]),
                flowId,
                byHgl ? hglActive : waterActive,
                undefined,
                isDhw ? 'heating' : 'cooling-flow',
            );
            line(
                view.pipes,
                [
                    [wall, returnY],
                    [returnX, returnY],
                    [returnX, g.yRet],
                ],
                isDhw ? ids.hpReturn : ids.coldBuffer,
                waterActive,
                undefined,
                isDhw ? 'heating' : 'cooling-return',
            );
        });
        if (ids.hgl && (central || g.hung.length)) {
            pipes.unshift({ y: g.yHgl, id: ids.hgl, tag: TAG.hgl, active: hglActive });
        }
        var chipX = central || g.hung.length ? (hpRight + L.tank.x) / 2 : hpRight + 80;
        pipes.forEach(function (p) {
            // without a heating buffer the pipes to the circuits run straight from the heat pump (the circuits draw them)
            if (central) {
                var tankSide = L.tank.x + L.tank.pipeInset;
                // a pipe flows from its first to its last point, so the return is drawn from the storage to the heat pump
                hline(view.pipes, p.back ? tankSide : hpRight, p.back ? hpRight : tankSide, p.y, p.id, p.active);
            }
            tagChip(view.parts, chipX, p.y, p.id, p.tag);
        });
        return { central: central, any: central || g.hung.length > 0 };
    }

    /* While the heat pump cools, the stretch of its flow and return pipe up to the branch of the cold storage carries cold water; it is
       drawn above everything else (the pipes beyond rest), and only in cooling operation. */
    function drawColdOverlay(g) {
        var lane = view.coldLane;
        if (!lane) {
            return;
        }
        var ids = view.m.ids;
        var hpRight = L.hp.x + L.hp.w;
        [
            {
                id: ids.hpFlow,
                points: [
                    [hpRight, g.yFlow],
                    [lane.feedX, g.yFlow],
                ],
            },
            {
                id: ids.hpReturn,
                points: [
                    [lane.returnX, g.yRet],
                    [hpRight, g.yRet],
                ],
            },
        ].forEach(function (row) {
            // a solid pipe in the colour of the page first: it hides the resting pipe below the dashes of the cold one
            var d = row.points
                .map(function (pt, k) {
                    return `${(k ? 'L' : 'M') + pt[0]} ${pt[1]}`;
                })
                .join(' ');
            var mask = rawPipe(view.pipes, d, 'var(--bg)');
            mask.style.display = 'none';
            bind(ids.coldBuffer, function () {
                mask.style.display = view.cooling ? '' : 'none';
            });
            // coloured like the chips: the flow deep blue, the return cyan
            line(view.pipes, row.points, row.id, view.waterActive, undefined, 'overlay');
        });
        view.modeIds.push(ids.coldBuffer);
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
        // beside a separate hot water vessel the station and its tap need the space left of the circuits: three or more circuits move
        // right so that their cards do not run into the tap
        var shift = m.hungDhw && m.circuits.length >= 3 ? L.split.circuitShift : 0;
        var c = Object.assign({}, L.circuit, { x: L.circuit.x + shift });
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
        var active = ids.dhwFlow || ids.pumpM22 ? [ids.dhwFlow, ids.pumpM22] : [ids.compressor];
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
            circulationBadge(view.mid, x + 14 + (ids.pumpM22 ? s.circulationGap : 0), y + 126);
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
    /* the hot water circulation pump M64: a pump badge whose tooltip names it */
    function circulationBadge(parent, x, y) {
        badge(parent, x, y, 'M64', view.m.ids.circulation, false);
    }
    /* without a fresh water station (an AQA tank) the circulation pump stands beside the hot water part on its own */
    function drawCirculation(g) {
        var m = view.m;
        var x = L.tank.x + L.tank.w + L.station.gap;
        var y = (m.hungDhw ? g.dhwTop + 20 : L.station.y) + 40;
        text(view.parts, x + 14, y - 22, m.labels.circulation, 'small');
        circulationBadge(view.parts, x + 14, y);
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
        // while the heat pump cools, the flow carries cold water: the colours follow the mode
        bind(m.ids.hpMode, function (v) {
            view.cooling = num(v) === COOLING_MODE;
            [].concat(view.modeIds).forEach(fire);
        });
        growForSolar(g, hp);
        var storage = drawStorage(g);
        var hasTank = storage.any;
        var circuits = drawCircuits(g, storage.central);
        drawColdOverlay(g);
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
        Array.prototype.forEach.call(svg.querySelectorAll('text'), function (node) {
            var text = node.textContent.trim();
            var match = /^([BM]\d+[a-z]?)\b/.exec(text);
            var name = match && names[match[1]];
            // a text that already names the part ("B37 Air intake temperature") needs no hover
            var rest = text.slice(match ? match[0].length : 0).match(/[^\s\d.,:%°/()+\-–−]+/g) || [];
            if (!name || rest.some(isNameWord)) {
                return;
            }
            var box = node.getBBox();
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
                node.parentNode,
            );
            el('title', {}, area).textContent = `${match[1]} ${name}`;
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
