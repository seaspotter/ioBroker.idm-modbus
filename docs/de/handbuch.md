# ioBroker.idm-modbus – Handbuch

Lokaler ioBroker-Adapter für IDM Wärmepumpen mit Navigatorregelung (Navigator 2.0 / Pro am Gerät geprüft, Navigator 10 und 1.0/1.7 nach den IDM-Dokumenten). Er spricht über **Modbus TCP** im eigenen Netzwerk mit dem Navigator, ohne Cloud. [English version](../en/manual.md)

## 1. Vorbereitung

Zwei Dinge müssen **einmalig am Navigator** eingerichtet werden, in der Regel auf Heizungsbauer- bzw. Serviceebene (im Zweifel den Installateur fragen):

1. **Modbus TCP** ist werkseitig ausgeschaltet. Im Hauptmenü „Einstellungen“ den Menüpunkt „Gebäudeleittechnik“ wählen und „Modbus TCP“ auf „Ein“ stellen. Dem Navigator eine feste IP-Adresse geben. Ohne Modbus TCP kann der Adapter nichts lesen; „Verbindung testen“ meldet dann einen Verbindungsfehler.
2. **Netzwerk-PIN**: nur für den optionalen Teil _Weboberfläche_ (Raumnamen, Raumdaten und Statistik aus den Webseiten des Navigators). Der Adapter funktioniert auch ohne.

Der Adapter schaltet keine Installateurfunktionen frei und ändert diese Einstellungen nie selbst.

**Sicherheit in Kürze:** Lesen ist immer unkritisch. Schreiben ist standardmäßig aus, je Gruppe einzeln freizugeben, und jeder Schreibvorgang wird geprüft, begrenzt und gezählt. Viele Einstellungen des Navigators liegen in einem EEPROM, das etwa 300.000 Schreibzyklen je Einstellung verträgt: niemals dauerhaft durch eine Automatisierung schreiben lassen.

## 2. Erste Einrichtung (5 Minuten)

1. Adapter installieren und eine Instanz anlegen.
2. Reiter **Verbindung**: IP-Adresse des Navigators eintragen und die Navigator-Generation wählen. **Verbindung testen** drücken: Es erscheinen die Außentemperatur und die erkannte Generation (bei Abweichung von Ihrer Wahl mit Hinweis).
3. Reiter **Anlage**: **Gerät scannen** drücken (etwa 3 Minuten, nur lesend; den Adapter währenddessen nicht neu starten; die Seite zeigt den Fortschritt). Steht in der Statuszeile _Scan beendet_, **Vorschlag übernehmen** drücken. Das setzt die Haken bei den Heizkreisen, Zonenmodulen und Blöcken, die der Navigator wirklich hat. Prüfen und **Speichern**.
4. Datenpunkte erscheinen, sobald der Navigator einen Wert meldet. Hardware, die Ihre Anlage nicht hat, bekommt keine leeren Datenpunkte.

Alles Weitere ist optional und bleibt aus, bis Sie es einschalten.

## 3. Einstellungen im Überblick

### Verbindung

| Einstellung              | Bedeutung                                                                                                                                                                                                                                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Navigator Host / IP      | Adresse des Navigators. Eine feste Adresse verwenden.                                                                                                                                                                                                                                                                 |
| Navigator-Generation     | 2.0 (auch Pro), 1.7 oder 10. Der Test-Button erkennt sie für Sie.                                                                                                                                                                                                                                                     |
| Weboberfläche (optional) | Auch Daten aus der Weboberfläche lesen: Ein- und Ausgänge (Navigator 2.0 / Pro und 10), dazu Raumnamen, Raumdaten und Statistik (Navigator 2.0 / Pro). Nicht für den Navigator 1.0/1.7. Braucht die Netzwerk-PIN des Displays (verschlüsselt gespeichert, im lokalen Netz wie im Browser unverschlüsselt übertragen). |
| Diagramm                 | Wärmequelle, Teile weglassen, Räume neben Heizkreisen; siehe Abschnitt 8a.                                                                                                                                                                                                                                            |
| Experteneinstellungen    | Sichtbar im Expertenmodus des Admins: Port (502), Unit-ID (1), Request-Timeout, Pause zwischen Requests (mindestens 100 ms: Der Navigator stockt bei hartem Polling), Abfrageintervalle schnell/mittel/langsam/Einstellungen (30 s / 60 s / 300 s / 3600 s) und die Intervalle der Weboberfläche.                     |

