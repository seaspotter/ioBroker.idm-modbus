# IDM heat pump models, plant schemes and measuring points

Working reference for the adapter (not product text, not part of the npm package). It collects **which IDM heat pump models exist, which
plant schemes ("Anlagenschemen") they are installed in, and which measuring points (`Bxx`) and actors (`Mxx`) such a plant has**, so
that the adapter can later (a) recognise what kind of plant it is talking to and (b) draw the heat pump diagram correctly for it.

Status: **first version, 2026-10-15.** Facts only, in our own words; the IDM documents stay IDM's copyright and are referenced, not
copied (CLAUDE.md rule 8). Where something is inferred and not written in a source, it says so.

## 1. How sure is each statement

Every table carries a column or note with one of these levels:

| Level          | Meaning                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------ |
| **catalog**    | stated in the IDM product catalogue 2025 (current range)                                                           |
| **manual**     | stated or drawn in an IDM installation manual (the manual and its edition are named)                               |
| **modbus/web** | taken from the IDM Modbus documents, the Navigator manual, or the names the Navigator itself delivers (web tables) |
| **device**     | seen on the test device (Navigator Pro, air heat pump with hot gas line)                                           |
| **user list**  | from a model list the project owner compiled from outside sources; not confirmed by an IDM document yet            |
| **inferred**   | our conclusion from patterns in the sources; check before relying on it                                            |

## 2. Sources

| Short name     | What                                                                                                                                                                         | Where                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Catalogue 2025 | IDM product catalogue 2025 (152 pages): current range, technical data, product lines                                                                                         | `partnerportal.myidm.at/documents/download/21070/` (linked from idm-energie.at/idm-produktkatalog) |
| ALM 2-15       | Installation manual AERO ALM 2-15 (Navigator 2.0): schemes `L7.1-…`, terminal plan, sensor equipment                                                                         | third-party mirror (badshop-austria.at), IDM edition with chapter 5.9 "Anlagenschemen"             |
| ALM 10-24      | Installation manual AERO ALM 10-24 (Rev. 6): schemes `L9.1-…`                                                                                                                | third-party mirror (badshop-austria.at; siblik.com IDM193406)                                      |
| SLM            | Installation manual AERO SLM 3-11 / 6-17 (IDM191871, Rev. 7): with and without hot gas line (HGL)                                                                            | siblik.com mirror                                                                                  |
| SWM            | Installation manual TERRA SWM 3-13 / 6-17 (IDM191611, Rev. 5)                                                                                                                | siblik.com mirror                                                                                  |
| SW Twin        | Installation manual TERRA SW 20-42 Twin HGL, Navigator 2.0 (IDM191868)                                                                                                       | siblik.com mirror                                                                                  |
| AL Twin        | Installation manual TERRA AL Twin, Navigator 2.0 (IDM191867)                                                                                                                 | siblik.com mirror                                                                                  |
| iPUMP A / T    | Installation manuals iPump A 2-7 / 3-11 (IDM191152), iPump T 2-8 / 3-13 (IDM181711)                                                                                          | siblik.com mirror                                                                                  |
| SW Complete    | Installation manual TERRA SW 17 HGL Complete, Navigator 2.0 (IDM181712), older generation                                                                                    | siblik.com mirror                                                                                  |
| ALM 2-8 / 4-12 | Installation manual AERO ALM 2-8 / 4-12 (Navigator 2.0): schemes with Hygienik **with** and **without** STP, cooling                                                         | siblik.com mirror (IDM193401u402_411u412)                                                          |
| iPUMP ALM      | Installation manual iPump ALM 2-8 / 4-12 (812606): tank-integrated air unit with mixer circuit, circulation, cooling                                                         | siblik.com mirror (IDM193411u412)                                                                  |
| Hygienik 2.0   | Installation manual HYGIENIK 2.0 with hot water station 2.0 (812156 Rev. 9): sizes, with and without STP, scheme list `S4.x`, `L3.2`, `L4.1`, `L5.1`, `L6.2`                 | siblik.com mirror (wrongly named file)                                                             |
| Hygienik 3.0   | Installation manual HYGIENIK 3.0 with hot water station 3.0 (812409 Rev. 0), chapter 6 "Anlagenschemen", terminal notes (M64, M110 / B110)                                   | siblik.com mirror                                                                                  |
| AQA / station  | AQA 300 / 500 installation manual (812120), fresh water station 2.0 data sheet, external heating circuit module description (812708; 3 mixer circuits, CAN bus, up to 300 m) | siblik.com mirrors                                                                                 |
| SW 50-280 MAX  | TERRA SW 50-280 Max incl. HGL and reversing (P) and SW 50-180 Max H (812122 Rev. 8): large units; **only a Ukrainian translation** of the IDM manual was found               | c-o-k.ru library                                                                                   |
| ILM            | Installation instructions AERO ILM 2-7 / 4-13 and HGL variant, Navigator 2.0 (812583 Rev. 2, English translation): 12 schemes                                                | idm.ua copy                                                                                        |
| ALM 10-50 Max  | Installation manual AERO ALM 10-50 Max, Navigator 2.0 (813954 Rev. 0, Hungarian translation; scheme titles in German): schemes `L10.1-…`                                     | idm-hoszivattyu.hu copy                                                                            |
| AL 60 Max      | Installation manual TERRA AL 60 Max, Navigator 2.0 (812176 Rev. 2.2): cascade of two units, up to 9 circuits, circuits A to G drawn                                          | siblik.com mirror                                                                                  |
| SW H           | Installation manual TERRA SW 10 / 13 / 19 / 22 H high temperature (812608 Rev. 1.1): schemes `S5.x`                                                                          | b2b.ezee-energy.de copy                                                                            |
| (all of them)  | **The manuals listed here are stored locally** in `docs/sources/manuals/` (not committed); the manifest with sources is `docs/sources/manuals/README.md`                     | repo                                                                                               |
| Modbus docs    | IDM Modbus TCP documents for Navigator 2.0 / 10 / 1.7, Navigator 2.0 operating manual (`docs/sources/`)                                                                      | in the repo, see `docs/sources/README.md`                                                          |
| Web tables     | Names of inputs, outputs and sensors that the Navigator's web interface delivers (read by the adapter's web module)                                                          | the test device; the adapter publishes them as `web.io.*`                                          |
| Xerolux        | idm-heatpump-api / idm-heatpump-hass (MIT): model detection by register structure, compatibility notes                                                                       | github.com/Xerolux                                                                                 |

The mirrors are third-party hosts of IDM documents. They were read for facts only and are not copied into the repo. The current
documents of IDM's partner portal may differ in details.

## 3. The model range

### 3.1 Product lines (Catalogue 2025)

| Line       | What it is                                                                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **AERO**   | air-to-water heat pumps. ALM = monobloc outdoor unit plus wall-hung indoor hydraulic module; SLM = split (outdoor unit plus indoor unit with refrigerant lines)                                        |
| **TERRA**  | brine-to-water and water-to-water heat pumps (SWM, SW, SW Twin, SW Max, SW H); also AL Twin / AL Max air units in the TERRA naming of older generations                                                |
| **iPUMP**  | heat pump with integrated hot water tank ("mit integriertem Speicher"): A (air), T (brine), N (NANO flat heat pump)                                                                                    |
| **MAX**    | large heat pumps for projects (AERO ALM 10-50 MAX, AL, TERRA SW MAX / MAX H, BOOSTER)                                                                                                                  |
| **NANO**   | iPUMP N5, flat/apartment heat pump                                                                                                                                                                     |
| Storage    | HYGIENIK 3.0 (combi storage with fresh water station), AQA (DHW storage), TERMO (heating buffer)                                                                                                       |
| Controller | NAVIGATOR (generations 1.0/1.7, 2.0 (with a Pro board option), 10; which generation a model ships with is not stated in the catalogue), optional expansion modules for more heating circuits and zones |

### 3.2 Current range with the catalogue's technical data (level: catalog)

