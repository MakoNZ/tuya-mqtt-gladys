import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'
import mqtt from 'mqtt'
import type { DeviceConfig } from './types'
import { GenericDevice } from './generic-device'
import { sleep, log, logError } from './utils'

dotenv.config({ quiet: true })

const devices: GenericDevice[] = []

function shutdown(exitCode?: number): void {
  for (const device of devices) {
    device.disconnect()
  }
  if (exitCode !== undefined) {
    log('[tuya-mqtt] exit', exitCode)
  }
  sleep(1).then(() => process.exit(exitCode ?? 0))
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
process.on('uncaughtException', (err) => {
  logError('[tuya-mqtt:error]', err)
  shutdown(1)
})

function loadDevices(): DeviceConfig[] {
  const configPath = process.env.DEVICES_CONFIG_PATH || './devices.conf'
  try {
    const content = fs.readFileSync(path.resolve(configPath), 'utf8')
    const parsed: DeviceConfig[] = JSON.parse(content)
    if (!Array.isArray(parsed) || parsed.length === 0) {
      logError('[tuya-mqtt] no devices in', configPath)
      process.exit(1)
    }
    return parsed
  } catch (e) {
    logError('[tuya-mqtt] failed to load', process.env.DEVICES_CONFIG_PATH || './devices.conf')
    logError(e)
    process.exit(1)
  }
}

function main(): void {
  const mqttHost = process.env.MQTT_HOST || 'localhost'
  const mqttPort = Number(process.env.MQTT_PORT) || 1883
  const mqttUser = process.env.MQTT_USERNAME || undefined
  const mqttPass = process.env.MQTT_PASSWORD || undefined
  const topicPrefix = (process.env.MQTT_TOPIC_PREFIX || 'tuya/').replace(/\/+$/, '') + '/'

  const deviceConfigs = loadDevices()

  const client = mqtt.connect({ host: mqttHost, port: mqttPort, username: mqttUser, password: mqttPass, protocol: mqttPort === 8883 ? 'mqtts' : 'mqtt' })

  log(`[tuya-mqtt] connecting to ${mqttHost}:${mqttPort} (protocol: ${mqttPort === 8883 ? 'mqtts' : 'mqtt'}, username: ${mqttUser ? '✓' : '✗'})`)

  client.on('connect', () => {
    log('[tuya-mqtt] connected to MQTT')
    client.subscribe(topicPrefix + '#')
    client.subscribe('gladys/device/#')

    for (const config of deviceConfigs) {
      devices.push(new GenericDevice(config, client, topicPrefix))
    }
  })

  client.on('reconnect', () => {
    log('[tuya-mqtt] MQTT reconnecting...')
  })

  client.on('error', (error) => {
    logError('[tuya-mqtt:error] MQTT', error.message)
  })

  client.on('message', (topic, buffer) => {
    try {
      const message = buffer.toString()

      for (const device of devices) {
        device.processMqttMessage(topic, message)
      }
    } catch (e) {
      logError('[tuya-mqtt:error]', e)
    }
  })
}

main()
