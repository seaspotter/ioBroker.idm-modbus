/**
 * The state ids behind the IDM tags (`Bxx` sensors, `Mxx` actors) of the plant schemes: Modbus registers first, the web interface
 * (`web.io.*`) where Modbus does not deliver the part. Used by the diagram gallery and the tests, the page itself finds the parts
 * through `www/model.js` (a unit test keeps the add-on ids equal).
 */
export const TAG_STATES: Record<string, string[]> = {
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

/**
 * The state ids behind a tag (also circuit tags: pump M31..M37, mixer M41..M47, flow B51..B57, room B61..B67).
 *
 * @param tag IDM tag such as B38 or M31
 */
export function statesOf(tag: string): string[] {
    if (TAG_STATES[tag]) {
        return TAG_STATES[tag];
    }
    const number = Number(tag.slice(1));
    const kind = tag.charAt(0);
    if (kind === 'M' && ((number >= 31 && number <= 37) || (number >= 41 && number <= 47))) {
        return [`web.io.digital_out.m${number}`];
    }
    if (kind === 'B' && number >= 51 && number <= 57) {
        return [`hc.${'ABCDEFG'[number - 51]}.flow_temp`];
    }
    if (kind === 'B' && number >= 61 && number <= 67) {
        return [`hc.${'ABCDEFG'[number - 61]}.room_temp`];
    }
    return [];
}