| Family | Model                             | kW (modulating range or rated) | Refrigerant | Heat source / build                                                         | SCOP 35 °C                |
| ------ | --------------------------------- | ------------------------------ | ----------- | --------------------------------------------------------------------------- | ------------------------- |
| AERO   | ALM 2-8                           | 2-8                            | R290        | air, monobloc with indoor hydraulic module                                  | 5.22                      |
| AERO   | ALM 4-12                          | 4-12                           | R290        | as above                                                                    | 5.12                      |
| AERO   | ALM 6-15                          | 6-15                           | R290        | as above                                                                    | 5.56                      |
| AERO   | ALM 10-24                         | 10-24                          | R290        | as above, separating circuit ("Trennkreiskonzept"), active cooling standard | 5.69                      |
| AERO   | SLM 3-11                          | 3-11                           | R410A       | air, split; active cooling standard                                         | 4.50                      |
| AERO   | SLM 6-17                          | 6-17                           | R410A       | air, split                                                                  | 5.25                      |
| TERRA  | SWM 3-13 / SWM 6-17               | 3-13 / 6-17                    | R410A       | brine; active cooling optional on SWM 6-17                                  | 5.51 / 5.84               |
| TERRA  | SW 20 / 26 / 35 / 42 TWIN         | 20 / 26 / 35 / 42              | R410A       | brine, two compressors                                                      | 5.90 / 5.72 / 5.61 / 5.57 |
| TERRA  | SW 13 / 22 TWIN H                 | 13 / 22                        | R134a       | brine, high flow temperature                                                | 4.54 / 4.78               |
| iPUMP  | A8 ONE / A12 ONE                  | 2-8 / 4-12                     | R290        | air, tank integrated                                                        | 5.26 / 5.15               |
| iPUMP  | A 2-7 / A 3-11                    | 2-7 / 3-11                     | R410A       | air, tank integrated                                                        | 5.14 / 4.50               |
| iPUMP  | T7 (no tank) / T7 ONE (with tank) | 2-7                            | R290        | brine                                                                       | 4.85                      |
| iPUMP  | T 3-13                            | 3-13                           | R410A       | brine, tank integrated                                                      | 5.52                      |
| iPUMP  | N5 (NANO)                         | 1-6.5                          | R290        | apartment heat pump                                                         | COP 5.89 (W10/W35)        |
| MAX    | AERO ALM 10-50 MAX                | 10-50                          | R290        | air, two refrigerant circuits                                               | 5.08                      |
| MAX    | AL 50 MAX / AL 32 TWIN            | 50 / 32                        | R410A       | air                                                                         | 4.04 / 4.56               |
| MAX    | TERRA SW 55 / 85 / 110 / 140 MAX  | 55-140                         | R410A       | brine                                                                       | 5.07-4.96                 |
| MAX    | TERRA SW 35 / 50 / 70 / 90 MAX H  | 35-90                          | R134a       | brine, high flow temperature                                                | 4.67-4.95                 |
| MAX    | TERRA SW 50 / 70 / 90 MAX H 513   | 50-90                          | R513A       | brine, high flow temperature, low GWP                                       | 4.51-4.56                 |
| MAX    | BOOSTER 10 / 20                   | 10 / 20                        | R513A       | water-to-water booster for high temperatures (SCOP given at 55 °C)          | 3.88 / 3.75               |

Storage (not heat pumps, but part of every scheme): HYGIENIK 3.0 (500 / 825 / 1000 / 1500 / 2000 l, with stratification plate), AQA 300 / 500 /
750 / 1000, TERMO 100 / 300 / 500 / 800 / 1000 / 1500 / 2000.

### 3.2a Older models documented only by manuals

These are not in the catalogue 2025 (level: **manual**; the figure source is the named installation manual). Refrigerants are the ones printed in the manual.

| Family      | Model                                                              | kW / compressors                                                              | Refrigerant             | Build and notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AERO        | **ILM 2-7** and **ILM 4-13**, plain and **HGL** variant            | 2-7 and 4-13 kW, 1 compressor (rolling piston in the 2-7, scroll in the 4-13) | R410A (3.2 kg / 6.2 kg) | **compact indoor air-to-water unit**: radial fan, air led through wall openings or an air hose (accessory); hydraulics complete inside (loading pump, safety group, expansion vessel, flow switch B14, 6 kW electric heating rod, **priority 3-way valve M63 (plain) or HGL valve (HGL type)**, an installed switching valve for cooling and defrosting, high and low pressure sensors, suction air sensor B37, heat exchanger sensor B72); Navigator 2.0 with 7" display. Rated heating capacity in the manual's data table: 3.9 / 7.1 kW at the first rating point (the heading is unreadable in the translation) |
| TERRA (air) | **AL Twin** (AL 17 / 24 Twin), Twin P with process reversal        | not stated in the manual text                                                 | R410A                   | air unit for outdoor installation; two compressors                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| TERRA (air) | **AL 60 Max**                                                      | 2 compressors per unit; cascade of two units (master / member)                | R410A                   | outdoor air unit, heating only or with a Hygienik without STP; up to 9 circuits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| TERRA       | **SW 17 HGL Complete** (SW 6-17 Complete series)                   | not stated                                                                    | R410A                   | brine unit, HGL variant, older generation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| TERRA       | **SW 10 / 13 / 19 / 22 H**                                         | not stated                                                                    | R134a                   | high-temperature brine units; no hot gas line                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| TERRA       | **SW 50-280 Max** incl. HGL and reversing (P), **SW 50-180 Max H** | several compressors                                                           | R410A                   | large brine units; Ukrainian translation only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| iPUMP       | **A 2-7 / 3-11**                                                   | rolling piston (2-7) / scroll (3-11)                                          | R410A                   | air unit with tank (also in the catalogue 2025)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| iPUMP       | **T 2-8 / 3-13**                                                   | -                                                                             | R410A                   | brine unit with tank                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| iPUMP       | **ALM 2-8 / 4-12**                                                 | -                                                                             | R290                    | same ranges as AERO ALM 2-8 / 4-12 with an integrated tank                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| AERO        | **ALM 10-50 Max**                                                  | 10-50 kW, two refrigerant circuits                                            | R290                    | also in the catalogue 2025                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### 3.2b Storage: Hygienik 2.0 versus 3.0 (and AQA, TERMO)

The Hygienik is a combi storage tank with a plate heat exchanger **hot water station** mounted on it (or on the wall) and, optionally, a
**stratification plate (STP)** that divides the tank into a hot water part above and a heating buffer part below.

|                           | **Hygienik 2.0** (manual 812156 Rev. 9)                                                                                                                   | **Hygienik 3.0** (manual 812409, catalogue 2025)                                                                                                                                                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sizes                     | 500, 825, 1000, 1500, 2000 l, each with station 25 / 35 l/min (500-1000) and 50 / 70 l/min (1000 / 1500 / 2000)                                           | the same sizes; the catalogue lists 500, 825, 1000 (920 l), 1500, 2000                                                                                                                                                                                                                               |
| STP                       | **two versions: with STP (upper part hot water, lower part buffer) or without STP (hot water only)**; manual lists "mit/ohne Schichttrennplatte" per size | **STP installed in the tank** ("combi tank for hot water and heating buffer, or for hot water only"); a few size variants in the data tables carry no STP volumes                                                                                                                                    |
| Volumes above / below STP | 500 l: 325 / 175; 825 l: 405 / 420; 920-1000 l: 500 / 420; 1500 l: 615 / 885; 2000 l: 700 / 1300                                                          | the same figures in the 3.0 manual (825 l also 397 l below the plate in one variant)                                                                                                                                                                                                                 |
| Station                   | 2.0: flow switch in the cold water line; accessory heat meter, UVR 67 controller, circulation module (25 / 35 l/min)                                      | 3.0: flow **sensor** on the water side plus cold water inlet and hot water outlet temperature sensors (**built-in heat quantity metering**); connected to the Navigator **by bus cable only**; optional return layering (valve M110, sensor B110); circulation pump M64 at terminals 20 / 20N / 20PE |
| Mixing valve              | variant with thermal mixing valve (limits heat exchanger inlet temperature; scalding protection)                                                          | the same variant                                                                                                                                                                                                                                                                                     |
| Heat sources              | heat pump, electric heating rod (sleeve), solar via accessory solar station, wood or oil / gas boiler                                                     | the same; a variant with a **smooth tube heat exchanger** takes solar without hydraulic accessories                                                                                                                                                                                                  |
| Tags                      | B38 (heating part, only with STP), B41 / B48 (hot water part), B42 (station), M22 (station pump), B1 (flow) as in the schemes                             | as 2.0; sensor terminal strip on the tank                                                                                                                                                                                                                                                            |

Other storage products: **AQA 300 / 500 / 750 / 1000** (DHW storage, no station), **TERMO 100 to 2000** (heating buffer). Compare the layer-2 rules
in chapter 6a: what the Navigator sees is B38 (a heating buffer exists), B41 / B48 (a DHW volume exists), B42 / M22 / B1 (a station exists); the
2.0 / 3.0 difference and the STP are **not** visible in the tags.

### 3.3 The project owner's model list, checked against the documents

The list below is the owner's compilation of "most probable all variants". Column "Document" says what we could confirm. **Nothing here is
a guarantee that a model exists or is missing from the list.**

