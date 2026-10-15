/*
 * Non-user-configurable constants. User-configurable values (host, port, intervals, ...)
 * live in io-package.json's "native" section / this.config - see adapter-config.d.ts.
 */

/** Register families the adapter knows (see the overview section of docs/SPEC.md). */
export const NAVIGATOR_FAMILIES = ['nav17', 'nav20', 'nav10'] as const;
export type NavigatorFamily = (typeof NAVIGATOR_FAMILIES)[number];

/** FLOAT word order on the wire (spec open point O1, verified at the device in Step 5). */
export const FLOAT_WORD_ORDERS = ['lowFirst', 'highFirst'] as const;
export type FloatWordOrder = (typeof FLOAT_WORD_ORDERS)[number];

/**
 * Node's setTimeout/setInterval accept at most a 32-bit signed delay (2^31 - 1 ms, ~24.8 days) -
 * a larger or invalid value runs immediately/unpredictably instead of after the expected delay.
 * Used to guard user-supplied interval/timeout config values before passing them to a timer.
 */
export const MAX_TIMER_MS = 2147483647;

export const DEFAULT_PORT = 502;
export const DEFAULT_UNIT_ID = 1;
export const DEFAULT_REQUEST_TIMEOUT_MS = 3000;
/** The Navigator stalls under hard polling - never go below this pause between requests. */
export const MIN_REQUEST_PAUSE_MS = 100;
export const DEFAULT_REQUEST_PAUSE_MS = 100;
/** Spec: `fast` polling interval must be at least 10 s. */
export const MIN_FAST_INTERVAL_S = 10;

/** Modbus protocol limits per request (function codes 03/04 read up to 125, FC16 writes up to 123 registers). */
export const MODBUS_MAX_READ_WORDS = 125;
export const MODBUS_MAX_WRITE_WORDS = 123;
/** Spec Modul A: at most 40 words per bundled read request. */
export const BATCH_MAX_WORDS = 40;
/** Reconnect backoff: 5 s, doubling up to 60 s (spec "Fehlerverhalten"). */
export const RECONNECT_INITIAL_MS = 5000;
export const RECONNECT_MAX_MS = 60000;

/** Spec Modul A: polling intervals in seconds (user-configurable except `config`). */
export const DEFAULT_FAST_INTERVAL_S = 30;
export const DEFAULT_MEDIUM_INTERVAL_S = 60;
export const DEFAULT_SLOW_INTERVAL_S = 300;
/** RW parameters (modes, setpoints, curves) are read at start, after writes, then at this interval (user-configurable). */
export const CONFIG_INTERVAL_S = 3600;
/** Lowest allowed interval of the settings group. */
export const MIN_CONFIG_INTERVAL_S = 60;
/** Interval of the diagnostic states (`diag.requestsPerMinute`, `diag.avgResponseMs`). */
export const DIAG_INTERVAL_MS = 60000;
/** At most one log line per register and hour for invalid values (spec "Fehlerbehandlung"). */
export const INVALID_LOG_INTERVAL_MS = 3600000;

/**
 * The Navigator closes a TCP connection that was idle for about 10 s (measured at the test device on 2026-10-10: 10.1 to
 * 12.1 s in five runs, independent of when the connection was opened). The poller therefore sends a small read when
 * nothing was requested for this long, so the connection survives the gaps between cycles.
 */
export const KEEPALIVE_AFTER_MS = 5000;
/** How often the poller checks whether a keepalive is due. */
export const KEEPALIVE_CHECK_MS = 1000;

/** Statistics module (spec Modul G). */
export const DEFAULT_PRICE_PER_KWH = 0.3;
export const DEFAULT_CO2_G_PER_KWH = 350;
export const DEFAULT_EXTERNAL_MAX_AGE_S = 120;
/** The statistics are written to the state `stats.data` this often. */
export const STATS_PERSIST_INTERVAL_MS = 60000;
/** Longest gap between two samples that is still integrated: three poll intervals, at least three minutes. */
export const STATS_MIN_GAP_MS = 180000;

/** Control (spec Modul B). */
export const DEFAULT_EEPROM_MIN_INTERVAL_S = 60;
/** Lowest allowed minimum interval between two writes of one EEPROM register. */
export const MIN_EEPROM_MIN_INTERVAL_S = 10;
export const DEFAULT_DAILY_WRITE_WARN = 24;

/** PV values for the Navigator (spec Modul D): default and minimum write interval, maximum age of a source value. */
export const DEFAULT_PV_INTERVAL_S = 30;
export const MIN_PV_INTERVAL_S = 10;
export const DEFAULT_PV_MAX_AGE_S = 120;
/** Every n-th PV cycle the written registers are read back to detect a second writer (spec Modul D). */
export const PV_READBACK_EVERY = 4;
/** Consecutive read-back mismatches that raise `pv.writer_conflict`. */
export const PV_CONFLICT_AFTER = 3;

/** Room sensor feeding (spec Modul C): defaults of the HASS integration and the spec's proposals. */
export const DEFAULT_ROOM_HEARTBEAT_S = 300;
export const DEFAULT_ROOM_TOLERANCE_C = 0.2;
export const DEFAULT_ROOM_MIN_C = 15;
export const DEFAULT_ROOM_MAX_C = 30;
export const DEFAULT_ROOM_MAX_AGE_S = 900;
/** How often the room module looks at its rows. */
export const ROOM_TICK_MS = 10000;
/** Consecutive read-back differences that raise `rooms.writer_conflict`. */
export const ROOM_CONFLICT_AFTER = 3;

/** Web interface module (spec Modul H): default and minimum poll interval, default port. The Navigator recommends no faster than 30 s. */
export const DEFAULT_WEB_INTERVAL_S = 60;
export const MIN_WEB_INTERVAL_S = 30;
export const DEFAULT_WEB_PORT = 80;
/** The Navigator 10 serves its web interface on a WebSocket on this port. */
export const DEFAULT_NAV10_WEB_PORT = 61220;
export const DEFAULT_WEB_STATISTICS_INTERVAL_S = 900;
export const MIN_WEB_STATISTICS_INTERVAL_S = 300;

/** Hot water boost (spec Modul E): default target temperature and time limit. */
export const DEFAULT_BOOST_TARGET_C = 55;
export const DEFAULT_BOOST_MAX_MINUTES = 60;

/** Parts of the heat pump diagram the user may hide (the page `www/model.js` knows the same names). */
export const DIAGRAM_PARTS = ['buffer', 'dhw', 'freshwater', 'pv', 'solar', 'bivalence'] as const;
/** Zone modules the diagram can place next to a heating circuit (the Navigator has up to ten). */
export const MAX_DIAGRAM_ZONE = 10;
/** The COP rows of the diagram: one that follows the source setting, both (Navigator and external), or none. */
export const DIAGRAM_COP_ROWS = ['source', 'both', 'none'] as const;
/** How the diagram draws heating buffer and hot water: one vessel (Hygienik with stratification plate) or two (a separate TERMO). */
export const DIAGRAM_STORAGE = ['combined', 'separate'] as const;
/** Size of the diagram in percent of the original size: default (a tenth smaller than before) and limits. */
export const DIAGRAM_SCALE = { default: 90, min: 40, max: 200 } as const;
