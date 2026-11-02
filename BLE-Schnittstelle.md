# Section Remote – BLE-Schnittstelle Handy ↔ ESP32

Gerätename im Advertising: `SectionRemote` (Präfix genügt, z. B. `SectionRemote-01`)

| Element | UUID | Richtung | Eigenschaften |
|---|---|---|---|
| Service | `71c6dc5d-59ec-4fef-9c03-0d0158819677` | – | – |
| Buttons | `98237ea2-4a3b-4189-a640-d2be777a7181` | Handy → ESP32 | Write Without Response |
| Status  | `3563e9a6-eb47-4bba-af5c-49ec13e3936e` | ESP32 → Handy | Read, Notify |

## Buttons (2 Byte, alle 100 ms und sofort bei Änderung)

| Byte | Inhalt |
|---|---|
| 0 | Bitmaske gedrückter Tasten: Bit0 = Links EIN, Bit1 = Links AUS, Bit2 = Rechts EIN, Bit3 = Rechts AUS, Bit4 = Hauptschalter umschalten |
| 1 | Sequenzzähler 0–255 (Heartbeat) |

Ein kurzer Tipp wird von der App mindestens 200 ms lang als „gedrückt“ gesendet.

**Fail-safe im ESP32:** Kommt 300 ms lang kein Paket (oder die BLE-Verbindung bricht ab), setzt der ESP32 alle vier AUX-Eingänge auf „losgelassen“.

## Status (2 Byte, bei Änderung und mindestens alle 500 ms als Notify)

| Byte | Inhalt |
|---|---|
| 0 | Flags: Bit0 = Adresse belegt (Address Claim OK), Bit1 = Terminal (VT) verbunden, Bit2 = Object Pool aktiv / AUX-N angemeldet, Bit3 = Lernmodus (Zuordnung im Terminal läuft) |
| 1 | Bitmaske: welche der vier Tasten im Terminal einer Funktion zugeordnet sind (gleiche Bit-Reihenfolge wie oben; die Firmware meldet immer 0x1F, da die Zuordnung am Eingabegerät nicht auslesbar ist) |

Die App zeigt „ESP32 antwortet nicht“, wenn 1,5 s kein Status kommt, und sperrt dann die Tasten.

## ISOBUS-Seite (Firmware)

- Bibliothek: AgIsoStack++ (ESP-IDF/PlatformIO), CAN über `MCP2515CANInterface` + `SPIInterfaceESP` (CS = D7) oder alternativ den internen TWAI-Controller.
- Vorlage: `examples/virtual_terminal/aux_inputs` – fünf Auxiliary-Input-Type-2-Objekte (Boolean momentary, IDs 4000–4004) mit Icons; der Hauptschalter (4004) ist ebenfalls ein Tastimpuls – das Umschalten übernimmt die Maschine, `update_auxiliary_input(objectId, value, transitions)` bei jeder Änderung.
- 250 kbit/s, Abschlusswiderstand am Board offen lassen.

## Firmware-Update (ab Firmware 1.1.0)

Zwei weitere Characteristics im selben Service:

| Element | UUID | Richtung | Eigenschaften |
|---|---|---|---|
| Update-Steuerung | `2c24d633-f30f-4a07-81cc-dd9d8f4ea307` | beide | Read, Write (mit Antwort), Notify |
| Update-Daten | `4303f225-7d2b-466f-abb3-fad98f8a28bc` | Handy → ESP32 | Write Without Response |

Zahlen sind Little Endian. Status-Byte 0 erhält zusätzlich **Bit4 = Firmware-Update läuft** (ISOBUS abgemeldet, Tasten gesperrt).

**Read Update-Steuerung** (36 Byte): `[Protokollversion=1][Flags][MTU u16][Firmware-Version, 32 Byte, nullterminiert]`
Flags: Bit0 = Standard-PIN aktiv, Bit1 = angemeldet, Bit2 = gesperrt (zu viele Fehlversuche), Bit3 = Update läuft, Bit4 = neue Firmware noch unbestätigt.

**Befehle (Write Update-Steuerung)** und Antworten (Notify):

| Befehl | Inhalt | Antwort |
|---|---|---|
| `0x01` AUTH_START | – | `0x81 [Ergebnis][Nonce 16 Byte]` |
| `0x02` AUTH_RESPONSE | HMAC-SHA256(PIN, Nonce ‖ "SRAUTH"), 32 Byte | `0x82 [Ergebnis][bei OK: 1 = Standard-PIN / bei Fehler: Restversuche]` |
| `0x03` SET_PIN | `[Länge 4–8][8 Byte: PIN-Ziffern XOR HMAC-SHA256(alte PIN, Nonce ‖ "SRPIN")]` | `0x83 [Ergebnis]` |
| `0x10` BEGIN | `[Größe u32][SHA-256 der Datei, 32 Byte]` | `0x90 [Ergebnis]` (nach Abmelden vom ISOBUS und Löschen des Speichers, einige Sekunden) |
| `0x11` END | – | `0x93 [Ergebnis]`, bei OK Neustart nach 1 s |
| `0x12` ABORT | – | `0x94 [14]`, Neustart mit bisheriger Firmware |

Asynchron: `0x91 [u32]` ACK = so viele Byte sind im Flash; `0x92 [u32]` NACK = erwarteter Offset (Paket fehlte, App sendet ab dort neu); `0x94 [Ergebnis]` Fehler → Update abgebrochen, ESP32 startet mit der bisherigen Firmware neu.

Ergebnis-Codes: 0 OK, 1 nicht angemeldet, 2 PIN falsch, 3 gesperrt, 4 ungültige Daten, 5 falscher Zustand, 6 Standard-PIN muss erst geändert werden, 7 zu groß, 8 Flash-Fehler, 9 SHA-256 falsch, 10 Image ungültig, 11 falsches Projekt, 12 Zeitüberschreitung (15 s ohne Daten), 13 Pufferüberlauf, 14 abgebrochen, 15 neue Firmware noch unbestätigt.

**Datenpakete** (Update-Daten): `[Offset u32][Daten]`, Datenlänge = min(MTU − 3, 512) − 4. Die App hält höchstens 8 KB unbestätigt (ESP-Puffer 16 KB); der ESP32 bestätigt alle 4 KB.

**Regeln im ESP32**
- PIN: 4–8 Ziffern, im NVS gespeichert. Nach dem USB-Flash der „merged“-Datei gilt wieder `0000` (NVS wird dabei gelöscht); mit `0000` ist kein Update möglich. 5 falsche PINs → gesperrt bis zum Neustart.
- Bei BEGIN: Tasten loslassen, Object Pool im Terminal löschen (Delete Object Pool), CAN stoppen. Ab hier endet jeder Abbruch (Fehler, ABORT, Verbindungsabbruch, Zeitüberschreitung) mit einem Neustart in die bisherige Firmware.
- Bei END: Länge und SHA-256 prüfen, ESP-IDF prüft das Image, dann Boot-Partition umstellen und Neustart.
- Neue Firmware: Sobald BLE läuft (Advertising aktiv) und sie 10 s stabil ist, wird sie als funktionierend markiert. Kommt sie bis 60 s nach dem Start nicht dahin oder startet vorher neu, lädt der Bootloader wieder die alte Firmware.
- Die App prüft vorab: ESP-IDF-App-Image, Chip ESP32-S3, Projektname `SectionRemote`.
