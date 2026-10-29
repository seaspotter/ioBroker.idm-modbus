# Register-Dateien nav10 und nav17 (Schritt 10)

Stand: 2026-10-10. Beide Familien sind **nur nach dem IDM-Dokument erstellt und an keinem Gerät geprüft** (`verified: doc`, kein `device`).
Erst Gerätescans anderer Nutzer können das ändern. Das einzige Testgerät des Projekts ist ein Navigator 2.0.

## nav10 (IDM 812663 Rev.0, NAV10_20.23-903, 18.06.2025)

Quelle: `tools/sources/nav10.source.json` (`extends: nav20`, nur die Unterschiede), geprüft gegen `nav10.pdf-index.json` (584 Adressen).

Gegenüber `nav20`:

- **Räume:** 6 statt 8 Räume je Zonenmodul, kein Raum 9 (`axisTo: r = 6`, `zm{z}_room9_relay` entfällt); Zonenmodule 1–10 bleiben.
- **Entfällt:** 4126 `thermal_power_flow_sensor`, 4128 `total_heat_energy` (nicht im Dokument).
- **Neu (33):** 88 PV-Zielwert, 90 Smart Grid Status, Wärmesenke 1068–1074, Grundwasser 1086/1088, Störungen 1680–1683, Booster A/B 4001–4052 (neuer Block „Booster“ in der Anlagenkonfiguration), Leistungsbegrenzung 4108/4112, 4124 Gesamtleistung (Smartfox).
- **1110 Umschaltventil Heizkreis (M61):** das nav10-Dokument benennt die Werte (0 = Heizen, 1 = Kühlen), das nav20-Dokument nur den Bereich 0–1; die Werte stehen deshalb nur in `nav10` (Override), nav20 bleibt wie es am Gerät verifiziert wurde.
- **Anders:** 1006 ist „Variabler Eingang“ (0–3, Funktionen statt Smart-Grid-Zuständen); 1090 Wert 0 heißt „Standby“; Pumpenstatus 1104–1109 Bereich 0–100 (Standard −1); Bivalenzpunkte 1120–1123 und 1226–1231 Bereich −40…40 (Standardwerte −5/−20); 1714/1715 Bereich 0–100 %, Standard −1; 1048 in €/MWh.
- **Nicht umgesetzt:** nichts aus dem Dokument. Schreibbare Register (z. B. 4108/4112) bekommen keine Schreibfreigabe in der Steuerung (Gruppe `energy`).
- **Zu prüfen (ohne Gerät):** ob 1716–1722 weiterhin −1 als „kein Wert“ melden (im nav10-Dokument ohne Standardwert), ob die Statistik ohne 4126 auskommt (sie nutzt 1790 nicht).
- **Zu prüfen: 1072 Durchfluss Wärmesenke (B2):** das Dokument nennt UCHAR; Xerolux (idm-heatpump-api 2.14.4, Diskussion #516 seines Integrationsprojekts) hat an zwei Anlagen gemessen, dass die Steuerung hier eine FLOAT32 mit vertauschten Wörtern liefert (wie 1068/1070; Anlagen ohne Plattenwärmetauscher antworten −1,0). Gerätemessung gewinnt gegen das Dokument, aber wir haben kein Navigator-10-Gerät: `nav10` bleibt bei UCHAR (`doc`), bis ein Tester 1072 beidseitig gelesen hat. Bis dahin kann der Wert springen oder zu hoch sein.
- **Sentinel 255 bei 1124/1856:** Xerolux behandelt 255 als „nicht vorhanden“ (Anlage ohne Bivalenz/Solar). Bei uns liegt 255 außerhalb des Bereichs (max 3) und wird als ungültig behandelt (Zustand ohne Wert, `diag.invalid`, nur Debug-Log); die Blöcke sind ohnehin nur aktiv, wenn die Anlage sie hat. Keine Änderung nötig.

## nav17 (IDM 812049 Rev.1, Parameterliste vom 13.06.2016, ab N1.7v)

Quelle: `tools/sources/nav17.source.json`, eigenständig, geprüft gegen `nav17.pdf-index.json` (147 Adressen, ohne Spulen).
Das Dokument beschreibt eine **andere Registerfamilie** als nav20/nav10 (andere Adressen und Bedeutungen), die Adressen gehören je zu einer Funktion:
Eingangsregister (FC04) ab 1000 und 1500, Halteregister (FC03/06) ab 2000.

- **IDs** folgen Xerolux (`idm-heatpump-api`, MIT), wo er die Familie abdeckt; seine Zuordnung der 1.7-Adressen stimmt mit dem Dokument überein.
- **Alle RW-Register sind EEPROM-empfindlich** (Hinweis im Dokument: 300 000 Schreibzyklen je Register, gleiche Werte werden nicht geschrieben); daher `eeprom: true` für alle, also gilt das Mindestintervall der Steuerung.
- **`lowByte`:** Statusbytes der Eingangsregister kommen laut Xerolux (idm-heatpump-hass #364, N1.MLj) in beiden Bytes des Worts (1 als `0x0101`). Der Adapter liest dort das niedrige Byte; `0xFFFF` bleibt „nicht verfügbar“.
- **2152 Frischwasser-Solltemperatur:** im Dokument FLOAT (2 Register); Xerolux bestätigt am Gerät (Float, niedriges Wort zuerst).
- **PV-Ergänzung (community):** 74/76/78/82 und 4122 stehen nicht im 2016er Dokument; Xerolux nimmt sie auf, wenn die Firmware sie beantwortet (Probe auf 74). Hier als `verified: community` und mit Hinweis `pv-supplement-post-2016`.
- **Dokument-Unstimmigkeiten:** 1503 heißt im PDF „Status Heizkreis A“ (gemeint HK B, „kein Heizkreis B bei Navigator 1.7“); die HEX-Spalte hat Tippfehler (z. B. 5D5 statt 5E5), die Dezimaladressen sind maßgeblich.
- **Nicht umgesetzt:** die Spulen 3000–3003 (FC01/05: Störung quittieren, Anforderungen Heizen/Kühlen/Vorrangladung). Der Adapter hat keine Spulen-Unterstützung; Xerolux beschreibt sie als flüchtige Befehlsbits (nur 3000 und 3003 sinnvoll).
- **Statistik:** ohne 4126 (nur Momentanleistung 1072 `thermal_power_total` und Mengen 1078/1082); `energy_dhw` und `energy_defrost` gibt es nicht.
- **Keine Zonenmodule** in dieser Familie.