| Group               | Entry                                                  | Era (owner)                | Document                                                                                                                                               |
| ------------------- | ------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AERO air            | ALM 2-8, 4-12, 6-15, 10-24, 10-50 MAX                  | current                    | catalog (all five)                                                                                                                                     |
| AERO air            | ALM 8-18                                               | current                    | **not in the catalogue 2025**; user list only                                                                                                          |
| AERO air            | SLM 3-11, 6-17, with and without HGL                   | current                    | catalog; the SLM manual covers HGL and non-HGL variants                                                                                                |
| AERO air            | ILM 2-7, 4-13, with and without HGL                    | older                      | manual: ILM 2-7 / 4-13 and "Additional Model: HGL" (812583 Rev. 2); not in the catalogue 2025                                                          |
| AERO / TERRA air    | AL 32 TWIN, AL 50 MAX                                  | current                    | catalog                                                                                                                                                |
| TERRA air           | AL 17 Twin, AL 24 Twin, AL 60 Max, ML 8-13             | older                      | manuals: AL Twin (one document), AL 60 Max (812176); ML 8-18 appears in the Hygienik 2.0 manual (scheme `L6.2`), "ML 8-13" is the user list's spelling |
| iPUMP               | A8 ONE, A12 ONE                                        | current                    | catalog                                                                                                                                                |
| iPUMP               | ALM 2-8, ALM 4-12 (iPUMP naming)                       | current                    | not as such in the catalogue; the catalogue's A8/A12 ONE have the same kW ranges as ALM 2-8/4-12 and the same sound data (inferred identity)           |
| iPUMP               | A 2-7, A 3-11                                          | older (still in catalogue) | catalog; iPUMP A manual                                                                                                                                |
| iPUMP               | A 2-11                                                 | older                      | user list only                                                                                                                                         |
| iPUMP               | T 2-8, T 2-13                                          | older                      | iPUMP T manual covers "T 2-8 / 3-13"; T 2-13 user list only                                                                                            |
| iPUMP               | T 3-13, T7, T7 ONE, N5 NANO                            | current                    | catalog                                                                                                                                                |
| TERRA brine / water | SWM 3-13 (HGL P), SWM 6-17                             | current                    | catalog; SWM manual has HGL ("HGL P") schemes and non-HGL schemes                                                                                      |
| TERRA brine / water | SW 6 / 8 / 10 / 13 / 17 Complete HGL C                 | older                      | SW Complete manual covers the 17 HGL; the rest user list                                                                                               |
| TERRA brine / water | SW 10 H / 13 H / 19 H / 22 H                           | older                      | manual: "TERRA SW 10/13/19/22 H" (812608 Rev. 1.1); the catalogue has SW 13 / 22 TWIN H (current)                                                      |
| TERRA brine / water | SW 20 / 26 / 35 / 42 Twin; Twin H 13 / 22              | current                    | catalog (the owner's "sizes unconfirmed": 20, 26, 35, 42 are confirmed)                                                                                |
| TERRA brine / water | SW 35 / 50 / 70 / 90 MAX H, SW 55 / 85 / 110 / 140 MAX | current                    | catalog                                                                                                                                                |
| TERRA brine / water | SW 180 MAX H, SW 70 / 170 / 220 / 280 MAX              | older                      | user list only                                                                                                                                         |
| Booster             | BOOSTER 10 / 20                                        | current                    | catalog (10 and 20 kW; the owner's kW values 10.92 / 18.47 are not in the catalogue)                                                                   |

## 4. Reading the plant scheme names

Installation manuals draw each scheme with a title and a code, for example _AERO ALM 2-15 + Hygienik für Heizung und Warmwasser + 1 Heizkreis
(`L7.1-0-1-0-0`)_. Codes seen:

| Code prefix        | Unit (manual)                          | Codes found                                                                         |
| ------------------ | -------------------------------------- | ----------------------------------------------------------------------------------- |
| `L7.1-…`           | AERO ALM 2-15 (ALM 2-8 / 4-12 / 6-15)  | `0-1-0-0`, `0-2-0-0`, `0-4+5-0-0`, `5-1-0-0`, `7-2+5-0-0`, `0-2+6-2-0`, `0-1+7-2-0` |
| `L9.1-…`           | AERO ALM 10-24                         | `1-5-0-7`, `1-2+5-0-2+7`, `1-4+5-0-4-7`, `3-2+5-0-2+7`, `1+7-2+5-…`, `1-5+7-2-7`    |
| `S4.1-…`, `S4.2-…` | TERRA SW Complete (S4.2 = with HGL)    | `0-2-0-0`, `0-1-0-0`, `0-1-1-0`                                                     |
| `S5.1-…`, `S5.3-…` | TERRA SW H / Twin H (high temperature) | `S5.3-0-1-0-2`, `S5.3-0-2+5-0-2`, `S5.1-0-4+5-0-4`                                  |

The Hygienik 2.0 manual's scheme list and the other manuals show that the prefix names the **unit family**, and the number after the dot the variant:

| Prefix  | Unit                                          | Variants seen        |
| ------- | --------------------------------------------- | -------------------- |
| `L3.x`  | AERO ILM (ILM Complete)                       | `.2` = HGL           |
| `L4.1`  | TERRA AL Twin                                 |                      |
| `L5.1`  | TERRA AL 60 Max                               |                      |
| `L6.2`  | TERRA ML 8-18 Complete HGL                    | `.2` = HGL           |
| `L7.1`  | AERO ALM 2-8 / 4-12 / 6-15                    |                      |
| `L9.1`  | AERO ALM 10-24                                |                      |
| `L10.1` | AERO ALM 10-50 Max (`L10.1+10.1` = two units) |                      |
| `S4.x`  | TERRA SW Complete                             | `.1` plain, `.2` HGL |
| `S5.x`  | TERRA SW H / Twin H (`.1` AQA, `.3` Hygienik) |                      |

(`.2` = HGL holds for S4, L3 and L6; the L-prefix covers air units, the S-prefix brine units, with the numbers assigned by IDM in the order the
families were introduced. **Inferred from the titles.**) This means a scheme code, if the user knows it from the installer's documents, identifies the unit family and
variant exactly, which tags alone cannot.

The letter looks like the source type (L = air, S = brine; inferred) and the number after it the unit generation. The digit groups are

One more hint from the S5 and L9 codes (**hypothesis**, from the title texts): the last group names the storage the circulation pump is attached to (`2` Hygienik, `4` AQA; schemes without circulation end in `0`, the L9 codes carry an extra `7`, possibly the separating circuit), and the group before it is cooling (`0` none, `1` passive, `2` active / reversal). This fits all codes seen but is not stated in any document.
**not a single legend** across units: in the ALM 2-15 the first group (`0`, `5`, `7`) distinguishes additional heat generators (none, tiled
stove, solar) and the next the storage (1 = Hygienik for heating and hot water, 2 = Hygienik for hot water only, `4+5` = AQA + TERMO, `+6`,
`+7` = cooling buffer), but the ALM 10-24 codes use the groups differently. We therefore **do not decode the code**; we use the title text
and the tags drawn in the scheme (chapter 7).

All manuals add the same remark: the schemes are non-binding suggestions for the integration of a heat pump into the heating system and do
not replace professional planning; installers deviate. This matters for detection: **a plant is a combination of components, not one of a
fixed list of schemes.**

## 5. Measuring points and actors

`Bxx` = sensor or switch input, `Mxx` = motor/actor (pump, valve, mixer, fan), `Exx` = electrical element. Names are the IDM documents' German
terms with our English wording. "Source" is where the meaning comes from.

### 5.1 Hydraulic module / heat pump core

| Tag                                       | Meaning                                                                                                                                                                                             | Source                                                                                    | Appears in                                                                   |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| B32                                       | outdoor temperature                                                                                                                                                                                 | modbus/web, manual                                                                        | every scheme                                                                 |
| B33                                       | heat pump flow temperature                                                                                                                                                                          | modbus/web, manual                                                                        | every scheme with a hydraulic module (not drawn in some SW Complete schemes) |
| B34                                       | heat pump return temperature                                                                                                                                                                        | modbus/web, manual                                                                        | as B33                                                                       |
| B35                                       | hot gas line (HGL) flow temperature                                                                                                                                                                 | modbus/web                                                                                | HGL units (SLM HGL, SWM HGL, SW Twin HGL, SW Complete HGL)                   |
| M71                                       | hot gas line mixer (analog output, 0-10 V)                                                                                                                                                          | web tables, device                                                                        | HGL units                                                                    |
| M94                                       | pump for domestic hot water heating **during cooling** (hot gas line waste heat use, accessory); the ILM HGL scheme "cooling and HGL usage in one step" draws it with B5 (dew point switch) and B35 | manual (ILM, scheme 6.12)                                                                 | HGL units that cool                                                          |
| M73                                       | charging pump heat pump to storage (variable speed; M73-1 / M73-2 where two pumps are installed)                                                                                                    | modbus/web, manual                                                                        | every scheme with a hydraulic module                                         |
| B2                                        | heating flow rate sensor                                                                                                                                                                            | web tables, manual                                                                        | air units' hydraulic module                                                  |
| M63                                       | changeover valve heating / hot water                                                                                                                                                                | modbus/web, manual                                                                        | schemes with a hot water storage in the heat pump circuit                    |
| B45                                       | charging sensor                                                                                                                                                                                     | modbus/web, manual                                                                        | units with a charge sensor: ALM 10-24, AL Twin                               |
| B14                                       | flow switch ("Strömungswächter")                                                                                                                                                                    | manual (text)                                                                             | AL Twin, ALM 10-24-type separating circuit, SW Twin cooling variants         |
| B124 / B125                               | return sensor (heat sink) and flow sensor of the separating heat exchanger ("Trennwärmetauscher"), led through the immersion sleeves on the brine side                                              | manual (text: ALM 10-24, note on the separating heat exchanger set)                       | ALM 10-24                                                                    |
| M125                                      | drawn next to the separating heat exchanger (with B124) in all ALM 10-24 schemes, PDF pages 38 and 41-46; **no text names it** (probably the pump of the separating / brine circuit, **inferred**)  | manual (drawing only)                                                                     | ALM 10-24                                                                    |
| B110, M110                                | return layering sensor / valve ("Rücklaufeinschichtung") at the hot water station 3.0, accessories                                                                                                  | manual (Hygienik 3.0 terminal notes)                                                      | Hygienik 3.0                                                                 |
| B93, B96, M95, M97, M98, M100, M101, M106 | large units: heat pump inlet sensor (B93), brine return sensor (B96), shut-off valves with servo drives (M95, M97), three-way valves (M100, M101), cooling buffer valve (M106)                      | manual (drawing labels in the Ukrainian translation, meanings from the translated labels) | TERRA SW 50-280 Max; **inferred**, not used by the adapter yet               |
| B47                                       | Hygienik sensor pair "B47 and B48" (hot water storage)                                                                                                                                              | manual (translated text)                                                                  | TERRA SW 50-280 Max                                                          |
| B10, B15                                  | high pressure fault 1, fault of the electric heating rod                                                                                                                                            | web tables                                                                                | seen on the test device                                                      |
| B71, B78, B78v, B79, B86, B86v, B87       | hot gas temperature, evaporation pressure and temperature, evaporator outlet, condensation pressure and temperature, liquid line temperature                                                        | web tables                                                                                | refrigerant circuit 1 (sensors read by the Navigator; no scheme drawing)     |
| E31                                       | siphon heating                                                                                                                                                                                      | web tables                                                                                | air units (condensate drain)                                                 |

### 5.2 Heat source side

| Tag                          | Meaning                                                                                                                                                                                         | Source                                        | Type of unit                                                                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| B37, B46                     | air intake temperature 1 / 2                                                                                                                                                                    | modbus/web                                    | air units                                                                                                                                        |
| B72                          | air heat exchanger temperature                                                                                                                                                                  | modbus/web                                    | air units                                                                                                                                        |
| M13                          | fan speed 1 (analog output, 0-10 V)                                                                                                                                                             | web tables, device                            | air units (see 7.2 for hot gas line)                                                                                                             |
| B36, B43                     | heat source outlet / inlet temperature                                                                                                                                                          | modbus/web, manual                            | brine and water units, iPUMP T                                                                                                                   |
| M16                          | brine / intermediate circuit pump                                                                                                                                                               | modbus/web, manual                            | brine units                                                                                                                                      |
| M15                          | heat source / groundwater pump                                                                                                                                                                  | modbus/web, manual                            | groundwater units, SW Twin, iPUMP T                                                                                                              |
| B31                          | room humidity sensor (dew point)                                                                                                                                                                | modbus/web, manual                            | every scheme with cooling                                                                                                                        |
| B17                          | dew point monitor of an uncontrolled circuit (switch)                                                                                                                                           | manual (text)                                 | iPUMP direct-circuit cooling schemes                                                                                                             |
| M74                          | changeover valve heat source heat / cool                                                                                                                                                        | modbus/web                                    | cooling variants                                                                                                                                 |
| M51                          | four-way valve circuit 1 (process reversal: the refrigerant circuit runs backwards for cooling)                                                                                                 | web tables, device                            | units that cool by reversal (**inferred** from the device; the SLM manual speaks of "heat pumps with process reversal" without naming the valve) |
| B5                           | dew point monitor of heating circuit A (digital input)                                                                                                                                          | web tables, device, manual (SLM cooling note) | cooling in a direct circuit                                                                                                                      |
| M61, M62                     | changeover valves heating circuit and storage heat/cool                                                                                                                                         | modbus/web                                    | cooling variants                                                                                                                                 |
| B40                          | cold storage temperature (or process reversal variant)                                                                                                                                          | modbus/web, manual                            | cooling schemes (cooling buffer)                                                                                                                 |
| B38 as B40                   | **in cooling operation the heat storage sensor B38 is used as the cold storage sensor B40** (iPump ALM manual, cooling schemes): a plant that cools through its buffer may have no separate B40 | manual (text note in the iPump ALM schemes)   | iPUMP ALM; see chapter 6a                                                                                                                        |
| B44, B49, M17, M84, M89, M99 | ISC (active cooling) sensors, pumps and valves                                                                                                                                                  | modbus/web                                    | TERRA SW Twin cooling "without process reversal"                                                                                                 |

### 5.3 Storage, hot water, circulation

| Tag                           | Meaning                                                                                                                        | Source                                                | Appears in                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- | -------------------------------------------------- |
| B38                           | heat storage (buffer) temperature                                                                                              | modbus/web, manual                                    | schemes with a TERMO / heating buffer              |
| B41                           | DHW heater temperature, bottom                                                                                                 | modbus/web, manual                                    | schemes with a DHW storage (Hygienik, AQA)         |
| B48                           | DHW heater temperature, top                                                                                                    | modbus/web, manual                                    | as B41                                             |
| B42                           | hot water tapping / hot water station temperature                                                                              | modbus/web, manual                                    | schemes with a fresh water station on the Hygienik |
| M22                           | fresh water station (digital and analog/% output)                                                                              | web tables, manual                                    | Hygienik with fresh water station                  |
| B1                            | DHW flow switch                                                                                                                | web tables, manual                                    | Hygienik with fresh water station                  |
| M64                           | circulation pump                                                                                                               | modbus/web, manual                                    | schemes with circulation                           |
| M88, B84                      | pump (0-10 V or PWM) and sensor at a tiled stove / solid fuel boiler; the text says only "pump M88 is driven by 0-10 V or PWM" | manual (ALM 2-15 PDF page 49, drawing + one sentence) | ALM 2-15 scheme with Kachelofen (`L7.1-5-1-0-0`)   |
| M111                          | priority valve of an oil/gas boiler                                                                                            | manual (text)                                         | ALM 10-24 with oil/gas boiler (bivalent)           |
| Electric heating rod 1/2/3 kW | internal electric heater stages                                                                                                | web tables                                            | seen on the test device                            |

### 5.4 Solar

| Tag           | Meaning                                                                                                                   | Source                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| B73, B74, B75 | collector, charging, return temperature                                                                                   | modbus/web            |
| B76           | solar heat source reference / pool temperature                                                                            | modbus/web            |
| B77           | drawn in the solar schemes next to B75 / M75 (ALM 2-15 PDF page 50, ALM 10-24 page 44, SWM page 40); **no text names it** | manual (drawing only) | solar schemes |
| M75, M76      | solar pumps                                                                                                               | manual (text)         |
| M78, M79      | changeover valves solar heating / hot water, solar storage / heat source                                                  | modbus/web            |

### 5.5 Heating circuits

Circuit letters run A to G. The numbers follow a fixed sequence; the evidence is the plant drawings (circuits A to D drawn), the Modbus
documents' labels (A) and Xerolux's live check (A, D).

| Circuit | Flow sensor | Room device | Circuit pump | Mixer   | Evidence                                                                                                                              |
| ------- | ----------- | ----------- | ------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| A       | B51         | B61         | M31          | M41     | manual terminal plan (mixer circuit on the central unit); Modbus labels                                                               |
| B       | (B52)       | B62         | M32          | -       | manuals: "HK (B) direct circuit, storage temperature controlled" (a direct circuit has no mixer; the flow sensor B52 is never drawn)  |
| C       | B53         | B63         | M33          | M43     | drawn in the heating circuit expansion box (dashed)                                                                                   |
| D       | B54         | B64         | M34          | M44     | as C                                                                                                                                  |
| E-G     | B55-B57     | B65-B67     | M35-M37      | M45-M47 | **drawn** in the AL 60 Max manual (PDF page 27: circuits C to G on expansion modules; B55 to B57, B65 to B67, M35 to M37, M45 to M47) |

Circuit A's sensors and actors are on the central unit; C to G are on expansion modules ("Heizkreiserweiterungsmodul", up to three further
mixer circuits per module). A, B, C, D are present in the schemes; the Modbus register layout (`hc_a` to `hc_g`) provides seven.

## 6. Plant elements and the tags that identify them

A "plant" for the diagram is the combination of the elements below. The last column is what the adapter can already read today.

| Element / variant                       | Identifying tags                       | Readable now by                                                      |
| --------------------------------------- | -------------------------------------- | -------------------------------------------------------------------- |
| Air heat pump                           | B37 (B46, B72), M13                    | Modbus (B37, B72, B46), web tables (M13)                             |
| Brine / groundwater heat pump           | B36, B43, M16 (M15)                    | Modbus (B36, B43, M15, M16)                                          |
| Hot gas line (HGL) technology           | B35, M71                               | Modbus (B35), web tables (M71)                                       |
| Heat pump with hydraulic module         | B33, B34, B2, M73, M63                 | Modbus (B33, B34, M73, M63), web (B2)                                |
| Heating buffer (TERMO)                  | B38                                    | Modbus (B38)                                                         |
| Hot water storage Hygienik / AQA        | B41, B48 (B42)                         | Modbus (B41, B48, B42)                                               |
| Fresh water station                     | M22, B1, B42                           | web tables (M22, B1), Modbus (B42)                                   |
| Circulation                             | M64                                    | Modbus (M64)                                                         |
| Heating circuits A to G                 | B51..B57 and pumps/mixers              | Modbus (flow and room temperatures), web tables (pumps, mixers of A) |
| Zone modules and rooms                  | zone registers 2000+                   | Modbus                                                               |
| Cooling (active or passive)             | B31, B40, M61, M62, M74                | Modbus (B31, B40, M61, M62, M74)                                     |
| Cooling by process reversal (no buffer) | M51, M61, M62, B5 (B31 / B40 absent)   | Modbus (M61, M62), web tables (M51, B5); seen on the test device     |
| Solar                                   | B73..B76, M75, M76, M78                | Modbus (B73..B76, M78, M79), pumps not exposed by Modbus             |
| ISC (cooling without process reversal)  | B44, B49, M17, M84, M89, M99           | Modbus (all)                                                         |
| Bivalent source (boiler, stove, rod)    | M111, M88, B84, electric heater stages | web tables (stages); the rest not exposed                            |
| PV / battery                            | registers 74-88                        | Modbus (our PV module)                                               |

A register that answers "not available" does not tell whether the hardware is missing or idle; M73 is the standing example (-1 while it is
not driven). Detection therefore has to use **sensors** (always valid when installed) and treat **actor states** as weak evidence.

## 6a. Plant model for detection: layers and rules

The plant is described in layers, each decided on its own from the tags that answer (chapter 6 lists the tags). This is the shape the
adapter's plant detection and the diagram should share. **Rules are hypotheses from the manuals' drawings until devices confirm them**; the
test device (7.3a) is the only confirmation so far, and "ambiguous" marks where tags cannot decide.

Evidence strength: **strong** = a sensor answers with a real value (installed hardware); **weak** = an actor or state that is also valid
when idle or "not driven" (M73 reads -1 while the pump stands).

### Layer 0: controller

| Attribute  | Rule                                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------- |
| generation | Navigator 1.0/1.7, 2.0 or 10 by register structure (strong, exists: `src/lib/detect.ts`)                          |
| Pro board  | not found yet; the manuals mention the Navigator Pro as zone control and for plants where no zone may stay closed |

### Layer 1: the heat pump unit

| Attribute                            | Rule (tags)                                                                                                                                                                                                                         | Strength      | Ambiguity                                                                                                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| heat source                          | B37 (or B46, B72) valid = **air**; B36 and B43 valid = **brine or water**                                                                                                                                                           | strong        | brine versus groundwater: M16 (brine / intermediate circuit pump) = brine, M15 (heat source / groundwater pump) = groundwater (weak: actors)                         |
| hot gas line (HGL)                   | B35 valid (M71 as analog output confirms)                                                                                                                                                                                           | strong        | none seen                                                                                                                                                            |
| compressors                          | `compressor_status_1..4` answer (a Twin or a unit with two refrigerant circuits shows 2)                                                                                                                                            | strong        | a cascade of several units is a different thing (see layer 4)                                                                                                        |
| cooling capability                   | process reversal: M51 four-way valve + M61 / M62; active cooling buffer: B40 (+ B31, M74); ISC variants: B44, B49, M17, M84, M89, M99                                                                                               | strong / weak | M51 is read only from the web tables; B31 may be missing even with cooling; **B40 may not exist even with cooling through a buffer, because B38 serves as B40 then** |
| build (monobloc, split, tank inside) | no direct tag. Hints: the iPUMP has no heat pump hydraulic module and its tank sensors B41 / B48 sit inside the unit; a charging sensor B45 and B124 / B125 point to the ALM 10-24 or the AL Twin; B2 (flow sensor) to the ALM 2-15 | weak          | **not decidable from tags**; ask the user                                                                                                                            |
| size (kW) and model                  | **not available**: the Navigator delivers no model name and no rated power over Modbus. The cascade power registers 1220-1225 are percentages (the test device answers 0 and 100)                                                   | -             | user setting; family and variant can be named, the size not                                                                                                          |

So the unit layer ends at: _air or brine/water, with or without HGL, number of compressors, cooling mode, optionally ISC_. That is
enough to choose the heat pump drawing (fan or source pumps, hot gas line, one or two compressors). The product name (for example
"AERO SLM 3-11 HGL") stays a user entry; the family can be suggested (air + HGL + split-typical tags to SLM or ILM, air + no HGL to ALM,
brine to SWM / SW).

### Layer 2: storage and hot water

Decide in this order; each line only adds to the previous ones.

| Variant                                                            | Tags that answer                                                                    | Notes                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| heating buffer (TERMO type)                                        | B38                                                                                 | a plain buffer; no DHW sensors on it                                                                                                                                                                                                                            |
| DHW storage without fresh water station (AQA type)                 | B41 + B48, no B42 / M22                                                             | hot water from the storage itself                                                                                                                                                                                                                               |
| fresh water station on the storage                                 | B42 (+ M22, B1)                                                                     | M22 digital and analog output, B1 digital input from the web tables                                                                                                                                                                                             |
| Hygienik with stratification plate (STP) for heating and hot water | B38 + B41 + B48 + B42 + M22                                                         | **the test device**. B38 is the heating part of the Hygienik. The same tag set also appears for a Hygienik **without** STP plus a separate TERMO buffer (ALM 2-8 / 4-12 manual: the TERMO carries B38 there), so **STP versus "Hygienik + TERMO" is ambiguous** |
| Hygienik for hot water only (no buffer, direct circuit)            | B42 (+ M22, B1), B41 + B48, **no B38**                                              | ALM 2-8 / 4-12 manual: Hygienik 2.0 without STP serving only hot water; one uncontrolled direct circuit, no cooling, no mixer                                                                                                                                   |
| Hygienik without STP plus TERMO buffer                             | B38 (in the TERMO) + B41 + B48 + B42 (+ B40 for cooling)                            | ALM 2-8 / 4-12 manual: the TERMO is flowed through in heating and cooling and acts as hydraulic separator; same tags as the STP variant                                                                                                                         |
| cooling buffer                                                     | B40 (+ B31 humidity, M61 / M62, M74)                                                | different from reversal cooling, which needs none of these                                                                                                                                                                                                      |
| integrated iPUMP tank                                              | B41 + B48 (older iPUMP A / T), plus B38 in the iPUMP ALM (heating part of the tank) | **ambiguous** with an AQA or a Hygienik; needs the unit family                                                                                                                                                                                                  |

The number of sensors drawn in a scheme can be lower than what the unit delivers (the ALM 2-15 terminal plan ships B38 and B40 in the
Two rules from the ALM 2-8 / 4-12 and iPump ALM manuals sharpen layer 2: **B38 is the heating buffer sensor wherever it physically sits (in the Hygienik with STP, or in a TERMO)**, and **a plant with a Hygienik for hot water only has no B38** (direct circuit, one circuit only, no cooling). So "B38 present" means "a heating buffer volume exists", and "B38 absent while B41 / B48 / B42 exist" means a direct-circuit plant. Whether the buffer is inside the Hygienik (STP) or a separate TERMO stays a user entry.
sensor set even where the scheme does not draw them), so "tag absent from the scheme drawing" does not prove the sensor is missing.
Only the Navigator's answer counts.

### Layer 3: heating circuits

| Attribute          | Rule                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| number and letters | circuits A to G with a valid flow temperature or an active mode (`hc_x_active_mode` answers); the scan already suggests this |
| mixer or direct    | mixer circuit: pump M3x and mixer M4x in the web tables (A: M31 / M41); direct circuit: pump (B: M32) without mixer          |
| room device        | B6x valid (A: B61)                                                                                                           |
| zones and rooms    | zone modules and rooms by their registers (existing detection)                                                               |
| where it sits      | A on the central unit; C to G on expansion modules, drawn as a box in the schemes                                            |

### Layer 4: additions

| Addition                                  | Tags that answer                                                                                                         | Strength | Notes                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------- | ---------------------------------------------------------------------- |
| solar                                     | B73 to B76 valid, `solar_mode` (1856); M78 / M79 valves                                                                  | strong   | solar pumps M75 / M76 are not exposed by Modbus                        |
| second heat generator (boiler, oil / gas) | M111 priority valve (web tables); the bivalence registers (1120 to 1124) exist on every Navigator, so they prove nothing | weak     | find the answer in the web tables, not in the registers                |
| electric heating rod                      | `electric_heater_power` (76), `energy_electric_heater`, web outputs "Elektroheizeinsatz 1 / 2 / 3 kW", B15 fault         | weak     | present on the test device; a stage only counts when the output exists |
| tiled stove / solid fuel boiler           | M88 (0-10 V / PWM pump), B84                                                                                             | unknown  | not in any Modbus document; check web tables of a plant that has one   |
| circulation                               | M64                                                                                                                      | weak     | actor                                                                  |
| ISC (cooling without process reversal)    | B44, B49, M17, M84, M89, M99                                                                                             | strong   |                                                                        |
| cascade (several units)                   | `cascade_available_*`, `cascade_running_*` answer                                                                        | strong   | answers "not available" on a single unit                               |
| PV, battery, smart grid                   | PV registers (74 to 88), smart grid status (1006)                                                                        | -        | our PV module handles these                                            |

### Result: a plant description

The layers combine into one description the diagram can draw. The test device (AERO SLM 3-11 HGL, 7.3a) would read:

```
controller:  navigator 2.0 (pro)
unit:        source air, hot gas line yes, compressors 1, cooling reversal (M51, M61, M62)
storage:     hygienik with stratification plate (B38, B41, B48, B42), fresh water station (M22, B1), no cooling buffer
circuits:    A mixer (B51, M31, M41), room device no
additions:   circulation (M64), electric heating rod stages 1 / 2 / 3 kW, no solar, no boiler
product:     "AERO SLM 3-11 HGL" (user entry)
```

What the tags **cannot** decide, to ask the user instead: product name and size, monobloc versus split, Hygienik with STP versus Hygienik + TERMO, an iPUMP tank versus an AQA, a tiled stove. The adapter should show these as "detected: ..., please confirm" and keep a user override
for every layer, as it already does for the diagram's heat source and circuits.

## 7. Plant schemes observed in the manuals

The tag sets are the tags drawn in each scheme page of the named manual (read from the PDF text; a scheme page may draw more than it
labels). They are what the diagram variants have to cover.

### 7.1 AERO ALM 2-15 (`L7.1`), Navigator 2.0, air, monobloc

| Code (title in brief)                                                        | Tags drawn                                                                                        |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `L7.1-0-1-0-0` Hygienik heating + hot water, 1 circuit                       | B32 B33 B34 B41 B48 B51 B61 (B53 B54 B63 B64 expansion) M22 M31 (M32 M33 M34 M41 M43 M44) M63 M73 |
| `L7.1-0-2-0-0` Hygienik hot water only, 1 uncontrolled circuit, heating only | B32 B33 B34 B42 B61 M63 M73 (B1)                                                                  |
| `L7.1-0-4+5-0-0` AQA + TERMO, 1 circuit                                      | B32 B33 B34 B38 B41 B48 B51 B61 B63 B64 B53 M31 M33 M34 M41 M43 M44 M63 M73                       |
| `L7.1-5-1-0-0` tiled stove + Hygienik heating + hot water                    | B32 B33 B34 B41 B48 B51 B61 B84 M31 M41 M63 M73 M88                                               |
| `L7.1-7-2+5-0-0` solar 15/30 m² + Hygienik hot water only + TERMO            | as 4+5 plus B73 B74 B75 B77 M75 M76 M78                                                           |
| `L7.1-0-2+6-2-0` Hygienik hot water only + TERMO 100 + cooling               | B31 B32 B33 B34 B38 B40 B42 B48 B51 B61 M22 M63 M73                                               |
| `L7.1-0-1+7-2-0` Hygienik heating + hot water + TERMO + cooling              | cooling set plus M61 M62 B40 B53 B54 B63 B64 M31 M33 M34 M41 M43 M44                              |

The ALM 2-15 central unit's standard terminal plan has: B32 outdoor, B38 heating buffer, B40 cold buffer, B41 / B48 DHW bottom / top,
B42 hot water station, B51 flow circuit A, B61 room device circuit A (optional accessory), M31 circuit A pump, M41 circuit A mixer.

### 7.2 AERO ALM 10-24 (`L9.1`), air, monobloc with separating circuit

| Code (title in brief)                                               | Tags drawn beyond the ALM 2-15 core                                                    |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `L9.1-1-5-0-7` external heating rod + TERMO + 1 circuit             | B32 B33 B34 B38 B45 B51 B53 B54 B61 B63 B64 B124 B125 M31 M33 M34 M41 M43 M44 M73 M125 |
| `L9.1-1-2+5-0-2+7` rod + Hygienik + TERMO + 1 circuit + circulation | adds B41 B42 B48 M22 M63 M64                                                           |
| `L9.1-1-4+5-0-4-7` rod + AQA500 or larger + TERMO + circulation     | AQA instead of Hygienik: B41 B48, M63 M64, no B42/M22                                  |
| `L9.1-1+7-…` solar station + Hygienik + TERMO + circulation         | adds B73 B74 B75 B77 M75 M76 M78                                                       |
| oil/gas boiler + Hygienik + TERMO + circulation                     | adds M111 (priority valve)                                                             |
| `L9.1-1-5+7-2-7` rod + TERMO + cold storage + cooling               | B31 B40 M61 M62 instead of DHW                                                         |

The ALM 10-24 draws no B2 flow sensor and uses the charging sensor B45; B124 / B125 belong to its separating heat exchanger.

### 7.3 AERO SLM 3-11 / 6-17, air, split, with hot gas line

| Scheme (SLM manual chapter 9)                                          | Tags drawn                                                                                                                                                                                              |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9.1 SLM HGL, direct circuit, Hygienik 2.0 without stratification plate | B31 B32 B33 B34 B35 B51 B61 M71 M73                                                                                                                                                                     |
| 9.2 SLM HGL, mixer circuit, Hygienik 2.0 with stratification plate     | B32 B33 B34 B35 B38 B41 B42 B48 B51 B53 B54 B61 B63 B64 M31 M33 M34 M41 M43 M44 M71                                                                                                                     |
| cooling note (SLM manual, direct circuit with cooling)                 | B31 (humidity, `rH%`), B5 (dew point monitor), B32, B35, B51, B61; a dew point monitor must be placed for cooling; minimum volume, flow and heat transfer apply (SLM 3-11 HGL: 80 l, 1.01 m³/h, 2.4 kW) |

### 7.3a The test device: AERO SLM 3-11 HGL

The project owner's plant (the test device; level **device**, confirmed by the owner 2026-10-15): **IDM AERO SLM 3-11 HGL** (air, split, with hot gas
line), **Hygienik 2.0 with stratification plate (STP)**, **one heating circuit (A, mixer circuit)**, and **direct cooling by process reversal**
("reversed circuit", no cooling buffer). Controller: Navigator 2.0 Pro. This is scheme **9.2** of the SLM manual (HGL, mixer circuit, Hygienik
2.0 with stratification plate), plus the cooling variant.