### Anlage

Heizkreise A–G (mit optionalem Namen), Anzahl der Zonenmodule und Räume je Modul, optionale Registerblöcke (Solar, ISC, Kaskade, Bivalenz, PV- und Leistungswerte, Booster-Wärmepumpen beim Navigator 10), der Gerätescan mit „Vorschlag übernehmen“ und zwei Optionen dazu, welche Datenpunkte es gibt:

- **Datenpunkte von Hardware ausblenden, die keinen Wert meldet** (Standard: ein): Datenpunkte von Fühlern, Pumpen usw., die Ihre Anlage nicht hat, werden nicht angelegt. Ein Datenpunkt erscheint von selbst, sobald ein echter Wert kommt, und bleibt dann: Der Adapter löscht nie einen vorhandenen Datenpunkt (nur das Abschalten eines Registers in den Einstellungen tut das).
- **Datenpunkte von hier abgeschalteten Kreisen, Zonen und Blöcken löschen**: räumt auf, was Sie abgeschaltet haben.

### Statistik

Abgeleitete Werte und Statistik (siehe Abschnitt 6): optionaler externer Stromzähler (Zählerstand und/oder Leistung) und Wärmemengenzähler, welche Wärmequelle die Effizienzwerte speist, Preis pro kWh (fest oder aus einem Datenpunkt, in Währung oder Cent pro kWh), Währung, CO₂-Faktor (fest oder aus einem Datenpunkt, in g oder kg pro kWh), maximales Alter externer Werte, _Statistik zurücksetzen_.

### Steuern

Erlaubt das Schreiben an die Wärmepumpe. **Alles ist standardmäßig aus**, je Gruppe: Systembetriebsart und Störungsquittierung, Warmwasser-Einstellungen, jeder Heizkreis, Raumsolltemperaturen und Raumbetriebsarten der Zonenmodule (Navigator Pro), Solar-Betriebsart sowie Bivalenz und Kaskade (Expertenmodus). Dazu die einmalige Warmwasserladung, der Mindestabstand zwischen zwei Schreibvorgängen einer Einstellung (Standard 60 s) und eine Warnschwelle für Schreibvorgänge je Einstellung und Tag.

### Photovoltaik, Raumsensoren, Gebäudeleittechnik

Übergabe von Werten aus ioBroker-Datenpunkten an den Navigator, siehe Abschnitt 7.

### Diagnose

_Support-Datei erstellen_ (Abschnitt 9).

## 4. Der Objektbaum

Alle Datenpunkte liegen unter der Instanz (`idm-modbus.0.`). Die Namen sind in die Sprache Ihres ioBroker übersetzt.

