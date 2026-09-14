# tuya-mqtt-gladys

A local Tuya-to-MQTT bridge with first-class support for Gladys Assistant.

This project is based on [nikoraes/tuya-mqtt](https://github.com/nikoraes/tuya-mqtt) and retains much of its Home Assistant MQTT discovery support while adding native Gladys MQTT topics, cleaner device topic names, improved state synchronisation, and more robust logging.

## Features

* Controls compatible Tuya devices directly over the local network using TuyAPI
* No Tuya cloud connection is required during normal operation
* Publishes clean MQTT state and command topics
* Publishes device state using the native Gladys MQTT topic format
* Accepts commands from Gladys over MQTT
* Supports stable per-device topic slugs
* Updates MQTT and Gladys state when a device changes externally, including changes made through Smart Life or another controller
* Supports value transforms for Tuya DPS values
* Converts colour temperature between device-specific Kelvin ranges and the mired range used by Gladys
* Retains the upstream Home Assistant MQTT discovery and command implementation
* Automatically reconnects to Tuya devices and the MQTT broker
* Timestamped logging with configurable timezone
* Runs directly under Node.js or in Docker

## Requirements

* Node.js 20+ or Docker
* An MQTT broker such as Mosquitto
* Tuya device ID and local key for each device
* Network access from tuya-mqtt to the Tuya devices

Gladys Assistant is required only if you want to use the native Gladys integration.

Home Assistant is not required. The inherited Home Assistant MQTT discovery support remains available but is not the primary focus of this fork.

## Installation

Clone this repository:

```bash
git clone https://github.com/MakoNZ/tuya-mqtt-gladys.git
cd tuya-mqtt-gladys
```

### Node.js

Install dependencies and build:

```bash
npm ci
npm run build
```

Copy the sample environment file:

```bash
cp .env.sample .env
```

Create a `devices.conf` file containing your devices. See [docs/DEVICES.md](docs/DEVICES.md) for configuration details.

Start the bridge:

```bash
npm start
```

### Docker Compose

An example `compose.yml` is included.

Configure `.env` and `devices.conf`, then build and start:

```bash
docker compose up -d --build
```

View logs with:

```bash
docker compose logs -f tuya-mqtt
```

If your MQTT broker is running in another Docker network, adjust the network section of `compose.yml` to suit your environment.

## Environment Configuration

Configuration is read from environment variables and may be stored in a local `.env` file.

| Variable              | Default          | Description                                                           |
| --------------------- | ---------------- | --------------------------------------------------------------------- |
| `TZ`                  | system timezone  | IANA timezone used for log timestamps, for example `Pacific/Auckland` |
| `MQTT_HOST`           | `localhost`      | MQTT broker hostname or IP address                                    |
| `MQTT_PORT`           | `1883`           | MQTT broker port                                                      |
| `MQTT_USERNAME`       | empty            | MQTT username                                                         |
| `MQTT_PASSWORD`       | empty            | MQTT password                                                         |
| `MQTT_TOPIC_PREFIX`   | `tuya/`          | Prefix used for normal Tuya MQTT topics                               |
| `DEVICES_CONFIG_PATH` | `./devices.conf` | Path to the device configuration file                                 |

`.env` and `devices.conf` are excluded from Git. Do not commit MQTT passwords or Tuya local keys.

Example:

```dotenv
TZ=UTC

MQTT_HOST=localhost
MQTT_PORT=1883
MQTT_USERNAME=
MQTT_PASSWORD=
MQTT_TOPIC_PREFIX=tuya/

DEVICES_CONFIG_PATH=./devices.conf
```

## Device Configuration

Devices are defined in `devices.conf` using strict JSON.

A simple smart plug might look like:

```json
[
  {
    "name": "Desk Plug",
    "topic": "desk_plug",
    "id": "<tuya-device-id>",
    "key": "<tuya-local-key>",
    "ip": "192.168.1.50",
    "version": "3.3",
    "template": {
      "power": {
        "key": 1,
        "type": "bool"
      }
    }
  }
]
```

A light with brightness and colour-temperature controls might use:

```json
[
  {
    "name": "Bedroom Lamp",
    "topic": "bedroom_lamp",
    "id": "<tuya-device-id>",
    "key": "<tuya-local-key>",
    "ip": "192.168.1.51",
    "version": "3.3",
    "template": {
      "power": {
        "key": 20,
        "type": "bool"
      },
      "brightness": {
        "key": 22,
        "type": "int",
        "topicMin": 0,
        "topicMax": 100,
        "stateMath": "/10",
        "commandMath": "*10"
      },
      "color_temp": {
        "key": 23,
        "type": "int",
        "topicMin": 2700,
        "topicMax": 6500
      }
    }
  }
]
```

The actual DPS numbers, ranges and transforms vary between Tuya devices. Do not assume the example above matches a different device.

See [docs/DEVICES.md](docs/DEVICES.md) for the complete template format.

## MQTT Topics

Each device may define a stable `topic` slug. With:

```json
"topic": "bedroom_lamp"
```

and the default prefix `tuya/`, a `power` entity uses:

```text
tuya/bedroom_lamp/power/state
tuya/bedroom_lamp/power/set
```

Other template entities follow the same pattern:

```text
tuya/<device>/<entity>/state
tuya/<device>/<entity>/set
```

The bridge also accepts:

```text
tuya/<device>/command
```

with the payload:

```text
get-states
```

to request a state refresh.

Changed raw Tuya DPS values are also published to:

```text
tuya/<device>/dps/state
```

## Gladys Assistant

This fork publishes state directly using Gladys' MQTT device/feature topic structure.

For a device configured as:

```json
"topic": "bedroom_lamp"
```

the Gladys device external ID becomes:

```text
mqtt:bedroom-lamp
```

For an entity called `power`, the feature external ID becomes:

```text
mqtt:bedroom-lamp:power
```

The bridge publishes state to:

```text
gladys/master/device/mqtt:bedroom-lamp/feature/mqtt:bedroom-lamp:power/state
```

and listens for Gladys commands on:

```text
gladys/device/mqtt:bedroom-lamp/feature/mqtt:bedroom-lamp:power/state
```

The corresponding MQTT device and features in Gladys should use matching external IDs.

### Gladys value handling

Boolean values are published to Gladys as:

```text
0
1
```

Numeric template values are published after applying any configured `stateMath`.

For an entity named `color_temp`, the normal template state represents the device colour temperature in Kelvin. The Gladys state is converted into the 153–500 mired range expected by Gladys.

Gladys colour-temperature commands are converted back into the Kelvin range specified by the template before being translated to the underlying Tuya DPS value.

## External State Changes

The bridge listens for both normal TuyAPI data events and DPS refresh events.

This means changes made outside this bridge, for example using the physical device or Smart Life application, are fed back through the normal state processing and published to MQTT and Gladys.

This keeps the Gladys dashboard synchronised with the actual device rather than only updating after commands sent by Gladys itself.

## Template Value Transforms

Numeric template entries may contain:

```json
"stateMath": "/10",
"commandMath": "*10"
```

`stateMath` converts the raw Tuya DPS value before publishing it.

`commandMath` converts an MQTT command back into the raw value expected by the device.

For example, a Tuya brightness range of 0–1000 can be exposed as 0–100 by dividing received values by 10 and multiplying commands by 10.

## Home Assistant Compatibility

The original project added Home Assistant MQTT discovery support. That implementation is still present in this fork.

When a device has a template, the bridge publishes Home Assistant discovery messages and subscribes to the corresponding command topics. The optional `climate` configuration inherited from upstream is also retained.

Home Assistant support has not been the primary development or testing target of this Gladys-focused fork, so Gladys and the normal MQTT topics should be considered the primary supported interfaces.

## Development

Build:

```bash
npm run build
```

Run:

```bash
npm start
```

Watch TypeScript sources:

```bash
npm run dev
```

## Upstream

This project is based on:

[nikoraes/tuya-mqtt](https://github.com/nikoraes/tuya-mqtt)

The Gladys-specific integration, topic handling and state synchronisation in this repository were added on top of that project.

## License

MIT. See [LICENSE](LICENSE).