What the Navigator reports for this plant, matched against the scheme (Modbus scan 2026-10, web tables):

| Element                               | Tags                                            | Reported by the device                                                                   |
| ------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| air heat pump                         | B37, M13                                        | B37 valid, M13 (0-10 V) in the analog outputs; B46 (second intake) and B72 not available |
| hot gas line                          | B35, M71                                        | B35 valid, M71 in the analog outputs                                                     |
| hydraulic module                      | B33, B34, B2, M73, M63                          | all valid; M73 reports -1 while the pump stands (analog output -1 %)                     |
| Hygienik with fresh water station     | B41, B48, B42, M22, B1                          | B41, B48, B42 valid; M22 as digital and analog output; B1 as digital input               |
| stratification plate (heating part)   | B38                                             | B38 valid                                                                                |
| circuit A                             | B51, M31, M41 (B61 optional)                    | B51 valid; M31, M41 as digital outputs; B61 not available (no room device)               |
| circulation                           | M64                                             | present                                                                                  |
| cooling by process reversal           | M51, M61, M62, B5                               | M51 four-way valve, M61 and M62 valid; B5 dew point monitor as digital input             |
| no cooling buffer, no humidity sensor | B40, B31                                        | both not available                                                                       |
| not installed                         | B36, B43 (source circuit), M15, M16, solar, ISC | not available                                                                            |