| Kanal                                               | Inhalt                                                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `info`                                              | `connection`, `family`, `errors`, `lastSuccess`                                                                                       |
| `system`                                            | Außentemperatur, Betriebsart System, Störungsnummer `internal_message` und ihr Text `internal_message_text`                           |
| `dhw`                                               | Warmwasser: Speicher- und Trinkwassererwärmertemperaturen, Solltemperaturen, einmalige Warmwasserladung (`boost_*`)                   |
| `hp`                                                | Wärmepumpe: Vor-/Rücklauf, Betriebsart, Verdichter, Pumpen, Ventile, Anforderungen, Summenstörung                                     |
| `hc.A` … `hc.G`                                     | je Heizkreis: Vorlauf, Raumtemperatur, Betriebsart, Solltemperaturen, Heizkurve, Grenzen                                              |
| `zones.1.rooms.1` …                                 | Zonenmodule: Raumtemperatur, Raumsolltemperatur, Raumfeuchte, Betriebsart, Relaisstatus (Namen aus der Weboberfläche, wenn aktiviert) |
| `energy`                                            | Wärmemengenzähler, Momentanleistung                                                                                                   |
| `solar`, `isc`, `cascade`, `bivalence`, `pv`, `glt` | optionale Blöcke                                                                                                                      |
| `calc`                                              | berechnete Werte: Temperaturdifferenzen, Vorlaufabweichung, momentaner COP                                                            |
| `stats`                                             | Energie je Betriebsart, COP und Jahresarbeitszahl, Kosten, CO₂, Betriebsstunden, Starts, Abtauungen                                   |
| `web`                                               | Raumdaten und Statistik aus der Weboberfläche                                                                                         |
| `diag`                                              | Anfragestatistik, letzter Fehler, Schreibzähler, Scan-Zustand                                                                         |

Regeln für die Werte:

- Temperaturen, Temperaturdifferenzen und Zähler (kWh, Stunden) zeigen **eine Nachkommastelle**.
- Ein Wert, den der Navigator als _nicht verfügbar_ meldet (Fühler fehlt), ist leer und hat ein schlechtes Qualitätsflag, nie eine erfundene Zahl.
- Beschreibbare Datenpunkte werden mit `ack=false` geschrieben; der Adapter bestätigt mit `ack=true`, nachdem der Navigator den Wert angenommen hat und er zurückgelesen wurde.

## 5. Schreiben und seine Schutzmechanismen

Jeder Schreibvorgang durchläuft diese Prüfungen: erlaubte Gruppe, gültiger Wert (nur der dokumentierte Bereich und erlaubte Werte), nur wenn er vom aktuellen Wert abweicht (bei EEPROM-Einstellungen), entprellt (1 s), mindestens 60 s zwischen zwei Schreibvorgängen derselben EEPROM-Einstellung (der neueste Wert gewinnt), geschrieben, nach 1 s **zurückgelesen** und gezählt (`diag.writes.<id>`). Eine Häufung oder mehr als die Tagesschwelle löst eine Warnung aus; drei Fehler in Folge sperren eine Einstellung für zehn Minuten. Solange der Navigator nicht erreichbar ist, wird nichts in eine Warteschlange gelegt, und ein abgelehnter Wert wird als der echte Wert zurückgezeigt.

**Einmalige Warmwasserladung** (Reiter Steuern, standardmäßig aus): `dhw.boost_start` / `dhw.boost_stop`. Sie schaltet die Warmwasseranforderung (Register 1712) ein, erneuert sie alle 30 s und **schaltet sie immer wieder aus**: bei der Zieltemperatur (Standard 55 °C), nach dem Zeitlimit (Standard 60 Minuten), auf Anforderung, nach drei fehlgeschlagenen Schreibvorgängen, beim Beenden des Adapters und nach einem Neustart.

## 6. Statistik

