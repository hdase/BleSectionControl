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
| 0 | Bitmaske gedrückter Tasten: Bit0 = Links EIN, Bit1 = Links AUS, Bit2 = Rechts EIN, Bit3 = Rechts AUS |
| 1 | Sequenzzähler 0–255 (Heartbeat) |

Ein kurzer Tipp wird von der App mindestens 200 ms lang als „gedrückt“ gesendet.

**Fail-safe im ESP32:** Kommt 300 ms lang kein Paket (oder die BLE-Verbindung bricht ab), setzt der ESP32 alle vier AUX-Eingänge auf „losgelassen“.

## Status (2 Byte, bei Änderung und mindestens alle 500 ms als Notify)

| Byte | Inhalt |
|---|---|
| 0 | Flags: Bit0 = Adresse belegt (Address Claim OK), Bit1 = Terminal (VT) verbunden, Bit2 = Object Pool aktiv / AUX-N angemeldet, Bit3 = Lernmodus (Zuordnung im Terminal läuft) |
| 1 | Bitmaske: welche der vier Tasten im Terminal einer Funktion zugeordnet sind (gleiche Bit-Reihenfolge wie oben) |

Die App zeigt „ESP32 antwortet nicht“, wenn 1,5 s kein Status kommt, und sperrt dann die Tasten.

## ISOBUS-Seite (Firmware)

- Bibliothek: AgIsoStack++ (ESP-IDF/PlatformIO), CAN über `MCP2515CANInterface` + `SPIInterfaceESP` (CS = D7) oder alternativ den internen TWAI-Controller.
- Vorlage: `examples/virtual_terminal/aux_inputs` – vier Auxiliary-Input-Type-2-Objekte (Boolean, momentary) mit den vier Icons, `update_auxiliary_input(objectId, value, transitions)` bei jeder Änderung.
- 250 kbit/s, Abschlusswiderstand am Board offen lassen.
