# Device Configuration

Devices are configured in `devices.conf`.

The file uses strict JSON and normally contains an array of one or more Tuya devices.

`devices.conf` contains Tuya local keys and is excluded from Git. Do not commit a real device configuration to a public repository.

## Basic Device Definition

A minimal device requires a Tuya device ID, local key and a template describing the DPS values to expose.

Example smart plug:

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

## Device Options

| Option     | Required    | Description                                             |
| ---------- | ----------- | ------------------------------------------------------- |
| `id`       | yes         | Tuya device ID                                          |
| `key`      | yes         | Tuya local key                                          |
| `name`     | no          | Friendly name used in logs and metadata                 |
| `topic`    | recommended | Stable MQTT topic slug                                  |
| `ip`       | no          | Device IP address                                       |
| `version`  | no          | Tuya protocol version, for example `3.3`                |
| `type`     | no          | Optional descriptive device type                        |
| `template` | recommended | Maps Tuya DPS keys to named MQTT entities               |
| `climate`  | no          | Optional inherited Home Assistant climate configuration |

Using an explicit `topic` is recommended because it keeps MQTT and Gladys identifiers stable even if the friendly device name changes.

## Templates

Each entry in `template` defines a named entity and maps it to a Tuya DPS key.

For example:

```json
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
  }
}
```

This creates entities named `power` and `brightness`.

With the default MQTT prefix and:

```json
"topic": "bedroom_lamp"
```

their normal MQTT topics are:

```text
tuya/bedroom_lamp/power/state
tuya/bedroom_lamp/power/set

tuya/bedroom_lamp/brightness/state
tuya/bedroom_lamp/brightness/set
```

## Template Options

| Option                | Description                                                        |
| --------------------- | ------------------------------------------------------------------ |
| `key`                 | Tuya DPS key                                                       |
| `type`                | Value type: `bool`, `int`, `float`, `str`, `hsb` or `hsbhex`       |
| `name`                | Optional display name                                              |
| `topicMin`            | Minimum exposed/accepted numeric value                             |
| `topicMax`            | Maximum exposed/accepted numeric value                             |
| `stateMath`           | Arithmetic appended to the raw DPS value before publishing         |
| `commandMath`         | Arithmetic appended to an incoming value before sending it to Tuya |
| `components`          | Component list used by HSB colour values                           |
| `options`             | Allowed values for a string/select entity                          |
| `device_class`        | Optional Home Assistant sensor device class                        |
| `unit_of_measurement` | Optional Home Assistant unit                                       |

## Boolean Values

Example:

```json
"power": {
  "key": 1,
  "type": "bool"
}
```

The normal MQTT state is:

```text
ON
OFF
```

Commands may use values such as:

```text
ON
OFF
1
0
true
false
toggle
```

Gladys receives boolean state as `1` or `0`.

## Integer and Floating-Point Values

Example:

```json
"brightness": {
  "key": 22,
  "type": "int",
  "topicMin": 0,
  "topicMax": 100,
  "stateMath": "/10",
  "commandMath": "*10"
}
```

If the raw Tuya DPS value is `750`, the published value becomes:

```text
75
```

A command of:

```text
50
```

is converted to `500` before being sent to the Tuya device.

For numeric values, a normal MQTT command topic is created when `topicMin` or `topicMax` is defined. Numeric entries without a range are treated as read-only sensors by the inherited Home Assistant discovery code.

## String Values

Example read-only string:

```json
"mode": {
  "key": 21,
  "type": "str"
}
```

A string becomes writable when an `options` array is provided:

```json
"mode": {
  "key": 21,
  "type": "str",
  "options": [
    "white",
    "colour"
  ]
}
```

## Colour Values

The template engine retains support for Tuya HSB colour values.

Available types are:

```text
hsb
hsbhex
```

The optional `components` property selects which components are exposed:

```json
"colour": {
  "key": 24,
  "type": "hsb",
  "components": "h,s,b"
}
```

Tuya devices vary considerably in their colour DPS formats. Determine the actual DPS layout of the device before creating the template.

## Colour Temperature and Gladys

An entity named:

```text
color_temp
```

receives special handling for Gladys.

The template's `topicMin` and `topicMax` values describe the device's usable Kelvin range.

For example:

```json
"color_temp": {
  "key": 23,
  "type": "int",
  "topicMin": 2700,
  "topicMax": 6500,
  "stateMath": "<device-specific transform>",
  "commandMath": "<device-specific transform>"
}
```

The normal template state is converted into Kelvin according to the configured transform.

For Gladys, that Kelvin value is mapped into Gladys' 153–500 mired colour-temperature range.

Commands arriving from Gladys are converted in the opposite direction before being sent to the device.

The DPS scale and transform are device-specific. Values that work for one Tuya bulb should not be assumed to work for another.

## MQTT Topic Naming

`MQTT_TOPIC_PREFIX` defaults to:

```text
tuya/
```

The configured device `topic` is appended to that prefix.

For:

```json
"topic": "bedroom_lamp"
```

the base topic is:

```text
tuya/bedroom_lamp/
```

Each template entity then uses:

```text
tuya/bedroom_lamp/<entity>/state
tuya/bedroom_lamp/<entity>/set
```

The device also listens on:

```text
tuya/bedroom_lamp/command
```

Send:

```text
get-states
```

to request a state refresh.

Raw changed DPS values are published as JSON to:

```text
tuya/bedroom_lamp/dps/state
```

## Gladys MQTT IDs

Gladys identifiers are generated from the device `topic`.

Underscores are converted to hyphens.

For:

```json
"topic": "bedroom_lamp"
```

the Gladys device external ID is:

```text
mqtt:bedroom-lamp
```

For an entity named `brightness`, its feature external ID is:

```text
mqtt:bedroom-lamp:brightness
```

The bridge publishes its state to:

```text
gladys/master/device/mqtt:bedroom-lamp/feature/mqtt:bedroom-lamp:brightness/state
```

and accepts commands from:

```text
gladys/device/mqtt:bedroom-lamp/feature/mqtt:bedroom-lamp:brightness/state
```

Configure corresponding MQTT features in Gladys using those external IDs.

## Detecting Tuya DPS Values

The DPS layout is device-specific.

A practical way to determine a device's DPS values is to monitor the bridge logs or MQTT state while changing one property at a time using the physical controls or Smart Life.

For example:

```bash
mosquitto_sub -h <broker> -t 'tuya/#' -v
```

Watch which DPS keys or template values change when you toggle power, adjust brightness, or change colour temperature.

The bridge handles both normal TuyAPI data events and `dp-refresh` events, so externally initiated changes can be reflected through MQTT.

## Example: Simple Light

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
      }
    }
  }
]
```

The DPS numbers and transforms above are examples only.

## Home Assistant Compatibility

The upstream Home Assistant MQTT discovery implementation remains in this fork.

Template entries are mapped to Home Assistant components approximately as follows:

| Template                      | Home Assistant component |
| ----------------------------- | ------------------------ |
| `bool`                        | `switch`                 |
| `int` / `float` without range | `sensor`                 |
| `int` / `float` with range    | `number`                 |
| `str` without options         | `sensor`                 |
| `str` with options            | `select`                 |

The optional `device_class` and `unit_of_measurement` template properties are used by Home Assistant discovery.

The upstream `climate` configuration is also still present.

Home Assistant support is retained for compatibility, but Gladys and the normal MQTT topic interface are the primary targets of this fork.