- **Berechnete Werte** (`calc`): Wärmepumpe Vorlauf minus Rücklauf, Wärmequelle Eintritt minus Austritt, Warmwasser minus Solltemperatur, Vorlaufabweichung je Heizkreis, momentaner COP (intern aus den Leistungsregistern des Navigators, extern mit eigenem Zähler).
- **Energie und Effizienz** (`stats`): elektrische und thermische Energie je Betriebsart (Heizen, Warmwasser, Kühlen, Abtauung) für heute, diesen Monat, dieses Jahr und seit Start, COP und Jahresarbeitszahl (auch für die letzten 365 Tage), Kosten zum Preis, der bei der Nutzung der Energie galt, CO₂ mit der damaligen Intensität (`stats.co2.intensity` zeigt den verwendeten Faktor), Betriebsstunden, Starts und kurze Läufe je Verdichter, Abtauzyklen und -stunden. Die Statistik übersteht Neustarts. Schutzregeln für den COP: mindestens 50 W, mindestens 0,1 kWh je Zeitraum.
- **Externe Zähler:** Ein Zählerstand wird bevorzugt (er zählt weiter, wenn der Adapter steht); ein reiner Leistungs-Datenpunkt wird integriert. Die Einheit wird aus dem Datenpunkt gelesen; hat er keine, bitte wählen, sonst bleibt die Quelle mit einer Warnung aus (der Adapter rät nie eine Einheit).
- **Web-Statistik** (`web.statistics`, braucht die PIN): Laufzeit, Wärmemenge und Stromverbrauch je Betriebsart für heute, Monat, Jahr und gesamt, ein JSON-Verlauf aus Tagen, Monaten und Jahren (bis zur ersten Inbetriebnahme) und der daraus berechnete COP. Vor dem Verlassen darauf mit den Modbus-Werten vergleichen; besonders der COP für Warmwasser hängt davon ab, wie der Navigator Energie zuordnet.

## 7. Werte an den Navigator senden

Alle drei Module sind **standardmäßig aus**, schreiben nur, wenn etwas konfiguriert ist, und lesen das Geschriebene zurück, um einen zweiten Schreiber zu erkennen (`*.writer_conflict`).

- **Photovoltaik** (Register 74–86): PV-Überschuss, Produktion, Hausverbrauch, Batterieentladung und -füllstand aus ioBroker-Datenpunkten. Ein Faktor rechnet auf kW um (1 bei kW, 0,001 bei W; es gibt bewusst keinen Standardwert), dazu Umkehren und Grenzen. Der Überschuss kommt direkt aus einem Datenpunkt oder wird als Produktion minus Hausverbrauch berechnet. Jeder Wert wird in jedem Zyklus geschrieben (standardmäßig 30 s). Fehlt die Überschussquelle oder ist sie zu alt, wird **0** geschrieben, damit die Wärmepumpe nicht auf einem alten Überschuss weiterläuft. Das PV-Menü des Navigators muss eingerichtet sein. Jedes andere Programm, das diese Register beschreibt, abschalten.
- **Raumsensoren** (Register 1650 ff.): Die Temperatur eines Datenpunkts als externe Raumtemperatur eines Heizkreises; geschrieben bei einer Änderung ab 0,2 °C oder im Heartbeat (300 s), nur im Bereich 15–30 °C und nicht aus Quellen, die älter als 15 Minuten sind (oder mit festem Ersatzwert). Im Navigator muss beim Heizkreis die Raumtemperaturerfassung auf „GLT Raumsensor“ stehen.
- **Gebäudeleittechnik** (Register 1690–1722): Außentemperatur, Feuchte, Temperaturanforderungen und Anforderungen Heizen/Kühlen/Warmwasser, Speichertemperaturen. Vorher im Navigator die passende GLT-Option einschalten (zum Beispiel „GLT Außentemperatur“). An einem echten Gerät nicht getestet.

## 8. Weboberfläche (optional)

Mit der PIN des Displays liest der Adapter die lokalen Webseiten des Navigators (nur lesend): Raum- und Heizkreisnamen (als Namen im Objektbaum), Raumtemperatur, Solltemperatur, Feuchte und Betriebsart je Raum sowie die Statistik. Die Weboberfläche ist von IDM nicht dokumentiert und kann sich mit Firmware-Updates ändern. Abfrage alle 60 s (Räume, Ein- und Ausgänge) und 15 Minuten (Statistik), nie schneller als 30 s bzw. 5 Minuten.

