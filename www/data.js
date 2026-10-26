/* Data of the heat pump diagram: reads the objects and states of one adapter instance through the socket of the web adapter and
   reports every change. Read only: it only subscribes and never writes. */
(function (root) {
    'use strict';

    var ADAPTER = 'idm-modbus';
    /* an id that sorts after every id with the prefix (the way ioBroker lists the ids of a range) */
    var RANGE_END = '香';
    var OBJECT_REFRESH_MS = 5000;
    /* a request without an answer after this long failed (a connection that is half dead never answers, and never says so) */
    var ASK_TIMEOUT_MS = 15000;
    /* all states are compared with the server this often, so that a missed update cannot stay missed */
    var RESYNC_MS = 60000;
    /* after this many failed re-syncs in a row the connection is opened again */
    var RESYNC_FAILURES = 2;
    /* a failed load after a connect is tried again after this long */
    var RETRY_MS = 5000;

    function loadScript(url) {
        return new Promise(function (resolve, reject) {
            var script = document.createElement('script');
            script.src = url;
            script.onload = resolve;
            script.onerror = function () {
                reject(new Error(`Cannot load ${url}`));
            };
            document.head.appendChild(script);
        });
    }

    /* The web adapter serves one of two client libraries under /socket.io/socket.io.js: the socket.io client (a function) or the
       shim of its pure WebSocket mode (an object with connect). */
    function openSocket(origin) {
        var options = { path: '/socket.io', transports: ['websocket', 'polling'], reconnection: true };
        var io = root.io;
        return typeof io === 'function' ? io(origin || undefined, options) : io.connect(origin || '/', options);
    }

    function parseSettings(text) {
        try {
            return typeof text === 'string' ? JSON.parse(text) : {};
        } catch {
            return {};
        }
    }

    function ask(socket, command) {
        var args = Array.prototype.slice.call(arguments, 2);
        return new Promise(function (resolve, reject) {
            var timer = setTimeout(function () {
                reject(new Error(`No answer to ${command}`));
            }, ASK_TIMEOUT_MS);
            args.push(function (error, result) {
                clearTimeout(timer);
                if (error) {
                    reject(new Error(String(error)));
                } else {
                    resolve(result);
                }
            });
            socket.emit.apply(socket, [command].concat(args));
        });
    }

    /**
     * Connect and keep the data current.
     *
     * @param options `instance` (instance number) and `origin` (address of the web adapter when the page is not served by it)
     * @param handlers `onSnapshot({ states, objects, settings, language })` after every (re)connect and when the objects changed,
     *   `onState(id, value, before)` for every change (`before` is the value it replaces), `onConnection(connected, message)`
     */
    function connect(options, handlers) {
        var origin = options.origin || '';
        var prefix = `${ADAPTER}.${options.instance}.`;
        var relative = function (id) {
            return id.indexOf(prefix) === 0 ? id.slice(prefix.length) : null;
        };
        var socket = null;
        var states = {};
        var objects = {};
        var settings = {};
        var language = (navigator.language || 'en').slice(0, 2);
        var refreshAt = 0;
        var failures = 0;
        var retryTimer = null;
        var resyncTimer = null;

        function loadObjects() {
            var range = { startkey: prefix, endkey: prefix + RANGE_END };
            return Promise.all(
                ['state', 'channel'].map(function (type) {
                    return ask(socket, 'getObjectView', 'system', type, range);
                }),
            ).then(function (views) {
                objects = {};
                views.forEach(function (view) {
                    ((view && view.rows) || []).forEach(function (row) {
                        var id = relative(row.id);
                        if (id) {
                            objects[id] = row.value;
                        }
                    });
                });
            });
        }
        function loadAll() {
            return Promise.all([
                loadObjects(),
                ask(socket, 'getStates', `${prefix}*`).then(function (all) {
                    states = {};
                    Object.keys(all || {}).forEach(function (id) {
                        var rel = relative(id);
                        if (rel) {
                            states[rel] = all[id] ? all[id].val : null;
                        }
                    });
                }),
                ask(socket, 'getObject', 'system.config')
                    .then(function (config) {
                        language = (config && config.common && config.common.language) || language;
                    })
                    .catch(function () {
                        /* the browser language stays */
                    }),
                ask(socket, 'getState', `${prefix}diagram.settings`)
                    .then(function (state) {
                        settings = parseSettings(state && state.val);
                    })
                    .catch(function () {
                        settings = {};
                    }),
            ]).then(function () {
                handlers.onSnapshot({ states: states, objects: objects, settings: settings, language: language });
            });
        }
        /* a state that is not in the object tree yet: the adapter created it, so look at the objects again (not too often) */
        function refreshObjects() {
            var now = Date.now();
            if (now < refreshAt) {
                return;
            }
            refreshAt = now + OBJECT_REFRESH_MS;
            loadObjects()
                .then(function () {
                    handlers.onSnapshot({ states: states, objects: objects, settings: settings, language: language });
                })
                .catch(function () {
                    /* the next change tries again */
                });
        }

        /* load everything; a load that fails (no answer, an error) is tried again while the socket stays up, otherwise nothing would
           ever fill the page again: the socket itself never reconnects as long as it believes it is connected */
        function load(sock) {
            clearTimeout(retryTimer);
            loadAll()
                .then(function () {
                    handlers.onConnection(true);
                })
                .catch(function (error) {
                    handlers.onConnection(false, error.message);
                    if (sock === socket) {
                        retryTimer = setTimeout(function () {
                            load(sock);
                        }, RETRY_MS);
                    }
                });
        }
        /* compare every state with the server: whatever differs is reported like a change (a missed update is corrected, the objects
           are not loaded again); a connection that does not answer is opened again */
        function resync() {
            if (!socket || socket.connected === false) {
                return; // the socket is reconnecting by itself and loads everything when it is back
            }
            var sock = socket;
            ask(sock, 'getStates', `${prefix}*`)
                .then(function (all) {
                    if (sock !== socket) {
                        return;
                    }
                    if (failures) {
                        failures = 0;
                        handlers.onConnection(true);
                    }
                    Object.keys(all || {}).forEach(function (id) {
                        var rel = relative(id);
                        var value = all[id] ? all[id].val : null;
                        if (rel !== null && rel !== 'diagram.settings' && states[rel] !== value) {
                            var before = states[rel];
                            states[rel] = value;
                            handlers.onState(rel, value, before);
                        }
                    });
                })
                .catch(function (error) {
                    failures++;
                    handlers.onConnection(false, error.message);
                    if (failures >= RESYNC_FAILURES && sock === socket) {
                        open();
                    }
                });
        }
        function bind(sock) {
            sock.on('connect', function () {
                failures = 0;
                // subscribe first: what changes while everything is loaded is not lost
                sock.emit('subscribe', `${prefix}*`);
                load(sock);
            });
            sock.on('disconnect', function () {
                handlers.onConnection(false);
            });
            sock.on('connect_error', function (error) {
                handlers.onConnection(false, error && error.message);
            });
            sock.on('stateChange', function (id, state) {
                var rel = relative(id);
                if (rel === null) {
                    return;
                }
                if (!objects[rel] && rel !== 'info.connection') {
                    refreshObjects();
                }
                var before = states[rel];
                states[rel] = state ? state.val : null;
                if (rel === 'diagram.settings') {
                    settings = parseSettings(states[rel]);
                    handlers.onSnapshot({ states: states, objects: objects, settings: settings, language: language });
                    return;
                }
                handlers.onState(rel, states[rel], before);
            });
        }
        /* open a socket (the old one is closed) */
        function open() {
            failures = 0;
            clearTimeout(retryTimer);
            if (socket) {
                try {
                    socket.close();
                } catch {
                    /* it is going away anyway */
                }
            }
            socket = openSocket(origin);
            bind(socket);
        }

        var start = loadScript(`${origin}/socket.io/socket.io.js`).then(function () {
            open();
            resyncTimer = setInterval(resync, RESYNC_MS);
            // a tab that was in the background wakes up with a connection nobody looked after: look at once
            document.addEventListener('visibilitychange', function () {
                if (document.visibilityState === 'visible') {
                    resync();
                }
            });
        });
        start.catch(function (error) {
            handlers.onConnection(false, error.message);
        });
        return {
            close: function () {
                clearInterval(resyncTimer);
                clearTimeout(retryTimer);
                if (socket) {
                    socket.close();
                }
            },
        };
    }

    root.DiagramData = { connect: connect };
})(this);