Consequences for the diagram and for detection:

- **Cooling by process reversal is recognisable without B40 / B31**: it shows as the four-way valve M51 (web tables), the changeover valves M61 / M62
  and the dew point monitor B5. Cooling with a cooling buffer (B40, B31, M74 present) is a different drawing from this one.
- The test device is the reference for "air, HGL, Hygienik with STP, one mixer circuit, reversal cooling". Everything else in chapter 7 is
  from manuals only until a second device confirms it.

### 7.4 TERRA brine units (SWM, SW Twin, SW Complete) and TERRA AL Twin

| Unit (manual)        | Schemes (summary)                                                                                                                                                                                                                | Distinguishing tags                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| SWM 3-13 / 6-17      | HGL with direct circuit (M16 M71 M73, B35 B36 B43); HGL P with active cooling + Hygienik 2.0; with Hygienik 2.0 and passive cooling (M61 M62 M74, B31 B40); with Hygienik, stratification plate and solar (B73..B77 M75 M76 M78) | B36 B43 M16 (+ B35 M71 for HGL)                         |
| SW Twin 20-42 (HGL)  | Hygienik only for hot water; Hygienik + heating buffer; direct circuits with cooling; cooling with and without process reversal (B14, B40, B44, B49, M17, M61 M62 M74 M84 M89)                                                   | B36 B43 M16 M15 (B35 M71 HGL), B14 for process reversal |
| AL Twin              | direct circuit; Hygienik with stratification plate; bivalent (M111); AL Twin P with cooling                                                                                                                                      | B45, B14, no B36/B43 (air)                              |
| SW Complete (17 HGL) | HGL with Hygienik; Hygienik with direct circuit; Hygienik with stratification plate; cooling with Hygienik                                                                                                                       | B36 B43 M16 (+ B35 HGL)                                 |