Die Ein- und Ausgänge aus dem Informationsmenü des Navigators (Fühler, Digitaleingänge, Analog- und Digitalausgänge) liegen unter `web.io`; die Namen bekannter Teile sind in allen Sprachen vorhanden, unbekannte stehen so, wie der Navigator sie zeigt. Navigator 10: dieselben Tabellen werden über den WebSocket des Navigator 10 gelesen (Port 61220, die Display-PIN als Anmeldung); Räume, Heizkreisnamen und Statistik werden dort noch nicht gelesen. Das ist nur gegen einen simulierten Navigator 10 getestet, nach dem Protokoll, das Xerolux dokumentiert; bitte berichten Sie, wie es an einem echten Gerät läuft. Navigator 1.0/1.7: es gibt keine Weboberfläche zum Lesen, die Option ist ausgeblendet.

Modbus hat Vorrang: Was Modbus liefert (der Adapter erkennt das an der IDM-Bezeichnung in den Registernamen, z. B. B33, M64), wird aus diesen Tabellen nicht noch einmal angelegt, und für einen Raum, den Modbus liest, gibt es unter `web.rooms` keinen Eintrag (sein Name ist der Zustand `zones.<Zone>.rooms.<Raum>.name` und der Name des Kanals, seine Werte sind die Zonen-Zustände). Die Web-Variante erscheint nur, solange Modbus keinen Wert hat, zum Beispiel bei der Ladepumpe M73 im Stillstand. Eine vorhandene Web-Variante bleibt bestehen (es wird nichts gelöscht), neu angelegt wird sie aber nur für einen Teil, für den Modbus gerade keinen Wert meldet.

## 8a. Wärmepumpen-Diagramm

Das Diagramm ist ein Livebild Ihrer Anlage auf einer Webseite. Es wird aus den Werten gezeichnet, die der Adapter liest, ist nur lesend und kann nichts verändern. Die Seite läuft in Ihrem Browser und bekommt ihre Daten über den **Web-Adapter** von ioBroker; sie braucht also eine Web-Instanz (üblicherweise Port 8082) und keinen eigenen Port.

**Öffnen.** Auf den Link _Wärmepumpen-Diagramm_ neben der Instanz in der Instanzenliste klicken oder `http://<ioBroker-Rechner>:8082/idm-modbus/index.html?instance=0` öffnen (die Zahl ist die Instanz dieses Adapters). Die Seite folgt der Sprache der ioBroker-Systemeinstellungen.

**Einstellungen (Reiter Diagramm).** Sie gelten sofort, die Seite zeichnet sich neu.

| Einstellung                   | Bedeutung                                                                                                                                                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wärmequelle                   | Automatisch, Luft oder Erdreich oder Grundwasser. „Automatisch“ entscheidet anhand der Fühler, die der Navigator meldet; von Hand wählen, wenn es falsch rät.                                                         |
| Quelle für Leistung und COP   | Elektrische Leistung, thermische Leistung und COP kommen vom Navigator (Standard) oder von den externen Zählern (Reiter Statistik). Ohne externen Zähler gilt der Navigator-Wert.                                     |
| COP-Zeilen                    | Zeigt den COP der gewählten Quelle (Standard), beide COPs (Navigator und extern) oder keinen.                                                                                                                         |
| Teile, die weggelassen werden | Pufferspeicher, Trinkwassererwärmer, Frischwasserstation, Photovoltaik, Solar, Bivalenz. Teile, die die Anlage nicht hat, werden ohnehin nicht gezeichnet.                                                            |
| Speicher im Schema            | Ein Behälter (Hygienik mit Schichttrennplatte: Heizungspuffer und Warmwasser teilen ihn) oder zwei Behälter (eigener Heizungspuffer neben Hygienik oder AQA). Aus den Messstellen lässt sich das nicht unterscheiden. |
| Größe des Schemas (%)         | Wie groß das Schema gezeichnet wird, in Prozent der ursprünglichen Größe (Standard 90).                                                                                                                               |
| Räume neben Heizkreisen       | Standardmäßig stehen die Räume von Zonenmodul 1 neben Heizkreis A, die von Modul 2 neben Heizkreis B usw. Mit einer Zeile ordnen Sie ein Zonenmodul einem anderen Heizkreis zu.                                       |

