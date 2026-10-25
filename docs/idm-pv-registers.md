# PV values the IDM Navigator 2.0 expects over Modbus

Registers and units: IDM Modbus TCP manual for the Navigator 2.0 (812170 Rev. 10), section 4.3. IDM gives **no sign convention**; the signs below were confirmed on a Navigator 2.0 whose values are written by an external energy manager (Navigator panel "Photovoltaik" and the GLT table compared, power balance checked).

| Register | Value to write                                  | Unit                    | Sign / meaning                                                                                                                                                                                                                                                                             |
| -------- | ----------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **74**   | PV surplus                                      | kW                      | Positive = power available for the heat pump. The heat pump starts when 74 is higher than its own power consumption (register 4122, read only). Calculate it as **PV production − house consumption − battery charging power**. A slightly negative value (for example −0.01) is accepted. |
| 76       | Power of the electric heating rod               | kW                      | Optional; 0 or not written.                                                                                                                                                                                                                                                                |
| **78**   | PV production                                   | kW                      | Always positive.                                                                                                                                                                                                                                                                           |
| **82**   | House consumption                               | kW                      | Positive, **including the heat pump**. The Navigator subtracts the heat pump's own consumption itself for its panel (written 3.8 kW = house 0.52 kW + heat pump 3.2 kW).                                                                                                                   |
| **84**   | Battery power ("Batterieentladung" = discharge) | kW                      | **Positive = discharging, negative = charging.**                                                                                                                                                                                                                                           |
| **86**   | Battery state of charge                         | % (whole number, 0–100) | Do not write it without a battery; the default −1 means "not available".                                                                                                                                                                                                                   |

## Rules

- The Navigator takes the values cyclically; a change acts after about 15 seconds. Rewrite the values regularly (every 30 s is a good interval).
- Only register 74 is essential; 76 to 86 are optional extras.
- The PV menu on the Navigator must be set up (signal type), otherwise the values are not used.
- The surplus (74) is compared with the heat pump's power consumption (4122). Read 4122 to see what the heat pump needs.

## What the Navigator does when values stop arriving

IDM does not document a timeout. A tester reports that the Navigator is sensitive to missing values and wants every configured value again in every cycle, even when it is 0 or unchanged. The Home Assistant integration of Xerolux writes all mapped values every 3 seconds (a mitigation for a report of a battery display that went blank between writes, which it explicitly does not claim as a proven rule) and on every source change. It skips invalid sources and writes no zero as a fallback, so as not to overwrite values of another energy manager. This adapter writes every configured register every cycle (30 s by default), and for a source that is missing or too old it writes 0 (battery level -1) instead of going silent.

## Not documented by IDM

- Sign conventions, ranges and minimum or maximum values for any of these registers.
- Whether 74 may be negative (it is accepted and shown on the device above; whether it changes the control is unknown).
- Whether the heating rod register 76 is used by the control.

## Check on the device

The Navigator's GLT table lists registers 74 to 86 with two columns: "Value" (what the Navigator uses now) and "GLT Value" (the last value written over Modbus). Compare them with your source values to verify sign and scale.