Note: the label "B445" in several scheme drawings is the charging sensor **B45** (text layout artefact: the drawing shows `B4 45`).
The tag "B333" (also "B33333", "BB333") in the SWM and SW Complete drawings is **not a real tag**: it is the text of B33 and B43 printed on top of each other in the drawing (extracted from the PDF text).

### 7.5 iPUMP A (air) and iPUMP T (brine), tank integrated

| Scheme                                                                | Tags drawn                                              |
| --------------------------------------------------------------------- | ------------------------------------------------------- |
| iPump A with direct circuit for heating and cooling + circulation     | B17 B31 B32 B33 B34 B41 B48 B62 M73                     |
| iPump A with direct circuit, circulation and one mixer circuit        | B32 B33 B34 B41 B48 B51 B61 B62 M31 M32 M41 M63 M64 M73 |
| iPump T with direct circuit + circulation                             | B32 B33 B34 B36 B41 B43 B48 B62 M15 M16 M63 M64 M73     |
| iPump T with direct circuit, cooling + circulation                    | as above plus B17 B31 M74                               |
| iPump T with direct circuit, cooling, circulation and a mixer circuit | adds B51 B61 M31 M32 M41                                |

The iPUMP has the tank built in (B41 / B48 are in the integrated tank), so there is no buffer and no separate hydraulic module drawn; the
hot water side differs from the Hygienik schemes.