**Was zu sehen ist.** Das Diagramm baut sich selbst auf: Ein Teil erscheint nur, wenn der Adapter einen echten Wert dafür hat.

- **Wärmepumpe** (links): elektrische und thermische Leistung, COP, der Heizungsdurchfluss (B2), Fühler der Wärmequelle (zum Beispiel die Ansaugluft B37), Pumpenstatus (M73), die Betriebsart und links daneben die Außentemperatur (B32). Der Lüfter dreht sich mit der Lüfterspannung M13 oder während der Verdichter läuft. Eine Erdreich- oder Grundwasser-Wärmepumpe (Wärmequellenfühler und Pumpen, keine Ansaugluft) zeigt statt des Lüfters ein Pumpensymbol mit den Quellenpumpen M15 und M16.
- **Speicher** (Mitte): Warmwasser oben (B48) und in der Mitte (B41), der Wärmespeicher unten (B38). Drei Leitungen führen zur Wärmepumpe: Heißgasleitung (B35), Vorlauf (B33) und Rücklauf (B34). Ein Speicher mit weniger Fühlern zeigt weniger Ebenen.
- **Frischwasserstation** (rechts vom Speicher, wenn die Warmwassertemperatur B42 gemeldet wird): der Wärmetauscher, der Kaltwasserzulauf und ein Wasserhahn mit B42 und der Warmwasser-Solltemperatur. Der Tropfen leuchtet, solange Warmwasser gezapft wird (Durchflussschalter B1).
- **Zwei Behälter:** Mit eigenem Heizungspuffer hängt der Warmwasserbehälter unter dem Puffer und wird über eigene Leitungen geladen. Eine Kühlanlage mit Kältespeicher (B40) zeigt ihn als weiteren Behälter. Hat die Anlage keinen Heizungspuffer, gehen die Leitungen direkt zu den Heizkreisen.
- **Heizkreise** (rechts): eine Karte je Heizkreis mit Vorlauftemperatur (B51 für Heizkreis A, B52 für B usw.), Solltemperatur, Raumtemperatur, seiner Pumpe (M31 für A, M32 für B, ...) und seinem Mischer (M41, ...). Ein Heizkreis mit Pumpe und ohne Mischer ist ein Direktheizkreis. Die Räume von Zonenmodul N stehen neben Heizkreis N; weitere Heizkreise stehen untereinander.
- **Solar** (links unten, wenn die Anlage es hat): der Kollektor (B73), eine Rohrschlange im Speicher, Ladetemperatur (B74) und Rücklauf (B75) an den Leitungen, die Solarpumpen (M75, M76) und weitere Solarfühler im Kasten. Die Solarleitungen bewegen sich, solange die Pumpen laufen (ohne Pumpenwerte: solange B74 deutlich wärmer als B75 ist).
- **Heizstab und Zirkulation:** die Stufen des Elektroheizstabs und die Warmwasser-Zirkulationspumpe (M64), wo die Anlage sie meldet.
- **Weitere Wärmeerzeuger** (links unten): eine Kaskade von Wärmepumpen (laufende von verfügbaren Stufen für Heizen, Kühlen und Warmwasser; die Fühler der anderen Geräte werden nicht bereitgestellt), ein Öl- oder Gaskessel (Vorrangventil M111) und ein Kachelofen (Pumpe M88, Fühler B84). Ihre Leitungen münden in den Heizungspuffer, ohne Puffer in die Leitungen der Wärmepumpe, und bewegen sich, solange sie laufen. Der Kessel wird immer zum Heizungspuffer gezeichnet, auch wenn seine Ventile ihn auf den Warmwasserbehälter umschalten können.
- **Energiekacheln** (unten): Photovoltaik, Batterie, Überschuss, Haus und Leistung der Wärmepumpe. Sie sind nicht mit der Wärmepumpe verbunden.

**Pumpen und Mischer.** Pumpen (Ladepumpe M73, Warmwasserpumpe M22, Heizkreispumpe M31 und die Quellenpumpen einer Erdreich-Wärmepumpe) erscheinen als kleines Pumpensymbol: grün, solange sie laufen, grau, solange sie aus sind, mit ihrer Drehzahl. Der Heißgasmischer M71 (in der Wärmepumpen-Box) und der Mischer M41 von Heizkreis A (der Text, den der Navigator meldet) erscheinen als Ventilsymbol, grün, solange sie angesteuert werden; M71 und der Lüfter M13 sind 0-10-V-Ausgänge und werden als 0-100 % gezeigt. Der Kreis der Pumpe wird grün, solange sie läuft. Mischer und die Pumpen M22, M31 und M73 brauchen die Werte der Weboberfläche.

**Farben und Bewegung.** Heizungsleitungen sind orange (Vorlauf) und blau (Rücklauf), der Speicher geht von heiß (oben) nach kalt (unten). Das Wasser nimmt den Weg der Betriebsart: Heizt die Wärmepumpe, sind die Leitungen zum Heizungspuffer und zu den Heizkreisen gefärbt; lädt sie Warmwasser, die zum Warmwasserbehälter; kühlt sie, sind die Leitungen mit kaltem Wasser alle blau, zum Kältespeicher (ohne ihn direkt zu den Heizkreisen). Leitungen, die in der aktuellen Betriebsart nichts führen, bleiben dünn und grau, ebenso die Wertschilder darauf. Helle Striche laufen an einer gefärbten Leitung entlang, solange etwas läuft: die Ladepumpe M73 oder der Durchflussfühler B2 bei den Leitungen der Wärmepumpe, der Mischer M71 und das Wasser bei der Heißgasleitung, der eigene Zustand des Heizkreises bei seinem Abzweig, die Station, solange Warmwasser gezapft wird (alle vier Leitungen der Station, solange sie arbeitet), die Solarpumpen bei der Solarschleife. Fährt man mit der Maus über ein Schild, das nur eine Kennung und einen Wert zeigt (zum Beispiel B38), erscheint der Name dieses Teils.

**Woher die Werte kommen.** Meist von Modbus. Einige gibt es nur in der Weboberfläche (der Durchfluss B2, der Durchflussschalter B1, die Pumpe M22, die Lüfterspannung M13, die Pumpe M31): _Weboberfläche_ einschalten und die Display-PIN eingeben, um sie zu sehen. Liefern Modbus und die Weboberfläche denselben Wert, gilt Modbus.

**Gut zu wissen.** Die Räume werden den Heizkreisen nach der Nummer des Zonenmoduls zugeordnet (Zone 1 zu Heizkreis A, Zone 2 zu Heizkreis B usw.); das ist eine Annahme. Die Fühler der Heizkreise A bis G heißen B51 bis B57 (Vorlauf) und B61 bis B67 (Raum). Die Variante für Erdreich und Grundwasser und der Solarblock wurden noch nicht an einer echten Anlage gesehen.

## 9. Support

Reiter _Diagnose_ → **Support-Datei erstellen**: ein Bericht für Fehlermeldungen mit der Konfiguration (ohne Host, PIN und Datenpunkt-IDs), Verbindungszustand, Registern ohne Wert, dem letzten Wert jedes Registers und dem letzten Scan-Ergebnis. IP- und E-Mail-Adressen werden entfernt. Die Datei öffnet sich in einem neuen Tab und bleibt im Dateibereich `support` (die letzten fünf). Zusammen mit dem Adapter-Log anhängen (bei Verbindungsproblemen die Log-Stufe _Debug_ einstellen).

## 10. Fehlersuche