### 7.6 AERO ALM 2-8 / 4-12 (Navigator 2.0): Hygienik with and without STP

The ALM 2-8 / 4-12 manual draws the Hygienik 2.0 in both forms, which is the clearest evidence for layer 2 (PDF pages 38 to 41).

| Scheme (title in brief)                                                                                                      | Tags drawn                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Hygienik 2.0 **with STP**: heating and hot water, mixer circuit A plus direct circuit B (and expansion circuits)             | B32 B33 B34 B38 B41 B42 B48 B51 B53 B54 B61 B63 B64 M22 M31 M32 M33 M34 M41 M43 M44 M63 M73                 |
| Hygienik 2.0 **without STP**, hot water only, one uncontrolled direct circuit ("cooling not possible")                       | B32 B33 B34 B41 B42 B48 B61 M22 M63 M73 (no B38, no B51, no M41)                                            |
| Hygienik 2.0 **with STP** and cooling (cooling buffer B40, humidity B31, charging sensor B45)                                | B31 B32 B33 B34 B38 B40 B41 B42 B45 B48 B51 B53 B54 B61 B63 B64 M22 M31 M33 M34 M41 M43 M44 M61 M62 M63 M73 |
| Hygienik 2.0 **without STP** plus TERMO 100 and cooling (TERMO flowed through in heating and cooling as hydraulic separator) | B31 B32 B33 B34 B38 B40 B41 B42 B48 B51 B61 M22 M63 M73                                                     |

In these schemes B38 sits in the Hygienik when it has an STP and in the TERMO when it has none; B38 is therefore a buffer sensor, not a statement
about the Hygienik type.

### 7.7 iPUMP ALM 2-8 / 4-12 (tank integrated)

| Scheme                                                            | Tags drawn                                                                                |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| iPump ALM + mixer circuit for heating                             | B32 B33 B34 B38 B41 B45 B48 B51 B61 M31 M32 M41 M73                                       |
| iPump ALM + mixer circuit for heating + circulation               | adds M63 (and M64 as a circulation pump)                                                  |
| iPump ALM + mixer circuit for heating and cooling (+ circulation) | adds B31 and B40; **"in cooling operation B38 is used as the cold storage sensor (B40)"** |

The iPUMP ALM has the same sound and kW data as the AERO ALM 2-8 / 4-12 in the catalogue, but a different hydraulic module (charging sensor B45 is
drawn; the circuit pump M32 serves circuit B).

### 7.8 HYGIENIK 3.0 with hot water station 3.0 (own manual, chapter 6)

The Hygienik 3.0 manual draws four schemes (PDF pages 39 to 42), all around the heat pump's hydraulic module with a charging sensor:

| Scheme                                                                                                                         | Tags drawn                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| air heat pump + Hygienik 3.0, mixer circuits (two pages)                                                                       | B32 B33 B34 B38 B41 B45 B48 B51 B53 B54 B61 B63 B64 M31 M33 M34 M41 M43 M44 M63 M73 |
| same with separating heat exchanger (ALM 10-24 type) and an electric rod that "is not a full bivalence, only frost protection" | adds B124 B125 M125                                                                 |

Terminal notes of the station: circulation pump M64 (optional accessory), return layering valve M110 with sensor B110 (accessory, all sizes),
fresh water station sizes 25 / 35 / 50 / 70 l/min.

### 7.9 TERRA SW 50-280 Max (large units; Ukrainian translation of 812122 Rev. 8)

Large units with several compressors and brine connections; the manual covers the variants with hot gas line (HGL), with reversing process (P)
and the high-temperature "Max H" family. Tags drawn on the scheme pages (PDF pages 31, 39 to 41, 48, 49):

| Page group            | Tags beyond the TERRA SW Twin set                                                                                                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit connection pages | B93 (heat pump inlet), B96 (brine return), M95 and M97 (shut-off valves with servo drive), M98, M100 and M101 (three-way valves), M103 to M107 (cooling-buffer related valves; M106 named "cooling buffer" in the drawing) |
| plant schemes         | the Twin set (B32 B33 B34 B36 B38 B40 B43 B51 B61, M16 M17, M31 M41, M61 M62 M63 M73 M74), ISC (B44, B49, M84, M89, M99), flow switch B14, hot water M22, M11 and M12 (not explained)                                      |
| hot water             | B47 and B48 on the Hygienik ("sensor Hygienik B47 and B48")                                                                                                                                                                |

Only a translation was found, so tag meanings from drawing labels are **inferred**; no German original was available.

### 7.10 AERO ILM 2-7 / 4-13 and ILM HGL (older air unit, Navigator 2.0)

Twelve schemes in the ILM manual (chapter 6; PDF pages 47 to 56); the sensor list on page 61 names B72 (heat exchange sensor), B37 (air inlet),
B2 (heat pump flow sensor), B34, B38, B51, B41 / B48 / B42, B32, B35 (HGL flow, HGL model only) and B40 (cooling buffer).

| Scheme (title in brief)                                                     | Tags drawn                                                                                     |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 6.3 ILM, unregulated direct circuit, Hygienik without separating plate      | B14 B32 B33 B34 B41 B42 B48 B51 B61 M22 M63 M73                                                |
| 6.4 ILM, unregulated direct circuit and AQA                                 | B14 B32 B33 B34 B41 B48 B51 B61 M63 M73                                                        |
| 6.5 ILM, Hygienik with separating plate, mixer circuits                     | adds B38 B53 B54 B63 B64 M31 M33 M34 M41 M43 M44                                               |
| 6.6 ILM, cooling buffer and Hygienik with separating plate                  | adds B31 B40 M61 M62 M74 (B35 not drawn)                                                       |
| 6.7 ILM, Hygienik with separating plate and oil / gas burner                | B38 B41 B42 B48 B51 ... (boiler drawn without M111)                                            |
| 6.8 ILM HGL, unregulated direct circuit, Hygienik without plate             | B14 B32 B33 B34 B35 B41 B42 B48 B51 B61 M22 M71 M73                                            |
| 6.9 ILM HGL, Hygienik with separating plate, mixer circuits                 | adds B38 B53 B54 B63 B64 M31 M33 M34 M41 M43 M44                                               |
| 6.10 ILM HGL, Hygienik without plate and heating buffer                     | B32 B33 B34 B35 B38 B41 B42 B48 ... M63 M71 M73                                                |
| 6.11 ILM HGL, Hygienik with separating plate and tiled stove (cockle stove) | adds B84 M88 (the stove feeds into the Hygienik)                                               |
| 6.12 ILM HGL, cooling and HGL usage in one step                             | B31 B32 B33 B34 B35 B38 B40 B41 B42 B48 B51 B61 M22 M31 M41 M61 M62 M73 **M94** (plus B5, B14) |

Two findings: the tiled stove tags M88 / B84 appear in a second manual (ALM 2-15 and ILM HGL), so they are standard accessory tags; and the HGL
unit that cools uses the hot gas line's waste heat for hot water via M94.

### 7.11 TERRA AL 60 Max (large air unit, Navigator 2.0)

PDF pages 26 to 30. The unit is heating only (no hot water from the heat pump itself unless a separate Hygienik without STP is added),
and it works as a **cascade of two units, "master" and "member"**, each driving one heating circuit; with extension modules up to 9 circuits.
A flow switch B14 sits in each unit's return.

| Scheme (title in brief)                              | Tags drawn                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| heating only, 1 unit                                 | B14 B32 B33 B34 B51 B53 B54 B61 B63 B64 M31 M33 M34 M41 M43 M44 M73          |
| + Hygienik without STP + circuits A to G             | adds B45 B48 M22 M63 and **B55 B56 B57 B65 B66 B67 M35 M36 M37 M45 M46 M47** |
| cooling (separate cooling buffer)                    | adds B31 B40 M61 M62                                                         |
| two units in cascade (master + member), heating only | B14 B32 B33 B34 B38 B51 B53 B54 B61 B63 B64 M31 M33 M34 M41 M43 M44 M73      |
| two units in cascade + Hygienik                      | adds B41 B45 M22 M63                                                         |

The sensor list (PDF page 34) names B32, B38, B40, B41, B42, B45, B48, B51 as delivered / required. A cascade shows in the Navigator as the
`cascade_*` registers; the test device (a single unit) answers them "not available".