| Beobachtung                                             | Ursache / Abhilfe                                                                                                                                                                                                       |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| „Verbindung testen“ schlägt fehl                        | Modbus TCP am Navigator nicht eingeschaltet, falsche IP oder ein anderer Client blockiert den Port.                                                                                                                     |
| Verbunden, aber keine Außentemperatur                   | Unit-ID ungleich 1 (Experteneinstellungen).                                                                                                                                                                             |
| Viele leere Datenpunkte                                 | Hardware, die Ihre Anlage nicht hat: _Datenpunkte von Hardware ausblenden, die keinen Wert meldet_ eingeschaltet lassen oder den Scan ausführen und den Vorschlag übernehmen.                                           |
| Falsche oder fehlende Werte nach Wechsel der Generation | Die Generation wählen, die der Test-Button meldet.                                                                                                                                                                      |
| Der Navigator wird langsam                              | Abfrageintervalle oder Pause zwischen Requests zu kurz; die Standardwerte beibehalten.                                                                                                                                  |
| Der Scan bricht bei etwa 25 % ab                        | Der Adapter wurde während des Scans neu gestartet (auch durch Speichern der Konfiguration); erneut starten und den Adapter in Ruhe lassen.                                                                              |
| `web.connected` ist false                               | Falsche PIN, Weboberfläche nicht erreichbar oder am Navigator ist keine PIN gesetzt.                                                                                                                                    |
| Das Diagramm öffnet sich nicht                          | Eine Web-Adapter-Instanz installieren und starten; sie liefert die Seite aus (`/idm-modbus/`). Den Link neben der Instanz benutzen, er enthält die Instanznummer.                                                       |
| Im Diagramm fehlt ein Teil                              | Der Adapter hat dafür keinen Wert: Die Anlage hat es nicht, es ist im Reiter Anlage nicht eingeschaltet, oder (Durchfluss, Pumpen, Lüfterspannung) die Weboberfläche ist aus.                                           |
| Ein Schreibvorgang bleibt ohne Wirkung                  | Prüfen, ob die Gruppe im Reiter Steuern freigegeben ist; das Log nennt den Grund (Bereich, gleicher Wert, Mindestabstand, Sperre). Raumsolltemperaturen wirken nur, solange der Raum in der Betriebsart _Normal_ steht. |

## 11. Bekannte Grenzen

- Die Registerdateien für Navigator 10 und 1.0/1.7 stammen aus den IDM-Dokumenten und sind an echten Geräten ungetestet; Scans anderer Nutzer werden sie bestätigen. Die Spulenregister (3000–3003) des Navigators 1.7 werden nicht unterstützt.
- Der Navigator kann falsche Daten liefern, wenn überlappende Register in einem Block gelesen werden; der Adapter liest die betroffenen Register (zum Beispiel Raumfeuchte und Betriebsart) einzeln.
- Ein in der Navigator-App angelegter „Raum mit Modbus TCP“ kann von diesem Adapter noch nicht mit einer Temperatur versorgt werden; laut IDM-Dokument gehört die Raumtemperatur an die Adresse des Raums, für einen neunten Raum ist sie nicht dokumentiert.

## 12. Dank und Haftungsausschluss

Die Registerdefinitionen folgen den IDM-Dokumenten „Modbus TCP“ (Navigator 2.0: 812170 Rev.10, Navigator 10: 812663 Rev.0, Navigator 1.0/1.7: 812049 Rev.1). Dank an **Xerolux** ([idm-heatpump-api](https://github.com/Xerolux/idm-heatpump-api), [idm-heatpump-hass](https://github.com/Xerolux/idm-heatpump-hass), MIT) für die Vergleichsdaten und dafür, viele Eigenheiten der Geräte zuerst gefunden zu haben. Dies ist ein unabhängiges Community-Projekt, nicht mit IDM Energiesysteme GmbH verbunden oder von ihr unterstützt. Nutzung auf eigene Gefahr, besonders beim Schreiben.