### 7.12 TERRA SW 10 / 13 / 19 / 22 H (high-temperature brine units, Navigator 2.0)

| Scheme                                                                      | Tags drawn                                                                                          |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `S5.3-0-1-0-2` Hygienik for heating and hot water + 1 circuit + circulation | B32 B33 B34 B36 B41 B43 B48 B51 B53 B54 B61 B63 B64 M15 M16 M22 M31 M33 M34 M41 M43 M44 M63 M64 M73 |
| `S5.3-0-2+5-0-2` Hygienik hot water only + TERMO + 1 circuit + circulation  | adds B38 B42; no B41 / B48                                                                          |
| `S5.1-0-4+5-0-4` AQA + TERMO + 1 circuit + circulation                      | B32 B36 B38 B41 B43 B48 B51 B53 B54 B61 B63 B64 M15 M16 M31 M33 M34 M41 M43 M44 M63 M64 M73         |

Both pumps M15 (groundwater) and M16 (brine) are drawn on these units. The required sensors named in the text: B32, B38, B51, B42, B41.
No B35 / M71: the H models have no hot gas line.

### 7.13 AERO ALM 10-50 Max (air, two refrigerant circuits, Navigator 2.0)

Scheme codes `L10.1-…`; PDF pages 34 to 37 (Hungarian translation; scheme titles and drawings are German).

| Code and title in brief                                                                                           | Tags drawn                                                                                           |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `L10.1-1-5-0-0` heating rod + TERMO + 1 circuit                                                                   | B10 B11 B32 B38 B45 B51 B53 B54 B61 B63 B64 M11 M31 M33 M34 M41 M43 M44 M73                          |
| `L10.1-1-2+5-0-2` Hygienik hot water only + TERMO + 1 circuit + circulation station                               | adds B41 B42 B48 B106 M22 M63 M64, circuits C to G: B55 B56 B57 B65 B66 B67 M35 M36 M37 M45 M46 M47  |
| `L10.1-1-2+5+7-2-2` heating rod + Hygienik + TERMO + cold storage + 1 circuit + circulation                       | adds B31 B105 B106 B107 M61                                                                          |
| `L10.1+10.1-2x1-2+5-0-2-A` **two** ALM 10-50 Max (cascade) + 2 rods + Hygienik + TERMO + 2 circuits + circulation | B10 B11 B32 B38 B41 B42 B45 B48 B51 B53 B54 B61 B63 B64 B106 M11 M22 M31 M33 M34 M41 M43 M44 M64 M73 |

New tags: **B10** is "high pressure fault 1" in the Navigator's web table on the test device, so B10 here is probably the high pressure
guard of the refrigerant circuit; **B11** (not named, probably the low pressure side, inferred); **M11** (not named); **B105, B106, B107**
(sensors in the heat sink / cooling side, not named). The code `…-2+5+7-2-2` ends with cooling `2` and circulation `2` (Hygienik), which
supports the hypothesis in chapter 4. The sensor list (page 39) names B32, B38, B40, B41, B48, B42, B51 and the charging sensor B45.

## 8. What the diagram needs from a plant description

From the schemes above, the dimensions that change the drawing (the diagram's current variants are in `www/model.js`):

1. **Heat source:** air (fan, air intake) or brine / groundwater (source pumps, source sensors) - already handled (`heatSource` setting).
2. **Hot gas line:** present or not (B35 / M71) - the hot gas line drawing is already conditional.
3. **Storage topology:** (a) Hygienik with fresh water station; (b) AQA DHW storage; (c) TERMO heating buffer; (d) combinations; (e) integrated
   iPUMP tank; (f) no buffer at all (direct circuit). Today the diagram assumes a buffer with a hot water part.
4. **Hot water side:** fresh water station (M22, B42, B1) versus a DHW heater with sensors B41 / B48 only.
5. **Circuits:** count, direct versus mixer circuit (a direct circuit has a pump M32 and no mixer), which of A to G exist. Today: zone to
   circuit mapping setting; circuit A drawn with M31 / M41.
6. **Cooling:** cooling buffer B40, humidity B31, valves M61 / M62 / M74.
7. **Heat generators besides the heat pump:** solar, oil/gas boiler, tiled stove, external heating rod.
8. **Circulation M64.**

## 9. Detection: what we know and what is open

- The Navigator offers **no model name and no scheme code over Modbus** (Modbus documents; Xerolux likewise detects only the controller family
  by register structure and heating circuit / zone module presence). Detection therefore means **recognising components**, not
  the model.
- Evidence available without writing: the answer pattern of the Modbus registers (present / unavailable / absent, see
  `src/lib/scan.ts`) plus the web tables' sensor and output lists. Sensors are strong evidence, actor states are weak (chapter 6).
- A plant description derived from this is a set of elements (chapter 6). The diagram then needs one drawing routine per element rather
  than one per model.

Open questions, in order of value:

| #   | Question                                                                                                                                                            | Way to answer it                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Q1  | Does the Navigator display the heat pump type or the hydraulic scheme somewhere (web pages, info menu)?                                                             | read-only look at the test device's web pages and the Navigator manual's info/configuration chapters      |
| Q2  | What are B77, B84 and M125 exactly? (B124 / B125 are named in the ALM 10-24 text; "B333" is a drawing artefact)                                                     | IDM wiring diagrams (supplied with the unit) or an installer; not in the public manuals                   |
| Q3  | Which tags does each model's **web table** actually list (a Navigator Pro delivered the list in `web.io`)?                                                          | support exports from users with other models (the adapter has a support export, Diagnostics tab)          |
| Q4  | Manuals still missing: AL 50 Max, SW 35 Max H, SW 6-13 Complete, NANO N5, SW 50-280 Max (only a translation in hand); translations are enough for tags and drawings | IDM partner portal; manualslib lists SW 35 Max H but needs an account to download                         |
| Q5  | Which scheme codes exist for the other units and do their digit groups follow a legend?                                                                             | IDM's "general notes on iDM plant schemes" (referenced in every manual; not found as a separate document) |
| Q6  | Model list: ALM 8-18, iPUMP ALM 2-8 / 4-12, SW Max older sizes, ILM - do they exist?                                                                                | owner's sources; confirm with an IDM document                                                             |

## 9a. Evidence summary: what is solid and what is not

**Solid (several independent sources, or a device):**

- The current model range and its technical data (catalogue 2025).
- Core tags and their meaning: B32 B33 B34 B35 B36 B37 B38 B40 B41 B42 B43 B45 B48, M13 M15 M16 M22 M31 M41 M61-M64 M71 M73 M74, B1 B2 B5 B10 B31: IDM Modbus documents and
  Navigator names, plus the same tags in the manuals' drawings.
- Heating circuit numbering A to G (flow B51-B57, room B61-B67, pump M31-M37, mixer M41-M47): drawn in three manuals (AL 60 Max, ALM 10-50 Max, ALM 2-8 / 4-12) and
  consistent with the Modbus labels.
- A tiled stove has M88 (0-10 V / PWM pump) and B84: two manuals (ALM 2-15, ILM HGL).
- Hygienik with STP versus a Hygienik without STP, with or without a TERMO: drawn explicitly in two manuals (ALM 2-8 / 4-12, ILM) and the Hygienik 3.0 manual.
- The test device (AERO SLM 3-11 HGL, Hygienik with STP, one mixer circuit, reversal cooling) against SLM scheme 9.2: tags match one to one.
- The Navigator gives no model name and no scheme code over Modbus (Modbus documents, Xerolux).

**Plausible (one manual, or consistent but never stated):**

- B124 / B125 (separating heat exchanger sensors): named in one manual's text (ALM 10-24).
- Cooling by process reversal shows as M51 + M61 / M62 + B5: one device, one manual remark; the M51 role is inferred.
- B38 doubles as the cold storage sensor B40 in iPUMP ALM cooling: one manual's note; our device cools without B40, which fits.
- The scheme code groups (generator, storage, cooling, circulation): fits every code, stated nowhere.
- Circuit B is a direct circuit without flow sensor (B52): drawn that way in several manuals, but no text says "B52 does not exist".
- M94 (hot water from waste heat while cooling): one ILM scheme.

**Unknown (drawn but never explained):** B77, B84 (role only), M125, B11, M11, B105-B107, B93 / B96 / M95-M107 (large units, only a translation).

**Not possible from tags:** model name and size, monobloc versus split, Hygienik with STP versus Hygienik + TERMO, iPUMP tank versus AQA.

**Biggest gaps in the evidence:** one test device only (an SLM HGL); the schemes show suggestions, not what installers built; the manuals are
older mirrors and translations; manuals for AL 50 Max, SW 35 Max H, SW 6-13 Complete and NANO are missing; web tables of other models are unknown (support exports would close
this).

## 10. How to extend this document

- Add a manual: read its _Anlagenschemen_ chapter, add its schemes to chapter 7 with the tags drawn, and add every new tag to chapter 5 with a
  source level.
- Add a plant seen in the field: record unit, scheme as described by the owner, and the tag list of its web tables / scan (without host,
  IP or other identifying data, CLAUDE.md rule 3).
- When a Modbus scan on a device contradicts a statement here, the scan wins (CLAUDE.md rule 5); correct this document afterwards.
